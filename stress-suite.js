const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const URL = process.env.STRESS_URL || 'http://localhost:3000';
const USERS = Number(process.env.USERS || 20);
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS || 25000);
const SCALE_ITERATIONS = Number(process.env.SCALE_ITERATIONS || 40);
const SCALE_PAUSE_MS = Number(process.env.SCALE_PAUSE_MS || 6);
const SOAK_DURATION_MS = Number(process.env.SOAK_DURATION_MS || 5 * 60 * 1000);
const SOAK_TICK_MS = Number(process.env.SOAK_TICK_MS || 150);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

function safeDisconnect(clients) {
  for (const c of clients) {
    try {
      c.disconnect();
    } catch {
      // best effort disconnect only
    }
  }
}

function writeReport(report) {
  const dir = path.join(__dirname, 'stress-reports');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `stress-report-${Date.now()}.json`;
  const outPath = path.join(dir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return outPath;
}

function createClient(name, room, shared) {
  const socket = io(URL, {
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 15000
  });

  socket.meta = {
    name,
    joined: false,
    tokens: new Set(),
    recvDrawMove: 0,
    recvTokenMove: 0,
    recvStrokeDone: 0,
    recvArrowDone: 0
  };

  socket.on('connect', () => {
    shared.connected += 1;
    socket.emit('join', { username: name, room });
  });

  socket.on('join-approved', () => {
    socket.emit('join', { username: name, room });
  });

  socket.on('join-denied', () => {
    shared.denied += 1;
  });

  socket.on('init-state', ({ tokens }) => {
    if (!socket.meta.joined) {
      socket.meta.joined = true;
      shared.joined += 1;
    }
    (tokens || []).forEach((t) => {
      if (t && t.id) socket.meta.tokens.add(t.id);
    });
  });

  socket.on('token-add', (token) => {
    if (token && token.id) socket.meta.tokens.add(token.id);
  });

  socket.on('draw-move', () => {
    socket.meta.recvDrawMove += 1;
  });

  socket.on('token-move', () => {
    socket.meta.recvTokenMove += 1;
  });

  socket.on('stroke-done', () => {
    socket.meta.recvStrokeDone += 1;
  });

  socket.on('arrow-done', () => {
    socket.meta.recvArrowDone += 1;
  });

  socket.on('connect_error', () => {
    shared.socketErrors += 1;
  });

  socket.on('error', () => {
    shared.socketErrors += 1;
  });

  socket.on('disconnect', () => {
    shared.disconnected += 1;
  });

  return socket;
}

async function createRoom(users, roomName) {
  const shared = {
    connected: 0,
    joined: 0,
    denied: 0,
    socketErrors: 0,
    disconnected: 0,
    requestsSeen: 0,
    approvalsSent: 0
  };

  const clients = [];
  const host = createClient('ScaleHost', roomName, shared);
  clients.push(host);

  host.on('room-join-request', ({ requestId }) => {
    shared.requestsSeen += 1;
    shared.approvalsSent += 1;
    host.emit('room-join-response', { requestId, allow: true });
  });

  const hostStart = Date.now();
  while (shared.joined < 1 && Date.now() - hostStart < JOIN_TIMEOUT_MS) {
    await sleep(50);
  }

  if (shared.joined < 1) {
    throw new Error('Host join timeout 0/1');
  }

  for (let i = 1; i < users; i += 1) {
    clients.push(createClient(`ScaleUser${i}`, roomName, shared));
  }

  const start = Date.now();
  while (shared.joined < users && Date.now() - start < JOIN_TIMEOUT_MS) {
    await sleep(100);
  }

  if (shared.joined < users) {
    throw new Error(`Join timeout ${shared.joined}/${users}`);
  }

  return { clients, host, shared };
}

function calculateReceives(clients) {
  return clients.reduce(
    (acc, c) => {
      acc.recvDrawMove += c.meta.recvDrawMove;
      acc.recvTokenMove += c.meta.recvTokenMove;
      acc.recvStrokeDone += c.meta.recvStrokeDone;
      acc.recvArrowDone += c.meta.recvArrowDone;
      return acc;
    },
    { recvDrawMove: 0, recvTokenMove: 0, recvStrokeDone: 0, recvArrowDone: 0 }
  );
}

function diffReceives(after, before) {
  return {
    recvDrawMove: Math.max(0, (after.recvDrawMove || 0) - (before.recvDrawMove || 0)),
    recvTokenMove: Math.max(0, (after.recvTokenMove || 0) - (before.recvTokenMove || 0)),
    recvStrokeDone: Math.max(0, (after.recvStrokeDone || 0) - (before.recvStrokeDone || 0)),
    recvArrowDone: Math.max(0, (after.recvArrowDone || 0) - (before.recvArrowDone || 0))
  };
}

async function seedTokens(clients) {
  for (let idx = 0; idx < clients.length; idx += 1) {
    const c = clients[idx];
    c.emit('token-add', {
      x: 180 + idx,
      y: 120 + idx,
      color: '#ffffff',
      label: '1',
      shape: 'circle',
      createdBy: c.id
    });
  }
  await sleep(800);
}

async function runScalePhase(clients) {
  const sent = {
    drawMove: 0,
    tokenMove: 0,
    strokeDone: 0,
    arrowDone: 0
  };

  const baseline = calculateReceives(clients);

  await Promise.all(
    clients.map(async (c, idx) => {
      for (let i = 0; i < SCALE_ITERATIONS; i += 1) {
        c.emit('draw-move', {
          tool: 'draw',
          width: 3,
          points: [
            { x: 70 + i, y: 55 + idx },
            { x: 130 + i, y: 95 + idx }
          ]
        });
        sent.drawMove += 1;

        const firstToken = Array.from(c.meta.tokens)[0];
        if (firstToken) {
          c.emit('token-move', {
            id: firstToken,
            x: 250 + i + idx,
            y: 170 + idx
          });
          sent.tokenMove += 1;
        }

        c.emit('stroke-done', {
          id: `${c.id}-stroke-${i}`,
          socketId: c.id,
          tool: 'draw',
          points: [
            { x: 90 + i, y: 80 + idx },
            { x: 150 + i, y: 120 + idx }
          ],
          color: '#27ae60',
          width: 3,
          timestamp: Date.now()
        });
        sent.strokeDone += 1;

        if (i % 2 === 0) {
          c.emit('arrow-done', {
            id: `${c.id}-arrow-${i}`,
            socketId: c.id,
            x1: 100 + i,
            y1: 85 + idx,
            x2: 210 + i,
            y2: 160 + idx,
            color: '#e74c3c',
            width: 3,
            style: 'solid'
          });
          sent.arrowDone += 1;
        }

        await sleep(SCALE_PAUSE_MS);
      }
    })
  );

  await sleep(1200);
  const recv = diffReceives(calculateReceives(clients), baseline);

  return { sent, recv };
}

async function runSoakPhase(clients) {
  const sent = {
    drawMove: 0,
    tokenMove: 0,
    strokeDone: 0,
    arrowDone: 0
  };

  const baseline = calculateReceives(clients);

  const startedAt = Date.now();
  await Promise.all(
    clients.map(async (c, idx) => {
      let localTick = 0;
      while (Date.now() - startedAt < SOAK_DURATION_MS) {
        c.emit('draw-move', {
          tool: 'draw',
          width: 2,
          points: [
            { x: 40 + localTick, y: 40 + idx },
            { x: 70 + localTick, y: 70 + idx }
          ]
        });
        sent.drawMove += 1;

        const firstToken = Array.from(c.meta.tokens)[0];
        if (firstToken) {
          c.emit('token-move', {
            id: firstToken,
            x: 220 + (localTick % 100),
            y: 130 + idx
          });
          sent.tokenMove += 1;
        }

        if (localTick % 3 === 0) {
          c.emit('stroke-done', {
            id: `${c.id}-soak-stroke-${localTick}`,
            socketId: c.id,
            tool: 'draw',
            points: [
              { x: 60 + localTick, y: 60 + idx },
              { x: 110 + localTick, y: 100 + idx }
            ],
            color: '#2980b9',
            width: 2,
            timestamp: Date.now()
          });
          sent.strokeDone += 1;
        }

        if (localTick % 6 === 0) {
          c.emit('arrow-done', {
            id: `${c.id}-soak-arrow-${localTick}`,
            socketId: c.id,
            x1: 90 + localTick,
            y1: 75 + idx,
            x2: 180 + localTick,
            y2: 130 + idx,
            color: '#d35400',
            width: 2,
            style: 'solid'
          });
          sent.arrowDone += 1;
        }

        localTick += 1;
        await sleep(SOAK_TICK_MS);
      }
    })
  );

  await sleep(1200);
  const recv = diffReceives(calculateReceives(clients), baseline);

  return {
    sent,
    recv,
    elapsedMs: Date.now() - startedAt
  };
}

function evaluate({ users, shared, scale, soak }) {
  const expectedDrawScale = scale.sent.drawMove * (users - 1);
  const expectedTokenScale = scale.sent.tokenMove * (users - 1);
  const expectedDrawSoak = soak.sent.drawMove * (users - 1);
  const expectedTokenSoak = soak.sent.tokenMove * (users - 1);

  const totalExpectedDraw = expectedDrawScale + expectedDrawSoak;
  const totalExpectedToken = expectedTokenScale + expectedTokenSoak;
  const totalRecvDraw = scale.recv.recvDrawMove + soak.recv.recvDrawMove;
  const totalRecvToken = scale.recv.recvTokenMove + soak.recv.recvTokenMove;

  const drawDeliveryPct = pct(totalRecvDraw, totalExpectedDraw);
  const tokenDeliveryPct = pct(totalRecvToken, totalExpectedToken);

  const thresholds = {
    joinedMustEqualUsers: users,
    deniedMustBe: 0,
    socketErrorsMax: 0,
    drawDeliveryMinPct: 95,
    tokenDeliveryMinPct: 95
  };

  const checks = {
    joinedOk: shared.joined === users,
    deniedOk: shared.denied === 0,
    socketErrorsOk: shared.socketErrors <= thresholds.socketErrorsMax,
    drawDeliveryOk: drawDeliveryPct >= thresholds.drawDeliveryMinPct,
    tokenDeliveryOk: tokenDeliveryPct >= thresholds.tokenDeliveryMinPct
  };

  const pass = Object.values(checks).every(Boolean);

  return {
    pass,
    thresholds,
    checks,
    summary: {
      joinRatePct: pct(shared.joined, users),
      drawDeliveryPct,
      tokenDeliveryPct,
      approvals: shared.approvalsSent,
      joinRequestsSeen: shared.requestsSeen
    }
  };
}

async function main() {
  const startedAt = nowIso();
  const room = `suite-${Date.now()}`;

  const report = {
    startedAt,
    mode: 'scale+soak',
    config: {
      url: URL,
      users: USERS,
      joinTimeoutMs: JOIN_TIMEOUT_MS,
      scaleIterations: SCALE_ITERATIONS,
      scalePauseMs: SCALE_PAUSE_MS,
      soakDurationMs: SOAK_DURATION_MS,
      soakTickMs: SOAK_TICK_MS,
      room
    },
    shared: null,
    scalePhase: null,
    soakPhase: null,
    evaluation: null,
    finishedAt: null
  };

  let clients = [];

  try {
    const roomState = await createRoom(USERS, room);
    clients = roomState.clients;

    await seedTokens(clients);
    const scale = await runScalePhase(clients);
    const soak = await runSoakPhase(clients);

    report.shared = roomState.shared;
    report.scalePhase = scale;
    report.soakPhase = soak;
    report.evaluation = evaluate({
      users: USERS,
      shared: roomState.shared,
      scale,
      soak
    });
  } catch (err) {
    report.evaluation = {
      pass: false,
      fatalError: err && err.message ? err.message : String(err)
    };
  } finally {
    safeDisconnect(clients);
    report.finishedAt = nowIso();
    const reportPath = writeReport(report);

    console.log('--- STRESS SUITE RESULT ---');
    console.log(JSON.stringify(report.evaluation, null, 2));
    console.log(`reportPath=${reportPath}`);

    process.exit(report.evaluation && report.evaluation.pass ? 0 : 1);
  }
}

main();
