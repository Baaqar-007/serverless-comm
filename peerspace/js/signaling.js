/**
 * signaling.js — BroadcastChannel signaling
 *
 * Works across tabs/windows on the same origin (Chrome recommended).
 * The server role is played by BroadcastChannel — no backend needed.
 *
 * Message envelope:
 *   { type, from, to, ...payload }
 *   to = null  → broadcast to all peers in room
 *   to = peerId → targeted delivery
 */
'use strict';

class Signaling {
  constructor(roomId, peerId) {
    if (!('BroadcastChannel' in window)) {
      throw new Error('BroadcastChannel not supported. Use Chrome or a modern browser.');
    }

    this._peerId   = peerId;
    this._handlers = {};
    this._channel  = new BroadcastChannel(PS.SIGNAL_CHANNEL(roomId));

    this._channel.onmessage      = (e) => this._dispatch(e.data);
    this._channel.onmessageerror = (e) => console.error('[Signaling] parse error', e);
  }

  // ── Routing ────────────────────────────────────────────────────

  _dispatch(msg) {
    // Ignore our own reflections (should not happen with BC, defensive)
    if (msg.from === this._peerId) return;
    // Drop messages targeted at someone else
    if (msg.to && msg.to !== this._peerId) return;

    const handler = this._handlers[msg.type];
    if (handler) handler(msg);
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Register a handler for an incoming message type.
   * Returns `this` for chaining.
   */
  on(type, handler) {
    this._handlers[type] = handler;
    return this;
  }

  /**
   * Broadcast or send a targeted message.
   * @param {string} type  - message type
   * @param {object} data  - payload (spread into envelope)
   * @param {string} [to]  - target peerId (null = broadcast)
   */
  send(type, data = {}, to = null) {
    this._channel.postMessage({
      type,
      from: this._peerId,
      to,
      ...data,
    });
  }

  destroy() {
    this._channel.close();
    this._handlers = {};
  }
}
