/**
 * transcription.js — Main-thread transcription manager.
 *
 * VAD pipeline:
 *   100ms frames → frame RMS → state machine (silence/speech)
 *   → speech end detected → concat segment frames → OfflineAudioContext resample
 *   → Whisper worker
 *
 * Key fix over previous version: segment frames are collected in a dedicated
 * _segFrames array, not by index into a rolling buffer that shifts.
 * The rolling buffer is only used for lead-in capture on speech start.
 */
'use strict';

const SPEECH_THRESHOLD  = 0.004;   // very low — handles attenuated phone-speaker-through-mic
const SPEECH_CONFIRM_MS = 250;
const SILENCE_CLOSE_MS  = 1400;
const MIN_SEGMENT_MS    = 400;     // lower — catch shorter utterances
const MAX_SEGMENT_MS    = 28000;
const LEAD_IN_MS        = 300;

// Debug: log peak RMS every 3 seconds so you can see the actual signal level
let _debugRmsMax   = 0;
let _debugRmsTimer = Date.now();

class TranscriptionManager {
  constructor(stream, speakerName, { onChunk, onModelProgress, onModelReady, onError }) {
    this._stream     = stream;
    this._speaker    = speakerName;
    this._onChunk    = onChunk;
    this._onProgress = onModelProgress;
    this._onReady    = onModelReady;
    this._onError    = onError;

    this._ctx         = null;
    this._sourceNode  = null;
    this._workletNode = null;
    this._worker      = null;
    this._paused      = false;
    this._nativeSR    = null;

    // Rolling buffer for lead-in capture only (last ~1s)
    this._frameMs        = 100;
    this._leadInFrames   = Math.ceil(LEAD_IN_MS / 100);
    this._recentFrames   = [];   // last N frames, used for lead-in only

    // Active segment — frames go here once speech opens
    this._segFrames      = [];
    this._segMs          = 0;

    // VAD state
    this._vadState       = 'silence';
    this._speechCount    = 0;    // consecutive speech frames
    this._silenceCount   = 0;    // consecutive silence frames

    this._init();
  }

  async _init() {
    try {
      this._worker = new Worker('js/workers/transcription.worker.js', { type: 'module' });
      this._worker.onmessage = ({ data }) => this._handleWorkerMsg(data);
      this._worker.onerror   = e => this._onError?.('Worker error: ' + (e.message || e));
      this._worker.postMessage({ cmd: 'load', modelId: 'Xenova/whisper-small.en' });

      this._ctx = new AudioContext();
      await this._ctx.audioWorklet.addModule('js/workers/audio-processor.js');
      this._sourceNode  = this._ctx.createMediaStreamSource(this._stream);
      this._workletNode = new AudioWorkletNode(this._ctx, 'audio-processor');

      this._workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'info') { this._nativeSR = data.sampleRate; return; }
        if (data.type === 'frame' && !this._paused) this._onFrame(data.frame);
      };

      this._sourceNode.connect(this._workletNode);
    } catch (e) {
      this._onError?.('TranscriptionManager init failed: ' + e.message);
    }
  }

  _onFrame(frame) {
    // Always maintain a small recent-frames window for lead-in
    this._recentFrames.push(frame);
    if (this._recentFrames.length > this._leadInFrames + 4)
      this._recentFrames.shift();

    const rms      = this._rms(frame);
    const isSpeech = rms > SPEECH_THRESHOLD;

    // Debug: report peak RMS every 3s so UI can show signal level
    if (rms > _debugRmsMax) _debugRmsMax = rms;
    const now = Date.now();
    if (now - _debugRmsTimer > 3000) {
      this._onError?.('DEBUG rms peak=' + _debugRmsMax.toFixed(4) +
        ' threshold=' + SPEECH_THRESHOLD +
        ' state=' + this._vadState);
      _debugRmsMax   = 0;
      _debugRmsTimer = now;
    }

    if (this._vadState === 'silence') {
      if (isSpeech) {
        this._speechCount++;
        if (this._speechCount * this._frameMs >= SPEECH_CONFIRM_MS) {
          // Open segment — prepend lead-in frames so we don't lose the first syllable
          this._vadState     = 'speech';
          this._silenceCount = 0;
          this._segFrames    = this._recentFrames.slice();  // lead-in included
          this._segMs        = this._segFrames.length * this._frameMs;
        }
      } else {
        this._speechCount = 0;
      }

    } else { // speech
      this._segFrames.push(frame);
      this._segMs += this._frameMs;

      if (!isSpeech) {
        this._silenceCount++;
        if (this._silenceCount * this._frameMs >= SILENCE_CLOSE_MS) {
          // Natural speech end
          this._vadState    = 'silence';
          this._speechCount = 0;
          this._flush();
        }
      } else {
        this._silenceCount = 0;
      }

      // Force-close very long segment
      if (this._segMs >= MAX_SEGMENT_MS) {
        this._vadState     = 'silence';
        this._speechCount  = 0;
        this._silenceCount = 0;
        this._flush();
      }
    }
  }

  async _flush() {
    const frames = this._segFrames.splice(0);
    this._segMs  = 0;

    const durationMs = frames.length * this._frameMs;
    if (durationMs < MIN_SEGMENT_MS) return;

    // Concatenate into single Float32Array at native rate
    const totalLen = frames.reduce((a, f) => a + f.length, 0);
    const raw = new Float32Array(totalLen);
    let off = 0;
    for (const f of frames) { raw.set(f, off); off += f.length; }

    try {
      const sr         = this._nativeSR || this._ctx.sampleRate;
      const resampled  = await this._resampleTo16k(raw, sr);
      if (resampled && resampled.length > 1600) {
        this._worker?.postMessage({ cmd: 'transcribe', audio: resampled }, [resampled.buffer]);
      }
    } catch (e) {
      this._onError?.('Resample error: ' + e.message);
    }
  }

  async _resampleTo16k(float32Array, fromRate) {
    const TARGET  = 16000;
    if (fromRate === TARGET) return float32Array;
    const outLen  = Math.ceil(float32Array.length * TARGET / fromRate);
    const offline = new OfflineAudioContext(1, outLen, TARGET);
    const buf     = offline.createBuffer(1, float32Array.length, fromRate);
    buf.getChannelData(0).set(float32Array);
    const src     = offline.createBufferSource();
    src.buffer    = buf;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  _rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] ** 2;
    return Math.sqrt(sum / frame.length);
  }

  _handleWorkerMsg(data) {
    switch (data.type) {
      case 'progress': this._onProgress?.(data.pct ?? 0); break;
      case 'ready':    this._onReady?.(data.modelId); break;
      case 'transcript':
        if (data.text) this._onChunk?.({ speaker: this._speaker, text: data.text, timestamp: Date.now() });
        break;
      case 'error': this._onError?.(data.message); break;
    }
  }

  pause()     { this._paused = true;  this._ctx?.suspend().catch(() => {}); }
  resume()    { this._paused = false; this._ctx?.resume().catch(() => {}); }
  isPaused()  { return this._paused; }

  stop() {
    try { this._workletNode?.disconnect(); } catch (_) {}
    try { this._sourceNode?.disconnect();  } catch (_) {}
    if (this._ctx?.state !== 'closed') this._ctx?.close().catch(() => {});
    if (this._worker) { this._worker.terminate(); this._worker = null; }
  }
}
