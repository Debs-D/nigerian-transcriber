// Prepares a recording for upload to AssemblyAI.
// - Large files are re-encoded to compact speech audio (mono, 16 kHz Opus, 32 kbps).
//   AssemblyAI processes speech at 16 kHz anyway, so accuracy is essentially unchanged,
//   but a 2-hour recording drops from ~100+ MB to ~30 MB, which matters on slow or mobile internet.
// - Video files always have their audio track extracted, so the video itself is never uploaded.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

let ffmpegPath = null;
try {
  ffmpegPath = (await import('ffmpeg-static')).default;
} catch {
  console.warn('[media] ffmpeg-static not available; files will be uploaded as-is.');
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.3gp', '.avi']);
// Files smaller than this are sent as they are (unless they are video).
const COMPRESS_MIN_BYTES = (Number(process.env.COMPRESS_MIN_MB) || 15) * 1024 ** 2;
const COMPRESS = process.env.COMPRESS_AUDIO !== 'false';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`))));
  });
}

function noAudioError(err) {
  if (!/matches no streams|does not contain any stream|Output file .* does not contain/i.test(err.message)) return null;
  const e = new Error('This recording has no audio track, so there is nothing to transcribe.');
  e.userFacing = true;
  return e;
}

/** Returns { path, generated: [paths to delete afterwards] }. */
export async function prepareMedia(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  if (!ffmpegPath) return { path: inputPath, generated: [] };

  const { size } = await fs.stat(inputPath);
  const base = inputPath.slice(0, -ext.length);
  const generated = [];

  // 1) Compact speech audio for large files (and for all video).
  if (COMPRESS && (size >= COMPRESS_MIN_BYTES || isVideo)) {
    const opus = `${base}-speech.ogg`;
    generated.push(opus);
    try {
      const started = Date.now();
      await runFfmpeg(['-i', inputPath, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-compression_level', '2', opus]);
      const out = (await fs.stat(opus)).size;
      console.log(`[media] compressed ${(size / 1024 ** 2).toFixed(1)} MB -> ${(out / 1024 ** 2).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
      if (out < size) return { path: opus, generated };
    } catch (err) {
      const noAudio = noAudioError(err);
      if (noAudio) throw noAudio;
      console.warn(`[media] compression failed, falling back: ${err.message}`);
    }
  }

  if (!isVideo) return { path: inputPath, generated };

  // 2) Video fallback: lossless copy of the audio stream (works for almost all MP4/MOV).
  const copied = `${base}-audio.m4a`;
  generated.push(copied);
  try {
    await runFfmpeg(['-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'copy', copied]);
    return { path: copied, generated };
  } catch (err) {
    const noAudio = noAudioError(err);
    if (noAudio) throw noAudio;
  }

  // 3) Last resort: lossless FLAC (e.g. Opus/Vorbis audio in WebM/MKV).
  const flac = `${base}-audio.flac`;
  generated.push(flac);
  try {
    await runFfmpeg(['-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'flac', flac]);
    return { path: flac, generated };
  } catch (err) {
    console.warn(`[media] audio extraction failed, uploading original file: ${err.message}`);
    return { path: inputPath, generated };
  }
}
