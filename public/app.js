/* ═══════════════════════════════════════════════════════════════
   Tac Board — client app.js
   ═══════════════════════════════════════════════════════════════ */

// ── DOM refs ──────────────────────────────────────────────────
const joinScreen   = document.getElementById('join-screen');
const appEl        = document.getElementById('app');
const usernameInput= document.getElementById('username-input');
const joinBtn      = document.getElementById('join-btn');

const pitchCanvas  = document.getElementById('pitch-canvas');
const strokesCanvas= document.getElementById('strokes-canvas');
const liveCanvas   = document.getElementById('live-canvas');
const tokenLayer   = document.getElementById('token-layer');
const cursorLayer  = document.getElementById('cursor-layer');
const canvasStack  = document.getElementById('canvas-stack');

const pitchCtx     = pitchCanvas.getContext('2d');
const strokesCtx   = strokesCanvas.getContext('2d');
const liveCtx      = liveCanvas.getContext('2d');

const colorPicker   = document.getElementById('color-picker');
const sizePicker    = document.getElementById('size-picker');
const sizeVal       = document.getElementById('size-val');
const userListEl    = document.getElementById('user-list');
const toastContainer= document.getElementById('toast-container');
const ownEraseCheck = document.getElementById('own-erase-check');
const arrowDashedCheck = document.getElementById('arrow-dashed-check');

// ── State ─────────────────────────────────────────────────────
let socket;
let myId    = null;
let myColor = '#ffffff';
let myName  = '';

let activeTool   = 'draw'; // draw | arrow | erase | select
let isDrawing    = false;
let currentPath  = [];   // [{x,y}] for current stroke
let arrowStart   = null; // {x,y} for arrow tool
let strokeSeq    = 0;    // local stroke ID counter
let arrowSeq     = 0;    // local arrow ID counter
let ownEraseOnly = false; // only erase own lines when checked
let arrowDashed  = false; // dashed arrows
let isReplaying  = false; // true while a server replay is running

// Throttle timestamps
let _lastCursorEmit = 0;

// ── Per-user undo stack ───────────────────────────────────────
// Each entry: { type: 'stroke'|'arrow'|'token', id }
const myUndoStack = [];

function undoLast() {
  if (!myUndoStack.length) return;
  const entry = myUndoStack.pop();
  if (entry.type === 'stroke') {
    for (let i = allStrokes.length - 1; i >= 0; i--) {
      if (allStrokes[i].id === entry.id) { allStrokes.splice(i, 1); break; }
    }
    socket?.emit('stroke-remove', { ids: [entry.id] });
    redrawStrokes();
  } else if (entry.type === 'arrow') {
    for (let i = allArrows.length - 1; i >= 0; i--) {
      if (allArrows[i].id === entry.id) { allArrows.splice(i, 1); break; }
    }
    socket?.emit('arrow-remove', { ids: [entry.id] });
    redrawStrokes();
  } else if (entry.type === 'token') {
    socket?.emit('token-remove', { id: entry.id });
  }
}

// Other users' live strokes: socketId → {points: [{x,y}], color, width}
const liveStrokes = {};

// Tokens: id → { el, x, y, color, label }
const tokens = {};

// Remote cursors: socketId → el
const remoteCursors = {};

// Canvas dimensions (logical)
const PITCH_W = 900;
const PITCH_H = 580;

// ── Canvas sizing ─────────────────────────────────────────────
function resizeCanvases() {
  const boardWrap = document.getElementById('board-wrap');
  const maxW = boardWrap.clientWidth  - 20;
  const maxH = boardWrap.clientHeight - 20;
  const scale = Math.min(maxW / PITCH_W, maxH / PITCH_H);
  const w = Math.floor(PITCH_W * scale);
  const h = Math.floor(PITCH_H * scale);

  canvasStack.style.width  = w + 'px';
  canvasStack.style.height = h + 'px';

  [pitchCanvas, strokesCanvas, liveCanvas].forEach(c => {
    c.width  = w;
    c.height = h;
  });

  drawPitch();
  redrawStrokes();
}

// Convert client canvas coords → logical [0..PITCH_W, 0..PITCH_H]
function toLogical(clientX, clientY) {
  const rect = liveCanvas.getBoundingClientRect();
  const sx = PITCH_W / rect.width;
  const sy = PITCH_H / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top)  * sy
  };
}

// Convert logical coords → canvas pixel
function toPixel(lx, ly) {
  const sx = liveCanvas.width  / PITCH_W;
  const sy = liveCanvas.height / PITCH_H;
  return { x: lx * sx, y: ly * sy };
}

// ── Draw pitch ────────────────────────────────────────────────
function drawPitch() {
  const ctx = pitchCtx;
  const W = pitchCanvas.width;
  const H = pitchCanvas.height;

  // Alternating stripes
  const stripeCount = 10;
  const stripeW = W / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#3a7d2c' : '#44942f';
    ctx.fillRect(i * stripeW, 0, stripeW, H);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth   = Math.max(1.5, W * 0.0018);
  ctx.lineCap     = 'round';

  const m  = W * 0.04;  // margin
  const fw = W - m * 2; // field width
  const fh = H - m * 2; // field height

  // Outer boundary
  rect(ctx, m, m, fw, fh);

  // Halfway line
  line(ctx, m + fw / 2, m, m + fw / 2, m + fh);

  // Centre circle
  circle(ctx, m + fw / 2, m + fh / 2, fh * 0.155);
  dot(ctx, m + fw / 2, m + fh / 2, W * 0.004);

  // ── Left penalty area
  const paW = fw * 0.165;
  const paH = fh * 0.60;
  rect(ctx, m, m + (fh - paH) / 2, paW, paH);

  // Left 6-yard box
  const sixW = fw * 0.062;
  const sixH = fh * 0.29;
  rect(ctx, m, m + (fh - sixH) / 2, sixW, sixH);

  // Left penalty dot
  dot(ctx, m + fw * 0.115, m + fh / 2, W * 0.004);

  // Left penalty arc
  arc(ctx, m + fw * 0.115, m + fh / 2, fh * 0.155, -0.92, 0.92, false);

  // Left goal
  const gW = fw * 0.018;
  const gH = fh * 0.18;
  rect(ctx, m - gW, m + (fh - gH) / 2, gW, gH);

  // ── Right penalty area
  rect(ctx, m + fw - paW, m + (fh - paH) / 2, paW, paH);
  rect(ctx, m + fw - sixW, m + (fh - sixH) / 2, sixW, sixH);
  dot(ctx, m + fw - fw * 0.115, m + fh / 2, W * 0.004);
  arc(ctx, m + fw - fw * 0.115, m + fh / 2, fh * 0.155, Math.PI - 0.92, Math.PI + 0.92, false);

  // Right goal
  rect(ctx, m + fw, m + (fh - gH) / 2, gW, gH);

  // Corner arcs
  const cr = fh * 0.025;
  arc(ctx, m,      m,      cr, 0,         Math.PI / 2, false);
  arc(ctx, m + fw, m,      cr, Math.PI / 2, Math.PI, false);
  arc(ctx, m,      m + fh, cr, -Math.PI / 2, 0, false);
  arc(ctx, m + fw, m + fh, cr, Math.PI, Math.PI * 1.5, false);
}

function rect(ctx, x, y, w, h) {
  ctx.strokeRect(x, y, w, h);
}
function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function circle(ctx, cx, cy, r) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
}
function dot(ctx, cx, cy, r) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
}
function arc(ctx, cx, cy, r, startA, endA, anti) {
  ctx.beginPath(); ctx.arc(cx, cy, r, startA, endA, anti); ctx.stroke();
}

// ── Stored strokes ────────────────────────────────────────────
const allStrokes = [];
const allArrows  = [];

function redrawStrokes() {
  strokesCtx.clearRect(0, 0, strokesCanvas.width, strokesCanvas.height);
  allStrokes.forEach(s => renderStroke(strokesCtx, s));
  allArrows.forEach(a  => renderArrow(strokesCtx, a));
}

function renderStroke(ctx, stroke) {
  if (!stroke.points || stroke.points.length < 2) return;
  ctx.beginPath();
  ctx.globalCompositeOperation = stroke.tool === 'erase' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth   = toPixelSize(stroke.width);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  const p0 = toPixel(stroke.points[0].x, stroke.points[0].y);
  ctx.moveTo(p0.x, p0.y);
  stroke.points.forEach(p => {
    const px = toPixel(p.x, p.y);
    ctx.lineTo(px.x, px.y);
  });
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function renderArrow(ctx, arrow) {
  const start = toPixel(arrow.x1, arrow.y1);
  const end   = toPixel(arrow.x2, arrow.y2);
  drawArrowLine(ctx, start.x, start.y, end.x, end.y, arrow.color, toPixelSize(arrow.width), arrow.style);
}

function drawArrowLine(ctx, x1, y1, x2, y2, color, width, style) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';

  // Dashed?
  if (style === 'dashed') {
    ctx.setLineDash([width * 4, width * 3]);
  } else {
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const hw = Math.max(10, width * 3.5);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - hw * Math.cos(angle - 0.4), y2 - hw * Math.sin(angle - 0.4));
  ctx.lineTo(x2 - hw * Math.cos(angle + 0.4), y2 - hw * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function toPixelSize(logicalSize) {
  // Pen width is stored in logical units (relative to 900-wide pitch)
  return logicalSize * (liveCanvas.width / PITCH_W);
}

// Check whether an erase path comes within `radius` (logical) of any stroke point
function strokeHitsErasePath(stroke, erasePath, radius) {
  if (!stroke.points) return false;
  const r2 = radius * radius;
  for (const ep of erasePath) {
    for (const sp of stroke.points) {
      const dx = ep.x - sp.x, dy = ep.y - sp.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}

// ── Live drawing canvas ───────────────────────────────────────
function redrawLive() {
  liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);

  // Render other users' active strokes
  Object.values(liveStrokes).forEach(s => {
    if (!s.points || s.points.length < 2) return;
    liveCtx.save();
    if (s.tool === 'erase') {
      // Show a dashed outline so the eraser is visible but doesn't paint over the board
      liveCtx.strokeStyle = 'rgba(255,255,255,0.4)';
      liveCtx.lineWidth   = toPixelSize(s.width) * 4;
      liveCtx.setLineDash([7, 5]);
    } else {
      liveCtx.strokeStyle = s.color;
      liveCtx.lineWidth   = toPixelSize(s.width);
      liveCtx.setLineDash([]);
    }
    liveCtx.lineCap  = 'round';
    liveCtx.lineJoin = 'round';
    liveCtx.beginPath();
    const p0 = toPixel(s.points[0].x, s.points[0].y);
    liveCtx.moveTo(p0.x, p0.y);
    s.points.forEach(p => { const px = toPixel(p.x, p.y); liveCtx.lineTo(px.x, px.y); });
    liveCtx.stroke();
    liveCtx.restore();
  });

  // Current user's own live stroke
  if (isDrawing && activeTool === 'draw' && currentPath.length >= 2) {
    liveCtx.beginPath();
    liveCtx.strokeStyle = colorPicker.value;
    liveCtx.lineWidth   = toPixelSize(+sizePicker.value);
    liveCtx.lineCap     = 'round'; liveCtx.lineJoin = 'round';
    const p0 = toPixel(currentPath[0].x, currentPath[0].y);
    liveCtx.moveTo(p0.x, p0.y);
    currentPath.forEach(p => { const px = toPixel(p.x, p.y); liveCtx.lineTo(px.x, px.y); });
    liveCtx.stroke();
  }

  // Arrow preview
  if (isDrawing && activeTool === 'arrow' && arrowStart && currentPath.length) {
    const last = currentPath[currentPath.length - 1];
    const s = toPixel(arrowStart.x, arrowStart.y);
    const e = toPixel(last.x, last.y);
    drawArrowLine(liveCtx, s.x, s.y, e.x, e.y, colorPicker.value, toPixelSize(+sizePicker.value), 'solid');
  }

  // Eraser preview circle
  if (activeTool === 'erase' && lastMousePos) {
    const px = toPixel(lastMousePos.x, lastMousePos.y);
    liveCtx.beginPath();
    const r = toPixelSize(+sizePicker.value) * 3;
    liveCtx.arc(px.x, px.y, r, 0, Math.PI * 2);
    liveCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    liveCtx.lineWidth = 1;
    liveCtx.stroke();
  }
}

let lastMousePos = null;

// ── Pointer events on liveCanvas ──────────────────────────────
liveCanvas.addEventListener('pointerdown', e => {
  if (activeTool === 'select' || isReplaying) return;
  isDrawing = true;
  liveCanvas.setPointerCapture(e.pointerId); // capture so pointerup fires even outside canvas
  const pos = toLogical(e.clientX, e.clientY);
  currentPath = [pos];
  if (activeTool === 'arrow') arrowStart = pos;

  socket?.emit('draw-move', {
    tool: activeTool,
    width: +sizePicker.value,
    points: currentPath
  });
});

liveCanvas.addEventListener('pointermove', e => {
  const pos = toLogical(e.clientX, e.clientY);
  lastMousePos = pos;

  // Emit cursor (throttled to max ~25/sec)
  const now = Date.now();
  if (now - _lastCursorEmit > 40) {
    socket?.emit('cursor-move', pos);
    _lastCursorEmit = now;
  }

  if (!isDrawing) { if (activeTool === 'erase') redrawLive(); return; }

  currentPath.push(pos);

  // Throttle: emit every other point
  if (currentPath.length % 2 === 0) {
    socket?.emit('draw-move', {
      tool: activeTool,
      width: +sizePicker.value,
      points: currentPath
    });
  }
  redrawLive();
});

liveCanvas.addEventListener('pointerup', e => {
  if (!isDrawing) return;
  isDrawing = false;

  if (activeTool === 'draw' && currentPath.length >= 2) {
    const stroke = {
      id: `${myId}-${++strokeSeq}`,
      socketId: myId,
      tool: 'draw',
      points: [...currentPath],
      color: colorPicker.value,
      width: +sizePicker.value
    };
    allStrokes.push(stroke);
    myUndoStack.push({ type: 'stroke', id: stroke.id });
    socket?.emit('stroke-done', stroke);
    redrawStrokes();
  }

  if (activeTool === 'erase' && currentPath.length >= 2) {
    if (ownEraseOnly) {
      // Proximity-based: remove only my own strokes that the erase path touches
      const eraserRadius = +sizePicker.value * 4;
      const toRemove = allStrokes
        .filter(s => s.socketId === myId && strokeHitsErasePath(s, currentPath, eraserRadius))
        .map(s => s.id)
        .filter(Boolean);
      if (toRemove.length) {
        for (let i = allStrokes.length - 1; i >= 0; i--) {
          if (toRemove.includes(allStrokes[i].id)) allStrokes.splice(i, 1);
        }
        socket?.emit('stroke-remove', { ids: toRemove });
        redrawStrokes();
      }
    } else {
      // Canvas composite erase — removes all lines underneath
      const stroke = {
        id: `${myId}-${++strokeSeq}`,
        socketId: myId,
        tool: 'erase',
        points: [...currentPath],
        color: 'rgba(0,0,0,1)',
        width: +sizePicker.value * 4
      };
      allStrokes.push(stroke);
      myUndoStack.push({ type: 'stroke', id: stroke.id });
      socket?.emit('stroke-done', stroke);
      redrawStrokes();
    }
  }

  if (activeTool === 'arrow' && arrowStart && currentPath.length >= 2) {
    const last = currentPath[currentPath.length - 1];
    const tempId = `${myId}-a${++arrowSeq}`;
    const arrow = {
      id: tempId,
      socketId: myId,
      x1: arrowStart.x, y1: arrowStart.y,
      x2: last.x,       y2: last.y,
      color: colorPicker.value,
      width: +sizePicker.value,
      style: arrowDashed ? 'dashed' : 'solid'
    };
    allArrows.push(arrow);
    myUndoStack.push({ type: 'arrow', id: tempId, _pending: true });
    socket?.emit('arrow-done', arrow);
    redrawStrokes();
  }

  currentPath = [];
  arrowStart  = null;
  redrawLive();
});

liveCanvas.addEventListener('pointerleave', () => {
  lastMousePos = null;
  redrawLive();
});

// ── Tokens ────────────────────────────────────────────────────
function createTokenEl(token) {
  const el = document.createElement('div');
  el.id = 'token-' + token.id;
  if (token.shape === 'ball') {
    el.className = 'token token-ball';
    el.textContent = '⚽';
    el.style.background = 'transparent';
    el.style.border = 'none';
    el.style.fontSize = '1.6rem';
    el.style.boxShadow = 'none';
  } else {
    el.className = 'token';
    el.textContent = token.label || '1';
    el.style.background = token.color;
    if (token.color === '#ffffff' || token.color === '#fff') el.style.color = '#222';
  }

  // Place
  positionToken(el, token.x, token.y);

  // Delete button
  const del = document.createElement('button');
  del.className = 'token-delete';
  del.textContent = '×';
  del.title = 'Remove';
  del.addEventListener('click', e => {
    e.stopPropagation();
    socket?.emit('token-remove', { id: token.id });
  });
  el.appendChild(del);

  // Double-click to rename (not for ball)
  if (token.shape !== 'ball') {
    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'token-rename-input';
      input.value = token.label || '';
      input.maxLength = 4;
      const rect2 = canvasStack.getBoundingClientRect();
      const scaleX = rect2.width  / PITCH_W;
      const scaleY = rect2.height / PITCH_H;
      input.style.left = (token.x * scaleX) + 'px';
      input.style.top  = (token.y * scaleY) + 'px';
      tokenLayer.appendChild(input);
      input.focus(); input.select();
      const commit = () => {
        const newLabel = input.value.trim() || token.label;
        input.remove();
        if (newLabel !== token.label) {
          token.label = newLabel;
          el.childNodes[0].textContent = newLabel; // update text node (first child)
          socket?.emit('token-relabel', { id: token.id, label: newLabel });
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') commit(); if (e2.key === 'Escape') input.remove(); });
    });
  }

  // Drag
  let dragging = false, ox = 0, oy = 0;
  let _lastTokenEmit = 0;
  el.addEventListener('pointerdown', e => {
    if (e.target === del) return;
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    ox = e.clientX; oy = e.clientY;
    e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - ox; ox = e.clientX;
    const dy = e.clientY - oy; oy = e.clientY;
    const rect = canvasStack.getBoundingClientRect();
    const scaleX = PITCH_W / rect.width;
    const scaleY = PITCH_H / rect.height;
    token.x += dx * scaleX;
    token.y += dy * scaleY;
    // Clamp
    token.x = Math.max(0, Math.min(PITCH_W, token.x));
    token.y = Math.max(0, Math.min(PITCH_H, token.y));
    positionToken(el, token.x, token.y);
    const now = Date.now();
    if (now - _lastTokenEmit > 33) { // ~30fps
      socket?.emit('token-move', { id: token.id, x: token.x, y: token.y });
      _lastTokenEmit = now;
    }
    e.stopPropagation();
  });
  el.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    // Emit final position on pointer up to ensure sync
    socket?.emit('token-move', { id: token.id, x: token.x, y: token.y });
    e.stopPropagation();
  });

  return el;
}

function positionToken(el, lx, ly) {
  const rect  = canvasStack.getBoundingClientRect();
  const scaleX = rect.width  / PITCH_W;
  const scaleY = rect.height / PITCH_H;
  el.style.left = (lx * scaleX) + 'px';
  el.style.top  = (ly * scaleY) + 'px';
}

function repositionAllTokens() {
  Object.values(tokens).forEach(t => {
    const el = document.getElementById('token-' + t.id);
    if (el) positionToken(el, t.x, t.y);
  });
}

// Token counter per color
const tokenCounters = {};

document.querySelectorAll('.token-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    const color = btn.dataset.color;
    const shape = btn.dataset.shape || 'circle';
    tokenCounters[color] = (tokenCounters[color] || 0) + 1;
    const label = shape === 'ball' ? '⚽' : String(tokenCounters[color]);
    // Place near center
    socket?.emit('token-add', {
      x: PITCH_W / 2 + (Math.random() - .5) * 100,
      y: PITCH_H / 2 + (Math.random() - .5) * 80,
      color,
      label,
      shape,
      createdBy: myId
    });
  });
});

// ── Remote cursors ────────────────────────────────────────────
function getOrCreateCursor(socketId, username, color) {
  if (remoteCursors[socketId]) return remoteCursors[socketId];
  const el = document.createElement('div');
  el.className = 'remote-cursor';
  el.innerHTML = `
    <svg width="16" height="20" viewBox="0 0 16 20">
      <polygon points="0,0 0,14 4,10 7,18 9,17 6,9 11,9" fill="${color}" stroke="#000" stroke-width="1"/>
    </svg>
    <div class="cursor-name" style="background:${color}">${escHtml(username)}</div>
  `;
  cursorLayer.appendChild(el);
  remoteCursors[socketId] = el;
  return el;
}

function moveCursor(socketId, username, color, lx, ly) {
  const el = getOrCreateCursor(socketId, username, color);
  const rect  = canvasStack.getBoundingClientRect();
  const scaleX = rect.width  / PITCH_W;
  const scaleY = rect.height / PITCH_H;
  el.style.transform = `translate(${lx * scaleX}px, ${ly * scaleY}px)`;
}

function removeCursor(socketId) {
  if (remoteCursors[socketId]) {
    remoteCursors[socketId].remove();
    delete remoteCursors[socketId];
  }
}

// ── Socket.io ─────────────────────────────────────────────────
function connectSocket(username) {
  socket = io();

  socket.on('connect', () => {
    myId = socket.id;
    // Flush stale live previews from previous session so nothing lingers on reconnect
    Object.keys(liveStrokes).forEach(k => delete liveStrokes[k]);
    redrawLive();
    socket.emit('join', { username });
  });

  socket.on('init-state', ({ strokes, tokens: tokenList, arrows, users, you }) => {
    myColor = you.color;
    colorPicker.value = myColor;

    // Re-render strokes
    allStrokes.length = 0; allArrows.length = 0;
    strokes.forEach(s => allStrokes.push(s));
    arrows.forEach(a  => allArrows.push(a));
    redrawStrokes();

    // Re-render tokens
    tokenLayer.innerHTML = '';
    Object.keys(tokens).forEach(k => delete tokens[k]);
    tokenList.forEach(t => {
      tokens[t.id] = t;
      tokenLayer.appendChild(createTokenEl(t));
    });

    updateUserList(users);
    toast(`Welcome, ${you.username}! Color: <span style="color:${you.color}">■</span>`);
  });

  socket.on('user-joined', (user) => {
    toast(`${escHtml(user.username)} joined`);
  });
  socket.on('user-left', (user) => {
    if (user) toast(`${escHtml(user.username)} left`);
  });
  socket.on('user-list', (users) => updateUserList(users));

  // Live draw from others
  socket.on('draw-move', ({ socketId, tool, width, points, color }) => {
    liveStrokes[socketId] = { tool, width, points, color };
    redrawLive();
  });

  // Finished stroke from others
  socket.on('stroke-done', (stroke) => {
    allStrokes.push(stroke);
    delete liveStrokes[stroke.socketId];
    redrawStrokes();
  });

  // Arrow from others (server broadcasts to non-senders)
  socket.on('arrow-done', (arrow) => {
    allArrows.push(arrow);
    redrawStrokes();
  });

  // Arrow confirmed back to sender — replace temp arrow with canonical server id
  socket.on('arrow-confirmed', ({ tempId, arrow }) => {
    const idx = allArrows.findIndex(a => a.id === tempId);
    if (idx !== -1) allArrows[idx] = arrow;
    // Update undo stack entry
    const ue = (myUndoStack.findLast ? myUndoStack.findLast(e => e._pending && e.id === tempId)
                                     : [...myUndoStack].reverse().find(e => e._pending && e.id === tempId));
    if (ue) { ue.id = arrow.id; delete ue._pending; }
    redrawStrokes();
  });

  // Arrow removed (undo from any user)
  socket.on('arrow-remove', ({ ids }) => {
    for (let i = allArrows.length - 1; i >= 0; i--) {
      if (ids.includes(allArrows[i].id)) allArrows.splice(i, 1);
    }
    redrawStrokes();
  });

  // Token events
  socket.on('token-add', (token) => {
    tokens[token.id] = token;
    tokenLayer.appendChild(createTokenEl(token));
    // Push to undo stack if I placed this token
    if (token.createdBy === myId) {
      myUndoStack.push({ type: 'token', id: token.id });
    }
  });

  socket.on('token-relabel', ({ id, label }) => {
    if (tokens[id]) {
      tokens[id].label = label;
      const el = document.getElementById('token-' + id);
      // Update the visible text node without removing child buttons
      if (el) el.childNodes[0].textContent = label;
    }
  });

  socket.on('token-move', ({ id, x, y }) => {
    if (tokens[id]) {
      tokens[id].x = x; tokens[id].y = y;
      const el = document.getElementById('token-' + id);
      if (el) positionToken(el, x, y);
    }
  });

  socket.on('token-remove', ({ id }) => {
    delete tokens[id];
    const el = document.getElementById('token-' + id);
    if (el) el.remove();
  });

  // Clear
  socket.on('clear-board', () => {
    allStrokes.length = 0; allArrows.length = 0;
    Object.keys(liveStrokes).forEach(k => delete liveStrokes[k]);
    redrawStrokes();
    liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  });

  // Server cleared all tokens (fired alongside clear-board)
  socket.on('tokens-cleared', () => {
    Object.keys(tokens).forEach(k => delete tokens[k]);
    tokenLayer.innerHTML = '';
  });

  // Stroke removal — own-lines-only erase from any user
  socket.on('stroke-remove', ({ ids }) => {
    for (let i = allStrokes.length - 1; i >= 0; i--) {
      if (ids.includes(allStrokes[i].id)) allStrokes.splice(i, 1);
    }
    redrawStrokes();
  });

  // Cursors
  socket.on('cursor-move', ({ socketId, username, color, x, y }) => {
    if (socketId === myId) return;
    moveCursor(socketId, username, color, x, y);
  });
  socket.on('cursor-remove', ({ socketId }) => removeCursor(socketId));

  socket.on('disconnect', () => toast('Disconnected. Reconnecting…'));
  // Socket.io v4: reconnect fires on the manager
  socket.io.on('reconnect', () => {
    toast('Reconnected!');
    // Re-announce ourselves so we appear in the user list again
    socket.emit('join', { username: myName });
  });

  // ── Recording / Replay socket events ────────────────────────────
  socket.on('recording-started', () => {
    _recActive = true;
    const recBtn = document.getElementById('record-btn');
    recBtn.textContent = '⏹ Stop Rec';
    recBtn.classList.add('recording');
    document.getElementById('replay-btn').disabled = true;
    toast('🔴 Recording started');
  });

  socket.on('recording-ready', ({ duration, eventCount }) => {
    _recActive = false;
    _replayDuration = duration;
    const recBtn = document.getElementById('record-btn');
    recBtn.textContent = '⏺ Record';
    recBtn.classList.remove('recording');
    document.getElementById('replay-btn').disabled = false;
    const secs = (duration / 1000).toFixed(1);
    toast(`✅ Recording ready — ${secs}s · ${eventCount} events`);
  });

  socket.on('replay-init',    applyBoardSnapshot);
  socket.on('replay-restore', applyBoardSnapshot);

  socket.on('replay-started', ({ duration }) => {
    isReplaying     = true;
    _replayDuration = duration;
    _replayStartMs  = Date.now();
    liveCanvas.style.pointerEvents = 'none';
    document.getElementById('replay-bar').classList.remove('hidden');
    document.getElementById('replay-btn').disabled = true;
    tickReplayBar();
    toast('▶ Replaying for everyone…');
  });

  socket.on('replay-done',    endReplay);
  socket.on('replay-stopped', endReplay);
}

// ── User list ─────────────────────────────────────────────────
function updateUserList(users) {
  userListEl.innerHTML = '';
  users.forEach(u => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="user-dot" style="background:${u.color}"></span>${escHtml(u.username)}${u.id === myId ? ' <em style="font-size:.7rem;color:#888">(you)</em>' : ''}`;
    userListEl.appendChild(li);
  });
}

// ── Toolbar ───────────────────────────────────────────────────
function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-' + tool)?.classList.add('active');
  liveCanvas.style.cursor = tool === 'select' ? 'default'
    : tool === 'erase' ? 'cell'
    : 'crosshair';
}

document.getElementById('tool-draw').addEventListener('click',   () => setTool('draw'));
document.getElementById('tool-arrow').addEventListener('click',  () => setTool('arrow'));
document.getElementById('tool-erase').addEventListener('click',  () => setTool('erase'));
document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
document.getElementById('tool-undo').addEventListener('click',   () => undoLast());

sizePicker.addEventListener('input', () => { sizeVal.textContent = sizePicker.value; });
ownEraseCheck?.addEventListener('change',      () => { ownEraseOnly = ownEraseCheck.checked; updateClearBtnLabels(); });
arrowDashedCheck?.addEventListener('change',   () => { arrowDashed  = arrowDashedCheck.checked; });

function updateClearBtnLabels() {
  const linesBtn = document.getElementById('clear-drawings-btn');
  const allBtn   = document.getElementById('clear-board-btn');
  if (!linesBtn || !allBtn) return;
  // Don't overwrite while armed
  if (linesBtn.dataset.armed !== '1') linesBtn.textContent = ownEraseOnly ? '🗑️ Clear My Lines' : '🗑️ Clear Lines';
  if (allBtn.dataset.armed   !== '1') allBtn.textContent   = ownEraseOnly ? '💥 Clear My Stuff'  : '💥 Clear All';
}

document.getElementById('clear-drawings-btn').addEventListener('click', () => {
  const idleLabel = ownEraseOnly ? '🗑️ Clear My Lines' : '🗑️ Clear Lines';
  armConfirm('clear-drawings-btn', idleLabel, 'Sure? Click again', () => {
    if (ownEraseOnly) {
      // Remove only my own strokes and arrows
      const myStrokeIds = allStrokes.filter(s => s.socketId === myId).map(s => s.id).filter(Boolean);
      const myArrowIds  = allArrows.filter(a => a.socketId === myId).map(a => a.id).filter(Boolean);
      if (myStrokeIds.length) {
        for (let i = allStrokes.length - 1; i >= 0; i--) {
          if (myStrokeIds.includes(allStrokes[i].id)) allStrokes.splice(i, 1);
        }
        socket?.emit('stroke-remove', { ids: myStrokeIds });
      }
      if (myArrowIds.length) {
        for (let i = allArrows.length - 1; i >= 0; i--) {
          if (myArrowIds.includes(allArrows[i].id)) allArrows.splice(i, 1);
        }
        socket?.emit('arrow-remove', { ids: myArrowIds });
      }
      if (myStrokeIds.length || myArrowIds.length) redrawStrokes();
    } else {
      socket?.emit('clear-drawings');
    }
  });
});
document.getElementById('clear-board-btn').addEventListener('click', () => {
  const idleLabel = ownEraseOnly ? '💥 Clear My Stuff' : '💥 Clear All';
  armConfirm('clear-board-btn', idleLabel, '⚠️ Click to confirm', () => {
    if (ownEraseOnly) {
      // Remove only my own strokes, arrows, and tokens
      const myStrokeIds = allStrokes.filter(s => s.socketId === myId).map(s => s.id).filter(Boolean);
      const myArrowIds  = allArrows.filter(a => a.socketId === myId).map(a => a.id).filter(Boolean);
      if (myStrokeIds.length) {
        for (let i = allStrokes.length - 1; i >= 0; i--) {
          if (myStrokeIds.includes(allStrokes[i].id)) allStrokes.splice(i, 1);
        }
        socket?.emit('stroke-remove', { ids: myStrokeIds });
      }
      if (myArrowIds.length) {
        for (let i = allArrows.length - 1; i >= 0; i--) {
          if (myArrowIds.includes(allArrows[i].id)) allArrows.splice(i, 1);
        }
        socket?.emit('arrow-remove', { ids: myArrowIds });
      }
      if (myStrokeIds.length || myArrowIds.length) redrawStrokes();
      // Remove only my own tokens (those I placed, tracked by createdBy)
      Object.values(tokens)
        .filter(t => t.createdBy === myId)
        .forEach(t => socket?.emit('token-remove', { id: t.id }));
    } else {
      socket?.emit('clear-board'); // server now clears tokens too and emits tokens-cleared
    }
  });
});

// Safe two-click confirmation — no native confirm() that can be triggered by stray keypresses
const _armTimers = {};
function armConfirm(btnId, labelIdle, labelArmed, action) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (btn.dataset.armed === '1') {
    // Second click — fire
    btn.dataset.armed = '0';
    clearTimeout(_armTimers[btnId]);
    btn.textContent = labelIdle;
    btn.classList.remove('armed');
    action();
  } else {
    // First click — arm
    btn.dataset.armed = '1';
    btn.textContent = labelArmed;
    btn.classList.add('armed');
    _armTimers[btnId] = setTimeout(() => {
      btn.dataset.armed = '0';
      btn.textContent = labelIdle;
      btn.classList.remove('armed');
    }, 3000);
  }
}

// Keyboard shortcuts
let _windowJustFocused = false;
window.addEventListener('focus', () => { _windowJustFocused = true; setTimeout(() => { _windowJustFocused = false; }, 300); });
window.addEventListener('keydown', e => {
  if (document.activeElement === usernameInput) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    if (_windowJustFocused) return; // ignore stray Ctrl+Z from Ctrl+Tab
    e.preventDefault(); undoLast(); return;
  }
  if (e.key === 'd' || e.key === 'D') setTool('draw');
  if (e.key === 'a' || e.key === 'A') setTool('arrow');
  if (e.key === 'e' || e.key === 'E') setTool('erase');
  if (e.key === 's' || e.key === 'S') setTool('select');
});

// ── Recording / Replay ───────────────────────────────────────
let _recActive      = false;  // true while server-side recording is active
let _replayDuration = 0;      // ms duration of the last recording
let _replayStartMs  = 0;
let _replayRafId    = null;

function drawCompositeFrame(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(pitchCanvas,   0, 0, w, h);
  ctx.drawImage(strokesCanvas, 0, 0, w, h);
  ctx.drawImage(liveCanvas,    0, 0, w, h);
  // Draw tokens manually (they live in the DOM, not a canvas)
  Object.values(tokens).forEach(t => drawTokenFrame(ctx, t, w, h));
}

function drawTokenFrame(ctx, t, w, h) {
  const sx = w / PITCH_W;
  const sy = h / PITCH_H;
  const cx = t.x * sx;
  const cy = t.y * sy;
  const r  = 18 * (w / pitchCanvas.width); // match 36px CSS token radius

  ctx.save();
  if (t.shape === 'ball') {
    ctx.font = `${r * 1.6}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚽', cx, cy);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.font         = `bold ${Math.max(8, r * 0.8)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = (t.color === '#ffffff' || t.color === '#fff') ? '#222' : '#fff';
    ctx.shadowColor  = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur   = 2;
    ctx.fillText(t.label || '', cx, cy);
    ctx.shadowBlur   = 0;
  }
  ctx.restore();
}

function applyBoardSnapshot({ strokes, arrows, tokens: tokenList }) {
  allStrokes.length = 0; allArrows.length = 0;
  strokes.forEach(s => allStrokes.push(s));
  arrows.forEach(a  => allArrows.push(a));
  redrawStrokes();
  tokenLayer.innerHTML = '';
  Object.keys(tokens).forEach(k => delete tokens[k]);
  tokenList.forEach(t => { tokens[t.id] = t; tokenLayer.appendChild(createTokenEl(t)); });
}

function endReplay() {
  isReplaying = false;
  liveCanvas.style.pointerEvents = '';
  cancelAnimationFrame(_replayRafId);
  document.getElementById('replay-bar').classList.add('hidden');
  document.getElementById('replay-progress').style.width = '0%';
  document.getElementById('replay-time').textContent    = '';
  document.getElementById('replay-btn').disabled = false;
  toast('⏹ Replay ended — board restored');
}

function tickReplayBar() {
  if (!isReplaying) return;
  const elapsed = Date.now() - _replayStartMs;
  const pct = _replayDuration > 0 ? Math.min(100, (elapsed / _replayDuration) * 100) : 0;
  document.getElementById('replay-progress').style.width = pct + '%';
  const remaining = Math.max(0, (_replayDuration - elapsed) / 1000);
  document.getElementById('replay-time').textContent = remaining.toFixed(1) + 's';
  _replayRafId = requestAnimationFrame(tickReplayBar);
}

document.getElementById('record-btn').addEventListener('click', () => {
  if (isReplaying) return;
  if (_recActive) {
    socket?.emit('recording-stop');
  } else {
    socket?.emit('recording-start');
  }
});

document.getElementById('replay-btn').addEventListener('click', () => {
  if (isReplaying || _recActive || !socket) return;
  socket.emit('replay-start');
});

document.getElementById('replay-stop-btn').addEventListener('click', () => {
  if (!isReplaying || !socket) return;
  socket.emit('replay-stop');
});

// ── Screenshot ───────────────────────────────────────────────
document.getElementById('screenshot-btn').addEventListener('click', () => {
  const combined = document.createElement('canvas');
  combined.width  = pitchCanvas.width;
  combined.height = pitchCanvas.height;
  const ctx = combined.getContext('2d');
  drawCompositeFrame(ctx, combined.width, combined.height);
  const link = document.createElement('a');
  link.download = 'tac-board.png';
  link.href = combined.toDataURL('image/png');
  link.click();
});
function doJoin() {
  const name = usernameInput.value.trim();
  if (!name) { usernameInput.focus(); return; }
  myName = name;
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  resizeCanvases();
  connectSocket(name);
}

joinBtn.addEventListener('click', doJoin);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

// ── Resize handling ───────────────────────────────────────────
window.addEventListener('resize', () => {
  resizeCanvases();
  repositionAllTokens();
  Object.keys(remoteCursors).forEach(id => removeCursor(id));
});

// ── Utility ───────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(html, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  toastContainer.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, duration);
}
