/**
 * connection.js — RTCPeerConnection lifecycle manager
 *
 * Fixes vs previous version:
 *  1. ICE candidate queue — candidates that arrive before setRemoteDescription
 *     completes are buffered and drained once the remote description is set.
 *  2. ontrack consolidation — waits for the stream to carry at least one
 *     track before emitting, and deduplicates on stream.id so the 'track'
 *     event fires exactly once per remote stream regardless of track count.
 */
'use strict';

class Connection {
  /**
   * @param {Signaling} signaling
   * @param {string}    peerId       - our own peerId
   * @param {string}    remotePeerId - who we're connecting to
   */
  constructor(signaling, peerId, remotePeerId) {
    this._sig          = signaling;
    this._peerId       = peerId;
    this._remoteId     = remotePeerId;
    this._channels     = {};
    this._evtHandlers  = {};
    this._chanHandlers = {};
    this._openChannels = new Set();

    // ── ICE candidate queue ──────────────────────────────────────
    // Candidates received before setRemoteDescription is called are
    // buffered here and drained immediately after.
    this._pendingIce        = [];
    this._remoteDescSet     = false;

    // ── ontrack deduplication ────────────────────────────────────
    this._emittedStreams = new Set();

    // ── ADDED: heartbeat & negotiation guards ────────────────────
    this._heartbeatInterval = null;
    this._isNegotiating     = false;

    this.pc = new RTCPeerConnection(PS.ICE);
    this._bindPC();
  }

  // ── RTCPeerConnection wiring ───────────────────────────────────

  _bindPC() {
    const pc = this.pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sig.send('ice', { candidate: candidate.toJSON() }, this._remoteId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this._emit('ice-state', pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      this._emit('conn-state', pc.connectionState);
    };

    // Answerer receives DataChannels via this event
    pc.ondatachannel = ({ channel }) => {
      this._bindChannel(channel);
    };

    // ── FIX: consolidate ontrack per stream ──────────────────────
    // ontrack fires once per MediaTrack (so twice for audio+video).
    // We deduplicate on stream.id and emit only when the stream has
    // at least one track that has started (readyState = 'live').
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;

      if (this._emittedStreams.has(stream.id)) return;

      // If the stream already has multiple tracks, emit immediately.
      // Otherwise wait briefly for the second track to attach.
      const emit = () => {
        if (!this._emittedStreams.has(stream.id)) {
          this._emittedStreams.add(stream.id);
          this._emit('track', { track, stream });
        }
      };

      if (stream.getTracks().length >= 2) {
        emit();
      } else {
        // Give the browser one task cycle to attach the second track
        stream.onaddtrack = emit;
        setTimeout(emit, 200);
      }
    };

    // ── ADDED: network status detection (P2P vs TURN) ────────────
    pc.addEventListener('connectionstatechange', async () => {
      if (pc.connectionState === 'connected') {
        const stats = await pc.getStats();
        let isRelayed = false;

        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const localCandidate = stats.get(report.localCandidateId);
            if (localCandidate && localCandidate.candidateType === 'relay') {
              isRelayed = true;
            }
          }
        });

        const status = isRelayed ? 'Relayed (TURN)' : 'Direct P2P';
        console.log(`[Network] Connection established. ${status}`);
        this._emit('network-status', status);
      }
    });

    // ── ADDED: ICE Restart on failure ────────────────────────────
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        console.warn('[Connection] Connection failed. Attempting ICE Restart...');
        pc.restartIce();
      }
    });

    // ── ADDED: handle renegotiation (triggered by restartIce) ────
    pc.addEventListener('negotiationneeded', async () => {
    // Only handle renegotiation on already-connected peers (e.g. ICE restart).
    // During initial setup, offer() manages this explicitly.
    // Without this guard, addStream() + offer() both send offers → broken state.
    if (this._isNegotiating || pc.connectionState !== 'connected') return;
    this._isNegotiating = true;

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._sig.send('offer', { sdp: pc.localDescription }, this._remoteId);
        console.log('[Connection] Renegotiation offer sent.');
      } catch (e) {
        console.error('[Connection] Renegotiation failed:', e);
      } finally {
        this._isNegotiating = false;
      }
    });
  }

  // ── DataChannel wiring ─────────────────────────────────────────

  _bindChannel(dc) {
    dc.binaryType = 'arraybuffer';
    this._channels[dc.label] = dc;

    // ── Common onopen / onclose (with heartbeat for control) ────
    dc.onopen = () => {
      this._openChannels.add(dc.label);
      this._emit('channel-open', dc.label);

      // ── ADDED: heartbeat for control channel ──────────────────
      if (dc.label === PS.DC.CTRL) {
        console.log('[Connection] Control channel open. Starting heartbeat.');
        this._heartbeatInterval = setInterval(() => {
          if (dc.readyState === 'open') {
            dc.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
          }
        }, 15000);
      }

      if (this._openChannels.size === Object.keys(PS.DC).length) {
        this._emit('channels-ready', null);
      }
    };

    dc.onclose = () => {
      this._openChannels.delete(dc.label);
      this._emit('channel-close', dc.label);

      // ── ADDED: clear heartbeat if control ─────────────────────
      if (dc.label === PS.DC.CTRL) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
      }
    };

    dc.onmessage = ({ data }) => {
      const h = this._chanHandlers[dc.label];
      if (h) h(data);
    };

    dc.onerror = (e) => {
      this._emit('channel-error', { label: dc.label, error: e });
    };
  }

  _createDataChannels() {
    const opts = { [PS.DC.CTRL]: { ordered: false, maxRetransmits: 0 } };
    Object.values(PS.DC).forEach(label => {
      const dc = this.pc.createDataChannel(label, opts[label] || { ordered: true });
      this._bindChannel(dc);
    });
  }

  // ── Event emitter ──────────────────────────────────────────────

  _emit(event, data) {
    const h = this._evtHandlers[event];
    if (h) h(data);
  }

  on(event, handler)      { this._evtHandlers[event]  = handler; return this; }
  onChannel(label, handler){ this._chanHandlers[label] = handler; return this; }

  // ── ICE queue helpers ──────────────────────────────────────────

  async _drainIceQueue() {
    for (const c of this._pendingIce) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn('[Connection] queued ICE failed:', e.message);
      }
    }
    this._pendingIce = [];
  }

  async _setRemoteDone() {
    this._remoteDescSet = true;
    await this._drainIceQueue();
  }

  // ── Offer / Answer ─────────────────────────────────────────────

  async offer() {
    this._createDataChannels();
    const sdp = await this.pc.createOffer();
    await this.pc.setLocalDescription(sdp);
    this._sig.send('offer', { sdp }, this._remoteId);
    return sdp;
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._setRemoteDone();                      // drain queued ICE
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._sig.send('answer', { sdp: answer }, this._remoteId);
    return answer;
  }

  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._setRemoteDone();                      // drain queued ICE
  }

  // ── FIX: queue candidates if remote description not yet set ────
  async handleIce(candidate) {
    if (!this._remoteDescSet) {
      this._pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('[Connection] addIceCandidate:', e.message);
    }
  }

  // ── Media ──────────────────────────────────────────────────────

  addStream(stream) {
    stream.getTracks().forEach(track => this.pc.addTrack(track, stream));
  }

  // ── Send ───────────────────────────────────────────────────────

  send(label, data) {
    const dc = this._channels[label];
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(data);
    return true;
  }

  getStats() { return this.pc.getStats(); }

  close() {
    // ── ADDED: clear heartbeat before closing ────────────────────
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    Object.values(this._channels).forEach(dc => { try { dc.close(); } catch (_) {} });
    try { this.pc.close(); } catch (_) {}
  }
}