/**
 * signaling.js — WebSocket (Socket.io) signaling
 */
'use strict';

class Signaling {
  constructor(roomId, peerId) {
    this._roomId   = roomId;
    this._peerId   = peerId;
    this._handlers = {};

    // Point this to your hosted server URL in production
    const SERVER_URL = `http://${window.location.hostname}:3000`;    
    if (typeof io === 'undefined') {
      throw new Error('Socket.io client library is missing.');
    }

    this._socket = io(SERVER_URL);

    this._socket.on('connect', () => {
      this._socket.emit('join-room', this._roomId);
    });

    this._socket.on('signal', (msg) => this._dispatch(msg));
    this._socket.on('connect_error', (err) => console.error('[Signaling] connection error', err));
  }

  // ── Routing ────────────────────────────────────────────────────

  _dispatch(msg) {
    // Drop messages targeted at someone else
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