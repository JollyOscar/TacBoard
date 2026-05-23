const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const ROOM = `load-${Date.now()}`;
const TOTAL_BOTS = 9;

const clients = [];
let pendingRequests = 0;
let approvedRequests = 0;
let botInits = 0;
let hostInit = false;

function log(msg) {
  console.log(`[loadtest] ${msg}`);
}

const host = io(URL, { transports: ['websocket', 'polling'], reconnection: false });
clients.push(host);

host.on('connect', () => {
  log(`host connected: ${host.id}`);
  host.emit('join', { username: 'HostLoad', room: ROOM });
});

host.on('init-state', () => {
  hostInit = true;
  log('host init-state received');
});

host.on('room-join-request', ({ requestId, username }) => {
  pendingRequests++;
  host.emit('room-join-response', { requestId, allow: true });
  approvedRequests++;
  log(`approved join for ${username}`);
});

host.on('user-list', (users) => {
  log(`user-list count=${users.length}`);
});

for (let i = 0; i < TOTAL_BOTS; i++) {
  const name = `Bot${i + 1}`;
  const bot = io(URL, { transports: ['websocket', 'polling'], reconnection: false });
  clients.push(bot);

  bot.on('connect', () => {
    bot.emit('join', { username: name, room: ROOM });
  });

  bot.on('join-approved', () => {
    bot.emit('join', { username: name, room: ROOM });
  });

  bot.on('init-state', () => {
    botInits++;
    log(`${name} init-state received (${botInits}/${TOTAL_BOTS})`);
  });

  bot.on('join-denied', (data) => {
    log(`${name} denied: ${data?.reason || 'unknown'}`);
  });
}

setTimeout(() => {
  const pass = hostInit && botInits === TOTAL_BOTS;
  console.log('--- LOAD TEST RESULT ---');
  console.log(JSON.stringify({
    room: ROOM,
    hostInit,
    botsExpected: TOTAL_BOTS,
    botsJoined: botInits,
    pendingRequests,
    approvedRequests,
    pass
  }, null, 2));

  clients.forEach(c => {
    try { c.disconnect(); } catch {}
  });

  process.exit(pass ? 0 : 1);
}, 8000);
