/**
 * doc-sync.js — Document synchronisation over RTCDataChannel
 *
 * Modified to support Quill Deltas for Operational Transformation 
 * (prevents cursor jumping and supports complex rich text + tables).
 */
'use strict';

class DocSync {
  constructor(onRemoteUpdate) {
    this._onRemote   = onRemoteUpdate;
    this._suppress   = false; 
  }

  /**
   * Package a Quill Delta edit for sending.
   */
  pack(delta) {
    return JSON.stringify({
      t: 'doc',
      d: delta
    });
  }

  /**
   * Handle incoming Delta from the remote peer.
   */
  receive(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return false; }
    if (msg.t !== 'doc') return false;

    this._suppress  = true;
    this._onRemote(msg.d);
    this._suppress  = false;
    return true;
  }

  /** True while a remote update is being applied — caller should NOT re-send. */
  get isSuppressed() { return this._suppress; }
}