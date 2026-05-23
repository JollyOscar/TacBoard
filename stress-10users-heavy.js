const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const USERS = 10;
const ROOM = `heavy-${Date.now()}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const clients = [];
let host;
let joined = 0;
let denied = 0;
let errors = 0;
let requests = 0;
let approvals = 0;

function mk(name) {
  const s = io(URL, { transports: ['websocket', 'polling'], reconnection: false, timeout: 15000 });
  s.meta = { name, inited: false, tokens: new Set(), recvDrawMoves: 0, recvTokenMoves: 0 };

  s.on('connect', () => s.emit('join', { username: name, room: ROOM }));
  s.on('join-approved', () => s.emit('join', { username: name, room: ROOM }));
  s.on('join-denied', () => denied++);
  s.on('connect_error', () => errors++);
  s.on('error', () => errors++);

  s.on('init-state', ({ tokens }) => {
    if (!s.meta.inited) { s.meta.inited = true; joined++; }
    (tokens || []).forEach(t => s.meta.tokens.add(t.id));
  });

  s.on('token-add', t => { if (t?.id) s.meta.tokens.add(t.id); });
  s.on('draw-move', () => { s.meta.recvDrawMoves++; });
  s.on('token-move', () => { s.meta.recvTokenMoves++; });

  clients.push(s);
  return s;
}

(async () => {
  host = mk('HeavyHost');
  host.on('room-join-request', ({ requestId }) => {
    requests++;
    approvals++;
    host.emit('room-join-response', { requestId, allow: true });
  });

  const hostJoinStart = Date.now();
  while (joined < 1 && Date.now() - hostJoinStart < 20000) await sleep(50);
  if (joined < 1) throw new Error('host join timeout 0/1');

  for (let i = 1; i < USERS; i++) mk(`HeavyUser${i}`);

  const start = Date.now();
  while (joined < USERS && Date.now() - start < 20000) await sleep(100);
  if (joined < USERS) throw new Error(`join timeout ${joined}/${USERS}`);

  // Seed tokens first (1 each)
  for (const c of clients) {
    c.emit('token-add', { x: 200, y: 140, color: '#fff', label: '1', shape: 'circle', createdBy: c.id });
  }

  await sleep(600);

  // Heavy concurrent stream (about ~80 events/socket in ~2.4s)
  await Promise.all(clients.map(async (c, idx) => {
    for (let i = 0; i < 40; i++) {
      c.emit('draw-move', {
        tool: 'draw',
        width: 3,
        points: [
          { x: 80 + i, y: 60 + idx },
          { x: 140 + i, y: 110 + idx }
        ]
      });
      const firstToken = Array.from(c.meta.tokens)[0];
      if (firstToken) {
        c.emit('token-move', { id: firstToken, x: 250 + i + idx, y: 180 + idx });
      }
      await sleep(6);
    }
  }));

  await sleep(1000);

  const totals = clients.reduce((acc, c) => {
    acc.recvDrawMoves += c.meta.recvDrawMoves;
    acc.recvTokenMoves += c.meta.recvTokenMoves;
    return acc;
  }, { recvDrawMoves: 0, recvTokenMoves: 0 });

  const result = {
    room: ROOM,
    joined,
    denied,
    errors,
    requests,
    approvals,
    recvDrawMovesTotal: totals.recvDrawMoves,
    recvTokenMovesTotal: totals.recvTokenMoves,
    pass: joined === USERS && denied === 0 && errors === 0
  };

  console.log('--- HEAVY STRESS RESULT ---');
  console.log(JSON.stringify(result, null, 2));

  clients.forEach(c => { try { c.disconnect(); } catch {} });
  process.exit(result.pass ? 0 : 1);
})();
