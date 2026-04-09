/**
 * doc-sync.js — Document synchronisation over RTCDataChannel
 *
 * Protocol:
 *   Each change is tagged with a monotonically increasing local sequence
 *   number and a timestamp. The receiver applies the update only if the
 *   incoming sequence is strictly greater than the last seen sequence
 *   from that sender — preventing stale replays.
 *
 *   For a production system this is replaced by Yjs CRDT. For the demo
 *   this is sufficient and keeps the file dependency-free.
 */
'use strict';

class DocSync {
  /**
   * @param {function} onRemoteUpdate - called with (text) when remote change arrives
   */
  constructor(onRemoteUpdate) {
    this._onRemote   = onRemoteUpdate;
    this._localSeq   = 0;
    this._remoteSeq  = 0;
    this._suppress   = false; // true while applying remote update
  }

  /**
   * Package a local edit for sending.
   * @param {string} text - full document text after edit
   * @returns {string} JSON string to send over DataChannel
   */
  pack(text) {
    this._localSeq++;
    return JSON.stringify({
      t:   'doc',
      seq: this._localSeq,
      txt: text,
      ts:  Date.now(),
    });
  }

  /**
   * Handle incoming data from the remote peer.
   * @param {string} raw - raw DataChannel message
   * @returns {boolean} true if it was a doc message and was applied
   */
  receive(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return false; }
    if (msg.t !== 'doc') return false;

    // Only apply if this is newer than what we've seen
    if (msg.seq <= this._remoteSeq) return true; // stale, silently drop

    this._remoteSeq = msg.seq;
    this._suppress  = true;
    this._onRemote(msg.txt);
    this._suppress  = false;
    return true;
  }

  /** True while a remote update is being applied — caller should NOT re-send. */
  get isSuppressed() { return this._suppress; }
}
