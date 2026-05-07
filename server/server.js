

'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const ROOM_MAX = 4;

// roomId → Map< socketId, peerId >
// Lets us route a targeted signal (msg.to = peerId) to the right socket.
const rooms = {};

// ─────────────────────────────────────────────────────────────────────────────
// THE BUG IN THE ORIGINAL: `socket` was referenced at module level (line 14 of
// the old file) before any connection existed. Every line below `io.on` is the
// fix — all socket logic now lives inside the connection callback.
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let currentRoom = null;   // room this socket is in
  let myPeerId    = null;   // the client-generated UUID for this peer

  // ── Join ──────────────────────────────────────────────────────────────────
  // Client now sends peerId as second arg so we can map signals to sockets.
  socket.on('join-room', (roomId, peerId) => {
    if (!rooms[roomId]) rooms[roomId] = new Map();
    const room = rooms[roomId];

    if (room.size >= ROOM_MAX) {
      socket.emit('room-full');
      return;
    }

    currentRoom = roomId;
    myPeerId    = peerId;
    room.set(socket.id, peerId);
    socket.join(roomId);

    // Tell the newcomer who is already here (peerIds only; names come via announce)
    const existing = [...room.values()].filter(pid => pid !== peerId);
    socket.emit('peer-list', existing);

    // Tell everyone else a new peer arrived
    socket.to(roomId).emit('peer-joined', peerId);

    console.log(`[room ${roomId}] peer ${peerId.slice(0,8)} joined (${room.size}/${ROOM_MAX})`);
  });

  // ── Signal relay ──────────────────────────────────────────────────────────
  // All WebRTC messages (announce, offer, answer, ice, leaving…) travel as
  // { type, from, to?, roomId, ...payload }.
  // If msg.to is set, deliver only to that peer; otherwise broadcast to room.
  socket.on('signal', msg => {
    if (!currentRoom) return;

    if (msg.to) {
      const room = rooms[currentRoom];
      if (!room) return;
      for (const [sid, pid] of room) {
        if (pid === msg.to) {
          io.to(sid).emit('signal', msg);
          return;
        }
      }
      // Target not found — they may have left already; silently drop
    } else {
      // Broadcast to everyone else in the room
      socket.to(currentRoom).emit('signal', msg);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].delete(socket.id);
    if (rooms[currentRoom].size === 0) {
      delete rooms[currentRoom];
      console.log(`[room ${currentRoom}] empty — cleaned up`);
    }
    // Notify remaining peers so they can close their connection to this peer
    io.to(currentRoom).emit('peer-left', myPeerId);
    console.log(`[room ${currentRoom}] peer ${(myPeerId||'?').slice(0,8)} left`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[PeerSpace] signaling server on :${PORT}`));