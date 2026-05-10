/**
 * summarizer.worker.js — Post-meeting summarization worker
 *
 * Message protocol (main thread → worker):
 *   { transcript: Array<{speaker, text, timestamp}>, models: {summarization: string} }
 *
 * Message protocol (worker → main thread):
 *   { type: 'progress', message: string }
 *   { type: 'result',   result: MeetingResult }
 *   { type: 'error',    message: string }
 *
 * MeetingResult shape:
 *   {
 *     minutes:      string,           — prose summary
 *     actions:      string[],         — heuristic action-item sentences
 *     references:   string[],         — extracted URLs
 *     speakers:     string[],         — unique speaker names
 *     duration:     number,           — meeting length in minutes
 *     chunkCount:   number,
 *     rawTranscript: chunk[]          — full transcript for export
 *   }
 */

import { pipeline, env }
  from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache  = true;

// ── Helpers ─────────────────────────────────────────────────────

/** Split a long string into ≤maxLen chunks at sentence boundaries. */
function splitText(text, maxLen = 900) {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/** Extract URLs from a blob of text. */
function extractUrls(text) {
  const rx = /https?:\/\/[^\s)>"']{6,}/gi;
  return [...new Set(text.match(rx) || [])].slice(0, 20);
}

/** Heuristic: sentences that look like action items. */
function extractActions(chunks) {
  const rx = /\b(will|should|need to|must|going to|please|action:|TODO:|task:)\b[^.!?\n]{5,100}/gi;
  const fullText = chunks.map(c => c.text).join(' ');
  return [...new Set(fullText.match(rx) || [])].slice(0, 10);
}

// ── Main ────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  const { transcript, models } = data;

  try {
    // ── 1. Load model ─────────────────────────────────────────
    self.postMessage({ type: 'progress', message: 'Loading summarization model…' });

    const summarizer = await pipeline(
      'summarization',
      models.summarization,
      {
        quantized: true,
        progress_callback(p) {
          if (p.status === 'downloading') {
            const pct = p.total
              ? Math.round((p.loaded / p.total) * 100)
              : 0;
            self.postMessage({
              type: 'progress',
              message: `Downloading summarizer… ${pct}%`,
            });
          }
        },
      }
    );

    // ── 2. Build labelled transcript ──────────────────────────
    self.postMessage({ type: 'progress', message: 'Analysing transcript…' });

    const fullText = transcript
      .map(c => `[${c.speaker}]: ${c.text}`)
      .join(' ');

    // ── 3. Summarise in chunks (model input limit ~1 024 tokens) ─
    self.postMessage({ type: 'progress', message: 'Generating minutes…' });

    const textChunks = splitText(fullText, 900);
    const summaryParts = [];

    for (let i = 0; i < textChunks.length; i++) {
      self.postMessage({
        type: 'progress',
        message: `Summarising segment ${i + 1} / ${textChunks.length}…`,
      });
      const out = await summarizer(textChunks[i], {
        max_new_tokens: 100,
        min_length:     20,
        no_repeat_ngram_size: 3,
      });
      const part = out[0]?.summary_text || '';
      if (part.trim()) summaryParts.push(part.trim());
    }

    const minutes = summaryParts.join(' ');

    // ── 4. Heuristics ─────────────────────────────────────────
    const actions    = extractActions(transcript);
    const references = extractUrls(fullText);
    const speakers   = [...new Set(transcript.map(c => c.speaker))];

    const first    = transcript[0]?.timestamp    || Date.now();
    const last     = transcript[transcript.length - 1]?.timestamp || Date.now();
    const duration = Math.round((last - first) / 60000);

    self.postMessage({
      type: 'result',
      result: {
        minutes,
        actions,
        references,
        speakers,
        duration,
        chunkCount:    transcript.length,
        rawTranscript: transcript,
      },
    });

  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
