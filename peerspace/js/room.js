/**
 * room.js — Session orchestrator (v4 — full mesh, up to 4 peers)
 *
 * Change log vs v3 (2-peer):
 *  - Single `conn` variable replaced by `peers` Map<peerId, PeerState>
 *  - Signaling now handles peer-list / peer-joined / peer-left
 *  - Offer/answer determinism: lower UUID always initiates (no race)
 *  - docSync and chatMgr are room-scoped (shared); fileXfer is per-peer
 *  - Broadcast helpers (broadcastDoc, broadcastChat) fan out to all peers
 *  - teardown(peerId?) closes one peer or all peers
 *  - UI replaced: dynamic video grid (Zoom-style), per-peer mute toggles
 *  - _pendingIceBuf is now a Map<peerId, candidate[]>
 */
'use strict';

(function () {

  // ── Session identity ───────────────────────────────────────────
  const params  = new URLSearchParams(location.search);
  const ROOM_ID = params.get('r');
  const MY_NAME = decodeURIComponent(params.get('n') || 'Anonymous');
  const MY_ID   = generateId();

  if (!ROOM_ID) {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:sans-serif;color:#ef4444">' +
      'No room ID. <a href="index.html">Return to lobby</a>.</p>';
    return;
  }

  // ── Peer state record ──────────────────────────────────────────
  // One of these per remote peer in the room.
  // {
  //   conn       : Connection instance
  //   name       : display name (filled in from announce/ack)
  //   stream     : remote MediaStream (once track arrives)
  //   fileXfer   : FileTransfer instance (per-peer; chunks are per-DC)
  //   statsTimer : interval id
  //   ready      : boolean — channels all open
  // }

  // ── Module instances ───────────────────────────────────────────
  let signaling     = null;
  let docSync       = null;   // shared across all peers
  let chatMgr       = null;   // shared across all peers
  let transcriptMgr = null;   // live transcription (one per session)

  // ── Runtime state ──────────────────────────────────────────────
  let localStream = null;
  let sessionStart = null;
  let _transcribing = true;              // toggled by the Stop/Resume button
  const peers = new Map();                  // peerId → PeerState
  const _pendingIceBuf = new Map();         // peerId → candidate[]

  // ── Boot ───────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      UI.init(MY_NAME, ROOM_ID);
      await startCamera();
      if (localStream) initTranscription();
      initSignaling();
      announce();

      // Render every incoming chunk (local + remote) to the Live Feed tab.
      TranscriptStore.onChunk(chunk => UI.renderTranscriptChunk(chunk, MY_NAME));

    } catch (e) {
      UI.log('Boot error: ' + e.message, 'error');
      console.error(e);
    }
  });

  // ── Camera ─────────────────────────────────────────────────────
  async function startCamera() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: {
          echoCancellation:   false,  // these aggressively suppress phone-speaker-through-mic
          noiseSuppression:   false,  // and any non-close-mic audio — kills transcription
          autoGainControl:    false,  // let Whisper see the raw signal
          channelCount:       1,
        },
      });
      UI.setLocalVideo(localStream);
      UI.log('Camera ready', 'ok');
    } catch (e) {
      UI.log('Camera failed: ' + e.message, 'warn');
      // Fallback: try audio-only with same constraints
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        UI.log('Audio-only mode', 'warn');
      } catch (e2) {
        UI.log('Microphone unavailable: ' + e2.message, 'warn');
      }
    }
  }

  // ── Signaling ──────────────────────────────────────────────────
  function initSignaling() {
    signaling = new Signaling(ROOM_ID, MY_ID);
    signaling
      .on('peer-list',   handlePeerList)     // NEW: existing peers on join
      .on('peer-joined', handlePeerJoined)   // NEW: runtime arrivals
      .on('peer-left',   handlePeerLeft)     // NEW: runtime departures
      .on('announce',    handlePeerAnnounce)
      .on('announce:ack',handlePeerAck)
      .on('offer',       handleOffer)
      .on('answer',      handleAnswer)
      .on('ice',         handleIce)
      .on('room-full',   () => UI.log('Room is full (max 4 peers)', 'error'));
  }

  function announce() {
    signaling.send('announce', { name: MY_NAME });
    UI.setStatus('waiting', 'Waiting for peers…');
    UI.log('Announced → room ' + ROOM_ID, 'info');
  }

  // ── Transcription ──────────────────────────────────────────────

  function initTranscription() {
    transcriptMgr = new TranscriptionManager(localStream, MY_NAME, {
      onChunk(chunk) {
        TranscriptStore.push(chunk);
        broadcastTranscript(chunk);
      },
      onModelProgress(pct) { UI.setTranscriptModelProgress(pct); },
      onModelReady(id, backend) {
        UI.log(
          'Transcription ready ✓ [Moonshine · ' + (backend || 'wasm').toUpperCase() + ']',
          'ok'
        );
        UI.setTranscriptModelReady();
      },
      onError(msg) { UI.log('Transcription: ' + msg, 'warn'); },
    });
  }

  function broadcastTranscript(chunk) {
    const packed = JSON.stringify(chunk);
    peers.forEach(({ conn, ready }) => {
      if (ready && conn) conn.send(PS.DC.TRANSCRIPT, packed);
    });
  }

  // ── Peer discovery ─────────────────────────────────────────────

  // Received on initial join: array of peerIds already in the room.
  // For each, send an announce so they know our name and trigger handshake.
  function handlePeerList({ peerIds }) {
    UI.log('Room has ' + peerIds.length + ' existing peer(s)', 'info');
    peerIds.forEach(pid => {
      // They will respond with announce:ack; handshake follows from there.
      signaling.send('announce', { name: MY_NAME }, pid);
    });
  }

  // A new peer arrived after us — they will send us an announce shortly.
  // Nothing to do here except log; we wait for their announce.
  function handlePeerJoined({ from }) {
    UI.log('New peer joined: ' + from.slice(0, 8), 'info');
  }

  // Handle announce from any peer (they just joined or we just joined).
  function handlePeerAnnounce({ from, name }) {
    if (peers.has(from)) return;              // already know this peer
    UI.log('"' + name + '" announced', 'ok');

    // Register name so we can label their tile before connection is live.
    _ensurePeerRecord(from, name);

    signaling.send('announce:ack', { name: MY_NAME }, from);

    // Offer rule: lower UUID initiates — exactly one side sends the offer.
    if (MY_ID < from) initiateOffer(from);
  }

  function handlePeerAck({ from, name }) {
    const p = peers.get(from);
    if (p) p.name = name;
    else _ensurePeerRecord(from, name);

    UI.log('"' + name + '" ack', 'ok');

    // Only offer if we haven't already started for this peer.
    const peer = peers.get(from);
    if (!peer.conn && !peer.initiating && MY_ID < from) initiateOffer(from);
  }

  // ── WebRTC flow ────────────────────────────────────────────────

  async function initiateOffer(remotePeerId) {
    const peer = peers.get(remotePeerId);
    if (!peer || peer.conn || peer.initiating) return;
    peer.initiating = true;

    UI.setStatus('connecting', 'Connecting to ' + (peer.name || remotePeerId.slice(0,8)) + '…');
    UI.log('Creating offer → ' + remotePeerId.slice(0,8), 'signal');

    const c = buildConnection(remotePeerId);
    _setPeerConn(remotePeerId, c);
    if (localStream) c.addStream(localStream);

    try {
      await c.offer();
      UI.log('Offer sent → ' + remotePeerId.slice(0,8), 'signal');
    } catch (e) {
      UI.log('Offer error: ' + e.message, 'error');
      peer.initiating = false;
    }
  }

  async function handleOffer({ from, sdp, name }) {
    UI.log('Offer ← ' + from.slice(0,8), 'signal');

    _ensurePeerRecord(from, name);
    const peer = peers.get(from);

    // If a connection already exists for this peer (rare race), tear it down.
    if (peer.conn) {
      UI.log('Re-offer from ' + from.slice(0,8) + ' — resetting', 'warn');
      _teardownPeer(from);
    }

    const c = buildConnection(from);
    _setPeerConn(from, c);
    if (localStream) c.addStream(localStream);

    try {
      await c.handleOffer(sdp);
      UI.log('Answer sent → ' + from.slice(0,8), 'signal');
    } catch (e) {
      UI.log('Answer error: ' + e.message, 'error');
    }
  }

  async function handleAnswer({ from, sdp }) {
    const peer = peers.get(from);
    if (!peer?.conn) return;
    try {
      await peer.conn.handleAnswer(sdp);
      UI.log('Answer ← ' + from.slice(0,8), 'signal');
    } catch (e) {
      UI.log('handleAnswer error: ' + e.message, 'error');
    }
  }

  // ── ICE — two-layer buffering (preserved from v3, now per-peer) ───────────
  // Layer 1 (room.js):      buffer until the Connection object for this peer exists
  // Layer 2 (connection.js): buffer until setRemoteDescription completes
  async function handleIce({ from, candidate }) {
    const peer = peers.get(from);
    if (!peer?.conn) {
      if (!_pendingIceBuf.has(from)) _pendingIceBuf.set(from, []);
      _pendingIceBuf.get(from).push(candidate);
      return;
    }
    await peer.conn.handleIce(candidate);
  }

  // Assign conn to a peer record and drain any buffered ICE for that peer.
  function _setPeerConn(peerId, c) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.conn = c;

    const buf = _pendingIceBuf.get(peerId);
    if (buf?.length) {
      UI.log('Draining ' + buf.length + ' buffered ICE for ' + peerId.slice(0,8), 'signal');
      _pendingIceBuf.delete(peerId);
      buf.forEach(cand => c.handleIce(cand));
    }
  }

  // ── Peer left ──────────────────────────────────────────────────
  function handlePeerLeft({ from }) {
    if (!peers.has(from)) return;
    const name = peers.get(from)?.name || from.slice(0,8);
    UI.log('"' + name + '" left', 'warn');
    _teardownPeer(from);
    UI.removePeerTile(from);

    // If now alone, go back to waiting state.
    if (peers.size === 0) {
      UI.setStatus('waiting', 'Waiting for peers…');
      _disableSessionIfEmpty();
    }
  }

  // ── Connection factory ─────────────────────────────────────────
  function buildConnection(remotePeerId) {
    const c = new Connection(signaling, MY_ID, remotePeerId);

    c.on('ice-state', state => {
      UI.log('ICE [' + remotePeerId.slice(0,8) + '] → ' + state, 'signal');
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        UI.log('Connection lost to ' + remotePeerId.slice(0,8), 'warn');
        handlePeerLeft({ from: remotePeerId });
      }
    });

    c.on('conn-state', state => {
      if (state === 'failed') handlePeerLeft({ from: remotePeerId });
    });

    c.on('track', ({ stream }) => {
      const peer = peers.get(remotePeerId);
      if (peer) peer.stream = stream;

      // If the tile doesn't exist yet (announce hasn't arrived), retry
      // after a short delay — the tile will be created by then.
      const trySetVideo = () => {
        const v = document.getElementById('vid-' + remotePeerId);
        if (v) {
          UI.setPeerVideo(remotePeerId, stream);
        } else {
          setTimeout(trySetVideo, 300);   // retry until tile exists
        }
      };
      trySetVideo();
      UI.log('Remote video ← ' + remotePeerId.slice(0,8), 'ok');
    });

    c.on('channels-ready', () => onChannelsReady(remotePeerId, c));
    c.on('channel-open',   label =>
      UI.log('Channel [' + label.replace('ps:','') + '] open with ' + remotePeerId.slice(0,8), 'ok'));
    c.on('channel-error',  ({ label, error }) =>
      UI.log('Channel error [' + label + ']: ' + error, 'error'));

     // ── NEW: Network status from connection.js ─────────────────────
    c.on('network-status', (status) => {
      const badge = document.getElementById('networkBadge');
      if (!badge) return;

      badge.hidden = false;
      const isDirect = (status === 'Direct P2P');
      badge.textContent = isDirect ? '⡀ Direct' : '⏣ Relayed';
      badge.className = 'network-badge ' + (isDirect ? 'direct' : 'relayed');
    });

    // doc and chat receive handlers delegate to shared managers
    c.onChannel(PS.DC.DOC,  data => docSync?.receive(data));
    c.onChannel(PS.DC.CHAT, data => chatMgr?.receive(data));

    // file handler set up once fileXfer exists for this peer (see onChannelsReady)
    c.onChannel(PS.DC.FILE, data => peers.get(remotePeerId)?.fileXfer?.receive(data));
    c.onChannel(PS.DC.CTRL, data => handleCtrl(data, c, remotePeerId));

    // Remote peer's transcript chunks — store locally and render in feed tab.
    c.onChannel(PS.DC.TRANSCRIPT, data => {
      try {
        const chunk = JSON.parse(data);
        TranscriptStore.push(chunk);
      } catch (_) {}
    });

    return c;
  }

  // ── Session live (per peer) ────────────────────────────────────
  function onChannelsReady(peerId, c) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.ready = true;

    // Initialise shared docSync and chatMgr on the first peer connection.
    if (!docSync) {
      docSync = new DocSync(delta => {
        UI.quill.updateContents(delta);
      });

      UI.quill.on('text-change', (delta, _old, source) => {
        if (source === 'user' && !docSync.isSuppressed) broadcastDoc(delta);
        document.getElementById('docChars').textContent =
          (UI.quill.getLength() - 1) + ' chars';
      });
    }

    if (!chatMgr) {
      chatMgr = new Chat(MY_NAME, (msg, self) => UI.renderChat(msg, self));
    }

    // File transfer is per-peer (chunk state is per-channel).
    peer.fileXfer = new FileTransfer(
      (id, name, ratio, dir) => UI.updateFileProgress(id, name, ratio, dir),
      (id, name, blob)       => UI.completeFile(id, name, blob)
    );
    peer.fileXfer.setSend(data => c.send(PS.DC.FILE, data));

    // Start ping/stats loop for this peer.
    if (!sessionStart) sessionStart = Date.now();
    peer.statsTimer = setInterval(async () => {
      c.send(PS.DC.CTRL, JSON.stringify({ t: 'ping', ts: Date.now() }));
    }, 2000);

    UI.setStatus('connected', '● P2P Live (' + peers.size + ' peer' + (peers.size > 1 ? 's' : '') + ')');
    UI.enableSession();
    UI.log('SESSION LIVE with ' + (peer.name || peerId.slice(0,8)) + ' — all data P2P', 'ok');
  }

  // ── Teardown helpers ───────────────────────────────────────────

  function _teardownPeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    if (peer.statsTimer) clearInterval(peer.statsTimer);
    if (peer.conn) { try { peer.conn.close(); } catch (_) {} }
    peers.delete(peerId);
    _pendingIceBuf.delete(peerId);
  }

  function _teardownAll() {
    peers.forEach((_, pid) => _teardownPeer(pid));
    docSync = chatMgr = null;
    sessionStart = null;
    UI.disableSession();
    UI.clearAllRemoteTiles();

    // Stop live transcription.
    if (transcriptMgr) { transcriptMgr.stop(); transcriptMgr = null; }

    // Fire post-meeting summariser if there is transcript content.
    const transcript = TranscriptStore.getAll();
    if (transcript.length > 0) {
      _triggerSummarizer(transcript);
      TranscriptStore.clear();
    }
  }

  function _triggerSummarizer(transcript) {
    UI.showSummaryModal('generating');
    const worker = new Worker(
      'js/workers/summarizer.worker.js',
      { type: 'module' }
    );
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        UI.updateSummaryProgress(data.message);
      } else if (data.type === 'result') {
        UI.showSummaryModal('done', data.result);
        worker.terminate();
      } else if (data.type === 'error') {
        UI.showSummaryModal('error', { error: data.message });
        worker.terminate();
      }
    };
    worker.onerror = e => {
      UI.showSummaryModal('error', { error: e.message || 'Unknown worker error' });
      worker.terminate();
    };
    worker.postMessage({ transcript, models: selectModels() });
  }

  function _disableSessionIfEmpty() {
    if (peers.size === 0) {
      docSync = chatMgr = null;
      UI.disableSession();
    }
  }

  // ── Ensure a peer record exists ────────────────────────────────
  function _ensurePeerRecord(peerId, name) {
    if (!peers.has(peerId)) {
      peers.set(peerId, {
        conn: null, name: name || '', stream: null,
        fileXfer: null, statsTimer: null, ready: false, initiating: false,
      });
      UI.addPeerTile(peerId, name || peerId.slice(0,8));
    } else if (name) {
      peers.get(peerId).name = name;
      UI.updatePeerName(peerId, name);
    }
  }

  // ── Control channel ────────────────────────────────────────────
  function handleCtrl(raw, c, peerId) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case 'ping':
        c.send(PS.DC.CTRL, JSON.stringify({ t: 'pong', ts: msg.ts }));
        break;
      case 'pong':
        UI.updateStat('rtt', (Date.now() - msg.ts) + ' ms');
        break;
      case 'typing':
        UI.showTyping(msg.name);
        break;
      // Peer is telling us they muted/unmuted their own audio or video.
      // We reflect this in their tile overlay (no actual track control on our side).
      case 'media-state':
        UI.updatePeerMediaState(peerId, msg.audio, msg.video);
        break;
    }
  }

  // ── Broadcast helpers ──────────────────────────────────────────
  // Fan out to all connected peers.

  function broadcastDoc(delta) {
    if (!docSync) return;
    const packed = docSync.pack(delta);
    peers.forEach(({ conn, ready }) => {
      if (ready && conn) conn.send(PS.DC.DOC, packed);
    });
  }

  function broadcastChat(text) {
    if (!text.trim() || !chatMgr) return;
    const packed = chatMgr.send(text);
    peers.forEach(({ conn, ready }) => {
      if (ready && conn) conn.send(PS.DC.CHAT, packed);
    });
  }

  function sendFile(file) {
    if (!file) return;
    // Sends to every peer (each gets their own copy via their own channel).
    peers.forEach(({ fileXfer, ready }) => {
      if (ready && fileXfer) fileXfer.send(file);
    });
  }

  function toggleMute() {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btnMute').textContent = t.enabled ? '🎤 Mute' : '🔇 Unmute';
    _broadcastMediaState();
  }

  function toggleCam() {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btnCam').textContent = t.enabled ? '📷 Cam Off' : '📷 Cam On';
    _broadcastMediaState();
  }

  // Tell all peers our current mute state so they can show the overlay.
  function _broadcastMediaState() {
    const audio = localStream?.getAudioTracks()[0]?.enabled ?? true;
    const video = localStream?.getVideoTracks()[0]?.enabled ?? true;
    const msg   = JSON.stringify({ t: 'media-state', audio, video });
    peers.forEach(({ conn, ready }) => {
      if (ready && conn) conn.send(PS.DC.CTRL, msg);
    });
  }

  window.addEventListener('beforeunload', () => {
    signaling?.send('leaving', {});
    _teardownAll();
    signaling?.destroy();
    localStream?.getTracks().forEach(t => t.stop());
  });

  window._ps = {
    broadcastDoc, broadcastChat, sendFile, toggleMute, toggleCam,

    toggleTranscription() {
      const btn = document.getElementById('btnToggleTranscript');

      if (!transcriptMgr) {
        UI.log('Whisper still loading — please wait', 'warn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '⏳ Loading…';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
        return;
      }

      if (transcriptMgr.isPaused()) {
        transcriptMgr.resume();
        _transcribing = true;
        if (btn) {
          btn.textContent = '⏹ Stop Transcribing';
          btn.classList.remove('tx-btn-paused');
          btn.classList.add('tx-btn-recording');
        }
        UI.log('Transcription resumed', 'ok');
      } else {
        transcriptMgr.pause();
        _transcribing = false;
        if (btn) {
          btn.textContent = '🎙 Resume Transcribing';
          btn.classList.remove('tx-btn-recording');
          btn.classList.add('tx-btn-paused');
        }
        UI.log('Transcription paused', 'warn');
      }
    },

    endMeeting() {
      signaling?.send('leaving', {});
      _teardownAll();
      signaling?.destroy();
      localStream?.getTracks().forEach(t => t.stop());
      UI.setStatus('waiting', 'Session ended');
    },
  };

  // ══════════════════════════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════════════════════════
  const UI = {
    _typingTimer: null,
    quill: null,

    init(name, roomId) {
      
      document.getElementById('myName').textContent   = name;
      const n2 = document.getElementById('myName2');
      if (n2) n2.textContent = name;
      document.getElementById('roomCode').textContent = roomId;

      this.quill = new Quill('#docEditor', {
        theme: 'snow',
        modules: { table: true, toolbar: '#docToolbar' },
        placeholder: 'Establish connection to begin collaborative editing…',
      });
      this.quill.disable();

      document.getElementById('btnInsertTable').addEventListener('click', () => {
        const table = this.quill.getModule('table');
        if (table) table.insertTable(3, 3);
      });

      document.getElementById('btnExport').addEventListener('click', () => {
        const html = this.quill.getSemanticHTML();
        const src  = "data:application/vnd.ms-word;charset=utf-8," +
          encodeURIComponent(
            "<html><head><meta charset='utf-8'></head><body>" + html + "</body></html>"
          );
        Object.assign(document.createElement('a'),
          { href: src, download: 'PeerSpace_Synthesis.doc' }).click();
        this.log('Exported document', 'ok');
      });

      document.getElementById('copyLink').addEventListener('click', () => {
        navigator.clipboard?.writeText(location.href).then(() => {
          const btn = document.getElementById('copyLink');
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = orig, 1400);
        });
      });

      document.getElementById('chatInput').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); broadcastChat(e.target.value); e.target.value = '';
        }
      });
      document.getElementById('chatSend').addEventListener('click', () => {
        const inp = document.getElementById('chatInput');
        broadcastChat(inp.value); inp.value = '';
      });

      document.getElementById('filePicker').addEventListener('change', e => {
        const f = e.target.files[0];
        if (f) { sendFile(f); e.target.value = ''; }
      });
      const dz = document.getElementById('fileDropZone');
      dz.addEventListener('click', () => document.getElementById('filePicker').click());
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dz-over'); });
      dz.addEventListener('dragleave', ()  => dz.classList.remove('dz-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('dz-over');
        const f = e.dataTransfer.files[0]; if (f) sendFile(f);
      });

      document.getElementById('btnMute').addEventListener('click', toggleMute);
      document.getElementById('btnCam').addEventListener('click', toggleCam);

      document.getElementById('btnEndMeeting').addEventListener('click', () => {
        window._ps.endMeeting();
      });

      document.getElementById('btnToggleTranscript').addEventListener('click', () => {
        window._ps.toggleTranscription();
      });

      document.getElementById('btnSummarise').addEventListener('click', () => {
        const transcript = TranscriptStore.getAll();
        if (transcript.length === 0) {
          UI.log('No transcript to summarise yet', 'warn');
          return;
        }
        _triggerSummarizer(transcript);
      });

      document.querySelectorAll('.tab').forEach(t =>
        t.addEventListener('click', () => this.switchTab(t.dataset.tab)));
    },

    // ── Status / logging ────────────────────────────────────────

    setStatus(state, text) {
      const el = document.getElementById('statusPill');
      el.textContent = text;
      el.className   = 'status-pill status-' + state;
    },

    // ── The stage ladder is kept for the first connection only.
    // Once multi-peer, we drop the granular stage steps. ────────
    setStage(n, state) {
      const el = document.querySelector('[data-stage="' + n + '"]');
      if (el) el.className = 'stage stage-' + state;
    },
    resetStages() { for (let i = 1; i <= 5; i++) this.setStage(i, 'idle'); },

    log(msg, type) {
      type = type || 'info';
      const log = document.getElementById('signalLog');
      if (!log) return;
      const row = document.createElement('div');
      row.className = 'log-row log-' + type;
      const d  = new Date();
      const ts = String(d.getMinutes()).padStart(2,'0') + ':' +
                 String(d.getSeconds()).padStart(2,'0');
      row.innerHTML =
        '<span class="log-ts">' + ts + '</span>' +
        '<span class="log-msg">' + escHtml(msg) + '</span>';
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    },

    updateStat(key, val) {
      const el = document.getElementById('stat-' + key);
      if (el) el.textContent = val;
    },

    // ── Local video ─────────────────────────────────────────────

    setLocalVideo(stream) {
          const v   = document.getElementById('localVideo');
          const off = document.getElementById('localOff');
          if (off) off.remove();                // ← remove from DOM entirely
          v.style.display = 'block';
          v.removeAttribute('hidden');
          v.srcObject = stream;
          v.play().catch(() => {});
        },

    // ── Dynamic peer tile grid ───────────────────────────────────
    // Each remote peer gets a <div class="video-tile"> inside #videoGrid.
    // The grid uses CSS grid-template-columns that reflows automatically
    // based on peer count (1→full width, 2→two cols, 3-4→2×2).

    addPeerTile(peerId, name) {
      const grid = document.getElementById('videoGrid');
      if (document.getElementById('tile-' + peerId)) return;

      const tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + peerId;
      tile.innerHTML =
        '<video id="vid-' + peerId + '" autoplay playsinline></video>' +
        '<div class="tile-off" id="toff-' + peerId + '">' +
          '<span>📷</span><span class="tile-name">' + escHtml(name) + '</span>' +
        '</div>' +
        '<div class="tile-overlay">' +
          '<span class="tile-name-label">' + escHtml(name) + '</span>' +
          '<span class="tile-badges" id="tbadge-' + peerId + '"></span>' +
        '</div>';
      grid.appendChild(tile);
      this._reflowGrid();
    },

    removePeerTile(peerId) {
      const el = document.getElementById('tile-' + peerId);
      if (el) el.remove();
      this._reflowGrid();
    },

    clearAllRemoteTiles() {
      document.querySelectorAll('.video-tile[id^="tile-"]').forEach(el => el.remove());
      this._reflowGrid();
    },

    updatePeerName(peerId, name) {
      const el = document.querySelector('#tile-' + peerId + ' .tile-name');
      if (el) el.textContent = name;
      const lbl = document.querySelector('#tile-' + peerId + ' .tile-name-label');
      if (lbl) lbl.textContent = name;
    },

setPeerVideo(peerId, stream) {
  const v   = document.getElementById('vid-' + peerId);
  const off = document.getElementById('toff-' + peerId);
  if (!v) return;
  if (off) off.remove();                // ← remove from DOM entirely
  v.style.display = 'block';
  v.removeAttribute('hidden');
  v.srcObject = stream;
  v.play().catch(() => {});
  setTimeout(() => v.play().catch(() => {}), 300);
},

    // Called when remote peer broadcasts their mute state via ctrl channel.
    updatePeerMediaState(peerId, audio, video) {
      const badges = document.getElementById('tbadge-' + peerId);
      if (!badges) return;
      let s = '';
      if (!audio) s += '<span class="badge-muted">🔇</span>';
      if (!video) s += '<span class="badge-novid">📵</span>';
      badges.innerHTML = s;

      // Dim the video tile if they turned off video
      const tile = document.getElementById('tile-' + peerId);
      if (tile) tile.classList.toggle('tile-novid', !video);
    },

    // Recompute CSS grid columns based on tile count.
    // 1 peer  → 1 col (large)
    // 2 peers → 2 cols
    // 3-4     → 2×2
    _reflowGrid() {
      const grid  = document.getElementById('videoGrid');
      const count = grid.querySelectorAll('.video-tile').length + 1; // +1 for local
      const cols  = count <= 2 ? count : 2;
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    },

    // ── Chat ────────────────────────────────────────────────────

    renderChat(msg, self) {
      const box = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.className = 'chat-msg ' + (self ? 'chat-self' : 'chat-remote');
      div.innerHTML =
        '<div class="chat-name">' + escHtml(msg.name) + '</div>' +
        '<div class="chat-text">' + escHtml(msg.text) + '</div>';
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    },

    showTyping(name) {
      const el = document.getElementById('typingIndicator');
      el.textContent = name + ' is typing…';
      el.hidden = false;
      clearTimeout(this._typingTimer);
      this._typingTimer = setTimeout(() => { el.hidden = true; }, 2000);
    },

    // ── File transfer ───────────────────────────────────────────

    updateFileProgress(id, name, ratio, dir) {
      let card = document.getElementById('fc-' + id);
      if (!card) {
        card = document.createElement('div');
        card.id = 'fc-' + id;
        card.className = 'file-card';
        card.innerHTML =
          '<span class="file-ico">' + fileIcon(name) + '</span>' +
          '<div class="file-body">' +
            '<div class="file-name">' + escHtml(name) + '</div>' +
            '<div class="file-meta">' + (dir === 'send' ? '↑ Sending' : '↓ Receiving') + '</div>' +
            '<div class="file-bar"><div class="file-fill" id="ff-' + id + '"></div></div>' +
          '</div>' +
          '<span class="file-pct" id="fp-' + id + '">0%</span>';
        document.getElementById('fileList').appendChild(card);
      }
      const pct = Math.round(ratio * 100);
      const fill  = document.getElementById('ff-' + id);
      const pctEl = document.getElementById('fp-' + id);
      if (fill)  fill.style.width  = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    },

    completeFile(id, name, blob) {
      const fill  = document.getElementById('ff-' + id);
      const pctEl = document.getElementById('fp-' + id);
      if (fill)  { fill.style.width = '100%'; fill.style.background = 'var(--green)'; }
      if (pctEl) pctEl.textContent = '✓';
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.log('Received: ' + name, 'ok');
    },

    // ── Session enable/disable ──────────────────────────────────

    enableSession() {
      this.quill.enable();
      document.getElementById('chatInput').disabled = false;
      document.getElementById('chatSend').disabled  = false;
      document.getElementById('fileDropZone').classList.remove('dz-disabled');
    },

    disableSession() {
      this.quill.disable();
      document.getElementById('chatInput').disabled = true;
      document.getElementById('chatSend').disabled  = true;
      document.getElementById('fileDropZone').classList.add('dz-disabled');
    },

    // ── Tab switching ───────────────────────────────────────────

    switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab));
      document.querySelectorAll('.tab-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.pane === tab));
    },

    // ── Transcript / Live Feed ──────────────────────────────────

    setTranscriptModelProgress(pct) {
      const bar   = document.getElementById('whisperBar');
      const label = document.getElementById('whisperLabel');
      if (bar)   bar.style.width   = pct + '%';
      if (label) label.textContent = `Loading Moonshine… ${pct}%`;
    },

    setTranscriptModelReady() {
      const row  = document.getElementById('whisperLoader');
      if (row)  row.hidden = true;
      const note = document.getElementById('transcriptNote');
      if (note) note.hidden = false;
    },

    renderTranscriptChunk(chunk, myName) {
      const feed = document.getElementById('transcriptFeed');
      if (!feed) return;

      // Remove any interim preview bubble
      const existing = feed.querySelector('.tx-interim');
      if (existing) existing.remove();

      const isSelf = chunk.speaker === myName;
      const ts     = new Date(chunk.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const div = document.createElement('div');
      div.className = 'tx-chunk ' + (isSelf ? 'tx-self' : 'tx-remote');
      div.innerHTML =
        '<div class="tx-meta">' +
          '<span class="tx-speaker">' + escHtml(chunk.speaker) + '</span>' +
          '<span class="tx-time">' + ts + '</span>' +
        '</div>' +
        '<div class="tx-bubble">' + escHtml(chunk.text) + '</div>';

      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    },

    renderInterimChunk(text) {
      const feed = document.getElementById('transcriptFeed');
      if (!feed) return;

      let interim = feed.querySelector('.tx-interim');
      if (!interim) {
        interim = document.createElement('div');
        interim.className = 'tx-chunk tx-self tx-interim';
        feed.appendChild(interim);
      }
      interim.innerHTML =
        '<div class="tx-bubble tx-bubble-interim">' + escHtml(text) + '</div>';
      feed.scrollTop = feed.scrollHeight;
    },

    // ── Summary modal ───────────────────────────────────────────

    showSummaryModal(state, result) {
      const modal = document.getElementById('summaryModal');
      if (!modal) return;
      modal.hidden = false;

      const body    = document.getElementById('summaryBody');
      const spinner = document.getElementById('summarySpinner');
      const content = document.getElementById('summaryContent');

      if (state === 'generating') {
        spinner.hidden = false;
        content.hidden = true;
        document.getElementById('summaryProgress').textContent = 'Initialising…';
        return;
      }

      spinner.hidden = true;
      content.hidden = false;

      if (state === 'error') {
        content.innerHTML =
          '<div class="sum-error">⚠️ Summarisation failed: ' +
          escHtml(result.error) + '</div>';
        return;
      }

      // ── Render minutes, actions, references ─────────────────
      const { minutes, actions, references, speakers, duration, chunkCount } = result;

      const speakerTags = speakers
        .map(s => `<span class="sum-speaker-chip">${escHtml(s)}</span>`)
        .join('');

      const actionHtml = actions.length
        ? actions.map(a => `<li>${escHtml(a)}</li>`).join('')
        : '<li class="sum-empty">No action items detected.</li>';

      const refHtml = references.length
        ? references.map(r =>
            `<li><a href="${escHtml(r)}" target="_blank" rel="noopener">${escHtml(r)}</a></li>`
          ).join('')
        : '<li class="sum-empty">No URLs mentioned.</li>';

      content.innerHTML = `
        <div class="sum-meta">
          <span>🕐 ${duration} min</span>
          <span>🎙️ ${chunkCount} segments</span>
          <span>👥 ${speakerTags}</span>
        </div>

        <section class="sum-section">
          <h3>📋 Meeting Minutes</h3>
          <p>${escHtml(minutes || 'Not enough content to summarise.')}</p>
        </section>

        <section class="sum-section">
          <h3>✅ Action Items</h3>
          <ul>${actionHtml}</ul>
        </section>

        <section class="sum-section">
          <h3>🔗 References</h3>
          <ul>${refHtml}</ul>
        </section>
      `;

      // Bind export button
      document.getElementById('btnExportSummary').onclick = () => {
        this._exportSummary(result);
      };
    },

    updateSummaryProgress(msg) {
      const el = document.getElementById('summaryProgress');
      if (el) el.textContent = msg;
    },

    _exportSummary(result) {
      const { minutes, actions, references, speakers, duration, rawTranscript } = result;

      const transcriptHtml = rawTranscript
        .map(c => {
          const ts = new Date(c.timestamp).toLocaleTimeString();
          return `<p><strong>${escHtml(c.speaker)}</strong> <span style="color:#888;font-size:11px">${ts}</span><br>${escHtml(c.text)}</p>`;
        }).join('');

      const actionsHtml = actions.length
        ? `<ul>${actions.map(a => `<li>${escHtml(a)}</li>`).join('')}</ul>`
        : '<p><em>None detected</em></p>';

      const refsHtml = references.length
        ? `<ul>${references.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>`
        : '<p><em>None</em></p>';

      const html = `
        <html><head><meta charset="utf-8">
        <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;line-height:1.6}
        h1{color:#059669}h2{color:#0ea5e9;border-bottom:1px solid #eee;padding-bottom:8px}
        p,li{font-size:14px}strong{color:#133a27}</style></head>
        <body>
          <h1>PeerSpace — Meeting Summary</h1>
          <p><strong>Duration:</strong> ${duration} min &nbsp; <strong>Speakers:</strong> ${speakers.map(s => escHtml(s)).join(', ')}</p>
          <h2>📋 Minutes</h2><p>${escHtml(minutes || '—')}</p>
          <h2>✅ Action Items</h2>${actionsHtml}
          <h2>🔗 References</h2>${refsHtml}
          <h2>📝 Full Transcript</h2>${transcriptHtml}
        </body></html>`;

      const src = 'data:application/vnd.ms-word;charset=utf-8,' + encodeURIComponent(html);
      Object.assign(document.createElement('a'),
        { href: src, download: 'PeerSpace_Summary.doc' }).click();
      this.log('Summary exported', 'ok');
    },
  };

  // ── Utilities ──────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      pdf:'📄', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', webp:'🖼️', gif:'🖼️',
      zip:'🗜️', tar:'🗜️', gz:'🗜️', rar:'🗜️',
      mp4:'🎬', webm:'🎬', mov:'🎬',
      mp3:'🎵', wav:'🎵', ogg:'🎵',
    };
    return map[ext] || '📦';
  }

})();