// For video files, extract just the audio track before uploading.
// A 2-hour video can be several GB; its audio track is a small fraction of that.
// The audio is copied without re-encoding when possible, so quality is untouched.
import { spawn } from 'node:child_process';
import path from 'node:path';

let ffmpegPath = null;
try {
  ffmpegPath = (await import('ffmpeg-static')).default;
} catch {
  console.warn('[media] ffmpeg-static not available; video files will be uploaded as-is.');
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.3gp', '.avi']);

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`))));
  });
}

/** Returns { path, generated: [paths to delete afterwards] }. */
export async function prepareMedia(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (!ffmpegPath || !VIDEO_EXTS.has(ext)) return { path: inputPath, generated: [] };

  const base = inputPath.slice(0, -ext.length);

  // 1) Lossless copy of the audio stream (works for AAC/MP3/ALAC — i.e. almost all MP4/MOV).
  const copied = `${base}-audio.m4a`;
  try {
    await runFfmpeg(['-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'copy', copied]);
    return { path: copied, generated: [copied] };
  } catch (err) {
    if (/matches no streams|does not contain any stream/i.test(err.message)) {
      const e = new Error('This video has no audio track, so there is nothing to transcribe.');
      e.userFacing = true;
      throw e;
    }
  }

  // 2) Fall back to lossless FLAC (e.g. Opus/Vorbis audio in WebM/MKV).
  const flac = `${base}-audio.flac`;
  try {
    await runFfmpeg(['-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'flac', flac]);
    return { path: flac, generated: [copied, flac] };
  } catch (err) {
    console.warn(`[media] audio extraction failed, uploading original file: ${err.message}`);
    return { path: inputPath, generated: [copied, flac] };
  }
}
