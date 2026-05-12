/**
 * transcription.worker.js v12 — Moonshine ASR
 *
 * Model: onnx-community/moonshine-base-ONNX
 * - 5-15x faster than Whisper (no 30s zero-padding)
 * - WebGPU accelerated → WASM fallback
 * - 100% local, zero data leaves device
 * - ~120MB WASM / ~150MB WebGPU
 *
 * At 5s chunks: ~300-500ms on WebGPU, ~1-2s on WASM.
 * Real-time capable on any modern laptop.
 */

import { AutoTokenizer, AutoProcessor, MoonshineForConditionalGeneration, env }
  from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache  = true;


let _tokenizer = null;
let _processor = null;
let _model     = null;

// v3 backend config
env.backends.onnx.wasm.numThreads =
  typeof navigator !== 'undefined'
    ? Math.min(navigator.hardwareConcurrency || 2, 4)
    : 2;

let transcriber    = null;
let _loadedModelId = null;
let _backend       = 'wasm';

// ── Hallucination filter ──────────────────────────────────────────────────────

const JUNK = new Set([
  'thank you.', 'thank you', 'thanks.', 'thanks', 'thanks for watching.',
  'please subscribe.', 'bye.', 'bye', 'goodbye.', 'you.',
  '[blank_audio]', '[music]', '[applause]', '[silence]', '.', '...', '',
]);

function clean(raw) {
  if (!raw) return null;
  let t = raw.replace(/\[.*?\]/g, '').replace(/>>+/g, '').trim();
  if (!t || JUNK.has(t.toLowerCase().replace(/[.,!?]/g, '').trim())) return null;
  if (t.length < 3) return null;
  return t;
}

// ── Loader ────────────────────────────────────────────────────────────────────

async function loadModel(modelId) {
  _loadedModelId = modelId;

  const hasWebGPU = typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    (await navigator.gpu?.requestAdapter().catch(() => null)) != null;
  _backend = hasWebGPU ? 'webgpu' : 'wasm';

  const opts = {
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    device: _backend,
    progress_callback(p) {
      if (p.status === 'downloading') {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        self.postMessage({ type: 'progress', pct, message: `Downloading Moonshine… ${pct}%` });
      }
    },
  };

  [_tokenizer, _processor, _model] = await Promise.all([
    AutoTokenizer.from_pretrained(modelId),
    AutoProcessor.from_pretrained(modelId),
    MoonshineForConditionalGeneration.from_pretrained(modelId, opts),
  ]);

  self.postMessage({ type: 'ready', modelId, backend: _backend });
}

// ── Inference ─────────────────────────────────────────────────────────────────

async function transcribe(audio) {
  if (!_model) {
    self.postMessage({ type: 'error', message: 'Model not loaded yet.' });
    return;
  }

  const inputs   = await _processor(audio, { sampling_rate: 16000 });
  const tokens   = await _model.generate({ ...inputs });
  const decoded  = _tokenizer.batch_decode(tokens, { skip_special_tokens: true });
  const text     = clean(decoded[0] || '');
  if (text) self.postMessage({ type: 'transcript', text });
}

// ── Handler ───────────────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'load')       await loadModel(data.modelId);
    if (data.cmd === 'transcribe') await transcribe(data.audio);
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
