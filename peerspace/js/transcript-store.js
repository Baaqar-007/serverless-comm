/**
 * transcript-store.js — In-memory store for live transcript chunks.
 *
 * Chunk shape: { speaker: string, text: string, timestamp: number }
 *
 * Zero dependencies. Written to by:
 *   - TranscriptionManager  (local mic chunks)
 *   - room.js DC handler     (remote peer chunks over ps:transcript)
 * Read by:
 *   - UI renderer            (live feed tab)
 *   - summarizer             (post-meeting input)
 */
'use strict';

const TranscriptStore = (() => {
  const _chunks    = [];
  const _listeners = [];

  return {
    push(chunk) {
      _chunks.push(chunk);
      _listeners.forEach(fn => {
        try { fn(chunk); } catch (_) {}
      });
    },

    getAll()  { return [..._chunks]; },
    count()   { return _chunks.length; },
    clear()   { _chunks.length = 0; },

    /** Subscribe to new chunks. Returns an unsubscribe function. */
    onChunk(fn) {
      _listeners.push(fn);
      return () => {
        const i = _listeners.indexOf(fn);
        if (i !== -1) _listeners.splice(i, 1);
      };
    },
  };
})();
