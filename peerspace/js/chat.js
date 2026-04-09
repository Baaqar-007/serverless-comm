/**
 * chat.js — Chat message pack/unpack over RTCDataChannel
 *
 * Keeps chat logic decoupled from transport and UI.
 * The caller is responsible for sending the packed string and
 * for rendering — this module just handles serialisation.
 */
'use strict';

class Chat {
  /**
   * @param {string}   myName    - display name of the local user
   * @param {function} onMessage - called with (msg, isSelf)
   *                               msg = { id, name, text, ts }
   */
  constructor(myName, onMessage) {
    this._name      = myName;
    this._onMessage = onMessage;
  }

  /**
   * Pack and "send" a message (caller actually sends the string).
   * Also triggers onMessage immediately for the local display.
   * @param {string} text
   * @returns {string} packed JSON to transmit
   */
  send(text) {
    const msg = {
      t:    'chat',
      id:   Math.random().toString(36).slice(2, 10),
      name: this._name,
      text: text.trim(),
      ts:   Date.now(),
    };
    this._onMessage(msg, true);            // show in local UI immediately
    return JSON.stringify(msg);            // return for caller to send
  }

  /**
   * Handle raw data arriving from remote peer.
   * @param {string} raw
   * @returns {boolean} true if it was a chat message
   */
  receive(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return false; }
    if (msg.t !== 'chat') return false;
    this._onMessage(msg, false);
    return true;
  }
}
