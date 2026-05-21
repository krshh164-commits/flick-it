const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;
const clients = new Set();
const roomClients = new Map();
const chatHistory = [];
const rooms = new Map();
const COLORS = new Set(['red', 'blue', 'green', 'yellow', 'black']);

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
  room.started = true;
  room.seed = Date.now();
  room.currentTurnId = room.players[0]?.id || null;
  room.currentTurnStartedAt = Date.now();
  room.cubeAvailable = true;
  broadcastRoom(room.id, 'room', publicRoom(room));
  broadcastRoom(room.id, 'start', publicRoom(room));
  res.json({ ok: true, room: publicRoom(room) });
});

app.post('/api/rooms/:roomId/turn', (req, res) => {
  const room = getRoom(req.params.roomId);
  const playerId = String(req.body?.playerId || '').trim();
  if (!room.started) return res.status(409).json({ ok: false, error: 'Game not started' });
  if (!room.players.some(p => p.id === playerId)) return res.status(403).json({ ok: false, error: 'Player not in room' });

  const nextTurnId = String(req.body?.nextTurnId || '').trim();
  if (nextTurnId && room.players.some(p => p.id === nextTurnId)) {
    room.currentTurnId = nextTurnId;
  }
  room.currentTurnStartedAt = Date.now();
  if (req.body?.cubeAvailable === false) room.cubeAvailable = false;

  broadcastRoom(room.id, 'room', publicRoom(room));
  res.json({ ok: true, room: publicRoom(room) });
});

app.post('/api/rooms/:roomId/game-event', (req, res) => {
  const room = getRoom(req.params.roomId);
  const playerId = String(req.body?.playerId || '').trim();
  if (!room.started) return res.status(409).json({ ok: false, error: 'Game not started' });
  if (room.currentTurnId && room.currentTurnId !== playerId) return res.status(403).json({ ok: false, error: 'Not your turn' });

  const type = String(req.body?.type || '').trim();
  if (!type) return res.status(400).json({ ok: false });

  broadcastRoom(room.id, 'game', {
    playerId,
    type,
    payload: req.body?.payload || {},
    time: Date.now()
  });
  res.json({ ok: true });
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
  const room = { id, mode, hostId: null, currentTurnId: null, currentTurnStartedAt: 0, cubeAvailable: true, started: false, seed: Date.now(), players: [], chatHistory: [] };
  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  const clean = cleanRoomId(id) || createRoom().id;
  if (!rooms.has(clean)) rooms.set(clean, { id: clean, mode: 'classic', hostId: null, currentTurnId: null, currentTurnStartedAt: 0, cubeAvailable: true, started: false, seed: Date.now(), players: [], chatHistory: [] });
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
    seed: room.seed,
    players: room.players
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
