const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

  // 3. Completed stroke — store it
  socket.on('stroke-done', (stroke) => {
    state.strokes.push(stroke);
    socket.broadcast.emit('stroke-done', stroke);
  });

  // 4. Token added
  socket.on('token-add', (token) => {
    const id = `t${nextTokenId++}`;
    const newToken = { ...token, id };
    state.tokens[id] = newToken;
    io.emit('token-add', newToken);
  });

  // 5. Token moved
  socket.on('token-move', ({ id, x, y }) => {
    if (state.tokens[id]) {
      state.tokens[id].x = x;
      state.tokens[id].y = y;
      socket.broadcast.emit('token-move', { id, x, y });
    }
  });

  // 6. Token removed
  socket.on('token-remove', ({ id }) => {
    delete state.tokens[id];
    io.emit('token-remove', { id });
  });

  // 7. Arrow added
  socket.on('arrow-done', (arrow) => {
    state.arrows.push(arrow);
    socket.broadcast.emit('arrow-done', arrow);
  });

  // 8. Clear board
  socket.on('clear-board', () => {
    state.strokes = [];
    state.arrows = [];
    io.emit('clear-board');
  });

  // 9. Clear drawings only
  socket.on('clear-drawings', () => {
    state.strokes = [];
    state.arrows = [];
    io.emit('clear-board');
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tac Board running → http://localhost:${PORT}`);
});
