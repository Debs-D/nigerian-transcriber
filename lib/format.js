// Turns an AssemblyAI transcript into readable, speaker-labelled paragraphs.
// Words are never altered — only grouped into paragraphs.

const SENTENCE_END = /[.?!]["'”’)\]]*$/;
const SOFT_PARAGRAPH_MS = 25_000; // break at a sentence end + pause after this long
const HARD_PARAGRAPH_MS = 60_000; // break at the next sentence end after this long
const PAUSE_MS = 1_200;

export function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function splitWords(words, speaker) {
  const segments = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);
    const next = words[i + 1];
    if (!next) break;
    if (!SENTENCE_END.test(w.text)) continue;
    const duration = w.end - current[0].start;
    const gap = next.start - w.end;
    if (duration >= HARD_PARAGRAPH_MS || (duration >= SOFT_PARAGRAPH_MS && gap >= PAUSE_MS)) {
      segments.push(toSegment(current, speaker));
      current = [];
    }
  }
  if (current.length) segments.push(toSegment(current, speaker));
  return segments;
}

function toSegment(words, speaker) {
  return {
    speaker,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.text).join(' '),
  };
}

export function buildSegments(t) {
  const segments = [];
  if (Array.isArray(t.utterances) && t.utterances.length) {
    for (const u of t.utterances) {
      if (u.words?.length) segments.push(...splitWords(u.words, u.speaker ?? null));
      else if (u.text) segments.push({ speaker: u.speaker ?? null, start: u.start, end: u.end, text: u.text });
    }
  } else if (t.words?.length) {
    segments.push(...splitWords(t.words, null));
  } else if (t.text) {
    segments.push({ speaker: null, start: 0, end: (t.audio_duration || 0) * 1000, text: t.text });
  }

  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  return {
    segments,
    speakers,
    durationSec: t.audio_duration ?? null,
    wordCount: t.words?.length ?? (t.text ? t.text.split(/\s+/).length : 0),
    model: t.speech_model_used || t.speech_model || null,
  };
}

export function speakerLabel(speaker, names = {}) {
  if (!speaker) return '';
  return (names[speaker] || '').trim() || `Speaker ${speaker}`;
}
