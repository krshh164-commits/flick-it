const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;
const clients = new Set();
const roomClients = new Map();
const chatHistory = [];
const rooms = new Map();
const COLORS = new Set(['red', 'blue', 'green', 'yellow', 'black']);

// ── PHYSICS CONSTANTS ─────────────────────────────────────────────────────────
const REF_W = 880, REF_H = 600;
const HALF_LEN = 100, HALF_W = 5;
const FRICTION = 0.87;
const COLLISION_ITERS = 8;
const STICKS_PER = 4;
const CLASSIC_PENS_PER = 3;
const PEN_STATS = {
  3: { mass: 0.5,  friction: 0.97 },
  2: { mass: 1.0,  friction: 0.78 },
  4: { mass: 1.12, friction: 0.88 },
  5: { mass: 0.92, friction: 0.84 }
};
const BATTLE_PEN_TYPES = [3, 4, 5, 2];

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/events', (req, res) => {
  const roomId = cleanRoomId(req.query.room);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  if (roomId) {
    const room = getRoom(roomId);
    res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(room.chatHistory)}\n\n`);
    addRoomClient(roomId, res);
    req.on('close', () => removeRoomClient(roomId, res));
  } else {
    res.write(`event: history\ndata: ${JSON.stringify(chatHistory)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }
});

app.post('/api/rooms', (req, res) => {
  const mode = String(req.body?.mode || 'classic') === 'battle' ? 'battle' : 'classic';
  const room = createRoom(mode);
  res.json(publicRoom(room));
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.json(publicRoom(room));
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const room = getRoom(req.params.roomId);
  const name = String(req.body?.name || '').trim().slice(0, 14);
  const colorId = String(req.body?.colorId || '').trim();
  let playerId = String(req.body?.playerId || '').trim();
  if (!name || !COLORS.has(colorId)) return res.status(400).json({ ok: false });

  let existing = playerId ? room.players.find(p => p.id === playerId) : null;
  if (!existing && room.players.length >= 5) return res.status(409).json({ ok: false, error: 'Room full' });
  if (room.players.some(p => p.id !== playerId && p.colorId === colorId)) {
    return res.status(409).json({ ok: false, error: 'Colour taken' });
  }

  if (existing) {
    existing.name = name;
    existing.colorId = colorId;
  } else {
    playerId = makePlayerId();
    room.players.push({ id: playerId, name, colorId });
    if (!room.hostId) room.hostId = playerId;
  }

  broadcastRoom(room.id, 'room', publicRoom(room));
  res.json({ ok: true, playerId, room: publicRoom(room) });
});

app.post('/api/rooms/:roomId/start', (req, res) => {
  const room = getRoom(req.params.roomId);
  const playerId = String(req.body?.playerId || '').trim();
  if (room.hostId && room.hostId !== playerId) return res.status(403).json({ ok: false, error: 'Only host can start' });
  if (room.players.length < 2) return res.status(409).json({ ok: false, error: 'Need at least 2 players' });

  if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }

  room.started = true;
  room.gameOver = false;
  room.seed = Date.now();
  room.currentTurnId = room.players[0]?.id || null;
  room.currentTurnStartedAt = Date.now();
  room.cubeAvailable = true;
  room.eliminatedPlayerIds = [];
  room.scores = { black: 0, blue: 0 };

  placeServerSticks(room);
  startRoomGameLoop(room);

  const stickData = room.serverSticks.map(s => s.serialize());
  broadcastRoom(room.id, 'room', publicRoom(room));
  broadcastRoom(room.id, 'start', { room: publicRoom(room), sticks: stickData });
  res.json({ ok: true, room: publicRoom(room), sticks: stickData });
});

app.post('/api/rooms/:roomId/flick', (req, res) => {
  const room = getRoom(req.params.roomId);
  const playerId = String(req.body?.playerId || '').trim();
  if (!room.started || room.gameOver) return res.status(409).json({ ok: false, error: 'Game not active' });
  if (room.currentTurnId && room.currentTurnId !== playerId) return res.status(403).json({ ok: false, error: 'Not your turn' });

  const stickIdx = parseInt(req.body?.stickIndex ?? -1);
  // stickIndex === -1 means skip turn (idle timeout)
  if (stickIdx === -1) {
    switchRoomTurn(room);
    broadcastRoom(room.id, 'turn', { currentTurnId: room.currentTurnId, currentTurnStartedAt: room.currentTurnStartedAt });
    return res.json({ ok: true, currentTurnId: room.currentTurnId });
  }

  const fx = parseFloat(req.body?.fx) || 0;
  const fy = parseFloat(req.body?.fy) || 0;
  const leverage = parseFloat(req.body?.leverage) || 0;
  const axisOff = parseFloat(req.body?.axisOff) || 0;

  const ss = room.serverSticks;
  if (!ss || stickIdx < 0 || stickIdx >= ss.length) return res.status(400).json({ ok: false, error: 'Invalid stick' });
  const stick = ss[stickIdx];
  if (stick.gone) return res.status(400).json({ ok: false, error: 'Stick already gone' });

  // Validate team ownership
  const playerIdx = room.players.findIndex(p => p.id === playerId);
  const expectedTeam = room.mode === 'battle'
    ? (playerIdx === 0 ? 'black' : 'blue')
    : 'classic' + playerIdx;
  if (stick.team !== expectedTeam) return res.status(403).json({ ok: false, error: 'Not your pen' });

  stick.kick(fx, fy, leverage, axisOff);
  switchRoomTurn(room);
  broadcastRoom(room.id, 'turn', { currentTurnId: room.currentTurnId, currentTurnStartedAt: room.currentTurnStartedAt });
  res.json({ ok: true, currentTurnId: room.currentTurnId });
});

app.post('/api/rooms/:roomId/leave', (req, res) => {
  const room = getRoom(req.params.roomId);
  const playerId = String(req.body?.playerId || '').trim();
  const before = room.players.length;
  room.players = room.players.filter(p => p.id !== playerId);
  if (room.hostId === playerId) room.hostId = room.players[0]?.id || null;
  if (before !== room.players.length) broadcastRoom(room.id, 'room', publicRoom(room));
  res.json({ ok: true, room: publicRoom(room) });
});

app.post('/chat', (req, res) => {
  const msg = normalizeEvent(req.body, 'chat');
  if (!msg) return res.status(400).json({ ok: false });
  const roomId = cleanRoomId(req.body?.roomId);
  if (roomId) {
    const room = getRoom(roomId);
    room.chatHistory.push(msg);
    while (room.chatHistory.length > 40) room.chatHistory.shift();
    broadcastRoom(room.id, 'chat', msg);
  } else {
    chatHistory.push(msg);
    while (chatHistory.length > 40) chatHistory.shift();
    broadcast('chat', msg);
  }
  res.json({ ok: true });
});

app.post('/reaction', (req, res) => {
  const msg = normalizeEvent(req.body, 'reaction');
  if (!msg) return res.status(400).json({ ok: false });
  const roomId = cleanRoomId(req.body?.roomId);
  if (roomId) {
    const room = getRoom(roomId);
    room.chatHistory.push(msg);
    while (room.chatHistory.length > 40) room.chatHistory.shift();
    broadcastRoom(room.id, 'reaction', msg);
  } else {
    chatHistory.push(msg);
    while (chatHistory.length > 40) chatHistory.shift();
    broadcast('reaction', msg);
  }
  res.json({ ok: true });
});

// ── LCG SEEDED RANDOM ─────────────────────────────────────────────────────────
function makeLCG(seed) {
  let s = (seed >>> 0) || 1;
  return {
    rand() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    },
    range(lo, hi) { return lo + this.rand() * (hi - lo); }
  };
}

// ── GEOMETRY ──────────────────────────────────────────────────────────────────
function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.sqrt((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2);
}

function segsTooClose(ax, ay, bx, by, cx, cy, dx, dy, thresh) {
  for (let t = 0; t <= 1; t += 0.1)
    if (ptSegDist(ax + (bx - ax) * t, ay + (by - ay) * t, cx, cy, dx, dy) < thresh) return true;
  return false;
}

function closestSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const u = { x: bx - ax, y: by - ay }, v = { x: dx - cx, y: dy - cy }, w = { x: ax - cx, y: ay - cy };
  const a = u.x * u.x + u.y * u.y, e = v.x * v.x + v.y * v.y, f = v.x * w.x + v.y * w.y;
  let s, t;
  if (a < 1e-6 && e < 1e-6) { s = 0; t = 0; }
  else if (a < 1e-6) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = u.x * w.x + u.y * w.y;
    if (e < 1e-6) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b2 = u.x * v.x + u.y * v.y, denom = a * e - b2 * b2;
      s = denom !== 0 ? Math.min(1, Math.max(0, (b2 * f - c * e) / denom)) : 0;
      t = Math.min(1, Math.max(0, (b2 * s + f) / e));
      s = Math.min(1, Math.max(0, (b2 * t - c) / a));
      t = Math.min(1, Math.max(0, (b2 * s + f) / e));
    }
  }
  const p1x = ax + s * u.x, p1y = ay + s * u.y, p2x = cx + t * v.x, p2y = cy + t * v.y;
  const ddx = p1x - p2x, ddy = p1y - p2y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
  return { d: dd, nx: dd > 0 ? ddx / dd : 1, ny: dd > 0 ? ddy / dd : 0, s, t };
}

// ── SERVER STICK ──────────────────────────────────────────────────────────────
class ServerStick {
  constructor(x, y, angle, team, penType, classicPlayerIdx, rng) {
    this.x = x; this.y = y;
    this.vx = rng ? rng.range(-0.2, 0.2) : 0;
    this.vy = rng ? rng.range(-0.1, 0.1) : 0;
    this.angle = angle;
    this.angVel = rng ? rng.range(-0.015, 0.015) : 0;
    this.rollPhase = rng ? rng.range(0, Math.PI * 2) : 0;
    this.rollVel = 0;
    this.team = team;
    this.classicPlayerIdx = classicPlayerIdx ?? -1;
    this.penType = penType;
    this.stats = PEN_STATS[penType] || { mass: 1, friction: FRICTION };
    this.gone = false;
    this.fallT = 0;
    this.fallDirX = 0; this.fallDirY = 1;
    this.calcEnds();
  }

  calcEnds() {
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
    this.ax = this.x + ca * HALF_LEN; this.ay = this.y + sa * HALF_LEN;
    this.bx = this.x - ca * HALF_LEN; this.by = this.y - sa * HALF_LEN;
  }

  kick(fx, fy, leverage, axisOff) {
    this.vx += fx / this.stats.mass;
    this.vy += fy / this.stats.mass;
    const cross = fx * Math.sin(this.angle) - fy * Math.cos(this.angle);
    const tipFactor = Math.pow(Math.abs(axisOff), 1.35);
    this.angVel += (cross * (0.2 + Math.abs(leverage))) / (HALF_LEN * 1.4 * this.stats.mass);
    const fmag = Math.sqrt(fx * fx + fy * fy);
    this.angVel += axisOff * fmag * (0.0012 + tipFactor * 0.0032) / this.stats.mass;
    this.rollVel += axisOff * fmag * 0.018 / this.stats.mass;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= this.stats.friction;
    this.vy *= this.stats.friction;
    this.angle += this.angVel;
    this.angVel *= this.stats.friction;
    this.rollPhase += this.rollVel;
    this.rollVel *= 0.9;

    if (this.gone) {
      this.fallT = Math.min(1, this.fallT + 0.04);
      this.x += this.fallDirX * (1.5 + this.fallT * 2.2);
      this.y += this.fallDirY * (1.5 + this.fallT * 2.2);
      this.vx *= 0.92; this.vy *= 0.92;
      this.angVel += 0.003;
    }

    this.calcEnds();
    if (!this.gone) this.checkBoundary();
  }

  checkBoundary() {
    let outside = 0;
    const total = 9;
    for (let i = 0; i < total; i++) {
      const tt = i / (total - 1);
      const px = this.ax + (this.bx - this.ax) * tt;
      const py = this.ay + (this.by - this.ay) * tt;
      if (px < 0 || px > REF_W || py < 0 || py > REF_H) outside++;
    }
    if (outside > total / 2) {
      this.gone = true; this.fallT = 0;
      let fdx = this.x - REF_W / 2, fdy = this.y - REF_H / 2;
      const fm = Math.sqrt(fdx * fdx + fdy * fdy);
      if (fm < 1) { fdx = 0; fdy = 1; }
      else { fdx /= fm; fdy /= fm; }
      this.fallDirX = fdx; this.fallDirY = fdy;
      return;
    }
    if (outside === 0) {
      const m = 6;
      if (this.x < m)       { this.x = m;       this.vx *= -0.4; }
      if (this.x > REF_W-m) { this.x = REF_W-m; this.vx *= -0.4; }
      if (this.y < m)       { this.y = m;        this.vy *= -0.4; }
      if (this.y > REF_H-m) { this.y = REF_H-m; this.vy *= -0.4; }
    }
  }

  resolve(other) {
    if (this.gone || other.gone) return;
    const res = closestSegSeg(this.ax, this.ay, this.bx, this.by, other.ax, other.ay, other.bx, other.by);
    const minD = HALF_W * 2 + 4;
    if (res.d >= minD) return;
    const invA = 1 / this.stats.mass, invB = 1 / other.stats.mass, invSum = invA + invB;
    const corr = Math.max(minD - res.d - 0.5, 0) / invSum;
    this.x  += res.nx * corr * invA; this.y  += res.ny * corr * invA;
    other.x -= res.nx * corr * invB; other.y -= res.ny * corr * invB;
    this.calcEnds(); other.calcEnds();
    const rvx = this.vx - other.vx, rvy = this.vy - other.vy;
    const dot = rvx * res.nx + rvy * res.ny;
    if (dot < 0) {
      const impulse = (-(1 + 0.55) * dot) / invSum;
      this.vx  += impulse * invA * res.nx; this.vy  += impulse * invA * res.ny;
      other.vx -= impulse * invB * res.nx; other.vy -= impulse * invB * res.ny;
      this.angVel  += dot * 0.008 * invA; other.angVel -= dot * 0.008 * invB;
      this.angVel  += (res.s - 0.5) * Math.abs(dot) * 0.028 * invA;
      other.angVel -= (res.t - 0.5) * Math.abs(dot) * 0.028 * invB;
      this.rollVel  += (res.s - 0.5) * Math.abs(dot) * 0.035;
      other.rollVel -= (res.t - 0.5) * Math.abs(dot) * 0.035;
    }
    this.calcEnds(); other.calcEnds();
  }

  serialize() {
    return {
      x: this.x, y: this.y,
      vx: this.vx, vy: this.vy,
      angle: this.angle, angVel: this.angVel,
      rollPhase: this.rollPhase, rollVel: this.rollVel,
      gone: this.gone, fallT: this.fallT,
      fallDirX: this.fallDirX, fallDirY: this.fallDirY,
      team: this.team, penType: this.penType,
      classicPlayerIdx: this.classicPlayerIdx
    };
  }
}

// ── STICK PLACEMENT ───────────────────────────────────────────────────────────
function placeServerSticks(room) {
  const rng = makeLCG(room.seed);
  const cx = REF_W / 2, cy = REF_H / 2;
  const sx = REF_W * 0.38, sy = REF_H * 0.38;
  const all = [];
  if (room.mode === 'battle') {
    for (const team of ['black', 'blue']) {
      for (let i = 0; i < STICKS_PER; i++) {
        const s = placeSingleServer(cx, cy, sx, sy, all, team, BATTLE_PEN_TYPES[i], -1, rng);
        if (s) all.push(s);
      }
    }
  } else {
    room.players.forEach((p, idx) => {
      for (let i = 0; i < CLASSIC_PENS_PER; i++) {
        const s = placeSingleServer(cx, cy, sx, sy, all, 'classic' + idx, 3, idx, rng);
        if (s) all.push(s);
      }
    });
  }
  room.serverSticks = all;
}

function placeSingleServer(cx, cy, sx, sy, all, team, penType, classicIdx, rng) {
  for (let tries = 0; tries < 3000; tries++) {
    const x = cx + rng.range(-sx, sx);
    const y = cy + rng.range(-sy, sy);
    const ang = rng.range(0, Math.PI * 2);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ax = x + ca * HALF_LEN, ay = y + sa * HALF_LEN;
    const bx = x - ca * HALF_LEN, by = y - sa * HALF_LEN;
    if (ax < 10 || ax > REF_W-10 || bx < 10 || bx > REF_W-10 ||
        ay < 10 || ay > REF_H-10 || by < 10 || by > REF_H-10) continue;
    let ok = true;
    for (const s of all) {
      if (segsTooClose(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by, HALF_W * 7)) { ok = false; break; }
    }
    if (!ok) continue;
    return new ServerStick(x, y, ang, team, penType, classicIdx, rng);
  }
  return null;
}

// ── GAME LOOP ─────────────────────────────────────────────────────────────────
function startRoomGameLoop(room) {
  if (room._tickInterval) clearInterval(room._tickInterval);
  room._tickInterval = setInterval(() => tickRoom(room), 33);
}

function tickRoom(room) {
  if (!room.started || room.gameOver) return;
  const ss = room.serverSticks;
  if (!ss || !ss.length) return;

  for (const s of ss) s.update();

  for (let iter = 0; iter < COLLISION_ITERS; iter++)
    for (let i = 0; i < ss.length; i++)
      for (let j = i + 1; j < ss.length; j++)
        ss[i].resolve(ss[j]);

  // Track eliminated players / scores
  if (room.mode === 'classic') {
    room.players.forEach((p, idx) => {
      if (room.eliminatedPlayerIds.includes(p.id)) return;
      if (!ss.some(s => s.team === 'classic' + idx && !s.gone))
        room.eliminatedPlayerIds.push(p.id);
    });
  } else {
    let bl = 0, bk = 0;
    for (const s of ss) { if (s.gone) { if (s.team === 'black') bk++; else bl++; } }
    room.scores = { black: bk, blue: bl };
  }

  const win = checkServerWin(room);
  if (win) { endRoomGame(room, win.winner, win.leftCounts); return; }

  broadcastRoom(room.id, 'gamestate', {
    sticks: ss.map(s => s.serialize()),
    currentTurnId: room.currentTurnId,
    currentTurnStartedAt: room.currentTurnStartedAt,
    eliminatedPlayerIds: room.eliminatedPlayerIds,
    scores: room.scores
  });
}

function checkServerWin(room) {
  const ss = room.serverSticks;
  if (room.mode === 'battle') {
    const blackLeft = ss.filter(s => s.team === 'black' && !s.gone).length;
    const blueLeft  = ss.filter(s => s.team === 'blue'  && !s.gone).length;
    if (blackLeft !== 0 && blueLeft !== 0) return null;
    let winner;
    if (blackLeft === 0 && blueLeft === 0) winner = 'DRAW';
    else if (blackLeft === 0) winner = room.players[1]?.name || 'Blue';
    else winner = room.players[0]?.name || 'Black';
    return { winner, leftCounts: { black: blackLeft, blue: blueLeft } };
  }
  const alive = room.players.filter(p => !room.eliminatedPlayerIds.includes(p.id));
  if (alive.length > 1) return null;
  const winner = alive.length === 1 ? alive[0].name : 'DRAW';
  const leftCounts = {};
  room.players.forEach((p, idx) => {
    leftCounts[p.id] = ss.filter(s => s.team === 'classic' + idx && !s.gone).length;
  });
  return { winner, leftCounts };
}

function endRoomGame(room, winner, leftCounts) {
  room.gameOver = true;
  if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }
  broadcastRoom(room.id, 'winner', {
    winner, leftCounts,
    sticks: room.serverSticks ? room.serverSticks.map(s => s.serialize()) : []
  });
}

function switchRoomTurn(room) {
  if (room.mode === 'battle') {
    const idx = room.players.findIndex(p => p.id === room.currentTurnId);
    room.currentTurnId = room.players[(idx + 1) % Math.max(room.players.length, 1)]?.id || null;
  } else {
    const alive = room.players.filter(p => !room.eliminatedPlayerIds.includes(p.id));
    if (!alive.length) return;
    const idx = alive.findIndex(p => p.id === room.currentTurnId);
    room.currentTurnId = alive[(idx + 1) % alive.length].id;
  }
  room.currentTurnStartedAt = Date.now();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function normalizeEvent(body, type) {
  if (!body || typeof body !== 'object') return null;
  const text = String(body.text || '').trim().slice(0, 80);
  const name = String(body.name || 'Player').trim().slice(0, 20);
  const color = String(body.color || '#eee').trim().slice(0, 16);
  if (!text) return null;
  return { type, name, color, text, time: Date.now() };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function createRoom(mode = 'classic') {
  let id;
  do { id = Math.random().toString(36).slice(2, 8).toUpperCase(); }
  while (rooms.has(id));
  const room = {
    id, mode, hostId: null,
    currentTurnId: null, currentTurnStartedAt: 0,
    cubeAvailable: true, started: false, gameOver: false,
    seed: Date.now(), players: [], chatHistory: [],
    eliminatedPlayerIds: [], scores: { black: 0, blue: 0 },
    serverSticks: null, _tickInterval: null
  };
  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  const clean = cleanRoomId(id) || createRoom().id;
  if (!rooms.has(clean)) {
    rooms.set(clean, {
      id: clean, mode: 'classic', hostId: null,
      currentTurnId: null, currentTurnStartedAt: 0,
      cubeAvailable: true, started: false, gameOver: false,
      seed: Date.now(), players: [], chatHistory: [],
      eliminatedPlayerIds: [], scores: { black: 0, blue: 0 },
      serverSticks: null, _tickInterval: null
    });
  }
  return rooms.get(clean);
}

function cleanRoomId(value) {
  const id = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return id || '';
}

function makePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

function publicRoom(room) {
  return {
    id: room.id,
    mode: room.mode || 'classic',
    hostId: room.hostId,
    currentTurnId: room.currentTurnId || null,
    currentTurnStartedAt: room.currentTurnStartedAt || 0,
    cubeAvailable: room.cubeAvailable !== false,
    started: room.started,
    gameOver: room.gameOver || false,
    seed: room.seed,
    players: room.players,
    eliminatedPlayerIds: room.eliminatedPlayerIds || [],
    scores: room.scores || { black: 0, blue: 0 }
  };
}

function addRoomClient(roomId, res) {
  if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
  roomClients.get(roomId).add(res);
}

function removeRoomClient(roomId, res) {
  const set = roomClients.get(roomId);
  if (!set) return;
  set.delete(res);
  if (!set.size) roomClients.delete(roomId);
}

function broadcastRoom(roomId, event, data) {
  const set = roomClients.get(roomId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of set) client.write(payload);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
