/**
 * config.js — PeerSpace constants and shared utilities
 */
'use strict';

const PS = Object.freeze({
  ICE: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]
  },
  // DataChannel labels
  DC: {
    DOC:  'ps:doc',
    CHAT: 'ps:chat',
    FILE: 'ps:file',
    CTRL: 'ps:ctrl',
  },
  CHUNK_SIZE: 64 * 1024,        // 64 KB per file chunk
  MAX_PEERS:  4,                
  SIGNAL_CHANNEL: (roomId) => `ps:room:${roomId}`,
});

// ── Utilities ────────────────────────────────────────────────────

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    b => chars[b % chars.length]
  ).join('');
}

function formatBytes(b) {
  if (b > 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b > 1024)        return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
