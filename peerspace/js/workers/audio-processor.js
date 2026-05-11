/**
 * audio-processor.js — sends 100ms frames to main thread at native rate.
 * No downsampling here. Main thread handles resampling via OfflineAudioContext.
 */
const FRAME_MS = 100;

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frameSamples = Math.ceil(sampleRate * (FRAME_MS / 1000));
    this._buf = new Float32Array(this._frameSamples);
    this._pos = 0;
    this.port.postMessage({ type: 'info', sampleRate });
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos++] = ch[i];
      if (this._pos >= this._frameSamples) {
        // Single slice, single transfer — correct ownership transfer
        const copy = this._buf.slice(0);
        this.port.postMessage({ type: 'frame', frame: copy }, [copy.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
