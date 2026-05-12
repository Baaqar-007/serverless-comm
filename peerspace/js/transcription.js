/**
 * transcription.js v12 — Moonshine pipeline
 *
 * VAD + interval flush strategy:
 *   - Collect 100ms frames
 *   - Flush on natural silence (>= 1.2s quiet after speech)
 *   - Hard flush every 5s regardless (for continuous speech)
 *   - Moonshine processes exact duration → no wasted compute
 *
 * 100% local. Zero external calls. Audio never leaves the device.
 */
'use strict';

const SPEECH_THRESHOLD  = 0.004;
const SPEECH_CONFIRM_MS = 200;
const SILENCE_CLOSE_MS  = 1200;
const MIN_SEGMENT_MS    = 400;
const FORCED_INTERVAL   = 5000;   // 5s — Moonshine handles this in ~0.5-2s
const LEAD_IN_MS        = 200;

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

    this._frameMs      = 100;
    this._leadInFrames = Math.ceil(LEAD_IN_MS / this._frameMs);
    this._recentFrames = [];
    this._segFrames    = [];
    this._segMs        = 0;
    this._inSpeech     = false;
    this._speechCount  = 0;
    this._silenceCount = 0;
    this._flushTimer   = null;

    this._init();
  }

  async _init() {
    try {
      this._worker = new Worker(
        'js/workers/transcription.worker.js?v=12',
        { type: 'module' }
      );
      this._worker.onmessage = ({ data }) => this._handleWorkerMsg(data);
      this._worker.onerror   = e =>
        this._onError?.('Worker error: ' + (e.message || e));

      this._worker.postMessage({
        cmd: 'load',
        modelId: 'onnx-community/moonshine-base-ONNX',
      });

      this._ctx = new AudioContext();
      await this._ctx.audioWorklet.addModule(
        'js/workers/audio-processor.js?v=12'
      );
      this._sourceNode  = this._ctx.createMediaStreamSource(this._stream);
      this._workletNode = new AudioWorkletNode(this._ctx, 'audio-processor');

      this._workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'info') { this._nativeSR = data.sampleRate; return; }
        if (data.type === 'frame' && !this._paused) this._onFrame(data.frame);
      };

      this._sourceNode.connect(this._workletNode);

      // Hard interval flush — primary path for continuous speech
      this._flushTimer = setInterval(() => {
        if (!this._paused && this._segFrames.length > 0)
          this._flush('interval');
      }, FORCED_INTERVAL);

    } catch (e) {
      this._onError?.('TranscriptionManager init failed: ' + e.message);
    }
  }

  _onFrame(frame) {
    this._recentFrames.push(frame);
    if (this._recentFrames.length > this._leadInFrames + 2)
      this._recentFrames.shift();

    const isSpeech = this._rms(frame) > SPEECH_THRESHOLD;

    if (!this._inSpeech) {
      if (isSpeech) {
        this._speechCount++;
        if (this._speechCount * this._frameMs >= SPEECH_CONFIRM_MS) {
          this._inSpeech     = true;
          this._silenceCount = 0;
          this._segFrames    = this._recentFrames.slice();
          this._segMs        = this._segFrames.length * this._frameMs;
        }
      } else {
        this._speechCount = 0;
      }
    } else {
      this._segFrames.push(frame);
      this._segMs += this._frameMs;

      if (!isSpeech) {
        this._silenceCount++;
        if (this._silenceCount * this._frameMs >= SILENCE_CLOSE_MS) {
          this._inSpeech    = false;
          this._speechCount = 0;
          this._flush('silence');
        }
      } else {
        this._silenceCount = 0;
      }
    }
  }

  async _flush(reason) {
    const frames = this._segFrames.splice(0);
    this._segMs  = 0;
    if (frames.length * this._frameMs < MIN_SEGMENT_MS) return;

    const totalLen = frames.reduce((s, f) => s + f.length, 0);
    const raw      = new Float32Array(totalLen);
    let   off      = 0;
    for (const f of frames) { raw.set(f, off); off += f.length; }

    try {
      const sr        = this._nativeSR || this._ctx.sampleRate;
      const resampled = await this._resampleTo16k(raw, sr);
      if (resampled && resampled.length > 1600) {
        this._worker?.postMessage(
          { cmd: 'transcribe', audio: resampled },
          [resampled.buffer]
        );
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
    const src = offline.createBufferSource();
    src.buffer = buf;
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
      case 'ready':
        this._onReady?.(data.modelId, data.backend);
        break;
      case 'transcript':
        if (data.text) this._onChunk?.({
          speaker: this._speaker, text: data.text, timestamp: Date.now(),
        });
        break;
      case 'error': this._onError?.(data.message); break;
    }
  }

  pause()    { this._paused = true;  this._ctx?.suspend().catch(() => {}); }
  resume()   { this._paused = false; this._ctx?.resume().catch(() => {}); }
  isPaused() { return this._paused; }

  stop() {
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    try { this._workletNode?.disconnect(); } catch (_) {}
    try { this._sourceNode?.disconnect();  } catch (_) {}
    if (this._ctx?.state !== 'closed') this._ctx?.close().catch(() => {});
    if (this._worker) { this._worker.terminate(); this._worker = null; }
  }
}
