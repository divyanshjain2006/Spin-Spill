import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { RoomModel } from './models/Room.js';
import * as game from './services/game.js';

const app = express();

// ------------------------------------------------------------------
// Trust the first proxy hop (GitHub Codespaces / Render / Railway).
// This lets Express read the real client IP from the X-Forwarded-For
// header instead of seeing the proxy's IP.  Using `1` (a number) is
// safer than `true` because it only trusts ONE hop, so rate-limiting
// still works correctly and cannot be spoofed by arbitrary headers.
// ------------------------------------------------------------------
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));

// CORS: allow the configured CLIENT_URL in production.
// In development the Vite proxy forwards requests from the same origin,
// so the browser never sends a cross-origin request and this header is
// not needed.  Keeping origin: true as the fallback is intentional for
// local development convenience; tighten it for production by setting
// CLIENT_URL to the actual frontend domain.
const corsOptions = {
  origin: process.env.CLIENT_URL || true,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 150 }));

// ------------------------------------------------------------------
// In-memory room store + optional MongoDB persistence
// ------------------------------------------------------------------
const rooms = new Map();
const code = () =>
  Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]
  ).join('');

async function save(room) {
  rooms.set(room.code, room);
  if (mongoose.connection.readyState === 1)
    await RoomModel.findOneAndUpdate({ code: room.code }, { state: room }, { upsert: true });
}

async function find(roomCode) {
  if (rooms.has(roomCode)) return rooms.get(roomCode);
  if (mongoose.connection.readyState === 1) {
    const record = await RoomModel.findOne({ code: roomCode });
    if (record) { rooms.set(roomCode, record.state); return record.state; }
  }
  return null;
}

const cleanName = name => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 24)
    throw Error('Use a display name of 1–24 characters');
  return name.trim();
};

// ------------------------------------------------------------------
// REST endpoints
// ------------------------------------------------------------------
app.get('/api/health', (_, res) =>
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'memory fallback' })
);

app.get('/api/rooms/:code', async (req, res) => {
  const room = await find(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(game.publicRoom(room));
});

// ------------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

function emit(room) {
  for (const member of room.players)
    io.to(`player:${member.id}`).emit('room:update', game.publicRoom(room, member.id));
}

function fail(callback, error) {
  callback?.({ ok: false, error: error.message || 'Something went wrong' });
}

io.on('connection', socket => {
  socket.on('room:create', async ({ name }, callback) => {
    try {
      const token = crypto.randomUUID();
      let roomCode = code();
      while (await find(roomCode)) roomCode = code();
      const room = game.createRoom(cleanName(name), token, roomCode);
      await save(room);
      socket.join(`room:${roomCode}`);
      socket.join(`player:${room.players[0].id}`);
      socket.data.member = { code: roomCode, id: room.players[0].id };
      callback({ ok: true, code: roomCode, playerId: room.players[0].id, token, room: game.publicRoom(room, room.players[0].id) });
    } catch (e) { fail(callback, e); }
  });

  socket.on('room:join', async ({ code: raw, name, playerId, token }, callback) => {
    try {
      const room = await find(raw?.toUpperCase());
      if (!room) throw Error('Room not found');
      let player;
      if (playerId && token) player = room.players.find(p => p.id === playerId && p.token === token);
      if (player) {
        player.connected = true;
      } else {
        if (room.phase !== 'LOBBY' && !room.settings.allowLateJoin) throw Error('This room is not accepting new players');
        const displayName = cleanName(name);
        if (room.players.some(p => p.name.toLowerCase() === displayName.toLowerCase())) throw Error('That display name is already in use');
        player = { id: game.id(), name: displayName, token: crypto.randomUUID(), connected: true, isHost: false, joinedAt: Date.now() };
        room.players.push(player);
      }
      socket.join(`room:${room.code}`);
      socket.join(`player:${player.id}`);
      socket.data.member = { code: room.code, id: player.id };
      await save(room);
      emit(room);
      callback({ ok: true, code: room.code, playerId: player.id, token: player.token, room: game.publicRoom(room, player.id) });
    } catch (e) { fail(callback, e); }
  });

  const action = (event, fn) => socket.on(event, async (data, callback) => {
    try {
      const room = await find(data.code);
      if (!room) throw Error('Room not found');
      const p = game.getPlayer(room, data.playerId, data.token);
      const result = fn(room, p, data);
      await save(room);
      emit(room);
      callback?.({ ok: true, result, room: game.publicRoom(room, p.id) });
    } catch (e) { fail(callback, e); }
  });

  action('game:start',    (r, p)    => game.start(r, p));
  action('game:spin',     (r, p)    => game.spin(r, p));
  action('game:target',   (r, p, d) => game.chooseTarget(r, p, d.targetId));
  action('game:category', (r, p, d) => game.chooseCategory(r, p, d.type));
  action('task:submit',   (r, p, d) => game.submit(r, p, d.text, d.type));
  action('task:draw',     (r, p)    => game.draw(r, p));
  action('task:resolve',  (r, p, d) => game.resolve(r, p, d.action));
  action('game:next',     (r, p)    => game.next(r, p));
  action('room:settings', (r, p, d) => {
    if (r.hostId !== p.id) throw Error('Host permission required');
    Object.assign(r.settings, d.settings);
  });

  socket.on('disconnect', async () => {
    const member = socket.data.member;
    if (!member) return;
    const room = await find(member.code);
    const p = room?.players.find(x => x.id === member.id);
    if (p) { p.connected = false; await save(room); emit(room); }
  });
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
const port = Number(process.env.PORT || 3001);

if (process.env.MONGODB_URI)
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(() => console.warn('MongoDB unavailable; using local memory for this session.'));

if (process.env.NODE_ENV !== 'test')
  server.listen(port, () => console.log(`Spin & Spill server listening on ${port}`));

export { app, server };

