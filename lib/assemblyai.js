// Thin client for the AssemblyAI pre-recorded transcription API.
// Docs: https://www.assemblyai.com/docs/api-reference/transcripts/submit
import fs from 'node:fs';
import { Readable } from 'node:stream';

const BASE_URL = (process.env.ASSEMBLYAI_BASE_URL || 'https://api.assemblyai.com').replace(/\/$/, '');

// Most accurate model first; Universal-2 is listed as a fallback.
// Override with SPEECH_MODELS=comma,separated,list in .env if model names change.
const SPEECH_MODELS = (process.env.SPEECH_MODELS || 'assemblyai-stt-3-7,universal-2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

class AssemblyAIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(apiKey, method, path, { body, headers } = {}) {
  const isStream = body && typeof body !== 'string';
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { authorization: apiKey, ...headers },
    body,
    ...(isStream ? { duplex: 'half' } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const msg = data.error || `Transcription service request failed (HTTP ${res.status})`;
    throw new AssemblyAIError(res.status === 401 ? 'Invalid AssemblyAI API key. Check ASSEMBLYAI_API_KEY in .env.' : msg, res.status);
  }
  return data;
}

const UPLOAD_STALL_MS = Number(process.env.UPLOAD_STALL_MS) || 60_000; // no bytes moving for this long = connection is dead
const UPLOAD_RESPONSE_MS = 5 * 60_000; // time allowed for the reply once everything is sent
const UPLOAD_ATTEMPTS = 3;

/**
 * Streams a local file to AssemblyAI's storage and returns a private upload URL.
 * A stalled connection (common on mobile data) is detected and the upload is retried.
 * onProgress(sentBytes, totalBytes) is called as the file goes out.
 */
export async function uploadFile(apiKey, filePath, onProgress = () => {}) {
  const total = fs.statSync(filePath).size;
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadOnce(apiKey, filePath, total, onProgress);
    } catch (err) {
      if (err instanceof AssemblyAIError && err.status && err.status < 500 && err.status !== 429) throw err;
      console.warn(`[assemblyai] upload attempt ${attempt} failed: ${err.message}`);
      if (attempt >= UPLOAD_ATTEMPTS) {
        const e = new AssemblyAIError('Sending the audio to AssemblyAI kept failing. Your internet connection may be slow or unstable. Please check it and try again.');
        e.userFacing = true;
        throw e;
      }
      onProgress(0, total);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

async function uploadOnce(apiKey, filePath, total, onProgress) {
  const controller = new AbortController();
  let sent = 0;
  let lastMove = Date.now();
  let doneSending = false;
  async function* counted() {
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 256 * 1024 })) {
      sent += chunk.length;
      lastMove = Date.now();
      onProgress(sent, total);
      yield chunk;
    }
    doneSending = true;
    lastMove = Date.now();
  }
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastMove;
    if (idle > (doneSending ? UPLOAD_RESPONSE_MS : UPLOAD_STALL_MS)) {
      controller.abort(new Error(doneSending ? 'no reply after upload' : `upload stalled at ${Math.round((sent / total) * 100)}%`));
    }
  }, 5000);
  try {
    const res = await fetch(BASE_URL + '/v2/upload', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/octet-stream', 'content-length': String(total) },
      body: Readable.toWeb(Readable.from(counted())),
      duplex: 'half',
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const msg = data.error || `Upload failed (HTTP ${res.status})`;
      throw new AssemblyAIError(res.status === 401 ? 'Invalid AssemblyAI API key. Check ASSEMBLYAI_API_KEY in .env.' : msg, res.status);
    }
    if (!data.upload_url) throw new AssemblyAIError('Upload succeeded but no upload_url was returned.');
    return data.upload_url;
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

/**
 * Submits a transcription job tuned for accuracy and verbatim output.
 * Returns { transcript, warnings }.
 */
export async function submitTranscript(apiKey, { audioUrl, speakers, keyterms, verbatim }) {
  const params = {
    audio_url: audioUrl,
    speech_models: SPEECH_MODELS,
    language_code: 'en',
    punctuate: true,
    format_text: true,
    // Keep filler words / false starts so the transcript reflects exactly what was said.
    disfluencies: Boolean(verbatim),
  };

  if (speakers === 'auto') {
    params.speaker_labels = true;
  } else if (Number.isInteger(speakers) && speakers >= 2) {
    params.speaker_labels = true;
    params.speakers_expected = speakers;
  } else {
    params.speaker_labels = false;
  }

  if (keyterms.length) params.keyterms_prompt = keyterms;

  const warnings = [];
  // If the API rejects an optional parameter (e.g. a model name was retired), drop it
  // and retry rather than failing the whole job.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const transcript = await request(apiKey, 'POST', '/v2/transcript', {
        body: JSON.stringify(params),
        headers: { 'content-type': 'application/json' },
      });
      return { transcript, warnings };
    } catch (err) {
      if (err.status !== 400) throw err;
      if (/speech_model/i.test(err.message) && params.speech_models) {
        console.warn(`[assemblyai] speech_models rejected (${err.message}); retrying with account default model.`);
        delete params.speech_models;
        continue;
      }
      if (/keyterm/i.test(err.message) && params.keyterms_prompt) {
        console.warn(`[assemblyai] keyterms_prompt rejected (${err.message}); retrying without it.`);
        delete params.keyterms_prompt;
        warnings.push('Your names & terms list could not be applied, so the transcript was made without it.');
        continue;
      }
      throw err;
    }
  }
  throw new AssemblyAIError('Could not submit the transcription job.');
}

export async function getTranscript(apiKey, id) {
  return request(apiKey, 'GET', `/v2/transcript/${encodeURIComponent(id)}`);
}
