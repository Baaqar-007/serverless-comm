/**
 * room.js — Session orchestrator
 *
 * Fix log:
 *  v2 — ICE queue in connection.js (too late; conn didn't exist yet)
 *  v3 — Room-level ICE buffer: candidates that arrive before `conn`
 *       is created are held in `_pendingIceBuf[]` and drained the
 *       moment `conn` is assigned via setConn(). Combined with
 *       connection.js's own post-setRemoteDescription drain this
 *       covers both timing gaps.
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

  // ── Module instances ───────────────────────────────────────────
  let signaling  = null;
  let conn       = null;
  let docSync    = null;
  let chatMgr    = null;
  let fileXfer   = null;

  // ── Runtime state ──────────────────────────────────────────────
  let localStream   = null;
  let sessionStart  = null;
  let statsTimer    = null;
  let connected     = false;
  let initiating    = false;

  // Room-level ICE buffer
  let _pendingIceBuf = [];

  // ── Boot ───────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      UI.init(MY_NAME, ROOM_ID);
      await startCamera();
      initSignaling();
      announce();
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
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      UI.setLocalVideo(localStream);
      UI.log('Camera ready', 'ok');
    } catch (e) {
      UI.log('No camera — audio only', 'warn');
    }
  }

  // ── Signaling ──────────────────────────────────────────────────
  function initSignaling() {
    signaling = new Signaling(ROOM_ID, MY_ID);
    signaling
      .on('announce',     handlePeerAnnounce)
      .on('announce:ack', handlePeerAck)
      .on('offer',        handleOffer)
      .on('answer',       handleAnswer)
      .on('ice',          handleIce)
      .on('leaving',      handlePeerLeft);
  }

  function announce() {
    signaling.send('announce', { name: MY_NAME });
    UI.setStatus('waiting', 'Waiting for peer…');
    UI.log('Announced → room ' + ROOM_ID, 'info');
  }

  // ── Peer discovery ─────────────────────────────────────────────
  function handlePeerAnnounce({ from, name }) {
    UI.log('"' + name + '" joined', 'ok');
    signaling.send('announce:ack', { name: MY_NAME }, from);
    if (MY_ID < from) initiateOffer(from);
  }

  function handlePeerAck({ from, name }) {
    UI.log('"' + name + '" ready', 'ok');
    if (!conn && !initiating && MY_ID < from) initiateOffer(from);
  }

  // ── WebRTC flow ────────────────────────────────────────────────
  async function initiateOffer(remotePeerId) {
    if (conn || initiating) return;
    initiating = true;
    UI.setStage(1, 'active');
    UI.log('Creating offer…', 'signal');

    setConn(buildConnection(remotePeerId));
    if (localStream) conn.addStream(localStream);

    try {
      await conn.offer();
      UI.log('Offer sent', 'signal');
      UI.setStage(1, 'done');
      UI.setStage(2, 'active');
    } catch (e) {
      UI.log('Offer error: ' + e.message, 'error');
      initiating = false;
    }
  }

  async function handleOffer({ from, sdp }) {
    UI.log('Offer received', 'signal');
    UI.setStage(1, 'done');
    UI.setStage(2, 'active');

    setConn(buildConnection(from));
    if (localStream) conn.addStream(localStream);

    try {
      await conn.handleOffer(sdp);
      UI.log('Answer sent', 'signal');
      UI.setStage(2, 'done');
      UI.setStage(3, 'active');
    } catch (e) {
      UI.log('Answer error: ' + e.message, 'error');
    }
  }

  async function handleAnswer({ sdp }) {
    if (!conn) return;
    try {
      await conn.handleAnswer(sdp);
      UI.log('Answer received — ICE checking…', 'signal');
      UI.setStage(2, 'done');
      UI.setStage(3, 'active');
    } catch (e) {
      UI.log('handleAnswer error: ' + e.message, 'error');
    }
  }

  // ── ICE — two-layer buffering ──────────────────────────────────
  // Layer 1 (room.js): buffer until conn object exists
  // Layer 2 (connection.js): buffer until setRemoteDescription done
  async function handleIce({ candidate }) {
    if (!conn) {
      _pendingIceBuf.push(candidate);
      return;
    }
    await conn.handleIce(candidate);
    UI.log('ICE ← ' + (candidate.type || 'host'), 'signal');
  }

  // Assigns conn and immediately drains any buffered ICE candidates
  function setConn(c) {
    conn = c;
    if (_pendingIceBuf.length) {
      UI.log('Draining ' + _pendingIceBuf.length + ' buffered ICE candidates', 'signal');
      const buf = _pendingIceBuf.slice();
      _pendingIceBuf = [];
      buf.forEach(cand => conn.handleIce(cand));
    }
  }

  function handlePeerLeft() {
    UI.log('Peer disconnected', 'warn');
    teardown();
    UI.setStatus('waiting', 'Peer left — waiting…');
    UI.setRemoteVideoOff();
    announce();
  }

  // ── Connection factory ─────────────────────────────────────────
  function buildConnection(remotePeerId) {
    const c = new Connection(signaling, MY_ID, remotePeerId);

    c.on('ice-state', state => {
      UI.updateStat('ice', state.toUpperCase().slice(0, 8));
      UI.log('ICE → ' + state, 'signal');
      if (state === 'connected' || state === 'completed') {
        UI.setStage(3, 'done');
        UI.setStage(4, 'active');
      }
      if (state === 'failed') {
        UI.log('ICE failed — restarting…', 'warn');
        c.pc.restartIce();
      }
    });

    c.on('conn-state', state => {
      if (state === 'failed') teardown();
    });

    c.on('track', ({ stream }) => {
      UI.setRemoteVideo(stream);
      UI.log('Remote video active', 'ok');
    });

    c.on('channels-ready', () => onChannelsReady(c));
    c.on('channel-open',  label =>
      UI.log('Channel [' + label.replace('ps:', '') + '] open', 'ok'));
    c.on('channel-error', ({ label, error }) =>
      UI.log('Channel error [' + label + ']: ' + error, 'error'));

    c.onChannel(PS.DC.DOC,  data => docSync?.receive(data));
    c.onChannel(PS.DC.CHAT, data => chatMgr?.receive(data));
    c.onChannel(PS.DC.FILE, data => fileXfer?.receive(data));
    c.onChannel(PS.DC.CTRL, data => handleCtrl(data, c));

    return c;
  }

  // ── Session live ───────────────────────────────────────────────
  function onChannelsReady(c) {
    if (connected) return;
    connected    = true;
    sessionStart = Date.now();

    // Hook up Quill to Sync Engine
    docSync = new DocSync(delta => {
      UI.quill.updateContents(delta);
    });

    UI.quill.on('text-change', (delta, oldDelta, source) => {
      if (source === 'user' && !docSync.isSuppressed) {
        sendDoc(delta);
      }
      document.getElementById('docChars').textContent = (UI.quill.getLength() - 1) + ' chars';
    });

    chatMgr = new Chat(MY_NAME, (msg, self) => UI.renderChat(msg, self));

    fileXfer = new FileTransfer(
      (id, name, ratio, dir) => UI.updateFileProgress(id, name, ratio, dir),
      (id, name, blob)       => UI.completeFile(id, name, blob)
    );
    fileXfer.setSend(data => c.send(PS.DC.FILE, data));

    UI.setStage(4, 'done');
    UI.setStage(5, 'active');
    setTimeout(() => UI.setStage(5, 'done'), 500);
    UI.setStatus('connected', '● P2P Live');
    UI.enableSession();
    startStats(c);
    UI.log('SESSION LIVE — all data is P2P', 'ok');
  }

  function teardown() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    conn?.close();
    conn         = null;
    initiating   = false;
    connected    = false;
    _pendingIceBuf = [];
    docSync = chatMgr = fileXfer = null;
    UI.disableSession();
    UI.resetStages();
  }

  // ── Control channel ────────────────────────────────────────────
  function handleCtrl(raw, c) {
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
    }
  }

  // ── Stats loop ─────────────────────────────────────────────────
  function startStats(c) {
    statsTimer = setInterval(async () => {
      c.send(PS.DC.CTRL, JSON.stringify({ t: 'ping', ts: Date.now() }));
      UI.updateStat('time', formatTime(Date.now() - sessionStart));
      try {
        const stats = await c.getStats();
        let sent = 0, recv = 0;
        stats.forEach(r => {
          if (r.type === 'data-channel') {
            sent += r.bytesSent    || 0;
            recv += r.bytesReceived || 0;
          }
        });
        UI.updateStat('sent', formatBytes(sent));
        UI.updateStat('recv', formatBytes(recv));
      } catch (_) {}
    }, 2000);
  }

  // ── Send actions ───────────────────────────────────────────────
  function sendDoc(delta) {
    if (!conn || !docSync || !connected) return;
    conn.send(PS.DC.DOC, docSync.pack(delta));
  }

  function sendChat(text) {
    if (!text.trim() || !conn || !chatMgr || !connected) return;
    conn.send(PS.DC.CHAT, chatMgr.send(text));
    conn.send(PS.DC.CTRL, JSON.stringify({ t: 'typing', name: MY_NAME }));
  }

  function sendFile(file) {
    if (!file || !conn || !fileXfer || !connected) return;
    fileXfer.send(file);
  }

  function toggleMute() {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btnMute').textContent = t.enabled ? '🎤 Mute' : '🔇 Unmute';
  }

  function toggleCam() {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btnCam').textContent = t.enabled ? '📷 Cam Off' : '📷 Cam On';
  }

  window.addEventListener('beforeunload', () => {
    signaling?.send('leaving', {});
    teardown();
    signaling?.destroy();
    localStream?.getTracks().forEach(t => t.stop());
  });

  window._ps = { sendDoc, sendChat, sendFile, toggleMute, toggleCam };

  // ══════════════════════════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════════════════════════
  const UI = {
    _typingTimer: null,
    quill: null,

    init(name, roomId) {
      document.getElementById('myName').textContent   = name;
      document.getElementById('roomCode').textContent = roomId;

      const icons = Quill.import('ui/icons');
      this.quill = new Quill('#docEditor', {
        theme: 'snow',
        modules: {
          table: true,
          toolbar: '#docToolbar'
        },
        placeholder: 'Establish connection to begin collaborative synthesis. Growth syncs seamlessly via WebRTC...'
      });
      this.quill.disable();

      document.getElementById('btnInsertTable').addEventListener('click', () => {
        if (!connected) return;
        const table = this.quill.getModule('table');
        table.insertTable(3, 3); // Default 3x3 table
      });

      document.getElementById('btnExport').addEventListener('click', () => {
        const html = this.quill.getSemanticHTML();
        const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>PeerSpace Synthesis</title></head><body>";
        const footer = "</body></html>";
        const sourceHTML = header + html + footer;
        
        const source = 'data:application/vnd.ms-word;charset=utf-8,' + encodeURIComponent(sourceHTML);
        const fileDownload = document.createElement("a");
        document.body.appendChild(fileDownload);
        fileDownload.href = source;
        fileDownload.download = 'PeerSpace_Synthesis.doc';
        fileDownload.click();
        document.body.removeChild(fileDownload);
        
        this.log('Exported document as Word file', 'ok');
      });

      document.getElementById('copyLink').addEventListener('click', () => {
        navigator.clipboard?.writeText(location.href).then(() => {
          const btn = document.getElementById('copyLink');
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = orig, 1400);
        });
      });

      const ed = document.getElementById('docEditor');
      ed.addEventListener('input', () => {
        if (!docSync?.isSuppressed) sendDoc(ed.value);
        document.getElementById('docChars').textContent = ed.value.length + ' chars';
      });

      document.getElementById('chatInput').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat(e.target.value);
          e.target.value = '';
        }
      });
      document.getElementById('chatSend').addEventListener('click', () => {
        const inp = document.getElementById('chatInput');
        sendChat(inp.value);
        inp.value = '';
      });

      document.getElementById('filePicker').addEventListener('change', e => {
        const f = e.target.files[0];
        if (f) { sendFile(f); e.target.value = ''; }
      });
      const dz = document.getElementById('fileDropZone');
      dz.addEventListener('click', () => document.getElementById('filePicker').click());
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dz-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('dz-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('dz-over');
        const f = e.dataTransfer.files[0];
        if (f) sendFile(f);
      });

      document.getElementById('btnMute').addEventListener('click', toggleMute);
      document.getElementById('btnCam').addEventListener('click', toggleCam);
      document.querySelectorAll('.tab').forEach(t =>
        t.addEventListener('click', () => this.switchTab(t.dataset.tab)));
    },

    setStatus(state, text) {
      const el = document.getElementById('statusPill');
      el.textContent = text;
      el.className   = 'status-pill status-' + state;
    },

    setStage(n, state) {
      const el = document.querySelector('[data-stage="' + n + '"]');
      if (el) el.className = 'stage stage-' + state;
    },

    resetStages() {
      for (let i = 1; i <= 5; i++) this.setStage(i, 'idle');
    },

    setLocalVideo(stream) {
      const v = document.getElementById('localVideo');
      document.getElementById('localOff').hidden = true;
      v.hidden = false;
      v.srcObject = stream;
      v.play().catch(() => {});
    },

    setRemoteVideo(stream) {
      const v = document.getElementById('remoteVideo');
      document.getElementById('remoteOff').hidden = true;
      v.hidden    = false;
      v.srcObject = stream;
      v.play().catch(() => {});
      setTimeout(() => v.play().catch(() => {}), 300);
    },

    setRemoteVideoOff() {
      const v = document.getElementById('remoteVideo');
      v.srcObject = null;
      v.hidden    = true;
      document.getElementById('remoteOff').hidden = false;
    },

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

    updateStat(key, val) {
      const el = document.getElementById('stat-' + key);
      if (el) el.textContent = val;
    },

    log(msg, type) {
      type = type || 'info';
      const log = document.getElementById('signalLog');
      if (!log) return;
      const row = document.createElement('div');
      row.className = 'log-row log-' + type;
      const d   = new Date();
      const ts  = String(d.getMinutes()).padStart(2,'0') + ':' +
                  String(d.getSeconds()).padStart(2,'0');
      row.innerHTML =
        '<span class="log-ts">' + ts + '</span>' +
        '<span class="log-msg">' + escHtml(msg) + '</span>';
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    },

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
      const pct  = Math.round(ratio * 100);
      const fill = document.getElementById('ff-' + id);
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

    switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab));
      document.querySelectorAll('.tab-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.pane === tab));
    },
  };

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
