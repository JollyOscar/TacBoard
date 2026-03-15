/* ═══════════════════════════════════════════════════════════════
   Tac Board — client app.js
   ═══════════════════════════════════════════════════════════════ */

// ── DOM refs ──────────────────────────────────────────────────
const joinScreen   = document.getElementById('join-screen');
const appEl        = document.getElementById('app');
const usernameInput= document.getElementById('username-input');
const roomInput    = document.getElementById('room-input');
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
let myRoom  = 'lobby';

let activeTool   = 'draw'; // draw | arrow | erase | ping | select
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
const laserStrokes = [];

function redrawStrokes() {
  strokesCtx.clearRect(0, 0, strokesCanvas.width, strokesCanvas.height);
  allStrokes.forEach(s => renderStroke(strokesCtx, s));
  allArrows.forEach(a  => renderArrow(strokesCtx, a));
  
  // Render fading laser strokes
  const now = Date.now();
  laserStrokes.forEach(s => {
    const age = now - s.timestamp;
    if (age > 1500) return;
    const opacity = 1 - (age / 1500);
    renderLaser(strokesCtx, s, opacity);
  });
}

function renderLaser(ctx, stroke, opacity) {
  if (!stroke.points || stroke.points.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
  ctx.lineWidth = toPixelSize(stroke.width) * 0.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = stroke.color;
  ctx.shadowBlur = toPixelSize(stroke.width) * 3;
  
  const p0 = toPixel(stroke.points[0].x, stroke.points[0].y);
  ctx.moveTo(p0.x, p0.y);
  stroke.points.forEach(p => {
    const px = toPixel(p.x, p.y);
    ctx.lineTo(px.x, px.y);
  });
  ctx.stroke();
  
  // Outer glow
  ctx.strokeStyle = `rgba(${hexToRgb(stroke.color)}, ${opacity * 0.8})`;
  ctx.lineWidth = toPixelSize(stroke.width) * 2;
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.restore();
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '255, 255, 255';
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
  if (arrow.tool === 'line') {
    drawLineLine(ctx, start.x, start.y, end.x, end.y, arrow.color, toPixelSize(arrow.width), arrow.style);
  } else {
    drawArrowLine(ctx, start.x, start.y, end.x, end.y, arrow.color, toPixelSize(arrow.width), arrow.style);
  }
}

function drawLineLine(ctx, x1, y1, x2, y2, color, width, style) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';

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

// ── Ramer-Douglas-Peucker stroke simplification ───────────────
function simplifyPoints(pts, tol) {
  if (pts.length <= 2) return pts;
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const len2 = dx * dx + dy * dy;
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let d;
    if (len2 === 0) {
      const ex = pts[i].x - first.x, ey = pts[i].y - first.y;
      d = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / len2));
      const px = first.x + t * dx - pts[i].x;
      const py = first.y + t * dy - pts[i].y;
      d = Math.sqrt(px * px + py * py);
    }
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tol) {
    const left  = simplifyPoints(pts.slice(0, maxIdx + 1), tol);
    const right = simplifyPoints(pts.slice(maxIdx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
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

  // Arrow / Line preview
  if (isDrawing && (activeTool === 'arrow' || activeTool === 'line') && arrowStart && currentPath.length) {
    const last = currentPath[currentPath.length - 1];
    const s = toPixel(arrowStart.x, arrowStart.y);
    const e = toPixel(last.x, last.y);
    if (activeTool === 'line') {
      drawLineLine(liveCtx, s.x, s.y, e.x, e.y, colorPicker.value, toPixelSize(+sizePicker.value), arrowDashed ? 'dashed' : 'solid');
    } else {
      drawArrowLine(liveCtx, s.x, s.y, e.x, e.y, colorPicker.value, toPixelSize(+sizePicker.value), arrowDashed ? 'dashed' : 'solid');
    }
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
  const pos = toLogical(e.clientX, e.clientY);

  if (activeTool === 'ping') {
    // Render local ping immediately and emit
    renderPing(pos.x, pos.y, colorPicker.value);
    socket?.emit('board-ping', { x: pos.x, y: pos.y, color: colorPicker.value });
    return; // Don't start drawing
  }

  isDrawing = true;
  liveCanvas.setPointerCapture(e.pointerId); // capture so pointerup fires even outside canvas
  currentPath = [pos];
  if (activeTool === 'arrow' || activeTool === 'line') arrowStart = pos;

  socket?.emit('draw-move', {
    tool: activeTool,
    width: +sizePicker.value,
    points: currentPath
  });
});

let _lastDrawEmit = 0;
liveCanvas.addEventListener('pointermove', e => {
  const pos = toLogical(e.clientX, e.clientY);
  lastMousePos = pos;

  // Emit cursor (throttled to 10fps / 100ms for massive bandwidth savings)
  const now = Date.now();
  if (now - _lastCursorEmit > 100) {
    socket?.emit('cursor-move', pos);
    _lastCursorEmit = now;
  }

  if (!isDrawing) { if (activeTool === 'erase') redrawLive(); return; }

  currentPath.push(pos);

  // Batching: only transmit drawing state every 50ms (20fps). 
  // It completely solves network congestion on fast hardware without losing any structural data on the server.
  if (now - _lastDrawEmit > 50) {
    socket?.emit('draw-move', {
      tool: activeTool,
      width: +sizePicker.value,
      points: currentPath
    });
    _lastDrawEmit = now;
  }
  redrawLive();
});

liveCanvas.addEventListener('pointerup', e => {
  if (!isDrawing) return;
  isDrawing = false;

  if ((activeTool === 'draw' || activeTool === 'laser') && currentPath.length >= 2) {
    const isLaser = activeTool === 'laser';
    const stroke = {
      id: `${myId}-${++strokeSeq}`,
      socketId: myId,
      tool: activeTool,
      points: simplifyPoints([...currentPath], 1.5),
      color: colorPicker.value,
      width: +sizePicker.value,
      timestamp: Date.now()
    };

    if (isLaser) {
      laserStrokes.push(stroke);
      setTimeout(() => {
        const idx = laserStrokes.findIndex(s => s.id === stroke.id);
        if (idx !== -1) {
          laserStrokes.splice(idx, 1);
          redrawStrokes();
        }
      }, 1500); // laser fades after 1.5s
    } else {
      allStrokes.push(stroke);
      myUndoStack.push({ type: 'stroke', id: stroke.id });
    }
    
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

  if ((activeTool === 'arrow' || activeTool === 'line') && arrowStart && currentPath.length >= 2) {
    const last = currentPath[currentPath.length - 1];
    const tempId = `${myId}-a${++arrowSeq}`;
    const shape = {
      id: tempId,
      socketId: myId,
      tool: activeTool,
      x1: arrowStart.x, y1: arrowStart.y,
      x2: last.x,       y2: last.y,
      color: colorPicker.value,
      width: +sizePicker.value,
      style: arrowDashed ? 'dashed' : 'solid'
    };
    allArrows.push(shape);
    myUndoStack.push({ type: 'arrow', id: tempId, _pending: true }); // using 'arrow' type for both straight lines and arrows
    socket?.emit('arrow-done', shape);
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
const ICONS = {
  ball: `<svg viewBox="0 0 24 24" fill="white" stroke="#222" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polygon points="12,6 16,9 14.5,14 9.5,14 8,9" fill="#222"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="16" y1="9" x2="20.5" y2="6.5"/><line x1="14.5" y1="14" x2="18" y2="20"/><line x1="9.5" y1="14" x2="6" y2="20"/><line x1="8" y1="9" x2="3.5" y2="6.5"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22v-7" stroke="#222"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1v12z" fill="#e74c3c" stroke="#c0392b"/></svg>`,
  cone: `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 18H4z" fill="#e67e22" stroke="#d35400"/><path d="M9.5 8h5 M8 13h8" stroke="white" stroke-width="3"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="#f1c40f" stroke="#f39c12" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#3498db"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#fff"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" fill="#e74c3c"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="#e67e22" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v3a5 5 0 01-10 0V4z" fill="#f1c40f"/><path d="M7 4H4a2 2 0 00-2 2v1a5 5 0 005 5h0M17 4h3a2 2 0 01-5 5h0"/></svg>`
};
const iconImages = {};
Object.entries(ICONS).forEach(([name, svgTxt]) => {
  const img = new Image();
  const blob = new Blob([svgTxt], { type: 'image/svg+xml' });
  img.src = URL.createObjectURL(blob);
  iconImages[name] = img;
});

// ── Tokens ────────────────────────────────────────────────────

function createTokenEl(token) {
  const el = document.createElement('div');
  el.id = 'token-' + token.id;
  if (token.shape === 'icon' || token.shape === 'ball') {
    el.className = 'token token-icon';
    const iconName = token.shape === 'ball' ? 'ball' : token.label;
    el.innerHTML = ICONS[iconName] || ICONS.ball;
    el.style.background = 'transparent';
    el.style.border = 'none';
    el.style.boxShadow = 'none';
  } else if (token.shape === 'emoji') {
    el.className = 'token token-emoji';
    el.textContent = token.label; // The emoji character
    el.style.background = 'transparent';
    el.style.border = 'none';
    el.style.boxShadow = 'none';
  } else {
    el.className = 'token';
    el.textContent = token.label || '1';
    el.style.background = token.color;
    if (token.color === '#ffffff' || token.color === '#fff') el.style.color = '#222';
  }
  el.classList.add('pop-in');

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

  // Double-click to rename (not for icons or balls)
  if (token.shape !== 'ball' && token.shape !== 'icon') {
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
    const isIcon = btn.classList.contains('token-icon-btn');
    const isEmoji = btn.classList.contains('token-emoji-btn');
    const color = btn.dataset.color || '#ffffff';
    let shape = btn.dataset.shape || 'circle';
    
    let label = '';
    if (isIcon) {
      shape = 'icon';
      label = btn.dataset.icon;
    } else if (isEmoji) {
      shape = 'emoji';
      label = btn.dataset.emoji;
    } else if (shape === 'ball') {
      label = '⚽';
    } else {
      tokenCounters[color] = (tokenCounters[color] || 0) + 1;
      label = String(tokenCounters[color]);
    }

    // Place near center
    socket?.emit('token-add', {
      x: PITCH_W / 2 + (Math.random() - .5) * 100,
      y: PITCH_H / 2 + (Math.random() - .5) * 80,
      color: (isIcon || isEmoji) ? 'transparent' : color,
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
  // Disconnect existing socket if any (prevents duplicate connections)
  if (socket && socket.connected) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  
  socket = io({
    reconnection: true,              // Enable automatic reconnection
    reconnectionAttempts: Infinity,   // Keep trying to reconnect
    reconnectionDelay: 1000,          // Wait 1s before first reconnect attempt
    reconnectionDelayMax: 5000,       // Max 5s between reconnect attempts
    timeout: 20000,                   // Connection timeout
    transports: ['websocket', 'polling']  // Try websocket first
  });

  socket.on('connect', () => {
    myId = socket.id;
    // Flush stale live previews from previous session so nothing lingers on reconnect
    Object.keys(liveStrokes).forEach(k => delete liveStrokes[k]);
    redrawLive();
    document.getElementById('conn-status')?.classList.remove('disconnected');
    socket.emit('join', { username, room: myRoom });
  });

  socket.on('init-state', ({ strokes, tokens: tokenList, arrows, users, you, room, recActive, repActive, repDuration, repPosition, repPaused }) => {
    myColor = you.color;
    colorPicker.value = myColor;

    // Update room badge
    if (room) {
      myRoom = room;
      const badge = document.getElementById('room-badge');
      if (badge) badge.textContent = '🏠 ' + room;
    }

    _recActive = !!recActive;
    if (_recActive) {
      const recBtn = document.getElementById('record-btn');
      recBtn.textContent = '⏹ Stop Rec';
      recBtn.classList.add('recording');
      updateReplayButton();
    } else {
      const recBtn = document.getElementById('record-btn');
      recBtn.textContent = '⏺ Record';
      recBtn.classList.remove('recording');
      updateReplayButton();
    }

    if (repActive) {
      isReplaying = true;
      isReplayPaused = !!repPaused;
      _replayDuration = repDuration;
      _replayPlaybackPosition = repPosition;
      _replayLastTick = Date.now();
      liveCanvas.style.pointerEvents = 'none';
      document.getElementById('replay-bar').classList.remove('hidden');
      document.getElementById('replay-playpause-btn').textContent = isReplayPaused ? '▶' : '⏸';
      updateReplayButton();
      tickReplayBar();
    } else {
      endReplay(); // Clean up just in case
    }

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
    // Request recordings list and presets when joining
    socket.emit('get-recordings');
    socket.emit('get-presets');
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

  // Ping from others
  socket.on('board-ping', ({ x, y, color }) => {
    renderPing(x, y, color);
  });

  // Finished stroke from others
  socket.on('stroke-done', (stroke) => {
    if (stroke.tool === 'laser') {
      stroke.timestamp = Date.now();
      laserStrokes.push(stroke);
      setTimeout(() => {
        const idx = laserStrokes.findIndex(s => s.id === stroke.id);
        if (idx !== -1) {
          laserStrokes.splice(idx, 1);
          redrawStrokes();
        }
      }, 1500);
    } else {
      allStrokes.push(stroke);
    }
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
    // Reset token counters so labels stay in sync across all clients
    Object.keys(tokenCounters).forEach(k => delete tokenCounters[k]);
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

  socket.on('disconnect', () => {
    document.getElementById('conn-status')?.classList.add('disconnected');
    toast('Disconnected. Reconnecting…');
  });
  
  // Socket.io v4: reconnect fires on the manager
  // NOTE: do NOT re-emit 'join' here — the 'connect' event already does it
  socket.io.on('reconnect', () => {
    toast('Reconnected!');
  });

  // ── Recording / Replay socket events ────────────────────────────
  socket.on('recording-started', () => {
    _recActive = true;
    const recBtn = document.getElementById('record-btn');
    recBtn.textContent = '⏹ Stop Rec';
    recBtn.classList.add('recording');
    updateReplayButton();
    toast('🔴 Recording started');
  });

  socket.on('recording-saved', (recordings) => {
    _recActive = false;
    _recordings = recordings;
    const recBtn = document.getElementById('record-btn');
    recBtn.textContent = '⏺ Record';
    recBtn.classList.remove('recording');
    // Auto-select the newest recording
    if (recordings.length) _selectedRecId = recordings[recordings.length - 1].id;
    renderRecordingsList();
    updateReplayButton();
    const last = recordings[recordings.length - 1];
    const secs = (last.duration / 1000).toFixed(1);
    toast(`✅ Recording saved — ${secs}s · ${last.eventCount} events`);
  });

  socket.on('recordings-list', (recordings) => {
    _recordings = recordings;
    renderRecordingsList();
    updateReplayButton();
  });

  socket.on('replay-init',    applyBoardSnapshot);
  socket.on('replay-restore', applyBoardSnapshot);

  socket.on('replay-started', ({ duration }) => {
    isReplaying     = true;
    isReplayPaused  = false;
    _replayDuration = duration;
    _replayPlaybackPosition = 0;
    _replayLastTick = Date.now();
    liveCanvas.style.pointerEvents = 'none';
    document.getElementById('replay-bar').classList.remove('hidden');
    document.getElementById('replay-slider').value = 0;
    document.getElementById('replay-playpause-btn').textContent = '⏸';
    updateReplayButton();
    tickReplayBar();
    toast('▶ Replaying for everyone…');
  });

  socket.on('replay-done',    endReplay);
  socket.on('replay-stopped', endReplay);

  socket.on('replay-paused', () => {
    isReplayPaused = true;
    document.getElementById('replay-playpause-btn').textContent = '▶';
  });

  socket.on('replay-resumed', () => {
    isReplayPaused = false;
    _replayLastTick = Date.now();
    document.getElementById('replay-playpause-btn').textContent = '⏸';
  });

  socket.on('replay-sync-state', ({ position, strokes, arrows, tokens: tokenList }) => {
    _replayPlaybackPosition = position;
    if (!isReplayPaused) _replayLastTick = Date.now();
    
    allStrokes.length = 0; allArrows.length = 0;
    strokes.forEach(s => allStrokes.push(s));
    arrows.forEach(a  => allArrows.push(a));
    redrawStrokes();
    tokenLayer.innerHTML = '';
    Object.keys(tokens).forEach(k => delete tokens[k]);
    tokenList.forEach(t => { tokens[t.id] = t; tokenLayer.appendChild(createTokenEl(t)); });
  });

  // ── Board Presets socket events ───────────────────────────────────────
  socket.on('presets-list', (presets) => {
    _boardPresets = presets;
    renderPresetsList();
  });

  socket.on('preset-saved', ({ id, name }) => {
    toast(`💾 Preset saved: ${name}`);
  });

  socket.on('preset-loaded', applyBoardSnapshot);
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
    : tool === 'ping' ? 'crosshair'
    : 'crosshair';
}

document.getElementById('tool-draw').addEventListener('click',   () => setTool('draw'));
document.getElementById('tool-line').addEventListener('click',   () => setTool('line'));
document.getElementById('tool-arrow').addEventListener('click',  () => setTool('arrow'));
document.getElementById('tool-laser').addEventListener('click',  () => setTool('laser'));
document.getElementById('tool-erase').addEventListener('click',  () => setTool('erase'));
document.getElementById('tool-ping').addEventListener('click',   () => setTool('ping'));
document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
document.getElementById('tool-undo').addEventListener('click',   () => undoLast());

sizePicker.addEventListener('input', () => { sizeVal.textContent = sizePicker.value; });
ownEraseCheck?.addEventListener('change',      () => { ownEraseOnly = ownEraseCheck.checked; updateClearBtnLabels(); });
arrowDashedCheck?.addEventListener('change',   () => { arrowDashed  = arrowDashedCheck.checked; });

// ── Color Presets ─────────────────────────────────────────────
const recentColors = new Set();
const MAX_RECENT_COLORS = 6;

function addRecentColor(color) {
  if (color === '#ffffff' || color === '#fff') return; // skip white
  const normalized = color.toLowerCase();
  // Skip if it's already in default presets
  if (['#e74c3c', '#3498db', '#f39c12'].includes(normalized)) return;
  
  recentColors.delete(normalized);
  recentColors.add(normalized);
  
  // Keep only last N colors
  const arr = Array.from(recentColors);
  if (arr.length > MAX_RECENT_COLORS) {
    recentColors.delete(arr[0]);
  }
  
  renderRecentColors();
}

function renderRecentColors() {
  const container = document.getElementById('recent-colors');
  container.innerHTML = '';
  Array.from(recentColors).forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'color-preset';
    btn.style.background = color;
    btn.dataset.color = color;
    btn.title = color;
    container.appendChild(btn);
  });
  // Re-attach event listeners
  container.querySelectorAll('.color-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      colorPicker.value = btn.dataset.color;
    });
  });
}

// Color preset click handlers
document.querySelectorAll('#color-presets .color-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    colorPicker.value = btn.dataset.color;
  });
});

// Track color changes to add to recent
colorPicker.addEventListener('change', () => {
  addRecentColor(colorPicker.value);
});

// ── Board Presets ─────────────────────────────────────────────────
function renderPresetsList() {
  const list = document.getElementById('presets-list');
  if (!_boardPresets.length) {
    list.innerHTML = '<li class="no-presets">No presets saved</li>';
    return;
  }
  list.innerHTML = '';
  _boardPresets.forEach(preset => {
    const li = document.createElement('li');
    li.className = 'preset-item';
    const time = new Date(preset.timestamp).toLocaleString();
    const parts = [];
    if (preset.strokeCount) parts.push(`${preset.strokeCount} stroke${preset.strokeCount !== 1 ? 's' : ''}`);
    if (preset.arrowCount) parts.push(`${preset.arrowCount} arrow${preset.arrowCount !== 1 ? 's' : ''}`);
    if (preset.tokenCount) parts.push(`${preset.tokenCount} token${preset.tokenCount !== 1 ? 's' : ''}`);
    const summary = parts.length ? parts.join(', ') : 'empty';
    li.innerHTML = `
      <div class="preset-info" data-id="${preset.id}">
        <div class="preset-name">${escHtml(preset.name)}</div>
        <div class="preset-time">${time} · ${summary}</div>
      </div>
      <div class="preset-actions">
        <button class="preset-load" data-id="${preset.id}" title="Load — click twice to confirm">↩</button>
        <button class="preset-edit" data-id="${preset.id}" title="Rename">✏️</button>
        <button class="preset-delete" data-id="${preset.id}" title="Delete">×</button>
      </div>
    `;
    list.appendChild(li);
  });

  // Load handlers — two-click confirmation (no blocking confirm())
  list.querySelectorAll('.preset-load').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.closest('.preset-item');
      if (li.dataset.armed === '1') {
        li.dataset.armed = '0';
        btn.textContent = '↩';
        btn.style.background = '';
        socket?.emit('load-preset', { presetId: +btn.dataset.id });
        closeModal(presetsModal);
      } else {
        li.dataset.armed = '1';
        btn.textContent = '✓';
        btn.style.background = 'var(--accent)';
        setTimeout(() => {
          if (li.dataset.armed === '1') {
            li.dataset.armed = '0';
            btn.textContent = '↩';
            btn.style.background = '';
          }
        }, 2500);
      }
    });
  });

  // Edit handlers — inline rename
  list.querySelectorAll('.preset-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const preset = _boardPresets.find(p => p.id === +btn.dataset.id);
      if (!preset) return;
      const li = btn.closest('.preset-item');
      const nameEl = li.querySelector('.preset-name');
      if (nameEl.querySelector('input')) return; // already editing
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'inline-rename-input';
      input.value = preset.name;
      input.maxLength = 60;
      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus(); input.select();
      let cancelled = false;
      const commit = () => {
        if (cancelled) return;
        const newName = input.value.trim();
        if (newName && newName !== preset.name) {
          socket?.emit('rename-preset', { presetId: preset.id, newName });
        }
        nameEl.textContent = newName || preset.name;
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { cancelled = true; nameEl.textContent = preset.name; input.remove(); }
      });
    });
  });

  // Delete handlers
  list.querySelectorAll('.preset-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Delete this preset?')) {
        socket?.emit('delete-preset', { presetId: +btn.dataset.id });
      }
    });
  });
}

document.getElementById('save-preset-btn').addEventListener('click', () => {
  const name = prompt('Name this preset:', `Board ${new Date().toLocaleTimeString()}`);
  if (name && name.trim()) {
    socket?.emit('save-preset', { name: name.trim() });
  }
});

// ── Export / Import ─────────────────────────────────────────────────
document.getElementById('export-board-btn').addEventListener('click', () => {
  const data = {
    strokes: allStrokes,
    arrows: allArrows,
    tokens: Object.values(tokens)
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `tacboard-export-${new Date().toISOString().slice(0,10)}.tacboard`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  toast('⬇️ Board exported');
  closeModal(document.getElementById('presets-modal'));
});

const importFileInput = document.getElementById('import-file');
document.getElementById('import-board-btn').addEventListener('click', () => {
  importFileInput.click();
});

importFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.strokes) || !Array.isArray(data.arrows) || !Array.isArray(data.tokens)) {
        throw new Error('Invalid file format');
      }
      
      socket?.emit('import-board', {
        strokes: data.strokes,
        arrows: data.arrows,
        tokens: data.tokens
      });
      
      toast('⬆️ Board imported successfully');
      closeModal(document.getElementById('presets-modal'));
    } catch (err) {
      toast('❌ Error loading file: Invalid format');
      console.error(err);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // Reset input
});

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
  if (e.key === 'p' || e.key === 'P') setTool('ping');
  if (e.key === 's' || e.key === 'S') setTool('select');
  if (e.key === 'l' || e.key === 'L') setTool('line');
  if (e.key === 'w' || e.key === 'W') setTool('laser');
  
  if (e.key >= '1' && e.key <= '8') {
    const presets = Array.from(document.querySelectorAll('.color-preset'));
    const index = parseInt(e.key) - 1;
    if (presets[index]) {
      presets[index].click();
      toast(`Color changed: <span style="color:${presets[index].dataset.color}">■</span>`, 1000);
    }
  }
});

// ── Ping Renderer ───────────────────────────────────────────
function renderPing(lx, ly, color) {
  const el = document.createElement('div');
  el.className = 'ping-blip';
  el.style.borderColor = color;
  
  const rect = canvasStack.getBoundingClientRect();
  const scaleX = rect.width / PITCH_W;
  const scaleY = rect.height / PITCH_H;
  
  el.style.left = (lx * scaleX) + 'px';
  el.style.top = (ly * scaleY) + 'px';
  
  cursorLayer.appendChild(el);
  
  // Clean up after animation
  setTimeout(() => el.remove(), 850);
}

// ── Recording / Replay ───────────────────────────────────────
let _recActive      = false;  // true while server-side recording is active
let _replayDuration = 0;      // ms duration of the last recording
let _replayLastTick = 0;
let _replayPlaybackPosition = 0;
let _replayRafId    = null;
let isReplayPaused  = false;
let isSeeking       = false;
let _selectedRecId  = null;

// Video recording (MP4 capture during replay)
let _videoRecorder     = null;
let _videoChunks       = [];
let _capturedVideoBlob = null;
let _capturingForRecId = null;
let _isCapturingVideo  = false;
let _captureCanvas     = null;
let _captureStream     = null;

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
  if (t.shape === 'icon' || t.shape === 'ball') {
    const iconName = t.shape === 'ball' ? 'ball' : t.label;
    const img = iconImages[iconName];
    if (img) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 2;
      ctx.drawImage(img, cx - r, cy - r, r*2, r*2);
    }
  } else if (t.shape === 'emoji') {
    ctx.font = `${r * 1.6}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.label, cx, cy);
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
  document.getElementById('replay-slider').value = 0;
  document.getElementById('replay-time').textContent    = '';
  updateReplayButton();
  toast('⏹ Replay ended — board restored');
  
  // Stop video recording if active
  stopVideoCapture();
}

// ── Video Capture (MP4 Recording) ────────────────────────────────────────
function startVideoCapture(recId) {
  try {
    // Create an offscreen canvas to composite all layers
    if (!_captureCanvas) {
      _captureCanvas = document.createElement('canvas');
      _captureCanvas.width = liveCanvas.width;
      _captureCanvas.height = liveCanvas.height;
    }
    
    // Capture at 30fps - draw composite on each frame
    _captureStream = _captureCanvas.captureStream(30);
    
    _videoRecorder = new MediaRecorder(_captureStream, {
      mimeType: 'video/webm',
      videoBitsPerSecond: 2500000
    });
    
    _videoChunks = [];
    _capturingForRecId = recId;
    _isCapturingVideo = true;
    
    _videoRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        _videoChunks.push(event.data);
      }
    };
    
    _videoRecorder.onstop = () => {
      _capturedVideoBlob = new Blob(_videoChunks, { type: 'video/webm' });
      _videoChunks = [];
      _isCapturingVideo = false;
    };
    
    _videoRecorder.start();
    
    // Start animation loop to draw composite frames
    captureFrame();
    
    console.log(`[+] Video capture started for recording ${recId}`);
  } catch (err) {
    console.error('[!] Video capture failed:', err);
    toast('⚠️ Video capture not supported in this browser');
    _isCapturingVideo = false;
  }
}

function captureFrame() {
  if (!_isCapturingVideo || !_captureCanvas) return;
  
  const ctx = _captureCanvas.getContext('2d');
  const w = _captureCanvas.width;
  const h = _captureCanvas.height;
  
  // Draw all canvas layers onto the capture canvas
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(pitchCanvas, 0, 0, w, h);
  ctx.drawImage(strokesCanvas, 0, 0, w, h);
  ctx.drawImage(liveCanvas, 0, 0, w, h);
  
  // Draw tokens (they're DOM elements, need to draw them manually)
  Object.values(tokens).forEach(token => {
    const el = document.getElementById('token-' + token.id);
    if (!el) return;
    
    const logicalX = token.x;
    const logicalY = token.y;
    const x = (logicalX / PITCH_W) * w;
    const y = (logicalY / PITCH_H) * h;
    const radius = 18;
    
    // Draw token circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = token.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw token label
    ctx.fillStyle = token.color === '#ffffff' ? '#333' : '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(token.label, x, y);
    ctx.restore();
  });
  
  // Continue capturing
  requestAnimationFrame(captureFrame);
}

function stopVideoCapture() {
  _isCapturingVideo = false;
  if (_videoRecorder && _videoRecorder.state !== 'inactive') {
    _videoRecorder.stop();
    console.log('[+] Video capture stopped');
  }
  if (_captureStream) {
    _captureStream.getTracks().forEach(track => track.stop());
    _captureStream = null;
  }
}

function downloadRecordingAsMP4(recId) {
  // Check if we already have a captured video for this recording
  if (_capturedVideoBlob && _capturingForRecId === recId) {
    // Already captured, download immediately
    downloadVideoBlob(recId);
    return;
  }
  
  // Need to replay and capture
  if (_recActive || isReplaying) {
    toast('⚠️ Wait for current recording or replay to finish');
    return;
  }
  
  toast('📽️ Starting replay to capture video...');
  
  // Reset any previous capture
  _capturedVideoBlob = null;
  _capturingForRecId = recId;
  _selectedRecId = recId;
  updateReplayButton();
  
  // Start capture when replay begins
  socket.once('replay-started', (data) => {
    startVideoCapture(recId);
  });
  
  // Download when replay ends
  socket.once('replay-done', () => {
    setTimeout(() => {
      stopVideoCapture();
      // Give recorder time to finalize
      setTimeout(() => {
        downloadVideoBlob(recId);
      }, 300);
    }, 200);
  });
  
  socket.once('replay-stopped', () => {
    setTimeout(() => {
      stopVideoCapture();
      setTimeout(() => {
        downloadVideoBlob(recId);
      }, 300);
    }, 200);
  });
  
  // Trigger the replay
  socket.emit('replay-start', { recId });
}

function downloadVideoBlob(recId) {
  if (!_capturedVideoBlob) {
    toast('❌ No video captured for this recording');
    return;
  }
  
  const url = URL.createObjectURL(_capturedVideoBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tac-board-recording-${recId}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  toast('✅ Video downloaded');
  _capturedVideoBlob = null;
  _capturingForRecId = null;
}

function updateReplayButton() {
  const btn = document.getElementById('replay-btn');
  btn.disabled = !_selectedRecId || isReplaying || _recActive;
}

function renderRecordingsList() {
  try {
    const list = document.getElementById('recordings-list');
    if (!_recordings || !_recordings.length) {
      list.innerHTML = '<li class="no-recordings">No recordings yet</li>';
      _selectedRecId = null;
      updateReplayButton();
      return;
    }
    list.innerHTML = '';
    _recordings.forEach(rec => {
      const li = document.createElement('li');
      li.className = 'recording-item' + (rec.id === _selectedRecId ? ' selected' : '');
      const time = new Date(rec.timestamp).toLocaleTimeString();
      const dur = (rec.duration / 1000).toFixed(1);
      li.innerHTML = `
        <div class="rec-info" data-id="${rec.id}">
          <div class="rec-time">${escHtml(rec.name)}</div>
          <div class="rec-meta">${time} · ${dur}s · ${rec.eventCount} events</div>
        </div>
        <div class="rec-actions">
          <button class="rec-play" data-id="${rec.id}" title="Play recording">▶</button>
          <button class="rec-rename" data-id="${rec.id}" title="Rename">✏️</button>
          <button class="rec-download" data-id="${rec.id}" title="Download as MP4">📽️</button>
          <button class="rec-delete" data-id="${rec.id}" title="Delete">×</button>
        </div>
      `;
      list.appendChild(li);
    });

    // Select handlers
    list.querySelectorAll('.rec-info').forEach(el => {
      el.addEventListener('click', () => {
        _selectedRecId = +el.dataset.id;
        renderRecordingsList();
        updateReplayButton();
      });
    });

    // Play handlers
    list.querySelectorAll('.rec-play').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const recId = +btn.dataset.id;
        if (isReplaying || _recActive || !socket) return;
        socket.emit('replay-start', { recId });
        closeModal(document.getElementById('recordings-modal'));
      });
    });

    // Rename handlers — inline rename
    list.querySelectorAll('.rec-rename').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const recording = _recordings.find(r => r.id === +btn.dataset.id);
        if (!recording) return;
        const li = btn.closest('.recording-item');
        const nameEl = li.querySelector('.rec-time');
        if (nameEl.querySelector('input')) return; // already editing
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-rename-input';
        input.value = recording.name;
        input.maxLength = 80;
        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus(); input.select();
        let cancelled = false;
        const commit = () => {
          if (cancelled) return;
          const newName = input.value.trim();
          if (newName && newName !== recording.name) {
            socket?.emit('rename-recording', { recId: recording.id, newName });
          }
          nameEl.textContent = newName || recording.name;
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { cancelled = true; nameEl.textContent = recording.name; input.remove(); }
        });
      });
    });

    // Delete handlers
    list.querySelectorAll('.rec-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        socket?.emit('delete-recording', { recId: +btn.dataset.id });
      });
    });
    
    // Download handlers
    list.querySelectorAll('.rec-download').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const recId = +btn.dataset.id;
        downloadRecordingAsMP4(recId);
      });
    });
  } catch (e) {
    toast(`[ERROR] renderRecordingsList: ${e.message}`);
    console.error(e);
  }
}

function tickReplayBar() {
  if (!isReplaying) return;
  
  if (!isReplayPaused && !isSeeking) {
    const now = Date.now();
    _replayPlaybackPosition += (now - _replayLastTick);
    _replayLastTick = now;
  }
  
  if (!isSeeking && _replayDuration > 0) {
    const pct = Math.min(100, (_replayPlaybackPosition / _replayDuration) * 100);
    document.getElementById('replay-slider').value = pct;
  }
  
  const remaining = Math.max(0, (_replayDuration - _replayPlaybackPosition) / 1000);
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
  if (isReplaying || _recActive || !_selectedRecId || !socket) return;
  socket.emit('replay-start', { recId: _selectedRecId });
});

document.getElementById('replay-stop-btn').addEventListener('click', () => {
  if (!isReplaying || !socket) return;
  socket.emit('replay-stop');
});

document.getElementById('replay-playpause-btn').addEventListener('click', () => {
  if (!isReplaying || !socket) return;
  if (isReplayPaused) {
    socket.emit('replay-resume');
  } else {
    socket.emit('replay-pause');
  }
});

const replaySlider = document.getElementById('replay-slider');
replaySlider.addEventListener('pointerdown', () => {
  if (!isReplaying || !socket) return;
  isSeeking = true;
});
replaySlider.addEventListener('input', () => {
  if (!isReplaying) return;
  const pos = (parseFloat(replaySlider.value) / 100) * _replayDuration;
  _replayPlaybackPosition = pos;
  const remaining = Math.max(0, (_replayDuration - _replayPlaybackPosition) / 1000);
  document.getElementById('replay-time').textContent = remaining.toFixed(1) + 's';
});
replaySlider.addEventListener('change', () => {
  if (!isReplaying || !socket) return;
  isSeeking = false;
  const pos = (parseFloat(replaySlider.value) / 100) * _replayDuration;
  socket.emit('replay-seek', { position: pos });
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
// Pre-fill username from previous session
const _savedUsername = localStorage.getItem('tac-board-username');
if (_savedUsername) usernameInput.value = _savedUsername;

// Pre-fill room from URL hash or localStorage
const _hashRoom = location.hash.replace('#', '').trim();
const _savedRoom = localStorage.getItem('tac-board-room');
if (_hashRoom) {
  roomInput.value = _hashRoom;
} else if (_savedRoom) {
  roomInput.value = _savedRoom;
}

// ── Active Room Picker ────────────────────────────────────────
async function fetchActiveRooms() {
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    const container = document.getElementById('active-rooms');
    const list = document.getElementById('active-rooms-list');
    if (!rooms.length) {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    list.innerHTML = '';
    rooms.forEach(r => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'room-chip';
      if (roomInput.value === r.id) chip.classList.add('selected');
      chip.innerHTML = `${r.id} <span class="room-chip-count">${r.users} online</span>`;
      chip.addEventListener('click', () => {
        roomInput.value = r.id;
        list.querySelectorAll('.room-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
      });
      list.appendChild(chip);
    });
  } catch { /* silently ignore — room list is optional UX */ }
}

fetchActiveRooms();
// Refresh room list every 10 seconds while on join screen
const _roomRefresh = setInterval(() => {
  if (!joinScreen.classList.contains('hidden')) fetchActiveRooms();
  else clearInterval(_roomRefresh);
}, 10000);

function doJoin() {
  const name = usernameInput.value.trim();
  if (!name) { usernameInput.focus(); return; }
  myName = name;
  myRoom = (roomInput.value.trim() || 'lobby').replace(/[^a-zA-Z0-9_-]/g, '-');
  localStorage.setItem('tac-board-username', name);
  localStorage.setItem('tac-board-room', myRoom);
  location.hash = myRoom;
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  resizeCanvases();
  connectSocket(name);
}

joinBtn.addEventListener('click', doJoin);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { roomInput.focus(); e.preventDefault(); } });
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

// ── Mobile toolbar toggle ───────────────────────────────────────
const mobileToggle = document.getElementById('mobile-toolbar-toggle');
const toolbar = document.getElementById('toolbar');

mobileToggle?.addEventListener('click', () => {
  toolbar.classList.toggle('mobile-open');
  mobileToggle.textContent = toolbar.classList.contains('mobile-open') ? '✕' : '☰';
});

// ── Modal / Popup handling ────────────────────────────────────
const recordingsModal = document.getElementById('recordings-modal');
const presetsModal = document.getElementById('presets-modal');
const openRecordingsBtn = document.getElementById('open-recordings-btn');
const openPresetsBtn = document.getElementById('open-presets-btn');
const closeRecordingsBtn = document.getElementById('close-recordings-modal');
const closePresetsBtn = document.getElementById('close-presets-modal');

function openModal(modal) {
  modal.classList.remove('hidden');
}

function closeModal(modal) {
  modal.classList.add('hidden');
}

openRecordingsBtn.addEventListener('click', () => openModal(recordingsModal));
openPresetsBtn.addEventListener('click', () => openModal(presetsModal));
closeRecordingsBtn.addEventListener('click', () => closeModal(recordingsModal));
closePresetsBtn.addEventListener('click', () => closeModal(presetsModal));

// Close modals when clicking outside the content
recordingsModal.addEventListener('click', (e) => {
  if (e.target === recordingsModal) closeModal(recordingsModal);
});
presetsModal.addEventListener('click', (e) => {
  if (e.target === presetsModal) closeModal(presetsModal);
});

// Close modals with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!recordingsModal.classList.contains('hidden')) closeModal(recordingsModal);
    if (!presetsModal.classList.contains('hidden')) closeModal(presetsModal);
  }
});

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
