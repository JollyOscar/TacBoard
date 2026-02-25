const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Shared state ──────────────────────────────────────────────
const state = {
  users: {},          // socketId → { username, color }
  strokes: [],        // finished strokes  [{ points, color, width, tool }]
  tokens: {},         // tokenId → { id, x, y, color, label, shape }
  arrows: []          // finished arrows [{ x1,y1,x2,y2,color,style }]
};

let nextTokenId = 1;
let nextArrowId  = 1;

// ── Recording / Replay ───────────────────────────────────────
let rec = { active: false, start: 0, snapshot: null, timeline: [] };
let rep = { active: false, timers: [], preSnap: null, currentRecId: null };
const recordings = [];  // Array of saved recordings: { id, name, timestamp, duration, eventCount, snapshot, timeline }
let nextRecId = 1;

// ── Board Presets ─────────────────────────────────────────────
const PRESETS_FILE = path.join(__dirname, 'board-presets.json');
let boardPresets = [];  // Array of saved board states: { id, name, timestamp, strokes, arrows, tokens }
let nextPresetId = 1;

// Load presets from file
function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const data = fs.readFileSync(PRESETS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      boardPresets = parsed.presets || [];
      nextPresetId = parsed.nextId || 1;
      console.log(`[+] Loaded ${boardPresets.length} board presets from file`);
    }
  } catch (err) {
    console.error('[!] Error loading presets:', err.message);
  }
}

// Save presets to file
function savePresets() {
  try {
    const data = JSON.stringify({
      presets: boardPresets,
      nextId: nextPresetId
    }, null, 2);
    fs.writeFileSync(PRESETS_FILE, data, 'utf8');
  } catch (err) {
    console.error('[!] Error saving presets:', err.message);
  }
}

function getBoardPresetsList() {
  return boardPresets.map(p => ({
    id: p.id,
    name: p.name,
    timestamp: p.timestamp
  }));
}

function recordEvent(event, data) {
  if (!rec.active) return;
  rec.timeline.push({ t: Date.now() - rec.start, event, data });
}

function snapState() {
  return {
    strokes: JSON.parse(JSON.stringify(state.strokes)),
    arrows:  JSON.parse(JSON.stringify(state.arrows)),
    tokens:  JSON.parse(JSON.stringify(state.tokens))
  };
}

function finishReplay() {
  rep.timers.forEach(clearTimeout);
  rep.timers = [];
  rep.active = false;
  rep.currentRecId = null;
  const s = rep.preSnap;
  state.strokes = s.strokes;
  state.arrows  = s.arrows;
  state.tokens  = s.tokens;
  io.emit('clear-board');
  io.emit('tokens-cleared');
  io.emit('replay-restore', {
    strokes: s.strokes,
    arrows:  s.arrows,
    tokens:  Object.values(s.tokens)
  });
  io.emit('replay-done');
}

function getRecordingsList() {
  return recordings.map(r => ({
    id: r.id,
    name: r.name,
    timestamp: r.timestamp,
    duration: r.duration,
    eventCount: r.eventCount
  }));
}

// ── Helpers ───────────────────────────────────────────────────
const USER_COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63'
];
let colorIndex = 0;

function getNextColor() {
  const c = USER_COLORS[colorIndex % USER_COLORS.length];
  colorIndex++;
  return c;
}

function broadcastUserList() {
  io.emit('user-list', Object.values(state.users));
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connected: ${socket.id}`);

  // 1. New user joins
  socket.on('join', ({ username }) => {
    const color = getNextColor();
    state.users[socket.id] = { id: socket.id, username, color };

    // Send full current state to the new user
    socket.emit('init-state', {
      strokes: state.strokes,
      tokens: Object.values(state.tokens),
      arrows: state.arrows,
      users: Object.values(state.users),
      you: state.users[socket.id]
    });

    // Announce join to others
    socket.broadcast.emit('user-joined', state.users[socket.id]);
    broadcastUserList();
    console.log(`  username: ${username}`);
  });

  // 2. Live drawing (broadcast only, not stored)
  socket.on('draw-move', (data) => {
    socket.broadcast.emit('draw-move', {
      ...data,
      socketId: socket.id,
      color: state.users[socket.id]?.color || '#fff'
    });
  });

  // 3. Completed stroke — store it (tag with sender's socketId)
  socket.on('stroke-done', (stroke) => {
    const saved = { ...stroke, socketId: socket.id };
    state.strokes.push(saved);
    socket.broadcast.emit('stroke-done', saved);
    recordEvent('stroke-done', saved);
  });

  // 3b. Remove specific strokes by ID (own-lines-only erase)
  socket.on('stroke-remove', ({ ids }) => {
    ids.forEach(id => {
      const idx = state.strokes.findIndex(s => s.id === id);
      if (idx !== -1) state.strokes.splice(idx, 1);
    });
    io.emit('stroke-remove', { ids });
    recordEvent('stroke-remove', { ids });
  });

  // 4. Token added
  socket.on('token-add', (token) => {
    const id = `t${nextTokenId++}`;
    const newToken = { ...token, id };
    state.tokens[id] = newToken;
    io.emit('token-add', newToken);
    recordEvent('token-add', newToken);
  });

  // 5. Token moved
  socket.on('token-move', ({ id, x, y }) => {
    if (state.tokens[id]) {
      state.tokens[id].x = x;
      state.tokens[id].y = y;
      socket.broadcast.emit('token-move', { id, x, y });
      recordEvent('token-move', { id, x, y });
    }
  });

  // 6. Token removed
  socket.on('token-remove', ({ id }) => {
    delete state.tokens[id];
    io.emit('token-remove', { id });
    recordEvent('token-remove', { id });
  });

  // 6b. Token label edit
  socket.on('token-relabel', ({ id, label }) => {
    if (state.tokens[id]) state.tokens[id].label = label;
    io.emit('token-relabel', { id, label });
    recordEvent('token-relabel', { id, label });
  });

  // 7. Arrow added
  socket.on('arrow-done', (arrow) => {
    const saved = { ...arrow, id: `ar${nextArrowId++}`, socketId: socket.id };
    state.arrows.push(saved);
    // Broadcast to others, and send confirmed id back to sender separately
    socket.broadcast.emit('arrow-done', saved);
    socket.emit('arrow-confirmed', { tempId: arrow.id, arrow: saved });
    recordEvent('arrow-done', saved);
  });

  // 7b. Arrow removed (undo)
  socket.on('arrow-remove', ({ ids }) => {
    ids.forEach(id => {
      const idx = state.arrows.findIndex(a => a.id === id);
      if (idx !== -1) state.arrows.splice(idx, 1);
    });
    io.emit('arrow-remove', { ids });
    recordEvent('arrow-remove', { ids });
  });

  // 8. Clear board
  socket.on('clear-board', () => {
    state.strokes = [];
    state.arrows = [];
    state.tokens = {}; // also wipe tokens so late joiners don't see ghosts
    io.emit('clear-board');
    io.emit('tokens-cleared'); // tell clients to remove all token DOM elements
    recordEvent('clear-board', {});
    recordEvent('tokens-cleared', {});
  });

  // 9. Clear drawings only
  socket.on('clear-drawings', () => {
    state.strokes = [];
    state.arrows = [];
    io.emit('clear-board');
    recordEvent('clear-board', {});
  });

  // 10. Cursor movement
  socket.on('cursor-move', ({ x, y }) => {
    socket.broadcast.emit('cursor-move', {
      socketId: socket.id,
      username: state.users[socket.id]?.username || '?',
      color: state.users[socket.id]?.color || '#fff',
      x, y
    });
  });

  // 10b. Recording controls
  socket.on('recording-start', () => {
    if (rec.active || rep.active) return;
    rec.active   = true;
    rec.start    = Date.now();
    rec.timeline = [];
    rec.snapshot = snapState();
    io.emit('recording-started');
  });

  socket.on('recording-stop', () => {
    if (!rec.active) return;
    rec.active = false;
    const duration = rec.timeline.length
      ? rec.timeline[rec.timeline.length - 1].t
      : 0;
    const savedRec = {
      id: nextRecId++,
      name: `Recording ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      duration,
      eventCount: rec.timeline.length,
      snapshot: rec.snapshot,
      timeline: rec.timeline
    };
    recordings.push(savedRec);
    io.emit('recording-saved', getRecordingsList());
  });

  // 10c. Replay controls
  socket.on('replay-start', ({ recId }) => {
    if (rep.active) return;
    const recording = recordings.find(r => r.id === recId);
    if (!recording) return;

    rep.active       = true;
    rep.currentRecId = recId;
    rep.preSnap      = snapState();

    // Temporarily set server state to recording snapshot so late-joiners see it
    state.strokes = JSON.parse(JSON.stringify(recording.snapshot.strokes));
    state.arrows  = JSON.parse(JSON.stringify(recording.snapshot.arrows));
    state.tokens  = JSON.parse(JSON.stringify(recording.snapshot.tokens));

    io.emit('clear-board');
    io.emit('tokens-cleared');
    io.emit('replay-started', { duration: recording.duration, recId });
    // Small delay so clients clear before snapshot arrives
    setTimeout(() => {
      io.emit('replay-init', {
        strokes: recording.snapshot.strokes,
        arrows:  recording.snapshot.arrows,
        tokens:  Object.values(recording.snapshot.tokens)
      });
    }, 150);

    rep.timers = [];
    recording.timeline.forEach(entry => {
      const tid = setTimeout(() => io.emit(entry.event, entry.data), entry.t + 350);
      rep.timers.push(tid);
    });
    const endTid = setTimeout(finishReplay, recording.duration + 900);
    rep.timers.push(endTid);
  });

  socket.on('replay-stop', () => {
    if (rep.active) finishReplay();
  });

  socket.on('get-recordings', () => {
    socket.emit('recordings-list', getRecordingsList());
  });

  socket.on('delete-recording', ({ recId }) => {
    const idx = recordings.findIndex(r => r.id === recId);
    if (idx !== -1) {
      recordings.splice(idx, 1);
      io.emit('recordings-list', getRecordingsList());
    }
  });

  // 10d. Board presets
  socket.on('save-preset', ({ name }) => {
    const preset = {
      id: nextPresetId++,
      name: name || `Preset ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      strokes: JSON.parse(JSON.stringify(state.strokes)),
      arrows: JSON.parse(JSON.stringify(state.arrows)),
      tokens: JSON.parse(JSON.stringify(state.tokens))
    };
    boardPresets.push(preset);
    savePresets(); // Persist to disk
    io.emit('presets-list', getBoardPresetsList());
    socket.emit('preset-saved', { id: preset.id, name: preset.name });
  });

  socket.on('load-preset', ({ presetId }) => {
    const preset = boardPresets.find(p => p.id === presetId);
    if (!preset) return;
    state.strokes = JSON.parse(JSON.stringify(preset.strokes));
    state.arrows = JSON.parse(JSON.stringify(preset.arrows));
    state.tokens = JSON.parse(JSON.stringify(preset.tokens));
    io.emit('clear-board');
    io.emit('tokens-cleared');
    io.emit('preset-loaded', {
      strokes: preset.strokes,
      arrows: preset.arrows,
      tokens: Object.values(preset.tokens)
    });
  });

  socket.on('rename-preset', ({ presetId, newName }) => {
    const preset = boardPresets.find(p => p.id === presetId);
    if (preset) {
      preset.name = newName;
      savePresets(); // Persist to disk
      io.emit('presets-list', getBoardPresetsList());
    }
  });

  socket.on('delete-preset', ({ presetId }) => {
    const idx = boardPresets.findIndex(p => p.id === presetId);
    if (idx !== -1) {
      boardPresets.splice(idx, 1);
      savePresets(); // Persist to disk
      io.emit('presets-list', getBoardPresetsList());
    }
  });

  socket.on('get-presets', () => {
    socket.emit('presets-list', getBoardPresetsList());
  });

  // 11. Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] disconnected: ${socket.id}`);
    socket.broadcast.emit('cursor-remove', { socketId: socket.id });
    socket.broadcast.emit('user-left', state.users[socket.id]);
    delete state.users[socket.id];
    broadcastUserList();
  });
});

// ── Start ─────────────────────────────────────────────────────
loadPresets(); // Load saved presets from disk

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tac Board running → http://localhost:${PORT}`);
});
