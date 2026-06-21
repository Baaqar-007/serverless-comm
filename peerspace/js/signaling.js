/**
 * signaling.js — WebSocket (Socket.io) signaling
 *
 * Changes vs v1:
 *  1. join-room now passes peerId as second arg so the server can
 *     build a socketId→peerId map for targeted signal routing.
 *  2. Listens for 'peer-list'   (array of peerIds already in room)
 *                  'peer-joined' (a new peer arrived after us)
 *                  'peer-left'   (a peer disconnected)
 *     These three events replace the old user-connected/disconnected pair
 *     and are the only server→client messages that room.js reacts to.
 *  3. Everything else (send, on, dispatch, destroy) is unchanged so
 *     room.js can consume them with the same API.
 */
'use strict';

class Signaling {
  constructor(roomId, peerId) {
    this._roomId   = roomId;
    this._peerId   = peerId;
    this._handlers = {};

    const SERVER_URL = 'https://peerspace-k66e.onrender.com/';
    if (typeof io === 'undefined') {
      throw new Error('Socket.io client library is missing.');
    }

    this._socket = io(SERVER_URL);

    this._socket.on('connect', () => {
      // CHANGE 1: pass peerId so the server can route targeted signals
      this._socket.emit('join-room', this._roomId, this._peerId);
    });

    // CHANGE 2: new server→client events for mesh peer discovery
    this._socket.on('peer-list',   peerIds => this._dispatch({ type: 'peer-list',   peerIds }));
    this._socket.on('peer-joined', peerId  => this._dispatch({ type: 'peer-joined', from: peerId }));
    this._socket.on('peer-left',   peerId  => this._dispatch({ type: 'peer-left',   from: peerId }));

    this._socket.on('signal',        msg => this._dispatch(msg));
    this._socket.on('room-full',     ()  => this._dispatch({ type: 'room-full' }));
    this._socket.on('connect_error', err => console.error('[Signaling] connection error', err));
  }

  // ── Routing ────────────────────────────────────────────────────

  _dispatch(msg) {
    if (msg.to && msg.to !== this._peerId) return;
    const handler = this._handlers[msg.type];
    if (handler) handler(msg);
  }

  // ── Public API ─────────────────────────────────────────────────

  on(type, handler) {
    this._handlers[type] = handler;
    return this;
  }

  send(type, data = {}, to = null) {
    this._socket.emit('signal', {
      roomId: this._roomId,
      type,
      from: this._peerId,
      to,
      ...data,
    });
  }

  destroy() {
    this._socket.disconnect();
    this._handlers = {};
  }
}