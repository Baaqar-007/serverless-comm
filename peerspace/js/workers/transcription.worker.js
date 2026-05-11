/**
 * transcription.worker.js — Whisper ASR inference worker
 *
 * Model: whisper-small.en  (~244MB, English-only, 4× better than base.en)
 * Inference: ONNX WASM with max threads for speed
 *
 * Post-processing:
 *   - Strips Whisper hallucination tokens (>>, [Music], [Blank_Audio], etc.)
 *   - Discards outputs that are pure repetition or too short to be real speech
 *   - Strips common silent-audio hallucinations ("Thank you.", "you", etc.)
 */

import { pipeline, env }
  from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache  = true;
// Use all available threads for faster WASM inference
env.backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 2, 4);

let transcriber = null;
let _loadedModelId = null;

// ── Known Whisper hallucination strings on silence / near-silence ────────────
const HALLUCINATION_EXACT = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thanks for watching!',
  'thank you.', 'thank you!', 'thank you so much', 'please subscribe',
  'bye', 'bye!', 'goodbye', 'see you', '.', '..', '...', 'uh', 'um',
  'the', 'a', 'i', 'and', 'or', 'is', 'it', 'in', 'of', 'to', 'we',
]);

const HALLUCINATION_PATTERNS = [
  /^>+$/,                         // >> or >>>
  /^\[.*\]$/,                     // [Music], [Applause], [BLANK_AUDIO]
  /^♪.*♪$/,                       // song lyrics markers
  /^(\w+)( \1){3,}$/i,            // word repeated 4+ times
];

function filterHallucination(text) {
  // Strip Whisper bracket tokens and >> markers
  text = text
    .replace(/\[.*?\]/g, '')      // [Music], [BLANK_AUDIO], etc.
    .replace(/>>+/g, '')          // >> >>>
    .replace(/♪[^♪]*♪?/g, '')    // ♪ ... ♪
    .trim();

  if (!text) return null;

  const lower = text.toLowerCase().replace(/[.,!?]/g, '').trim();

  // Exact hallucination match
  if (HALLUCINATION_EXACT.has(lower)) return null;

  // Pattern match
  if (HALLUCINATION_PATTERNS.some(rx => rx.test(lower))) return null;

  // Too short after cleaning — likely garbage
  if (text.length < 6) return null;

  // Very short single-word outputs are almost always hallucinations
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && text.length < 8) return null;

  return text;
}

// ── Model loader ─────────────────────────────────────────────────────────────

async function loadModel(modelId) {
  _loadedModelId = modelId;
  transcriber = await pipeline(
    'automatic-speech-recognition',
    modelId,
    {
      quantized: true,
      progress_callback(p) {
        if (p.status === 'downloading') {
          const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
          self.postMessage({ type: 'progress', pct, message: `Downloading ${modelId}… ${pct}%` });
        }
      },
    }
  );
  self.postMessage({ type: 'ready', modelId: _loadedModelId });
  console.log('[Whisper worker] loaded:', _loadedModelId);
}

// ── Inference ────────────────────────────────────────────────────────────────

async function transcribe(audio) {
  if (!transcriber) {
    self.postMessage({ type: 'error', message: 'Model not loaded yet.' });
    return;
  }

  const result = await transcriber(audio, {
    task:                              'transcribe',
    return_timestamps:                 false,
    // Beam search — significantly more accurate than greedy
    num_beams:                         5,
    // Temperature: start at 0 (deterministic), fall back to sampling on low-confidence
    temperature:                       0,
    temperature_increment_on_fallback: 0.2,
    // Discard windows Whisper classifies as non-speech
    no_speech_threshold:               0.8,  // lenient for attenuated audio
    // Discard if output looks repetitive / compressed (hallucination signal)
    compression_ratio_threshold:       2.4,
    // Discard low log-probability outputs
    logprob_threshold:                 -1.0,
    // Suppress common hallucination tokens at the decoding level
    suppress_tokens: [-1],
  });

  const raw  = result?.text || '';
  const text = filterHallucination(raw);
  if (text) self.postMessage({ type: 'transcript', text });
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'load')       await loadModel(data.modelId);
    if (data.cmd === 'transcribe') await transcribe(data.audio);
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
