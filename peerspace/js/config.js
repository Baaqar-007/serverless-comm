/**
 * config.js — PeerSpace constants and shared utilities
 */
'use strict';

const PS = Object.freeze({
  ICE: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "e5b32916d49eafeb4be017c0",
        credential: "8F08omBCRLzJUWEP",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "e5b32916d49eafeb4be017c0",
        credential: "8F08omBCRLzJUWEP",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "e5b32916d49eafeb4be017c0",
        credential: "8F08omBCRLzJUWEP",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "e5b32916d49eafeb4be017c0",
        credential: "8F08omBCRLzJUWEP",
      }
    ]
  },
  // DataChannel labels
  DC: {
    DOC:        'ps:doc',
    CHAT:       'ps:chat',
    FILE:       'ps:file',
    CTRL:       'ps:ctrl',
    TRANSCRIPT: 'ps:transcript',  // live transcript chunks — one per speaker
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

/**
 * selectModels — returns the Transformers.js model IDs for this session.
 *
 * Phase 1: hardcoded small models that run on any WebAssembly-capable browser.
 * Phase 2: will benchmark deviceMemory / hardwareConcurrency / WebGPU at
 *          worker startup and return a tiered model set (tiny → small → medium).
 *          Only this function needs to change for Phase 2 — nothing else.
 *
 * @returns {{ transcription: string, summarization: string }}
 */
function selectModels() {
  return {
    // Moonshine: 5-15x faster than Whisper, processes exact audio duration,
    // WebGPU-accelerated, 100% local — no data leaves the device.
    transcription: 'onnx-community/moonshine-base-ONNX',
    summarization: 'Xenova/distilbart-cnn-6-6',
  };
}
