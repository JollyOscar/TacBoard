const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const USERS = 10;
const ROUNDS = 2;
const JOIN_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeStroke(socketId, idx) {
  const base = idx * 3;
  return {
    id: `${socketId}-s-${idx}`,
    socketId,
    tool: 'draw',
    points: [
      { x: 120 + base, y: 80 + base },
      { x: 220 + base, y: 160 + base },
      { x: 300 + base, y: 140 + base }
    ],
    color: '#3498db',
    width: 3,
    timestamp: Date.now()
  };
}

function makeArrow(socketId, idx) {
  const base = idx * 4;
  return {
    id: `${socketId}-a-${idx}`,
    socketId,
    tool: 'arrow',
    x1: 100 + base,
    y1: 90 + base,
    x2: 260 + base,
    y2: 180 + base,
    color: '#e74c3c',
    width: 3,
    style: 'solid'
  };
}

async function runRound(roundNum) {
  const room = `stress-${Date.now()}-${roundNum}`;
  const clients = [];
  const byName = new Map();
  const metrics = {
    room,
    round: roundNum,
    connected: 0,
    joined: 0,
    denied: 0,
    disconnected: 0,
    socketErrors: 0,
    joinRequestsSeen: 0,
    approvedByHost: 0,
    tokenAddsSent: 0,
    tokenMovesSent: 0,
    strokesSent: 0,
    arrowsSent: 0,
    recordingSavedEvents: 0,
    replayStartedEvents: 0,
    replayDoneEvents: 0
  };

  let host = null;

  function mkClient(name) {
    const s = io(URL, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 15000
    });

    s.meta = {
      name,
      inited: false,
      tokens: new Set()
    };

    s.on('connect', () => {
      metrics.connected++;
      s.emit('join', { username: name, room });
    });

    s.on('join-approved', () => {
      s.emit('join', { username: name, room });
    });

    s.on('join-denied', () => {
      metrics.denied++;
    });

    s.on('init-state', ({ tokens }) => {
      if (!s.meta.inited) {
        s.meta.inited = true;
        metrics.joined++;
      }
      (tokens || []).forEach(t => s.meta.tokens.add(t.id));
    });

    s.on('token-add', token => {
      if (token?.id) s.meta.tokens.add(token.id);
    });

    s.on('recording-saved', () => {
      metrics.recordingSavedEvents++;
    });

    s.on('replay-started', () => {
      metrics.replayStartedEvents++;
    });

    s.on('replay-done', () => {
      metrics.replayDoneEvents++;
    });

    s.on('disconnect', () => {
      metrics.disconnected++;
    });

    s.on('connect_error', () => {
      metrics.socketErrors++;
    });

    s.on('error', () => {
      metrics.socketErrors++;
    });

    clients.push(s);
    byName.set(name, s);
    return s;
  }

  host = mkClient('HostStress');

  host.on('room-join-request', ({ requestId }) => {
    metrics.joinRequestsSeen++;
    metrics.approvedByHost++;
    host.emit('room-join-response', { requestId, allow: true });
  });

  for (let i = 1; i < USERS; i++) {
    mkClient(`User${i}`);
  }

  const joinStart = Date.now();
  while (metrics.joined < USERS && Date.now() - joinStart < JOIN_TIMEOUT_MS) {
    await sleep(100);
  }

  if (metrics.joined < USERS) {
    throw new Error(`Join timeout: ${metrics.joined}/${USERS}`);
  }

  // Phase 1: simultaneous token creation from all users
  await Promise.all(clients.map(async (c, idx) => {
    for (let j = 0; j < 2; j++) {
      c.emit('token-add', {
        x: 150 + (idx * 20) + (j * 6),
        y: 120 + (idx * 14) + (j * 5),
        color: '#2ecc71',
        label: String(j + 1),
        shape: 'circle',
        createdBy: c.id
      });
      metrics.tokenAddsSent++;
      await sleep(20);
    }
  }));

  await sleep(500);

  // Phase 2: simultaneous token movement (best effort on locally known tokens)
  await Promise.all(clients.map(async c => {
    const ids = Array.from(c.meta.tokens).slice(0, 2);
    for (let i = 0; i < ids.length; i++) {
      c.emit('token-move', { id: ids[i], x: 360 + (i * 40), y: 220 + (i * 20) });
      metrics.tokenMovesSent++;
      await sleep(20);
    }
  }));

  // Phase 3: simultaneous strokes and arrows from everyone
  await Promise.all(clients.map(async c => {
    for (let i = 0; i < 6; i++) {
      c.emit('stroke-done', makeStroke(c.id, i));
      metrics.strokesSent++;
      await sleep(15);
    }
    for (let i = 0; i < 3; i++) {
      c.emit('arrow-done', makeArrow(c.id, i));
      metrics.arrowsSent++;
      await sleep(20);
    }
  }));

  // Phase 4: recording + concurrent activity + replay
  host.emit('recording-start');
  await sleep(120);
  await Promise.all(clients.map(async c => {
    c.emit('stroke-done', makeStroke(c.id, 99));
    metrics.strokesSent++;
    await sleep(10);
    c.emit('arrow-done', makeArrow(c.id, 99));
    metrics.arrowsSent++;
  }));

  await sleep(200);
  host.emit('recording-stop');
  await sleep(600);

  host.emit('get-recordings');
  let latestRecId = null;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    host.once('recordings-list', list => {
      if (Array.isArray(list) && list.length) {
        latestRecId = list[list.length - 1].id;
      }
      clearTimeout(timer);
      resolve();
    });
  });

  if (latestRecId) {
    host.emit('replay-start', { recId: latestRecId });
    await sleep(1800);
    host.emit('replay-stop');
  }

  // Cleanup
  clients.forEach(c => {
    try { c.disconnect(); } catch {}
  });

  return metrics;
}

(async () => {
  const all = [];
  let failed = false;

  for (let r = 1; r <= ROUNDS; r++) {
    try {
      const m = await runRound(r);
      all.push(m);
      console.log(`ROUND ${r} OK`, JSON.stringify(m));
      if (m.joined !== USERS || m.socketErrors > 0 || m.denied > 0) {
        failed = true;
      }
    } catch (err) {
      failed = true;
      console.error(`ROUND ${r} FAIL:`, err.message);
    }
    await sleep(500);
  }

  console.log('\n=== RIGOROUS STRESS SUMMARY ===');
  console.log(JSON.stringify(all, null, 2));
  process.exit(failed ? 1 : 0);
})();
