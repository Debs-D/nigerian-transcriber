# Transcriber

Upload an audio or video recording (up to 2 hours or more). You get back a word-for-word transcript with punctuation, paragraphs, speaker labels and timestamps. Accuracy on Nigerian English is the main goal.

Transcription is done by **AssemblyAI**, using its most accurate model (`assemblyai-stt-3-7`, with `universal-2` as a fallback).

## Setup

1. Install Node.js 20.12 or newer.
2. Create an AssemblyAI API key at https://www.assemblyai.com/app/api-keys.
3. In this folder:

   ```bash
   npm install
   cp .env.example .env      # then paste your keys after ASSEMBLYAI_API_KEY= 
   npm start
   ```

4. Open http://localhost:3000.

## How it works

- **Upload.** The browser sends the file to this server. The AssemblyAI key stays on the server and never reaches the browser.
- **Smaller uploads.** Video files, and audio files over 15 MB, are converted with ffmpeg (bundled through `ffmpeg-static`) to compact speech audio: mono, 16 kHz Opus at 32 kbps. AssemblyAI processes speech at 16 kHz anyway, so accuracy is essentially unchanged. A 2-hour recording becomes about 30 MB, which helps a lot on slow or mobile internet. Set `COMPRESS_AUDIO=false` in `.env` to send files unchanged.
- **Unreliable connections.** If the upload to AssemblyAI stops moving for a minute, it is cancelled and retried (up to 3 tries), and the page shows how much has been sent.
- **Transcription settings, chosen for accuracy:**
  - `language_code: en` with the accent-robust STT-3.7 model.
  - `disfluencies: true` by default. Um, uh and false starts are kept, so speakers' words are not cleaned up. You can switch this off in the UI.
  - `speaker_labels`, with an optional expected number of speakers.
  - **Names & terms** (`keyterms_prompt`). Add Nigerian names, places, organisations and jargon to improve recognition of them.
- **Formatting.** Utterances are grouped into paragraphs at sentence boundaries and natural pauses. Words are never changed or rewritten.
- **Output.** Clickable timestamps jump to that point in the recording (when the file is still loaded in the browser), the current paragraph is highlighted during playback, and speakers can be renamed. Copy, TXT and DOCX exports use the speaker names you set.

- **Shorter, clean version.** After a transcript is ready, the "Shorter, clean version" tab sends it through AssemblyAI's LLM Gateway, in parts of about 1,200 words. By default it uses `qwen3.5-4b-32k-fast`, the model AssemblyAI allows on accounts without paid credit. The model removes filler words, false starts, repeated statements and padding, and merges sentences that say the same thing. It keeps every point, explanation, example, illustration and Bible reference, in the speaker's own voice. It is an edit, not a summary. Paragraphs keep their speaker and timestamp, and Copy, TXT and DOCX export whichever version is on screen. It uses the same `ASSEMBLYAI_API_KEY`, and each clean version is charged to your AssemblyAI balance. Once the account has credit, set `CLEAN_MODEL=claude-opus-5-5` in `.env` for higher quality, with larger parts of about 3,000 words. If a part comes back much shorter than expected, it is retried once.

## Notes

- Jobs are kept in server memory for 24 hours. If you refresh the page during processing, it picks up where it left off. Restarting the server forgets the jobs, but the transcripts remain in your AssemblyAI dashboard.
- Uploaded files (and their compressed copies) are deleted from this server as soon as they have been sent to AssemblyAI.
- If AssemblyAI renames or retires a model, set `SPEECH_MODELS` in `.env`. If the API rejects the configured models, the app automatically retries with the account's default model.
