/**
 * transcription.worker.js — Whisper ASR inference worker
 *
 * Message protocol (main thread → worker):
 *   { cmd: 'load',       modelId: string }
 *   { cmd: 'transcribe', audio: Float32Array }  (transferred buffer)
 *
 * Message protocol (worker → main thread):
 *   { type: 'progress', pct: number, message: string }
 *   { type: 'ready' }
 *   { type: 'transcript', text: string }
 *   { type: 'error',    message: string }
 *
 * The worker is created with { type: 'module' } so ES import syntax works.
 */

import { pipeline, env }
  from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

// Use the browser's IndexedDB cache (built into Transformers.js).
// On first load the model is downloaded once; all subsequent rooms use cache.
env.allowLocalModels = false;
env.useBrowserCache  = true;

let transcriber = null;

// ── Model loader ────────────────────────────────────────────────

async function loadModel(modelId) {
  transcriber = await pipeline(
    'automatic-speech-recognition',
    modelId,
    {
      quantized: true,                        // smaller/faster .onnx weights
      progress_callback(p) {
        if (p.status === 'downloading') {
          const pct = p.total
            ? Math.round((p.loaded / p.total) * 100)
            : 0;
          self.postMessage({
            type: 'progress',
            pct,
            message: `Downloading Whisper… ${pct}%`,
          });
        }
      },
    }
  );
  self.postMessage({ type: 'ready' });
}

// ── Inference ───────────────────────────────────────────────────

async function transcribe(audio) {
  if (!transcriber) {
    self.postMessage({ type: 'error', message: 'Model not loaded yet.' });
    return;
  }

  // audio is a Float32Array at 16 kHz — exactly what Whisper expects.
  const result = await transcriber(audio, {
    language:          'english',
    task:              'transcribe',
    return_timestamps: false,
  });

  const text = (result?.text || '').trim();
  if (text) self.postMessage({ type: 'transcript', text });
}

// ── Message handler ─────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'load')       await loadModel(data.modelId);
    if (data.cmd === 'transcribe') await transcribe(data.audio);
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
