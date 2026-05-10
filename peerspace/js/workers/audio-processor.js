/**
 * audio-processor.js — AudioWorkletProcessor
 *
 * Accumulates raw PCM frames from the microphone and flushes one window
 * (~6 seconds) to the main thread via port.postMessage().
 *
 * Expects the AudioContext to be created at sampleRate 16 000 Hz so that
 * no resampling is needed before feeding the buffer to Whisper.
 *
 * Isolation: this file runs inside the AudioWorklet global scope — no ES
 * module imports, no DOM access, only AudioWorkletProcessor API.
 */

const WINDOW_SAMPLES = 16000 * 15; // 15 s — more context = much better accuracy

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(WINDOW_SAMPLES);
    this._pos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._pos++] = channel[i];

      if (this._pos >= WINDOW_SAMPLES) {
        // VAD: compute RMS — skip silent windows so Whisper doesn't hallucinate
        let sum = 0;
        for (let j = 0; j < this._buf.length; j++) sum += this._buf[j] ** 2;
        const rms = Math.sqrt(sum / this._buf.length);

        if (rms > 0.008) {
          const copy = this._buf.slice(0);
          this.port.postMessage({ audio: copy }, [copy.buffer]);
        }
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
