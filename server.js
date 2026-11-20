import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { uploadFile, submitTranscript, getTranscript } from './lib/assemblyai.js';
import { buildSegments } from './lib/format.js';
import { buildDocx } from './lib/docx.js';
import { prepareMedia } from './lib/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ASSEMBLYAI_API_KEY?.trim();

if (!API_KEY) {
  console.error('\n  Missing ASSEMBLYAI_API_KEY.\n  Copy .env.example to .env and paste your key from https://www.assemblyai.com/app/api-keys\n');
  process.exit(1);
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'transcriber-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTS = new Set([
  '.mp3', '.wav', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.flac',
  '.webm', '.mov', '.mkv', '.wma', '.amr', '.3gp', '.avi',
]);
const MAX_UPLOAD_BYTES = 6 * 1024 ** 3; // 6 GB — enough for a 2-hour HD video
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.has(ext)) return cb(null, true);
    cb(new HttpError(400, `Unsupported file type "${ext || 'unknown'}". Please upload MP3, WAV, M4A, MP4 or another common audio/video format.`));
  },
});

/** @type {Map<string, any>} */
const jobs = new Map();

function parseKeyterms(raw) {
  if (!raw) return [];
  const seen = new Set();
  const terms = [];
  for (const t of String(raw).split(/[\n,;]+/)) {
    const term = t.trim().replace(/\s+/g, ' ');
    if (!term || term.split(' ').length > 6 || term.length > 100) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 200) break;
  }
  return terms;
}

function parseSpeakers(raw) {
  if (!raw || raw === 'auto') return 'auto';
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 'auto';
}

async function removeQuietly(paths) {
  await Promise.all(paths.map((p) => fsp.rm(p, { force: true }).catch(() => {})));
}

async function processJob(job, file, options) {
  const toDelete = [file.path];
  try {
    job.status = 'preparing';
    const media = await prepareMedia(file.path);
    toDelete.push(...media.generated);

    job.status = 'uploading';
    const audioUrl = await uploadFile(API_KEY, media.path);
    await removeQuietly(toDelete); // free disk as soon as the service has the audio

    job.status = 'queued';
    const { transcript, warnings } = await submitTranscript(API_KEY, { audioUrl, ...options });
    job.transcriptId = transcript.id;
    job.warnings.push(...warnings);
    console.log(`[job ${job.id}] submitted transcript ${transcript.id} for "${job.fileName}"`);
  } catch (err) {
    console.error(`[job ${job.id}] failed:`, err);
    job.status = 'error';
    job.error = err.userFacing || err.status ? err.message : 'Something went wrong while preparing your file. Please try again.';
  } finally {
    await removeQuietly(toDelete);
  }
}

async function refreshJob(job) {
  if (!job.transcriptId || job.status === 'completed' || job.status === 'error') return;
  if (job.refreshing) return job.refreshing;
  job.refreshing = (async () => {
    try {
      const t = await getTranscript(API_KEY, job.transcriptId);
      if (t.status === 'completed') {
        job.result = buildSegments(t);
        job.status = 'completed';
        console.log(`[job ${job.id}] completed (${job.result.wordCount} words, model: ${job.result.model ?? 'n/a'})`);
      } else if (t.status === 'error') {
        job.status = 'error';
        job.error = t.error || 'The transcription service could not process this file.';
      } else {
        job.status = t.status; // queued | processing
      }
    } catch (err) {
      // Transient network/API hiccup: keep the current status and try again on the next poll.
      console.warn(`[job ${job.id}] status check failed: ${err.message}`);
    } finally {
      job.refreshing = null;
    }
  })();
  return job.refreshing;
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/transcribe', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'Please choose an audio or video file.');
  const job = {
    id: crypto.randomUUID(),
    fileName: req.file.originalname,
    status: 'preparing',
    error: null,
    warnings: [],
    transcriptId: null,
    result: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  processJob(job, req.file, {
    speakers: parseSpeakers(req.body.speakers),
    keyterms: parseKeyterms(req.body.keyterms),
    verbatim: req.body.verbatim !== 'false',
  });
  res.status(202).json({ jobId: job.id });
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) throw new HttpError(404, 'This transcription was not found. It may have expired or the server was restarted.');
  await refreshJob(job);
  res.json({
    id: job.id,
    fileName: job.fileName,
    status: job.status,
    error: job.error,
    warnings: job.warnings,
    createdAt: job.createdAt,
    result: job.status === 'completed' ? job.result : null,
  });
});

app.post('/api/export/docx', express.json({ limit: '20mb' }), async (req, res) => {
  const { title, subtitle, segments, speakerNames, timestamps } = req.body || {};
  if (!Array.isArray(segments)) throw new HttpError(400, 'No transcript to export.');
  const buffer = await buildDocx({ title, subtitle, segments, speakerNames, timestamps: timestamps !== false });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': 'attachment; filename="transcript.docx"',
  });
  res.send(buffer);
});

app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Unexpected server error.';
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 6 GB).' : message;
  } else if (status >= 500) {
    console.error(err);
    message = 'Unexpected server error.';
  }
  res.status(status).json({ error: message });
});

// Forget old jobs (the transcript itself stays in your AssemblyAI account).
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 60 * 60 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`\n  Transcriber running at http://localhost:${PORT}\n`);
});
// Large uploads can take a long time on slow connections — don't cut them off.
server.requestTimeout = 0;
server.headersTimeout = 120_000;
