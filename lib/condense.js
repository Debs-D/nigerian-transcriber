// Produces a "clean" version of a transcript: same full message, minus fillers,
// repetition and padding. It is an edit, not a summary.
// Runs through AssemblyAI's LLM Gateway, so it uses the same AssemblyAI key and
// account as transcription. Docs: https://www.assemblyai.com/docs/llm-gateway/overview
// The default model is the one AssemblyAI allows on accounts without paid credit.
// Once the account has credit, set CLEAN_MODEL=claude-opus-5-5 in .env for higher quality.
const GATEWAY_URL = (process.env.LLM_GATEWAY_URL || 'https://llm-gateway.assemblyai.com/v1').replace(/\/$/, '');
const MODEL = process.env.CLEAN_MODEL || 'qwen3.5-4b-32k-fast';
// Smaller pieces keep a small model from skipping content. Bigger models handle more.
const CHUNK_WORDS = Number(process.env.CLEAN_CHUNK_WORDS) || (MODEL.startsWith('qwen') ? 1200 : 3000);
const MAX_OUTPUT_TOKENS = 8000; // well above what one piece needs; the small model's limit is 8192
// If a cleaned piece is shorter than this share of the original, content was probably dropped: retry.
const MIN_KEPT_RATIO = 0.15;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

const SYSTEM_PROMPT = `You are an expert transcript editor. You turn a word-for-word transcript of a spoken message (often a sermon, talk or teaching, frequently by a Nigerian speaker) into a shorter, cleaner, easy-to-read version that still carries the complete message.

This is an edit, not a summary. A reader of your version must receive everything the speaker taught: every point, explanation, illustration, story, example, Bible reference and quotation, application and call to action, in the speaker's order and in the speaker's voice (keep first person, keep how they address the audience).

Remove:
- Filler words and verbal tics that add no meaning: "um", "uh", "eh", "you know", "actually", "I mean", "you see", "like", "basically", "so so", and similar.
- False starts, self-corrections, stammered or abandoned phrases.
- Statements repeated without adding anything new, and redundant phrasings of the same idea. Merge sentences that say the same thing into one clear sentence that keeps every distinct detail.
- Padding that carries no content (e.g. "let me tell you something", "are you following me?", "can somebody say amen?") unless it is part of the message's meaning.

Keep:
- Every distinct idea, even small ones. If a repetition adds a new detail, nuance or example, keep that detail.
- Repetition the speaker uses deliberately for emphasis or rhetorical effect (e.g. a key phrase stated three times as a refrain, a declaration the congregation is asked to repeat). Keep it, but you may trim it slightly.
- Bible references, verses read aloud (keep the wording of verses as read), names, numbers, dates, places.
- Nigerian English expressions, Pidgin, Yoruba, Igbo, Hausa or other words and phrases when they carry meaning or flavour. Do not translate or "correct" them away.
- Questions to the audience when they make a point.

Do not:
- Add ideas, explanations, headings, commentary, or anything the speaker did not say.
- Change the speaker's meaning, tone, emphasis or conclusions.
- Turn it into bullet points, an outline or a summary. Write flowing prose paragraphs.

Make sentences clear, grammatical and smooth, while staying close to the speaker's own wording.

How long the result is depends on how repetitive the speaker is: many spoken transcripts shrink to a quarter or a third of their length, others less. Length is an outcome, not a target. Never drop content to make it shorter.

Input format: numbered paragraphs, each like "[P12] (Speaker A) text". The speaker tag is absent when speakers were not detected.

Output format: only the cleaned paragraphs, separated by blank lines. Start each output paragraph with the [P#] tag of the first input paragraph it draws from, e.g. "[P12] text". One output paragraph may cover several input paragraphs; never merge paragraphs from different speakers. Do not add speaker tags, headings or any other text.`;

function apiKey() {
  return process.env.ASSEMBLYAI_API_KEY?.trim() || '';
}
export function cleanVersionAvailable() {
  return Boolean(apiKey());
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/** Splits segments into chunks of roughly CHUNK_WORDS, at paragraph boundaries. */
export function chunkSegments(segments) {
  const chunks = [];
  let current = [];
  let words = 0;
  segments.forEach((seg, index) => {
    const w = wordCount(seg.text);
    if (current.length && words + w > CHUNK_WORDS) {
      chunks.push(current);
      current = [];
      words = 0;
    }
    current.push({ index, seg });
    words += w;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

function renderChunk(chunk) {
  return chunk
    .map(({ index, seg }) => `[P${index}]${seg.speaker ? ` (Speaker ${seg.speaker})` : ''} ${seg.text}`)
    .join('\n\n');
}

class CleanError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One chat-completions call, retrying on rate limits and temporary server errors. */
async function callGateway(userContent) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${GATEWAY_URL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: apiKey(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
        }),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(2000 * attempt);
      continue;
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (res.ok) return data;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt);
      continue;
    }
    const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message || '';
    console.error(`[clean] LLM Gateway HTTP ${res.status}: ${detail || text.slice(0, 300)}`);
    if (res.status === 401) throw new CleanError('AssemblyAI rejected the API key. Check ASSEMBLYAI_API_KEY in .env.');
    if (res.status === 429) throw new CleanError('AssemblyAI is limiting requests right now. Please wait a minute and try again.');
    if (res.status === 402 || /credit|balance|billing|payment|insufficient/i.test(detail)) {
      throw new CleanError('Your AssemblyAI account has no credit left for this. Check your balance at assemblyai.com/app.');
    }
    throw new CleanError(detail ? `AssemblyAI could not make the clean version: ${detail}` : `AssemblyAI could not make the clean version (HTTP ${res.status}).`);
  }
}

async function cleanChunk(chunk, segments) {
  const inputWords = chunk.reduce((n, c) => n + wordCount(c.seg.text), 0);
  let best = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await cleanChunkOnce(chunk, segments);
    const kept = out.reduce((n, s) => n + wordCount(s.text), 0);
    if (!best || kept > best.kept) best = { out, kept };
    if (inputWords < 80 || kept / inputWords >= MIN_KEPT_RATIO) break;
    console.warn(`[clean] piece came back very short (${kept} of ${inputWords} words); retrying`);
  }
  return best.out;
}

async function cleanChunkOnce(chunk, segments) {
  const data = await callGateway(`Clean this part of the transcript:\n\n${renderChunk(chunk)}`);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new CleanError('Part of the clean version came back incomplete. Please try again.');
  }
  const content = choice?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((c) => c?.text || '').join('') : '';
  if (!text.trim()) {
    throw new CleanError('The AI returned an empty result for part of the transcript. Please try again.');
  }
  return parseOutput(text, chunk, segments);
}

/** Turns "[P12] text" paragraphs back into segments with speaker + timestamp. */
export function parseOutput(text, chunk, segments) {
  const allowed = new Set(chunk.map((c) => c.index));
  const out = [];
  let fallbackIndex = chunk[0].index;
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    const m = para.match(/^\[P(\d+)\]\s*/);
    let index = fallbackIndex;
    let body = para;
    if (m) {
      body = para.slice(m[0].length).trim();
      const n = Number(m[1]);
      if (allowed.has(n)) index = n;
    }
    // Strip any speaker tag the model may have echoed.
    body = body.replace(/^\(Speaker [^)]+\)\s*/, '').trim();
    if (!body) continue;
    const src = segments[index];
    if (!m && out.length && out[out.length - 1].speaker === src.speaker) {
      out[out.length - 1].text += `\n\n${body}`; // untagged continuation
      continue;
    }
    out.push({ speaker: src.speaker, start: src.start, end: src.end, text: body });
    fallbackIndex = index;
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Returns { segments, wordCount } for the clean version.
 * onProgress(done, total) is called as chunks finish.
 */
export async function buildCleanVersion(segments, onProgress = () => {}) {
  if (!segments?.length) return { segments: [], wordCount: 0 };
  const chunks = chunkSegments(segments);
  let done = 0;
  onProgress(0, chunks.length);
  const parts = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
    const result = await cleanChunk(chunk, segments);
    onProgress(++done, chunks.length);
    return result;
  });
  const cleaned = parts.flat();
  return { segments: cleaned, wordCount: cleaned.reduce((n, s) => n + wordCount(s.text), 0) };
}
