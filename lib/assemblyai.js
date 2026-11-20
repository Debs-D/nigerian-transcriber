// Thin client for the AssemblyAI pre-recorded transcription API.
// Docs: https://www.assemblyai.com/docs/api-reference/transcripts/submit
import fs from 'node:fs';

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

/** Streams a local file to AssemblyAI's storage and returns a private upload URL. */
export async function uploadFile(apiKey, filePath) {
  const data = await request(apiKey, 'POST', '/v2/upload', {
    body: fs.createReadStream(filePath),
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!data.upload_url) throw new AssemblyAIError('Upload succeeded but no upload_url was returned.');
  return data.upload_url;
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
