const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,      // Wait 60s for ping response before disconnect
  pingInterval: 25000,     // Send ping every 25s to keep connection alive
  connectTimeout: 45000,   // Wait 45s for connection to establish
  transports: ['websocket', 'polling']  // Try websocket first, fallback to polling
});

app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const list = Object.keys(rooms).map(id => ({
    id,
    users: Object.keys(rooms[id].users).length
  })).filter(r => r.users > 0);  // only show rooms with active users
  res.json(list);
});

app.get('/health', (req, res) => {
  const totalUsers = Object.values(rooms).reduce((sum, r) => sum + Object.keys(r.users).length, 0);
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    rooms: Object.keys(rooms).length,
    users: totalUsers
  });
});

// ── Database setup ────────────────────────────────────────────
let db = null;
let useDatabase = false;

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false  // Required for Railway PostgreSQL
    }
  });
  useDatabase = true;
  console.log('[+] PostgreSQL database configured');
} else {
  console.log('[!] No DATABASE_URL found, using file persistence');
}

// Initialize database tables
async function initDatabase() {
  if (!useDatabase || !db) {
    console.log('[!] Skipping database initialization - no database configured');
    return;
  }
  
  try {
    console.log('[*] Creating database tables...');
    
    await db.query(`
      CREATE TABLE IF NOT EXISTS presets (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[+] Presets table created/verified');
    
    await db.query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[+] Recordings table created/verified');
    
    console.log('[+] Database tables initialized successfully');
  } catch (err) {
    console.error('[!] Database initialization error:', err);
    console.error('[!] Full error details:', err.stack);
    useDatabase = false;
  }
}

// ── Per-Room State ────────────────────────────────────────────
// Each room has its own isolated board state, recording, and replay.
const rooms = {};  // roomId → room state object

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: {},          // socketId → { username, color }
      strokes: [],        // finished strokes
      tokens: {},         // tokenId → { id, x, y, color, label, shape }
      arrows: [],         // finished arrows
      nextTokenId: 1,
      nextArrowId: 1,
      colorIndex: 0,
      rec: { active: false, start: 0, snapshot: null, timeline: [] },
      rep: { active: false, interval: null, preSnap: null, currentRecId: null, isPlaying: false, playbackPosition: 0, lastTick: 0 }
    };
    console.log(`[+] Room "${roomId}" created`);
  }
  return rooms[roomId];
}

// Maps socketId → roomId so we can look up rooms on disconnect
const socketRooms = {};

const disconnectTimers = {}; // socketId → setTimeout handle for grace-period removal

// ── Recording / Replay (global, shared across rooms) ─────────
const RECORDINGS_FILE = path.join(__dirname, 'board-recordings.json');
let recordings = [];
let nextRecId = 1;

// Load recordings from database or file
async function loadRecordings() {
  if (useDatabase && db) {
    try {
      const result = await db.query('SELECT * FROM recordings ORDER BY id ASC');
      recordings = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        timestamp: parseInt(row.timestamp),
        duration: row.duration,
        eventCount: row.event_count,
        snapshot: row.data.snapshot,
        timeline: row.data.timeline
      }));
      if (recordings.length > 0) {
        nextRecId = Math.max(...recordings.map(r => r.id)) + 1;
      }
      console.log(`[+] Loaded ${recordings.length} recordings from database`);
      return;
    } catch (err) {
      console.error('[!] Error loading recordings from database:', err.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(RECORDINGS_FILE)) {
      const data = fs.readFileSync(RECORDINGS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      recordings = parsed.recordings || [];
      nextRecId = parsed.nextId || 1;
      console.log(`[+] Loaded ${recordings.length} recordings from file`);
    }
  } catch (err) {
    console.error('[!] Error loading recordings from file:', err.message);
  }
}

// Save recordings to file (backup)
async function saveRecordings() {
  try {
    const data = JSON.stringify({
      recordings: recordings,
      nextId: nextRecId
    }, null, 2);
    fs.writeFileSync(RECORDINGS_FILE, data, 'utf8');
  } catch (err) {
    console.error('[!] Error saving recordings to file:', err.message);
  }
}

// Add recording to database
async function addRecordingToDB(recording) {
  if (!useDatabase || !db) return;
  try {
    await db.query(
      'INSERT INTO recordings (id, name, timestamp, duration, event_count, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [recording.id, recording.name, recording.timestamp, recording.duration, recording.eventCount,
        JSON.stringify({ snapshot: recording.snapshot, timeline: recording.timeline })]
    );
    console.log(`[+] Recording ${recording.id} saved to database`);
  } catch (err) {
    console.error('[!] Error saving recording to database:', err.message);
  }
}

// Update recording in database
async function updateRecordingInDB(recording) {
  if (!useDatabase || !db) return;
  try {
    await db.query('UPDATE recordings SET name = $1, timestamp = $2 WHERE id = $3',
      [recording.name, recording.timestamp, recording.id]);
    console.log(`[+] Recording ${recording.id} updated in database`);
  } catch (err) {
    console.error('[!] Error updating recording in database:', err.message);
  }
}

// Delete recording from database
async function deleteRecordingFromDB(recId) {
  if (!useDatabase || !db) return;
  try {
    await db.query('DELETE FROM recordings WHERE id = $1', [recId]);
    console.log(`[+] Recording ${recId} deleted from database`);
  } catch (err) {
    console.error('[!] Error deleting recording from database:', err.message);
  }
}

// ── Board Presets (global, shared across rooms) ───────────────
const PRESETS_FILE = path.join(__dirname, 'board-presets.json');
let boardPresets = [];
let nextPresetId = 1;

// Load presets from database or file
async function loadPresets() {
  if (useDatabase && db) {
    try {
      const result = await db.query('SELECT * FROM presets ORDER BY id ASC');
      boardPresets = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        timestamp: parseInt(row.timestamp),
        strokes: row.data.strokes || [],
        arrows: row.data.arrows || [],
        tokens: row.data.tokens || []
      }));
      if (boardPresets.length > 0) {
        nextPresetId = Math.max(...boardPresets.map(p => p.id)) + 1;
      }
      console.log(`[+] Loaded ${boardPresets.length} board presets from database`);
      return;
    } catch (err) {
      console.error('[!] Error loading presets from database:', err.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const data = fs.readFileSync(PRESETS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      boardPresets = parsed.presets || [];
      nextPresetId = parsed.nextId || 1;
      console.log(`[+] Loaded ${boardPresets.length} board presets from file`);
    }
  } catch (err) {
    console.error('[!] Error loading presets from file:', err.message);
  }
}

// Save presets to file (backup)
async function savePresets() {
  try {
    const data = JSON.stringify({
      presets: boardPresets,
      nextId: nextPresetId
    }, null, 2);
    fs.writeFileSync(PRESETS_FILE, data, 'utf8');
  } catch (err) {
    console.error('[!] Error saving presets to file:', err.message);
  }
}

// Preset DB helpers
async function addPresetToDB(preset) {
  if (!useDatabase || !db) return;
  try {
    await db.query('INSERT INTO presets (id, name, timestamp, data) VALUES ($1, $2, $3, $4) RETURNING id',
      [preset.id, preset.name, preset.timestamp,
        JSON.stringify({ strokes: preset.strokes, arrows: preset.arrows, tokens: preset.tokens })]);
    console.log(`[+] Preset ${preset.id} saved to database`);
  } catch (err) { console.error('[!] Error saving preset to database:', err.message); }
}

async function deletePresetFromDB(presetId) {
  if (!useDatabase || !db) return;
  try {
    await db.query('DELETE FROM presets WHERE id = $1', [presetId]);
    console.log(`[+] Preset ${presetId} deleted from database`);
  } catch (err) { console.error('[!] Error deleting preset from database:', err.message); }
}

async function updatePresetInDB(preset) {
  if (!useDatabase || !db) return;
  try {
    await db.query('UPDATE presets SET name = $1, timestamp = $2, data = $3 WHERE id = $4',
      [preset.name, preset.timestamp,
        JSON.stringify({ strokes: preset.strokes, arrows: preset.arrows, tokens: preset.tokens }),
        preset.id]);
    console.log(`[+] Preset ${preset.id} updated in database`);
  } catch (err) { console.error('[!] Error updating preset in database:', err.message); }
}

function getBoardPresetsList() {
  return boardPresets.map(p => ({
    id: p.id,
    name: p.name,
    timestamp: p.timestamp,
    strokeCount: (p.strokes || []).length,
    arrowCount: (p.arrows || []).length,
    tokenCount: Object.keys(p.tokens || {}).length
  }));
}

function getRecordingsList() {
  console.log(`[DEBUG] getRecordingsList called. recordings.length = ${recordings.length}`);
  return recordings.map(r => ({
    id: r.id,
    name: r.name,
    timestamp: r.timestamp,
    duration: r.duration,
    eventCount: r.eventCount
  }));
}

// ── Room helpers ──────────────────────────────────────────────
function recordEvent(room, event, data) {
  if (!room.rec.active) return;
  room.rec.timeline.push({ t: Date.now() - room.rec.start, event, data });
}

function snapState(room) {
  return {
    strokes: JSON.parse(JSON.stringify(room.strokes)),
    arrows:  JSON.parse(JSON.stringify(room.arrows)),
    tokens:  JSON.parse(JSON.stringify(room.tokens))
  };
}

function finishReplay(roomId) {
  const room = getRoom(roomId);
  if (room.rep.interval) clearInterval(room.rep.interval);
  room.rep.interval = null;
  room.rep.active = false;
  room.rep.isPlaying = false;
  room.rep.currentRecId = null;
  room.rep.playbackPosition = 0;
  const s = room.rep.preSnap;
  room.strokes = s.strokes;
  room.arrows  = s.arrows;
  room.tokens  = s.tokens;
  io.to(roomId).emit('clear-board');
  io.to(roomId).emit('tokens-cleared');
  io.to(roomId).emit('replay-restore', {
    strokes: s.strokes,
    arrows:  s.arrows,
    tokens:  Object.values(s.tokens)
  });
  io.to(roomId).emit('replay-done');
}

// ── Helpers ───────────────────────────────────────────────────
const USER_COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63'
];

function getNextColor(room) {
  const c = USER_COLORS[room.colorIndex % USER_COLORS.length];
  room.colorIndex++;
  return c;
}

// ── Rate Limiting ─────────────────────────────────────────────
const rateLimits = {};  // socketId → { count, resetAt }
const RATE_LIMIT_MAX = 60;  // max events per second
const RATE_LIMIT_WINDOW = 1000;  // 1 second window

function isRateLimited(socketId) {
  const now = Date.now();
  if (!rateLimits[socketId] || now > rateLimits[socketId].resetAt) {
    rateLimits[socketId] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    return false;
  }
  rateLimits[socketId].count++;
  if (rateLimits[socketId].count > RATE_LIMIT_MAX) {
    return true; // over limit, drop this event
  }
  return false;
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connected: ${socket.id}`);

  // 1. New user joins a room
  socket.on('join', ({ username, room: roomId }) => {
    // Sanitize inputs
    username = (username || 'Anonymous').toString().trim().substring(0, 20) || 'Anonymous';
    roomId = (roomId || 'lobby').toString().trim().substring(0, 40).replace(/[^a-zA-Z0-9_-]/g, '-') || 'lobby';

    // Cancel any pending disconnect grace timer for this socket
    if (disconnectTimers[socket.id]) {
      clearTimeout(disconnectTimers[socket.id]);
      delete disconnectTimers[socket.id];
    }

    // If socket was in a different room, leave it first
    const prevRoom = socketRooms[socket.id];
    if (prevRoom && prevRoom !== roomId) {
      socket.leave(prevRoom);
      const oldRoom = getRoom(prevRoom);
      delete oldRoom.users[socket.id];
      io.to(prevRoom).emit('user-list', Object.values(oldRoom.users));
    }

    // Join the Socket.IO room
    socket.join(roomId);
    socketRooms[socket.id] = roomId;
    const room = getRoom(roomId);

    // Remove any stale entry for this socket id
    if (room.users[socket.id]) {
      delete room.users[socket.id];
    }

    // Remove any previous connection for the same username (cross-socket reconnect)
    const existingSocketId = Object.keys(room.users).find(
      id => room.users[id].username === username
    );
    let color;
    if (existingSocketId) {
      color = room.users[existingSocketId].color; // keep their colour
      delete room.users[existingSocketId];
    } else {
      color = getNextColor(room);
    }
    room.users[socket.id] = { id: socket.id, username, color };

    // Send full current state to the new user
    socket.emit('init-state', {
      strokes: room.strokes,
      tokens: Object.values(room.tokens),
      arrows: room.arrows,
      users: Object.values(room.users),
      you: room.users[socket.id],
      room: roomId,
      recActive: room.rec.active,
      repActive: room.rep.active,
      repDuration: room.rep.currentRecId ? (recordings.find(r => r.id === room.rep.currentRecId)?.duration || 0) : 0,
      repPosition: room.rep.playbackPosition,
      repPaused: !room.rep.isPlaying
    });

    // Proactively push lists so client doesn't need to request them
    socket.emit('recordings-list', getRecordingsList());
    socket.emit('presets-list', getBoardPresetsList());

    // Announce join to others in the same room
    socket.to(roomId).emit('user-joined', room.users[socket.id]);
    socket.to(roomId).emit('user-list', Object.values(room.users));
    console.log(`  username: ${username} → room: ${roomId}`);
  });

  // 2. Live drawing (broadcast only, not stored)
  socket.on('draw-move', (data) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    socket.to(roomId).emit('draw-move', {
      ...data,
      socketId: socket.id,
      color: room.users[socket.id]?.color || '#fff'
    });
  });

  // 2b. Ping (broadcast only, not stored)
  socket.on('board-ping', (data) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    socket.to(roomId).emit('board-ping', {
      ...data,
      socketId: socket.id,
      color: room.users[socket.id]?.color || '#fff'
    });
  });

  // 3. Completed stroke — store it
  socket.on('stroke-done', (stroke) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);

    // Basic protection against malicious huge payloads
    if (stroke && stroke.points && stroke.points.length > 5000) {
      console.log(`[!] Rejected large stroke (${stroke.points.length} points) from ${socket.id}`);
      return;
    }
    
    const saved = { ...stroke, socketId: socket.id };
    room.strokes.push(saved);
    socket.to(roomId).emit('stroke-done', saved);
    recordEvent(room, 'stroke-done', saved);
  });

  // 3b. Remove specific strokes by ID
  socket.on('stroke-remove', ({ ids }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    ids.forEach(id => {
      const idx = room.strokes.findIndex(s => s.id === id);
      if (idx !== -1) room.strokes.splice(idx, 1);
    });
    io.to(roomId).emit('stroke-remove', { ids });
    recordEvent(room, 'stroke-remove', { ids });
  });

  // 4. Token added
  socket.on('token-add', (token) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    const id = `t${room.nextTokenId++}`;
    const newToken = { ...token, id };
    room.tokens[id] = newToken;
    io.to(roomId).emit('token-add', newToken);
    recordEvent(room, 'token-add', newToken);
  });

  // 5. Token moved
  socket.on('token-move', ({ id, x, y }) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.tokens[id]) {
      room.tokens[id].x = x;
      room.tokens[id].y = y;
      socket.to(roomId).emit('token-move', { id, x, y });
      recordEvent(room, 'token-move', { id, x, y });
    }
  });

  // 6. Token removed
  socket.on('token-remove', ({ id }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    delete room.tokens[id];
    io.to(roomId).emit('token-remove', { id });
    recordEvent(room, 'token-remove', { id });
  });

  // 6b. Token label edit
  socket.on('token-relabel', ({ id, label }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.tokens[id]) room.tokens[id].label = label;
    io.to(roomId).emit('token-relabel', { id, label });
    recordEvent(room, 'token-relabel', { id, label });
  });

  // 7. Arrow added
  socket.on('arrow-done', (arrow) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    const saved = { ...arrow, id: `ar${room.nextArrowId++}`, socketId: socket.id };
    room.arrows.push(saved);
    socket.to(roomId).emit('arrow-done', saved);
    socket.emit('arrow-confirmed', { tempId: arrow.id, arrow: saved });
    recordEvent(room, 'arrow-done', saved);
  });

  // 7b. Arrow removed (undo)
  socket.on('arrow-remove', ({ ids }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    ids.forEach(id => {
      const idx = room.arrows.findIndex(a => a.id === id);
      if (idx !== -1) room.arrows.splice(idx, 1);
    });
    io.to(roomId).emit('arrow-remove', { ids });
    recordEvent(room, 'arrow-remove', { ids });
  });

  // 8. Clear board
  socket.on('clear-board', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    room.strokes = [];
    room.arrows = [];
    room.tokens = {};
    io.to(roomId).emit('clear-board');
    io.to(roomId).emit('tokens-cleared');
    recordEvent(room, 'clear-board', {});
    recordEvent(room, 'tokens-cleared', {});
  });

  // 9. Clear drawings only
  socket.on('clear-drawings', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    room.strokes = [];
    room.arrows = [];
    io.to(roomId).emit('clear-board');
    recordEvent(room, 'clear-board', {});
  });

  // 10. Cursor movement
  socket.on('cursor-move', ({ x, y }) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    socket.to(roomId).emit('cursor-move', {
      socketId: socket.id,
      username: room.users[socket.id]?.username || '?',
      color: room.users[socket.id]?.color || '#fff',
      x, y
    });
  });

  // 10b. Recording controls
  socket.on('recording-start', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.rec.active || room.rep.active) return;
    room.rec.active   = true;
    room.rec.start    = Date.now();
    room.rec.timeline = [];
    room.rec.snapshot = snapState(room);
    io.to(roomId).emit('recording-started');
  });

  socket.on('recording-stop', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.rec.active) return;
    room.rec.active = false;
    const duration = room.rec.timeline.length
      ? room.rec.timeline[room.rec.timeline.length - 1].t
      : 0;
    const savedRec = {
      id: nextRecId++,
      name: `Recording ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      duration,
      eventCount: room.rec.timeline.length,
      snapshot: room.rec.snapshot,
      timeline: room.rec.timeline
    };
    recordings.push(savedRec);
    addRecordingToDB(savedRec).then(() => saveRecordings());
    io.to(roomId).emit('recording-saved', getRecordingsList());
  });

  // 10c. Replay controls
  socket.on('replay-start', ({ recId }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.rep.active) return;
    const recording = recordings.find(r => r.id === recId);
    if (!recording) return;

    room.rep.active       = true;
    room.rep.currentRecId = recId;
    room.rep.preSnap      = snapState(room);

    // Temporarily set room state to recording snapshot
    room.strokes = JSON.parse(JSON.stringify(recording.snapshot.strokes));
    room.arrows  = JSON.parse(JSON.stringify(recording.snapshot.arrows));
    room.tokens  = JSON.parse(JSON.stringify(recording.snapshot.tokens));

    room.rep.isPlaying = true;
    room.rep.playbackPosition = 0;

    io.to(roomId).emit('clear-board');
    io.to(roomId).emit('tokens-cleared');
    io.to(roomId).emit('replay-started', { duration: recording.duration, recId });
    setTimeout(() => {
      io.to(roomId).emit('replay-init', {
        strokes: recording.snapshot.strokes,
        arrows:  recording.snapshot.arrows,
        tokens:  Object.values(recording.snapshot.tokens)
      });
      room.rep.lastTick = Date.now();
      room.rep.interval = setInterval(() => {
        if (!room.rep.isPlaying) return;
        const now = Date.now();
        const delta = now - room.rep.lastTick;
        room.rep.lastTick = now;

        const prevPos = room.rep.playbackPosition;
        room.rep.playbackPosition += delta;

        recording.timeline.forEach(entry => {
          if (entry.t > prevPos && entry.t <= room.rep.playbackPosition) {
            io.to(roomId).emit(entry.event, entry.data);
          }
        });

        if (room.rep.playbackPosition >= recording.duration + 500) {
          finishReplay(roomId);
        }
      }, 50);
    }, 150);
  });

  socket.on('replay-stop', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.rep.active) finishReplay(roomId);
  });

  socket.on('replay-pause', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.rep.active || !room.rep.isPlaying) return;
    room.rep.isPlaying = false;
    io.to(roomId).emit('replay-paused');
  });

  socket.on('replay-resume', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.rep.active || room.rep.isPlaying) return;
    room.rep.isPlaying = true;
    room.rep.lastTick = Date.now();
    io.to(roomId).emit('replay-resumed');
  });

  socket.on('replay-seek', ({ position }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.rep.active) return;
    const recording = recordings.find(r => r.id === room.rep.currentRecId);
    if (!recording) return;

    room.rep.playbackPosition = position;
    if (room.rep.isPlaying) room.rep.lastTick = Date.now();

    // Recalculate board state up to position
    const simStrokes = JSON.parse(JSON.stringify(recording.snapshot.strokes || []));
    const simArrows  = JSON.parse(JSON.stringify(recording.snapshot.arrows || []));
    const simTokens  = JSON.parse(JSON.stringify(recording.snapshot.tokens || {}));

    recording.timeline.forEach(entry => {
      if (entry.t <= position) {
        if (entry.event === 'stroke-done') {
          simStrokes.push(entry.data);
        } else if (entry.event === 'stroke-remove') {
          entry.data.ids.forEach(id => {
            const idx = simStrokes.findIndex(s => s.id === id);
            if (idx !== -1) simStrokes.splice(idx, 1);
          });
        } else if (entry.event === 'arrow-done') {
          simArrows.push(entry.data);
        } else if (entry.event === 'arrow-remove') {
          entry.data.ids.forEach(id => {
            const idx = simArrows.findIndex(a => a.id === id);
            if (idx !== -1) simArrows.splice(idx, 1);
          });
        } else if (entry.event === 'token-add') {
          simTokens[entry.data.id] = entry.data;
        } else if (entry.event === 'token-move') {
          if (simTokens[entry.data.id]) {
            simTokens[entry.data.id].x = entry.data.x;
            simTokens[entry.data.id].y = entry.data.y;
          }
        } else if (entry.event === 'token-remove') {
          delete simTokens[entry.data.id];
        } else if (entry.event === 'token-relabel') {
          if (simTokens[entry.data.id]) {
            simTokens[entry.data.id].label = entry.data.label;
          }
        } else if (entry.event === 'clear-board') {
          simStrokes.length = 0;
          simArrows.length = 0;
        } else if (entry.event === 'tokens-cleared') {
          for (let k in simTokens) delete simTokens[k];
        }
      }
    });

    room.strokes = simStrokes;
    room.arrows = simArrows;
    room.tokens = simTokens;

    io.to(roomId).emit('replay-sync-state', {
      position,
      strokes: simStrokes,
      arrows: simArrows,
      tokens: Object.values(simTokens)
    });
  });

  socket.on('get-recordings', () => {
    socket.emit('recordings-list', getRecordingsList());
  });

  socket.on('rename-recording', ({ recId, newName }) => {
    const recording = recordings.find(r => r.id === recId);
    if (recording) {
      recording.name = newName;
      updateRecordingInDB(recording).then(() => saveRecordings());
      io.emit('recordings-list', getRecordingsList());
    }
  });

  socket.on('delete-recording', ({ recId }) => {
    const idx = recordings.findIndex(r => r.id === recId);
    if (idx !== -1) {
      recordings.splice(idx, 1);
      deleteRecordingFromDB(recId).then(() => saveRecordings());
      io.emit('recordings-list', getRecordingsList());
    }
  });

  // 10d. Board presets
  socket.on('save-preset', ({ name }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    const preset = {
      id: nextPresetId++,
      name: name || `Preset ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      strokes: JSON.parse(JSON.stringify(room.strokes)),
      arrows: JSON.parse(JSON.stringify(room.arrows)),
      tokens: JSON.parse(JSON.stringify(room.tokens))
    };
    
    console.log(`[*] Saving preset "${preset.name}": ${preset.strokes.length} strokes, ${preset.arrows.length} arrows, ${Object.keys(preset.tokens).length} tokens`);
    
    boardPresets.push(preset);
    addPresetToDB(preset).then(() => savePresets());
    io.to(roomId).emit('presets-list', getBoardPresetsList());
    socket.emit('preset-saved', { id: preset.id, name: preset.name });
  });

  socket.on('load-preset', ({ presetId }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    const preset = boardPresets.find(p => p.id === presetId);
    if (!preset) return;
    room.strokes = JSON.parse(JSON.stringify(preset.strokes));
    room.arrows = JSON.parse(JSON.stringify(preset.arrows));
    room.tokens = JSON.parse(JSON.stringify(preset.tokens));
    io.to(roomId).emit('clear-board');
    io.to(roomId).emit('tokens-cleared');
    io.to(roomId).emit('preset-loaded', {
      strokes: preset.strokes,
      arrows: preset.arrows,
      tokens: Object.values(preset.tokens)
    });
  });

  socket.on('import-board', ({ strokes, arrows, tokens }) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    room.strokes = JSON.parse(JSON.stringify(strokes || []));
    room.arrows = JSON.parse(JSON.stringify(arrows || []));
    room.tokens = {};
    (tokens || []).forEach(t => { room.tokens[t.id] = t; });
    io.to(roomId).emit('clear-board');
    io.to(roomId).emit('tokens-cleared');
    io.to(roomId).emit('preset-loaded', {
      strokes: room.strokes,
      arrows: room.arrows,
      tokens: Object.values(room.tokens)
    });
  });

  socket.on('rename-preset', ({ presetId, newName }) => {
    const preset = boardPresets.find(p => p.id === presetId);
    if (preset) {
      preset.name = newName;
      updatePresetInDB(preset).then(() => savePresets());
      io.emit('presets-list', getBoardPresetsList());
    }
  });

  socket.on('delete-preset', ({ presetId }) => {
    const idx = boardPresets.findIndex(p => p.id === presetId);
    if (idx !== -1) {
      boardPresets.splice(idx, 1);
      deletePresetFromDB(presetId).then(() => savePresets());
      io.emit('presets-list', getBoardPresetsList());
    }
  });

  socket.on('get-presets', () => {
    socket.emit('presets-list', getBoardPresetsList());
  });

  // 11. Disconnect — use a grace period so brief hiccups don't spam user-left
  socket.on('disconnect', () => {
    const roomId = socketRooms[socket.id];
    console.log(`[-] disconnected: ${socket.id} (room: ${roomId || 'none'})`);

    if (roomId) {
      socket.to(roomId).emit('cursor-remove', { socketId: socket.id });
    }

    // Wait 8 seconds before removing user
    disconnectTimers[socket.id] = setTimeout(() => {
      delete disconnectTimers[socket.id];
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;
      const departedUser = room.users[socket.id];
      if (!departedUser) return;
      delete room.users[socket.id];
      delete socketRooms[socket.id];
      delete rateLimits[socket.id];
      console.log(`[-] removed user: ${departedUser.username} from room: ${roomId}`);
      io.to(roomId).emit('cursor-remove', { socketId: socket.id });
      io.to(roomId).emit('user-left', departedUser);
      io.to(roomId).emit('user-list', Object.values(room.users));

      // Clean up empty rooms to prevent memory leaks
      if (Object.keys(room.users).length === 0) {
        delete rooms[roomId];
        console.log(`[*] Room "${roomId}" cleaned up (empty)`);
      }
    }, 8000);
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDatabase();
    await loadPresets();
    await loadRecordings();
    
    server.listen(PORT, () => {
      console.log(`⚽ Tac Board running → http://localhost:${PORT}`);
      console.log(`📊 Database mode: ${useDatabase ? 'PostgreSQL' : 'File-based'}`);
      console.log(`🏠 Room system: enabled (URL hash-based)`);
    });
  } catch (err) {
    console.error('[!] Server startup error:', err.message);
    process.exit(1);
  }
}

startServer();
