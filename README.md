# Transcriber

Upload an audio or video recording (up to 2 hours or more). You get back a word-for-word transcript with punctuation, paragraphs, speaker labels and timestamps. Accuracy on Nigerian English is the main goal.

Transcription is done by **AssemblyAI**, using its most accurate model (`assemblyai-stt-3-7`, with `universal-2` as a fallback).

## Setup

1. Install Node.js 20.12 or newer.
2. Create an AssemblyAI API key at https://www.assemblyai.com/app/api-keys.
3. In this folder:

   ```bash
   npm install
   cp .env.example .env      # then paste your key after ASSEMBLYAI_API_KEY=
   npm start
   ```

4. Open http://localhost:3000.

## How it works

- **Upload.** The browser sends the file to this server. The AssemblyAI key stays on the server and never reaches the browser.
- **Video.** The server pulls out the audio track with ffmpeg (bundled through `ffmpeg-static`). It copies the audio without re-encoding when it can, so quality stays the same. A multi-GB video becomes a much smaller audio upload.
- **Transcription settings, chosen for accuracy:**
  - `language_code: en` with the accent-robust STT-3.7 model.
  - `disfluencies: true` by default. Um, uh and false starts are kept, so speakers' words are not cleaned up. You can switch this off in the UI.
  - `speaker_labels`, with an optional expected number of speakers.
  - **Names & terms** (`keyterms_prompt`). Add Nigerian names, places, organisations and jargon to improve recognition of them.
- **Formatting.** Utterances are grouped into paragraphs at sentence boundaries and natural pauses. Words are never changed or rewritten.
- **Output.** Clickable timestamps jump to that point in the recording (when the file is still loaded in the browser), the current paragraph is highlighted during playback, and speakers can be renamed. Copy, TXT and DOCX exports use the speaker names you set.

## Notes

- Jobs are kept in server memory for 24 hours. If you refresh the page during processing, it picks up where it left off. Restarting the server forgets the jobs, but the transcripts remain in your AssemblyAI dashboard.
- Uploaded files are deleted from this server as soon as they have been sent to AssemblyAI.
- If AssemblyAI renames or retires a model, set `SPEECH_MODELS` in `.env`. If the API rejects the configured models, the app automatically retries with the account's default model.
