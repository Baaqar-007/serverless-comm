/**
 * transcription.js — Main-thread transcription manager.
 */
'use strict';

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

    this._init();
  }

  async _init() {
    try {
      this._worker = new Worker(
        'js/workers/transcription.worker.js',
        { type: 'module' }
      );
      this._worker.onmessage = ({ data }) => this._handleWorkerMsg(data);
      this._worker.onerror   = e =>
        this._onError?.('Worker error: ' + (e.message || e));

      this._worker.postMessage({ cmd: 'load', modelId: 'Xenova/whisper-base.en' });

      this._ctx = new AudioContext({ sampleRate: 16000 });
      await this._ctx.audioWorklet.addModule('js/workers/audio-processor.js');

      this._sourceNode  = this._ctx.createMediaStreamSource(this._stream);
      this._workletNode = new AudioWorkletNode(this._ctx, 'audio-processor');

      this._workletNode.port.onmessage = ({ data }) => {
        if (this._paused) return;
        if (this._worker && data?.audio) {
          this._worker.postMessage(
            { cmd: 'transcribe', audio: data.audio },
            [data.audio.buffer]
          );
        }
      };

      this._sourceNode.connect(this._workletNode);

    } catch (e) {
      this._onError?.('TranscriptionManager init failed: ' + e.message);
    }
  }

  _handleWorkerMsg(data) {
    switch (data.type) {
      case 'progress':
        this._onProgress?.(data.pct ?? 0);
        break;
      case 'ready':
        this._onReady?.();
        break;
      case 'transcript':
        if (data.text?.trim()) {
          this._onChunk?.({
            speaker:   this._speaker,
            text:      data.text.trim(),
            timestamp: Date.now(),
          });
        }
        break;
      case 'error':
        this._onError?.(data.message);
        break;
    }
  }

  pause() {
    this._paused = true;
    this._ctx?.suspend().catch(() => {});
  }

  resume() {
    this._paused = false;
    this._ctx?.resume().catch(() => {});
  }

  isPaused() { return this._paused; }

  stop() {
    try { this._workletNode?.disconnect(); } catch (_) {}
    try { this._sourceNode?.disconnect();  } catch (_) {}
    if (this._ctx?.state !== 'closed') {
      this._ctx?.close().catch(() => {});
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }
}
