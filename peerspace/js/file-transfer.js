/**
 * file-transfer.js — Chunked P2P file transfer over RTCDataChannel
 *
 * Wire format
 * ───────────
 * 1. Sender → Receiver (string):
 *      { t:'file:meta', id, name, size, mime, total }
 *
 * 2. Sender → Receiver (binary, repeated):
 *      [ JSON header bytes ] [ 0x0A ] [ chunk bytes ]
 *      header = { t:'file:chunk', id, i, total }
 *      0x0A   = newline separator
 *
 * 3. Sender → Receiver (string):
 *      { t:'file:done', id }
 *
 * Backpressure: sender yields every chunk and checks bufferedAmount
 * via the sendFn wrapper (caller is responsible for the DC reference).
 */
'use strict';

class FileTransfer {
  /**
   * @param {function} onProgress - (id, name, ratio [0-1], dir ['send'|'recv'])
   * @param {function} onComplete - (id, name, blob) — receiver gets a Blob
   */
  constructor(onProgress, onComplete) {
    this._onProgress = onProgress;
    this._onComplete = onComplete;
    this._sendFn     = null;   // set by caller via setSend()
    this._recv       = {};     // active receives keyed by transferId
  }

  /** Inject the send function after construction (breaks circular dependency). */
  setSend(fn) { this._sendFn = fn; }

  // ── Sending ────────────────────────────────────────────────────

  async send(file) {
    if (!this._sendFn) throw new Error('FileTransfer.setSend() not called');

    const id    = Math.random().toString(36).slice(2, 12);
    const total = Math.ceil(file.size / PS.CHUNK_SIZE);

    // 1. Metadata frame
    this._sendFn(JSON.stringify({
      t: 'file:meta', id,
      name:  file.name,
      size:  file.size,
      mime:  file.type || 'application/octet-stream',
      total,
    }));

    const buffer = await file.arrayBuffer();
    const enc    = new TextEncoder();

    // 2. Chunk frames
    for (let i = 0; i < total; i++) {
      const chunkData  = buffer.slice(i * PS.CHUNK_SIZE, (i + 1) * PS.CHUNK_SIZE);
      const headerJSON = JSON.stringify({ t: 'file:chunk', id, i, total });
      const headerBytes = enc.encode(headerJSON + '\n');

      const pkt = new Uint8Array(headerBytes.length + chunkData.byteLength);
      pkt.set(headerBytes, 0);
      pkt.set(new Uint8Array(chunkData), headerBytes.length);

      this._sendFn(pkt.buffer);
      this._onProgress(id, file.name, (i + 1) / total, 'send');

      // Yield to avoid flooding the DataChannel buffer
      await new Promise(r => setTimeout(r, 8));
    }

    // 3. Done frame
    this._sendFn(JSON.stringify({ t: 'file:done', id }));
  }

  // ── Receiving ──────────────────────────────────────────────────

  /**
   * Route incoming data to the appropriate handler.
   * Caller should pass every raw DataChannel message here.
   * @param {string|ArrayBuffer} data
   * @returns {boolean} true if consumed
   */
  receive(data) {
    if (typeof data === 'string') {
      return this._receiveString(data);
    }
    if (data instanceof ArrayBuffer) {
      return this._receiveChunk(data);
    }
    return false;
  }

  _receiveString(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return false; }

    if (msg.t === 'file:meta') {
      this._recv[msg.id] = {
        name:   msg.name,
        mime:   msg.mime,
        size:   msg.size,
        total:  msg.total,
        chunks: new Array(msg.total).fill(null),
        got:    0,
      };
      this._onProgress(msg.id, msg.name, 0, 'recv');
      return true;
    }

    if (msg.t === 'file:done') {
      const f = this._recv[msg.id];
      if (!f) return false;

      // Reassemble — filter nulls for safety, preserve order
      const blob = new Blob(f.chunks.filter(Boolean), { type: f.mime });
      this._onComplete(msg.id, f.name, blob);
      delete this._recv[msg.id];
      return true;
    }

    return false;
  }

  _receiveChunk(buffer) {
    const bytes = new Uint8Array(buffer);
    const nl    = bytes.indexOf(0x0A); // newline separator
    if (nl === -1) return false;

    let msg;
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes.slice(0, nl)));
    } catch { return false; }
    if (msg.t !== 'file:chunk') return false;

    const f = this._recv[msg.id];
    if (!f) return false;

    f.chunks[msg.i] = bytes.slice(nl + 1);
    f.got++;
    this._onProgress(msg.id, f.name, f.got / f.total, 'recv');
    return true;
  }
}
