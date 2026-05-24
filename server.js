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

    // Additive migration only: this creates a new table and never removes existing data.
    await db.query(`
      CREATE TABLE IF NOT EXISTS playbooks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        step_count INTEGER NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[+] Playbooks table created/verified');
    
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
      hostId: null,       // socketId of the room host
      bannedUsers: {},    // normalized username -> { username, addedAt, by }
      locked: false,      // when true, only host can edit board state
      strokes: [],        // finished strokes
      tokens: {},         // tokenId → { id, x, y, color, label, shape }
      arrows: [],         // finished arrows
      nextTokenId: 1,
      nextArrowId: 1,
      colorIndex: 0,
      rec: { active: false, start: 0, snapshot: null, timeline: [] },
      rep: { active: false, interval: null, preSnap: null, currentRecId: null, isPlaying: false, playbackPosition: 0, lastTick: 0 },
      play: { active: false, playbookId: null, stepIndex: 0, timeoutIds: [] }
    };
    console.log(`[+] Room "${roomId}" created`);
  }
  return rooms[roomId];
}

// Maps socketId → roomId so we can look up rooms on disconnect
const socketRooms = {};

const disconnectTimers = {}; // socketId → setTimeout handle for grace-period removal
const pendingJoinRequests = {}; // requestId -> { requesterSocketId, hostSocketId, roomId, username, timeoutId }
const approvedJoinOnce = {}; // socketId -> roomId

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

function getUsersWithHost(room) {
  return Object.values(room.users).map(u => ({
    ...u,
    isHost: u.id === room.hostId
  }));
}

function isLockedForUser(room, socketId) {
  return !!room?.locked && room.hostId !== socketId;
}

function normalizeUsernameKey(name) {
  return (name || '').toString().trim().toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toSafeString(value, maxLen = 80, fallback = '') {
  const v = (value || '').toString().trim();
  return (v.substring(0, maxLen) || fallback);
}

function toSafeNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function toSafeBoolean(value) {
  return !!value;
}

function sanitizeId(value, maxLen = 80) {
  const id = toSafeString(value, maxLen, '');
  return id || null;
}

function sanitizeIds(value, maxCount = 300, maxLen = 80) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value.slice(0, maxCount)) {
    const id = sanitizeId(raw, maxLen);
    if (id) result.push(id);
  }
  return result;
}

function sanitizePoint(rawPoint) {
  const p = asObject(rawPoint);
  return {
    x: toSafeNumber(p.x, 0, 900, 0),
    y: toSafeNumber(p.y, 0, 580, 0)
  };
}

function emitScopedList(socket, eventName, payload) {
  const roomId = socketRooms[socket.id];
  if (roomId) {
    io.to(roomId).emit(eventName, payload);
    return;
  }
  socket.emit(eventName, payload);
}

function clearPendingJoinRequestsForSocket(socketId) {
  Object.keys(pendingJoinRequests).forEach(requestId => {
    const req = pendingJoinRequests[requestId];
    if (!req) return;
    if (req.requesterSocketId === socketId || req.hostSocketId === socketId) {
      clearTimeout(req.timeoutId);
      if (req.requesterSocketId === socketId) {
        const hostSocket = io.sockets.sockets.get(req.hostSocketId);
        if (hostSocket) {
          hostSocket.emit('room-join-request-expired', {
            requestId,
            username: req.username,
            room: req.roomId,
            reason: 'requester-left'
          });
        }
      }
      if (req.requesterSocketId !== socketId) {
        const requester = io.sockets.sockets.get(req.requesterSocketId);
        if (requester) requester.emit('join-denied', { room: req.roomId, reason: 'Host unavailable' });
      }
      delete pendingJoinRequests[requestId];
    }
  });
}

function clearPendingJoinRequestsForRoom(roomId, reason = 'room-closed') {
  Object.keys(pendingJoinRequests).forEach(requestId => {
    const req = pendingJoinRequests[requestId];
    if (!req || req.roomId !== roomId) return;
    clearTimeout(req.timeoutId);
    const requester = io.sockets.sockets.get(req.requesterSocketId);
    const hostSocket = io.sockets.sockets.get(req.hostSocketId);
    if (requester) requester.emit('join-denied', { room: req.roomId, reason: 'Room is no longer available' });
    if (hostSocket) {
      hostSocket.emit('room-join-request-expired', {
        requestId,
        username: req.username,
        room: req.roomId,
        reason
      });
    }
    delete pendingJoinRequests[requestId];
  });
}

function selectNextHostId(room) {
  let bestId = null;
  let bestJoinedAt = Number.POSITIVE_INFINITY;
  Object.entries(room.users || {}).forEach(([id, user]) => {
    const joinedAt = Number(user?.joinedAt) || Number.POSITIVE_INFINITY;
    if (joinedAt < bestJoinedAt) {
      bestJoinedAt = joinedAt;
      bestId = id;
      return;
    }
    if (joinedAt === bestJoinedAt && bestId && id < bestId) {
      bestId = id;
    }
  });
  return bestId;
}

function closeRoom(roomId, closedBySocketId = null) {
  const room = rooms[roomId];
  if (!room) return false;

  const closedByName = room.users[closedBySocketId]?.username || 'Host';
  if (room.play?.active) stopPlaybook(roomId, false);
  clearPendingJoinRequestsForRoom(roomId, 'room-closed');

  const userIds = Object.keys(room.users);
  userIds.forEach((userId) => {
    const target = io.sockets.sockets.get(userId);
    if (target) {
      target.emit('room-removed', {
        room: roomId,
        reason: `Room closed by ${closedByName}.`
      });
      try { target.leave(roomId); } catch {}
    }

    delete socketRooms[userId];
    delete rateLimits[userId];
    if (disconnectTimers[userId]) {
      clearTimeout(disconnectTimers[userId]);
      delete disconnectTimers[userId];
    }
  });

  delete rooms[roomId];
  console.log(`[*] Room "${roomId}" closed by ${closedByName}`);
  return true;
}

function removeUserFromRoom(roomId, socketId, options = {}) {
  const room = rooms[roomId];
  if (!room) return false;

  const departedUser = room.users[socketId];
  if (!departedUser) return false;

  const reason = options.reason || null;
  delete room.users[socketId];

  let hostChanged = false;
  if (room.hostId === socketId) {
    room.hostId = selectNextHostId(room);
    hostChanged = true;
  }

  delete socketRooms[socketId];
  delete rateLimits[socketId];

  if (disconnectTimers[socketId]) {
    clearTimeout(disconnectTimers[socketId]);
    delete disconnectTimers[socketId];
  }

  const target = io.sockets.sockets.get(socketId);
  if (target) {
    try { target.leave(roomId); } catch {}
    if (reason === 'kicked') {
      target.emit('room-removed', { room: roomId, reason: 'You were removed by the host.' });
    } else if (reason === 'banned') {
      target.emit('room-removed', { room: roomId, reason: 'You were banned by the host.' });
    } else if (reason === 'left') {
      target.emit('room-removed', { room: roomId, reason: 'You left the room.' });
    }
  }

  io.to(roomId).emit('cursor-remove', { socketId });
  io.to(roomId).emit('user-left', departedUser);
  io.to(roomId).emit('user-list', getUsersWithHost(room));
  if (hostChanged) {
    io.to(roomId).emit('room-host-changed', {
      hostId: room.hostId,
      hostUsername: room.users[room.hostId]?.username || null
    });
  }

  // Clean up empty rooms to prevent memory leaks
  if (Object.keys(room.users).length === 0) {
    if (room.play?.active) {
      stopPlaybook(roomId, false);
    }
    delete rooms[roomId];
    console.log(`[*] Room "${roomId}" cleaned up (empty)`);
  }

  return true;
}

// ── Playbooks (global, shared across rooms) ──────────────────
const PLAYBOOKS_FILE = path.join(__dirname, 'board-playbooks.json');
let playbooks = [];
let nextPlaybookId = 1;

function sanitizeTokenForPlaybook(token) {
  const speedFactor = Math.max(0.25, Math.min(4, Number(token.speedFactor) || 1));
  return {
    id: (token.id || '').toString().substring(0, 40),
    x: Number(token.x) || 0,
    y: Number(token.y) || 0,
    color: (token.color || '#ffffff').toString().substring(0, 24),
    label: (token.label || '').toString().substring(0, 20),
    shape: (token.shape || 'circle').toString().substring(0, 20),
    createdBy: (token.createdBy || '').toString().substring(0, 60),
    speedFactor
  };
}

function normalizePlaybookSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 200).map((step, idx) => {
    const safeDuration = Math.max(250, Math.min(10000, Number(step.duration) || 1200));
    const safeSpeed = Math.max(40, Math.min(2000, Number(step.speed) || 260));
    const safeName = (step.name || `Step ${idx + 1}`).toString().trim().substring(0, 60) || `Step ${idx + 1}`;
    const tokensArr = Array.isArray(step.targets)
      ? step.targets
      : Object.values(step.tokens || {});
    const safeTokens = {};
    tokensArr.slice(0, 250).forEach(t => {
      const legacySpeed = Number(t?.speed);
      const speedFactor = Number.isFinite(Number(t?.speedFactor))
        ? Number(t.speedFactor)
        : (Number.isFinite(legacySpeed) ? legacySpeed / safeSpeed : 1);
      const safe = sanitizeTokenForPlaybook({ ...(t || {}), speedFactor });
      if (safe.id) safeTokens[safe.id] = safe;
    });
    return {
      name: safeName,
      duration: safeDuration,
      speed: safeSpeed,
      tokens: safeTokens
    };
  });
}

async function loadPlaybooks() {
  if (useDatabase && db) {
    try {
      const result = await db.query('SELECT * FROM playbooks ORDER BY id ASC');
      playbooks = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        timestamp: parseInt(row.timestamp),
        steps: normalizePlaybookSteps(row.data.steps || [])
      }));
      if (playbooks.length > 0) {
        nextPlaybookId = Math.max(...playbooks.map(p => p.id)) + 1;
      }
      console.log(`[+] Loaded ${playbooks.length} playbooks from database`);
      return;
    } catch (err) {
      console.error('[!] Error loading playbooks from database:', err.message);
    }
  }

  try {
    if (fs.existsSync(PLAYBOOKS_FILE)) {
      const data = fs.readFileSync(PLAYBOOKS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      playbooks = (parsed.playbooks || []).map(p => ({
        id: p.id,
        name: p.name,
        timestamp: p.timestamp,
        steps: normalizePlaybookSteps(p.steps || [])
      }));
      nextPlaybookId = parsed.nextId || 1;
      console.log(`[+] Loaded ${playbooks.length} playbooks from file`);
    }
  } catch (err) {
    console.error('[!] Error loading playbooks from file:', err.message);
  }
}

async function savePlaybooks() {
  try {
    const data = JSON.stringify({
      playbooks,
      nextId: nextPlaybookId
    }, null, 2);
    fs.writeFileSync(PLAYBOOKS_FILE, data, 'utf8');
  } catch (err) {
    console.error('[!] Error saving playbooks to file:', err.message);
  }
}

async function addPlaybookToDB(playbook) {
  if (!useDatabase || !db) return;
  try {
    await db.query(
      'INSERT INTO playbooks (id, name, timestamp, step_count, data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [playbook.id, playbook.name, playbook.timestamp, playbook.steps.length, JSON.stringify({ steps: playbook.steps })]
    );
    console.log(`[+] Playbook ${playbook.id} saved to database`);
  } catch (err) {
    console.error('[!] Error saving playbook to database:', err.message);
  }
}

async function updatePlaybookInDB(playbook) {
  if (!useDatabase || !db) return;
  try {
    await db.query(
      'UPDATE playbooks SET name = $1, timestamp = $2, step_count = $3, data = $4 WHERE id = $5',
      [playbook.name, playbook.timestamp, playbook.steps.length, JSON.stringify({ steps: playbook.steps }), playbook.id]
    );
    console.log(`[+] Playbook ${playbook.id} updated in database`);
  } catch (err) {
    console.error('[!] Error updating playbook in database:', err.message);
  }
}

async function deletePlaybookFromDB(playbookId) {
  if (!useDatabase || !db) return;
  try {
    await db.query('DELETE FROM playbooks WHERE id = $1', [playbookId]);
    console.log(`[+] Playbook ${playbookId} deleted from database`);
  } catch (err) {
    console.error('[!] Error deleting playbook from database:', err.message);
  }
}

function getPlaybooksList() {
  return playbooks.map(p => ({
    id: p.id,
    name: p.name,
    timestamp: p.timestamp,
    stepCount: (p.steps || []).length,
    totalDuration: (p.steps || []).reduce((sum, s) => sum + (Number(s.duration) || 0), 0)
  }));
}

function clearPlaybookTimers(room) {
  room.play.timeoutIds.forEach(id => clearTimeout(id));
  room.play.timeoutIds = [];
}

function getPlaybookStepTravelDurationForTokens(currentTokens, step) {
  const fallbackDuration = Math.max(250, Number(step?.duration) || 1200);
  const targets = Object.values(step?.tokens || {});
  let maxTravelMs = 0;

  targets.forEach(target => {
    const current = currentTokens?.[target.id];
    if (!current) return;
    const dx = (Number(target.x) || 0) - (Number(current.x) || 0);
    const dy = (Number(target.y) || 0) - (Number(current.y) || 0);
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return;
    const baseSpeed = Math.max(40, Number(step?.speed) || 260);
    const speedFactor = Math.max(0.25, Math.min(4, Number(target.speedFactor) || 1));
    const speed = Math.max(40, baseSpeed * speedFactor);
    const travelMs = (distance / speed) * 1000;
    if (travelMs > maxTravelMs) maxTravelMs = travelMs;
  });

  return Math.max(fallbackDuration, Math.ceil(maxTravelMs));
}

function getPlaybookStepTravelDuration(room, step) {
  return getPlaybookStepTravelDurationForTokens(room.tokens || {}, step);
}

function stopPlaybook(roomId, emitEvent = true) {
  const room = getRoom(roomId);
  if (!room.play.active) return;
  clearPlaybookTimers(room);
  room.play.active = false;
  room.play.playbookId = null;
  room.play.stepIndex = 0;
  if (emitEvent) io.to(roomId).emit('playbook-stopped');
}

function startPlaybook(roomId, playbook) {
  const room = getRoom(roomId);
  stopPlaybook(roomId, false);

  const PLAYBOOK_STEP_LEAD_MS = 220;
  const PLAYBOOK_STEP_GAP_MS = 80;
  const PLAYBOOK_FIRST_ALIGN_MS = 90;

  room.play.active = true;
  room.play.playbookId = playbook.id;
  room.play.stepIndex = 0;

  const steps = normalizePlaybookSteps(playbook.steps || []);
  if (!steps.length) {
    stopPlaybook(roomId, false);
    return;
  }

  io.to(roomId).emit('playbook-started', {
    playbookId: playbook.id,
    name: playbook.name,
    stepCount: steps.length
  });

  const baseStartAt = Date.now() + PLAYBOOK_STEP_LEAD_MS;
  let offset = 0;
  let simulatedTokens = JSON.parse(JSON.stringify(room.tokens || {}));
  steps.forEach((step, idx) => {
    const calculatedDuration = getPlaybookStepTravelDurationForTokens(simulatedTokens, step);
    const instantStart = idx === 0;
    const duration = instantStart
      ? Math.min(calculatedDuration, PLAYBOOK_FIRST_ALIGN_MS)
      : calculatedDuration;
    const stepSpeed = Math.max(40, Number(step.speed) || 260);
    const stepStartAt = baseStartAt + offset;
    const emitIn = Math.max(0, stepStartAt - Date.now() - PLAYBOOK_STEP_LEAD_MS);

    const stepTimer = setTimeout(() => {
      if (!room.play.active || room.play.playbookId !== playbook.id) return;
      room.play.stepIndex = idx;
      room.tokens = JSON.parse(JSON.stringify(step.tokens || {}));

      io.to(roomId).emit('playbook-step', {
        playbookId: playbook.id,
        stepIndex: idx,
        stepName: step.name,
        duration,
        stepSpeed,
        instantStart,
        startAt: stepStartAt,
        targets: Object.values(step.tokens || {})
      });

      if (idx === steps.length - 1) {
        const doneTimer = setTimeout(() => {
          if (!room.play.active || room.play.playbookId !== playbook.id) return;
          clearPlaybookTimers(room);
          room.play.active = false;
          room.play.playbookId = null;
          room.play.stepIndex = 0;
          io.to(roomId).emit('playbook-finished', { playbookId: playbook.id });
        }, duration + PLAYBOOK_STEP_GAP_MS + 120);
        room.play.timeoutIds.push(doneTimer);
      }
    }, emitIn);

    room.play.timeoutIds.push(stepTimer);
    offset += duration + PLAYBOOK_STEP_GAP_MS;
    simulatedTokens = JSON.parse(JSON.stringify(step.tokens || {}));
  });
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
  socket.on('join', (payload) => {
    const data = asObject(payload);
    let username = data.username;
    let roomId = data.room;
    // Sanitize inputs
    username = (username || 'Anonymous').toString().trim().substring(0, 20) || 'Anonymous';
    roomId = (roomId || 'lobby').toString().trim().substring(0, 40).replace(/[^a-zA-Z0-9_-]/g, '-') || 'lobby';
    const usernameKey = normalizeUsernameKey(username);

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
      if (oldRoom.hostId === socket.id) {
        oldRoom.hostId = selectNextHostId(oldRoom);
      }
      io.to(prevRoom).emit('user-list', getUsersWithHost(oldRoom));
    }

    const room = getRoom(roomId);

    if (room.bannedUsers && room.bannedUsers[usernameKey]) {
      socket.emit('join-denied', { room: roomId, reason: 'This username is banned by the room host.' });
      return;
    }

    // Remove any stale entry for this socket id
    if (room.users[socket.id]) {
      delete room.users[socket.id];
    }

    // Remove any previous connection for the same username (cross-socket reconnect)
    const existingSocketId = Object.keys(room.users).find(
      id => room.users[id].username === username
    );

    // Existing rooms require host approval unless this is a reconnect for same username.
    const hasHostApproval = approvedJoinOnce[socket.id] === roomId;
    if (Object.keys(room.users).length > 0 && !existingSocketId && !hasHostApproval && room.hostId && room.hostId !== socket.id) {
      const existingPending = Object.values(pendingJoinRequests).find(
        r => r.requesterSocketId === socket.id && r.roomId === roomId
      );
      if (existingPending) {
        socket.emit('join-pending-approval', { room: roomId, host: room.users[room.hostId]?.username || 'Host' });
        return;
      }

      const requestId = `jr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const hostSocketId = room.hostId;
      pendingJoinRequests[requestId] = {
        requesterSocketId: socket.id,
        hostSocketId,
        roomId,
        username,
        timeoutId: setTimeout(() => {
          const req = pendingJoinRequests[requestId];
          if (!req) return;
          const requester = io.sockets.sockets.get(req.requesterSocketId);
          const hostSocket = io.sockets.sockets.get(req.hostSocketId);
          if (requester) requester.emit('join-denied', { room: req.roomId, reason: 'No response from host' });
          if (hostSocket) {
            hostSocket.emit('room-join-request-expired', {
              requestId,
              username: req.username,
              room: req.roomId,
              reason: 'timeout'
            });
          }
          delete pendingJoinRequests[requestId];
        }, 30000)
      };

      socket.emit('join-pending-approval', { room: roomId, host: room.users[hostSocketId]?.username || 'Host' });
      io.to(hostSocketId).emit('room-join-request', {
        requestId,
        room: roomId,
        username
      });
      return;
    }

    // Join the Socket.IO room only after approval checks pass.
    socket.join(roomId);
    socketRooms[socket.id] = roomId;

    let color;
    let joinedAt;
    if (existingSocketId) {
      color = room.users[existingSocketId].color; // keep their colour
      joinedAt = room.users[existingSocketId].joinedAt || Date.now();
      if (room.hostId === existingSocketId) room.hostId = socket.id;
      delete room.users[existingSocketId];
    } else {
      color = getNextColor(room);
      joinedAt = Date.now();
    }
    room.users[socket.id] = { id: socket.id, username, color, joinedAt };
    if (!room.hostId) room.hostId = socket.id;
    if (approvedJoinOnce[socket.id] === roomId) delete approvedJoinOnce[socket.id];

    // Send full current state to the new user
    socket.emit('init-state', {
      strokes: room.strokes,
      tokens: Object.values(room.tokens),
      arrows: room.arrows,
      users: getUsersWithHost(room),
      you: room.users[socket.id],
      room: roomId,
      hostUsername: room.users[room.hostId]?.username || null,
      recActive: room.rec.active,
      repActive: room.rep.active,
      roomLocked: !!room.locked,
      repDuration: room.rep.currentRecId ? (recordings.find(r => r.id === room.rep.currentRecId)?.duration || 0) : 0,
      repPosition: room.rep.playbackPosition,
      repPaused: !room.rep.isPlaying
    });

    // Proactively push lists so client doesn't need to request them
    socket.emit('recordings-list', getRecordingsList());
    socket.emit('presets-list', getBoardPresetsList());
    socket.emit('playbooks-list', getPlaybooksList());

    // Announce join to others in the same room
    socket.to(roomId).emit('user-joined', room.users[socket.id]);
    io.to(roomId).emit('user-list', getUsersWithHost(room));
    console.log(`  username: ${username} → room: ${roomId}`);
  });

  socket.on('room-join-response', (payload) => {
    const data = asObject(payload);
    const requestId = sanitizeId(data.requestId, 120);
    const allow = toSafeBoolean(data.allow);
    if (!requestId) return;
    const req = pendingJoinRequests[requestId];
    if (!req) return;

    const room = rooms[req.roomId];
    if (!room || room.hostId !== socket.id) {
      return;
    }

    clearTimeout(req.timeoutId);
    delete pendingJoinRequests[requestId];

    const requester = io.sockets.sockets.get(req.requesterSocketId);
    if (!requester) return;

    if (!allow) {
      requester.emit('join-denied', { room: req.roomId, reason: 'Host denied request' });
      return;
    }

    // Client re-emits join after approval.
    approvedJoinOnce[req.requesterSocketId] = req.roomId;
    requester.emit('join-approved', { room: req.roomId });
  });

  socket.on('host-kick-user', (payload) => {
    const data = asObject(payload);
    const userId = sanitizeId(data.userId, 120);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (!userId || userId === socket.id || !room.users[userId]) return;

    clearPendingJoinRequestsForSocket(userId);
    const targetUser = room.users[userId];
    removeUserFromRoom(roomId, userId, { reason: 'kicked' });
    console.log(`[HOST] ${room.users[socket.id]?.username || socket.id} kicked ${targetUser?.username || userId} from room: ${roomId}`);
  });

  socket.on('room-lock-set', (payload) => {
    const data = asObject(payload);
    const locked = toSafeBoolean(data.locked);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    room.locked = !!locked;
    io.to(roomId).emit('room-lock-state', {
      locked: room.locked,
      by: room.users[socket.id]?.username || 'Host'
    });
  });

  socket.on('host-ban-user', (payload) => {
    const data = asObject(payload);
    const userId = sanitizeId(data.userId, 120);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (!userId || userId === socket.id || !room.users[userId]) return;

    const targetUser = room.users[userId];
    const key = normalizeUsernameKey(targetUser.username);
    if (key) {
      room.bannedUsers[key] = {
        username: targetUser.username,
        addedAt: Date.now(),
        by: room.users[socket.id]?.username || 'Host'
      };
    }

    clearPendingJoinRequestsForSocket(userId);
    removeUserFromRoom(roomId, userId, { reason: 'banned' });
    console.log(`[HOST] ${room.users[socket.id]?.username || socket.id} banned ${targetUser?.username || userId} from room: ${roomId}`);
  });

  socket.on('leave-room', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    removeUserFromRoom(roomId, socket.id, { reason: 'left' });
  });

  socket.on('host-close-room', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    closeRoom(roomId, socket.id);
  });

  // 2. Live drawing (broadcast only, not stored)
  socket.on('draw-move', (payload) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    const data = asObject(payload);
    const points = Array.isArray(data.points)
      ? data.points.slice(0, 240).map(sanitizePoint)
      : [];
    if (!points.length) return;
    const width = toSafeNumber(data.width, 1, 40, 3);
    const tool = toSafeString(data.tool, 12, 'draw');
    socket.to(roomId).emit('draw-move', {
      tool,
      width,
      points,
      socketId: socket.id,
      color: room.users[socket.id]?.color || '#fff'
    });
  });

  // 2b. Ping (broadcast only, not stored)
  socket.on('board-ping', (payload) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    const data = asObject(payload);
    const point = sanitizePoint(data);
    socket.to(roomId).emit('board-ping', {
      x: point.x,
      y: point.y,
      socketId: socket.id,
      color: room.users[socket.id]?.color || '#fff'
    });
  });

  // 3. Completed stroke — store it
  socket.on('stroke-done', (payload) => {
    if (isRateLimited(socket.id)) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    const stroke = asObject(payload);
    const points = Array.isArray(stroke.points)
      ? stroke.points.slice(0, 1200).map(sanitizePoint)
      : [];
    if (points.length < 2) return;

    // Basic protection against malicious huge payloads
    if (points.length > 5000) {
      console.log(`[!] Rejected large stroke (${points.length} points) from ${socket.id}`);
      return;
    }

    const saved = {
      id: sanitizeId(stroke.id, 120) || `${socket.id}-${Date.now()}`,
      socketId: socket.id,
      tool: toSafeString(stroke.tool, 12, 'draw'),
      points,
      color: toSafeString(stroke.color, 24, '#ffffff'),
      width: toSafeNumber(stroke.width, 1, 40, 3),
      timestamp: Date.now()
    };
    room.strokes.push(saved);
    socket.to(roomId).emit('stroke-done', saved);
    recordEvent(room, 'stroke-done', saved);
  });

  // 3b. Remove specific strokes by ID
  socket.on('stroke-remove', (payload) => {
    const data = asObject(payload);
    const ids = sanitizeIds(data.ids, 300, 120);
    if (!ids.length) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    ids.forEach(id => {
      const idx = room.strokes.findIndex(s => s.id === id);
      if (idx !== -1) room.strokes.splice(idx, 1);
    });
    io.to(roomId).emit('stroke-remove', { ids });
    recordEvent(room, 'stroke-remove', { ids });
  });

  // 4. Token added
  socket.on('token-add', (payload) => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    const token = asObject(payload);
    const id = `t${room.nextTokenId++}`;
    const newToken = {
      id,
      x: toSafeNumber(token.x, 0, 900, 450),
      y: toSafeNumber(token.y, 0, 580, 290),
      color: toSafeString(token.color, 24, '#ffffff'),
      label: toSafeString(token.label, 20, '1'),
      shape: toSafeString(token.shape, 20, 'circle'),
      createdBy: sanitizeId(token.createdBy, 120) || socket.id
    };
    room.tokens[id] = newToken;
    io.to(roomId).emit('token-add', newToken);
    recordEvent(room, 'token-add', newToken);
  });

  // 5. Token moved
  socket.on('token-move', (payload) => {
    if (isRateLimited(socket.id)) return;
    const data = asObject(payload);
    const id = sanitizeId(data.id, 120);
    const x = toSafeNumber(data.x, 0, 900, 0);
    const y = toSafeNumber(data.y, 0, 580, 0);
    if (!id) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    if (room.tokens[id]) {
      room.tokens[id].x = x;
      room.tokens[id].y = y;
      socket.to(roomId).emit('token-move', { id, x, y });
      recordEvent(room, 'token-move', { id, x, y });
    }
  });

  // 6. Token removed
  socket.on('token-remove', (payload) => {
    const data = asObject(payload);
    const id = sanitizeId(data.id, 120);
    if (!id) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    delete room.tokens[id];
    io.to(roomId).emit('token-remove', { id });
    recordEvent(room, 'token-remove', { id });
  });

  // 6b. Token label edit
  socket.on('token-relabel', (payload) => {
    const data = asObject(payload);
    const id = sanitizeId(data.id, 120);
    const label = toSafeString(data.label, 20, '');
    if (!id) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    if (room.tokens[id]) room.tokens[id].label = label;
    io.to(roomId).emit('token-relabel', { id, label });
    recordEvent(room, 'token-relabel', { id, label });
  });

  // 7. Arrow added
  socket.on('arrow-done', (payload) => {
    const arrow = asObject(payload);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
    const saved = {
      id: `ar${room.nextArrowId++}`,
      socketId: socket.id,
      tool: toSafeString(arrow.tool, 12, 'arrow'),
      x1: toSafeNumber(arrow.x1, 0, 900, 0),
      y1: toSafeNumber(arrow.y1, 0, 580, 0),
      x2: toSafeNumber(arrow.x2, 0, 900, 0),
      y2: toSafeNumber(arrow.y2, 0, 580, 0),
      color: toSafeString(arrow.color, 24, '#ffffff'),
      width: toSafeNumber(arrow.width, 1, 40, 3),
      style: toSafeString(arrow.style, 12, 'solid')
    };
    room.arrows.push(saved);
    socket.to(roomId).emit('arrow-done', saved);
    socket.emit('arrow-confirmed', { tempId: sanitizeId(arrow.id, 120), arrow: saved });
    recordEvent(room, 'arrow-done', saved);
  });

  // 7b. Arrow removed (undo)
  socket.on('arrow-remove', (payload) => {
    const data = asObject(payload);
    const ids = sanitizeIds(data.ids, 300, 120);
    if (!ids.length) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;
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
    if (isLockedForUser(room, socket.id)) return;
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
    if (isLockedForUser(room, socket.id)) return;
    room.strokes = [];
    room.arrows = [];
    io.to(roomId).emit('clear-board');
    recordEvent(room, 'clear-board', {});
  });

  // 10. Cursor movement
  socket.on('cursor-move', (payload) => {
    if (isRateLimited(socket.id)) return;
    const data = asObject(payload);
    const point = sanitizePoint(data);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    socket.to(roomId).emit('cursor-move', {
      socketId: socket.id,
      username: room.users[socket.id]?.username || '?',
      color: room.users[socket.id]?.color || '#fff',
      x: point.x,
      y: point.y
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
  socket.on('replay-start', (payload) => {
    const data = asObject(payload);
    const recId = toSafeNumber(data.recId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!recId) return;
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

  socket.on('replay-seek', (payload) => {
    const data = asObject(payload);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.rep.active) return;
    const recording = recordings.find(r => r.id === room.rep.currentRecId);
    if (!recording) return;

    const position = toSafeNumber(data.position, 0, recording.duration + 500, 0);

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

  socket.on('rename-recording', (payload) => {
    const data = asObject(payload);
    const recId = toSafeNumber(data.recId, 1, Number.MAX_SAFE_INTEGER, 0);
    const newName = toSafeString(data.newName, 120, '');
    if (!recId || !newName) return;
    const recording = recordings.find(r => r.id === recId);
    if (recording) {
      recording.name = newName;
      updateRecordingInDB(recording).then(() => saveRecordings());
      emitScopedList(socket, 'recordings-list', getRecordingsList());
    }
  });

  socket.on('delete-recording', (payload) => {
    const data = asObject(payload);
    const recId = toSafeNumber(data.recId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!recId) return;
    const idx = recordings.findIndex(r => r.id === recId);
    if (idx !== -1) {
      recordings.splice(idx, 1);
      deleteRecordingFromDB(recId).then(() => saveRecordings());
      emitScopedList(socket, 'recordings-list', getRecordingsList());
    }
  });

  // 10d. Board presets
  socket.on('save-preset', (payload) => {
    const data = asObject(payload);
    const name = toSafeString(data.name, 120, '');
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

  socket.on('load-preset', (payload) => {
    const data = asObject(payload);
    const presetId = toSafeNumber(data.presetId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!presetId) return;
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

  socket.on('import-board', (payload) => {
    const data = asObject(payload);
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isLockedForUser(room, socket.id)) return;

    const strokes = Array.isArray(data.strokes) ? data.strokes.slice(0, 5000) : [];
    const arrows = Array.isArray(data.arrows) ? data.arrows.slice(0, 3000) : [];
    const tokens = Array.isArray(data.tokens) ? data.tokens.slice(0, 500) : [];

    room.strokes = JSON.parse(JSON.stringify(strokes));
    room.arrows = JSON.parse(JSON.stringify(arrows));
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

  socket.on('rename-preset', (payload) => {
    const data = asObject(payload);
    const presetId = toSafeNumber(data.presetId, 1, Number.MAX_SAFE_INTEGER, 0);
    const newName = toSafeString(data.newName, 120, '');
    if (!presetId || !newName) return;
    const preset = boardPresets.find(p => p.id === presetId);
    if (preset) {
      preset.name = newName;
      updatePresetInDB(preset).then(() => savePresets());
      emitScopedList(socket, 'presets-list', getBoardPresetsList());
    }
  });

  socket.on('delete-preset', (payload) => {
    const data = asObject(payload);
    const presetId = toSafeNumber(data.presetId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!presetId) return;
    const idx = boardPresets.findIndex(p => p.id === presetId);
    if (idx !== -1) {
      boardPresets.splice(idx, 1);
      deletePresetFromDB(presetId).then(() => savePresets());
      emitScopedList(socket, 'presets-list', getBoardPresetsList());
    }
  });

  socket.on('get-presets', () => {
    socket.emit('presets-list', getBoardPresetsList());
  });

  // 10e. Playbooks (simultaneous token movement by step)
  socket.on('save-playbook', (payload) => {
    const data = asObject(payload);
    const name = toSafeString(data.name, 120, '');
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const normalizedSteps = normalizePlaybookSteps(steps);
    if (!normalizedSteps.length) return;

    const playbook = {
      id: nextPlaybookId++,
      name: (name || `Playbook ${new Date().toLocaleString()}`).toString().trim().substring(0, 80) || `Playbook ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      steps: normalizedSteps
    };

    playbooks.push(playbook);
    addPlaybookToDB(playbook).then(() => savePlaybooks());
    emitScopedList(socket, 'playbooks-list', getPlaybooksList());
    socket.emit('playbook-saved', { id: playbook.id, name: playbook.name });
  });

  socket.on('rename-playbook', (payload) => {
    const data = asObject(payload);
    const playbookId = toSafeNumber(data.playbookId, 1, Number.MAX_SAFE_INTEGER, 0);
    const newName = toSafeString(data.newName, 120, '');
    if (!playbookId) return;
    const playbook = playbooks.find(p => p.id === playbookId);
    if (!playbook) return;
    const safeName = (newName || '').toString().trim().substring(0, 80);
    if (!safeName) return;
    playbook.name = safeName;
    playbook.timestamp = Date.now();
    updatePlaybookInDB(playbook).then(() => savePlaybooks());
    emitScopedList(socket, 'playbooks-list', getPlaybooksList());
  });

  socket.on('delete-playbook', (payload) => {
    const data = asObject(payload);
    const playbookId = toSafeNumber(data.playbookId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!playbookId) return;
    const idx = playbooks.findIndex(p => p.id === playbookId);
    if (idx === -1) return;
    playbooks.splice(idx, 1);
    deletePlaybookFromDB(playbookId).then(() => savePlaybooks());
    emitScopedList(socket, 'playbooks-list', getPlaybooksList());

    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room?.play?.active && room.play.playbookId === playbookId) {
        stopPlaybook(roomId, true);
      }
    });
  });

  socket.on('get-playbooks', () => {
    socket.emit('playbooks-list', getPlaybooksList());
  });

  socket.on('playbook-start', (payload) => {
    const data = asObject(payload);
    const playbookId = toSafeNumber(data.playbookId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!playbookId) return;
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    const room = getRoom(roomId);
    if (room.rec.active || room.rep.active) return;

    const pb = playbooks.find(p => p.id === playbookId);
    if (!pb) return;
    startPlaybook(roomId, pb);
  });

  socket.on('playbook-stop', () => {
    const roomId = socketRooms[socket.id];
    if (!roomId) return;
    stopPlaybook(roomId, true);
  });

  // 11. Disconnect — use a grace period so brief hiccups don't spam user-left
  socket.on('disconnect', () => {
    const roomId = socketRooms[socket.id];
    console.log(`[-] disconnected: ${socket.id} (room: ${roomId || 'none'})`);

    // Reject any pending join requests tied to this socket.
    clearPendingJoinRequestsForSocket(socket.id);
    delete approvedJoinOnce[socket.id];

    if (roomId) {
      socket.to(roomId).emit('cursor-remove', { socketId: socket.id });
    }

    // Wait 8 seconds before removing user
    disconnectTimers[socket.id] = setTimeout(() => {
      if (!roomId) {
        delete disconnectTimers[socket.id];
        return;
      }
      const room = rooms[roomId];
      const departedUser = room?.users?.[socket.id];
      if (departedUser) {
        console.log(`[-] removed user: ${departedUser.username} from room: ${roomId}`);
      }
      removeUserFromRoom(roomId, socket.id);
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
    await loadPlaybooks();
    
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
