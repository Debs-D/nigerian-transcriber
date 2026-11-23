(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALLOWED = ['mp3', 'wav', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mov', 'mkv', 'wma', 'amr', '3gp', 'avi'];
  const VIDEO = ['mp4', 'mov', 'mkv', 'webm', '3gp', 'avi'];
  const STORAGE_KEY = 'transcriber.activeJob';

  const state = {
    file: null,
    jobId: null,
    fileName: '',
    result: null,
    speakerNames: {},
    mediaUrl: null,
    media: null,
    pollTimer: null,
    startedAt: 0,
    activeSeg: -1,
    view: 'full', // 'full' | 'clean'
    clean: null, // { status, error, progress, result } from the server
    cleanAvailable: false,
    cleanTimer: null,
  };

  /** Segments of the version currently on screen. */
  function currentSegments() {
    if (state.view === 'clean') return state.clean?.result?.segments || [];
    return state.result?.segments || [];
  }
  function versionSuffix() {
    return state.view === 'clean' ? 'clean transcript' : 'transcript';
  }

  // ---------- helpers ----------
  const ext = (name) => (name.split('.').pop() || '').toLowerCase();
  const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'transcript';

  function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  }
  function formatDuration(sec) {
    if (!Number.isFinite(sec)) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
  }
  function formatBytes(b) {
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }
  function speakerLabel(sp) {
    if (!sp) return '';
    return (state.speakerNames[sp] || '').trim() || `Speaker ${sp}`;
  }
  function store(fn) { try { return fn(); } catch { return null; } }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function show(view) {
    for (const v of ['upload-view', 'progress-view', 'error-view', 'result-view']) $(v).hidden = v !== view;
    window.scrollTo({ top: 0 });
  }

  // ---------- file selection ----------
  const dropzone = $('dropzone');
  const fileInput = $('file-input');

  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) selectFile(fileInput.files[0]); });
  $('file-clear').addEventListener('click', clearFile);

  function selectFile(file) {
    $('upload-error').hidden = true;
    if (!ALLOWED.includes(ext(file.name))) {
      showUploadError(`"${file.name}" isn't a supported audio or video file. Try MP3, WAV, M4A or MP4.`);
      return;
    }
    state.file = file;
    $('file-name').textContent = file.name;
    $('file-details').textContent = formatBytes(file.size);
    $('dropzone').hidden = true;
    $('file-card').hidden = false;
    $('start-btn').disabled = false;

    // Read the duration locally (no upload needed).
    const probe = document.createElement(VIDEO.includes(ext(file.name)) ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const d = probe.duration;
      if (state.file === file && Number.isFinite(d)) {
        let text = `${formatBytes(file.size)} · ${formatDuration(d)}`;
        if (d > 2 * 3600 + 60) text += ' · longer than 2 hours, may take extra time';
        $('file-details').textContent = text;
      }
      URL.revokeObjectURL(url);
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }

  function clearFile() {
    state.file = null;
    fileInput.value = '';
    $('dropzone').hidden = false;
    $('file-card').hidden = true;
    $('start-btn').disabled = true;
  }

  function showUploadError(msg) {
    $('upload-error').textContent = msg;
    $('upload-error').hidden = false;
  }

  // ---------- upload + polling ----------
  $('start-btn').addEventListener('click', startUpload);

  function startUpload() {
    if (!state.file) return;
    const form = new FormData();
    form.append('speakers', $('speakers').value);
    form.append('verbatim', String($('verbatim').checked));
    form.append('keyterms', $('keyterms').value);
    form.append('file', state.file); // file last so text fields are parsed first

    state.fileName = state.file.name;
    state.startedAt = Date.now();
    setProgress('Uploading your file…', '0%', 0);
    show('progress-view');
    startElapsedTimer();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setProgress('Uploading your file…', `${pct}% of ${formatBytes(e.total)}`, pct);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.jobId) {
        state.jobId = data.jobId;
        store(() => localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: data.jobId, fileName: state.fileName, startedAt: state.startedAt })));
        setProgress('Preparing audio…', '', null);
        poll();
      } else {
        fail(data.error || `Upload failed (HTTP ${xhr.status}).`);
      }
    };
    xhr.onerror = () => fail('Upload failed. Check that the server is running and your connection is stable, then try again.');
    xhr.send(form);
  }

  const STAGES = {
    preparing: ['Preparing audio…', 'Making the file smaller so it uploads faster. A long recording can take a minute.'],
    uploading: ['Sending to the transcription service…', 'This depends on your internet speed.'],
    queued: ['Queued…', 'Waiting for a transcription slot.'],
    processing: ['Transcribing…', 'Recognising speech, speakers and timestamps.'],
  };

  async function poll() {
    clearTimeout(state.pollTimer);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(state.jobId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        store(() => localStorage.removeItem(STORAGE_KEY));
        return fail(data.error || 'This transcription could not be found.');
      }
      if (!res.ok) throw new Error(data.error || 'Status check failed');

      if (data.status === 'completed') return renderResult(data);
      if (data.status === 'error') {
        store(() => localStorage.removeItem(STORAGE_KEY));
        return fail(data.error || 'Transcription failed.');
      }
      const [title, detail] = STAGES[data.status] || ['Working…', ''];
      const up = data.uploadProgress;
      if (data.status === 'uploading' && up?.total) {
        const pct = Math.min(100, Math.round((up.sent / up.total) * 100));
        setProgress(title, `${pct}% of ${formatBytes(up.total)} sent. ${detail}`, pct);
      } else {
        setProgress(title, detail, null);
      }
    } catch {
      // network blip — keep polling
    }
    state.pollTimer = setTimeout(poll, 3000);
  }

  function setProgress(title, detail, pct) {
    $('progress-title').textContent = title;
    $('progress-detail').textContent = detail;
    const bar = $('progress-bar');
    if (pct == null) {
      bar.classList.add('indeterminate');
      bar.style.width = '';
    } else {
      bar.classList.remove('indeterminate');
      bar.style.width = pct + '%';
    }
  }

  let elapsedTimer;
  function startElapsedTimer() {
    clearInterval(elapsedTimer);
    const tick = () => { $('progress-elapsed').textContent = `Elapsed: ${formatTimestamp(Date.now() - state.startedAt)}`; };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }

  function fail(msg) {
    clearInterval(elapsedTimer);
    clearTimeout(state.pollTimer);
    $('error-message').textContent = msg;
    show('error-view');
  }

  // ---------- result ----------
  function renderResult(data) {
    clearInterval(elapsedTimer);
    const r = data.result;
    state.result = r;
    state.fileName = data.fileName || state.fileName;
    state.speakerNames = store(() => JSON.parse(localStorage.getItem(`transcriber.names.${data.id}`))) || {};

    state.cleanAvailable = Boolean(data.cleanAvailable);
    state.clean = data.clean || null;
    state.view = 'full';

    $('result-name').textContent = state.fileName;

    const warn = $('result-warning');
    const warnings = [...(data.warnings || [])];
    if (!r.segments.length) warnings.push('No speech was detected in this recording.');
    warn.textContent = warnings.join(' ');
    warn.hidden = !warnings.length;

    renderPlayer();
    renderSpeakerInputs();
    show('result-view');
    setView('full');
    if (state.clean?.status === 'processing') pollClean();
  }

  function renderMeta() {
    const r = state.result;
    const meta = [];
    if (r.durationSec) meta.push(formatDuration(r.durationSec));
    if (state.view === 'clean' && state.clean?.result) {
      const pct = r.wordCount ? Math.round((state.clean.result.wordCount / r.wordCount) * 100) : 0;
      meta.push(`${state.clean.result.wordCount.toLocaleString()} words (${pct}% of the full ${r.wordCount.toLocaleString()})`);
    } else {
      meta.push(`${r.wordCount.toLocaleString()} words`);
    }
    if (r.speakers.length) meta.push(`${r.speakers.length} speaker${r.speakers.length > 1 ? 's' : ''}`);
    $('result-meta').textContent = meta.join(' · ');
  }

  // ---------- full vs clean version ----------
  function setView(view) {
    state.view = view;
    $('tab-full').setAttribute('aria-selected', String(view === 'full'));
    $('tab-clean').setAttribute('aria-selected', String(view === 'clean'));
    const ready = view === 'full' || state.clean?.status === 'completed';
    $('clean-panel').hidden = ready;
    $('transcript').hidden = !ready;
    for (const id of ['copy-btn', 'txt-btn', 'docx-btn']) $(id).disabled = !ready;
    renderMeta();
    if (ready) renderTranscript();
    else renderCleanPanel();
  }

  function renderCleanPanel() {
    const c = state.clean;
    const working = c?.status === 'processing';
    $('clean-intro').hidden = working;
    $('clean-working').hidden = !working;
    const err = !state.cleanAvailable
      ? 'The clean version is not available on this server.'
      : c?.status === 'error' ? c.error : '';
    $('clean-error').textContent = err;
    $('clean-error').hidden = !err;
    $('clean-start').disabled = !state.cleanAvailable;
    $('clean-start').textContent = c?.status === 'error' ? 'Try again' : 'Create clean version';
    if (working) {
      const p = c.progress || {};
      $('clean-progress').textContent = p.total > 1
        ? `Part ${Math.min(p.done + 1, p.total)} of ${p.total} is being cleaned… A long recording can take a few minutes.`
        : 'This usually takes a minute or two.';
    }
  }

  $('tab-full').addEventListener('click', () => setView('full'));
  $('tab-clean').addEventListener('click', () => setView('clean'));

  $('clean-start').addEventListener('click', async () => {
    $('clean-start').disabled = true;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(state.jobId)}/clean`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start the clean version.');
      state.clean = data.clean;
    } catch (e) {
      state.clean = { status: 'error', error: e.message };
    }
    if (state.view === 'clean') setView('clean');
    if (state.clean?.status === 'processing') pollClean();
  });

  async function pollClean() {
    clearTimeout(state.cleanTimer);
    const jobId = state.jobId;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/clean`);
      const data = await res.json().catch(() => ({}));
      if (jobId !== state.jobId) return; // user started over
      if (res.status === 404) {
        state.clean = { status: 'error', error: data.error || 'This transcription has expired.' };
      } else if (res.ok) {
        state.clean = data.clean;
      }
    } catch {
      // network blip — keep polling
    }
    if (state.view === 'clean') setView('clean');
    if (state.clean?.status === 'processing') state.cleanTimer = setTimeout(pollClean, 3000);
    else if (state.clean?.status === 'completed' && state.view !== 'clean') toast('Clean version is ready');
  }

  function renderPlayer() {
    const wrap = $('player-wrap');
    wrap.replaceChildren();
    state.media = null;
    if (!state.file) { wrap.hidden = true; return; }
    if (!state.mediaUrl) state.mediaUrl = URL.createObjectURL(state.file);
    const el = document.createElement(VIDEO.includes(ext(state.file.name)) ? 'video' : 'audio');
    el.controls = true;
    el.preload = 'metadata';
    el.src = state.mediaUrl;
    el.addEventListener('timeupdate', () => highlightAt(el.currentTime * 1000));
    wrap.append(el);
    wrap.hidden = false;
    state.media = el;
  }

  function renderSpeakerInputs() {
    const box = $('speaker-inputs');
    box.replaceChildren();
    const speakers = state.result.speakers;
    $('speaker-names').hidden = speakers.length === 0;
    for (const sp of speakers) {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = `Speaker ${sp}`;
      input.value = state.speakerNames[sp] || '';
      input.setAttribute('aria-label', `Name for Speaker ${sp}`);
      input.addEventListener('input', () => {
        state.speakerNames[sp] = input.value;
        store(() => localStorage.setItem(`transcriber.names.${state.jobId}`, JSON.stringify(state.speakerNames)));
        document.querySelectorAll(`[data-speaker="${sp}"]`).forEach((n) => { n.textContent = speakerLabel(sp); });
      });
      box.append(input);
    }
  }

  function renderTranscript() {
    const root = $('transcript');
    const frag = document.createDocumentFragment();
    let prevSpeaker;
    state.activeSeg = -1;
    currentSegments().forEach((seg, i) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.dataset.index = i;

      const ts = document.createElement('button');
      ts.type = 'button';
      ts.className = 'ts';
      ts.textContent = formatTimestamp(seg.start);
      if (state.media) {
        ts.title = 'Play from here';
        ts.addEventListener('click', () => {
          state.media.currentTime = seg.start / 1000;
          state.media.play().catch(() => {});
        });
      } else {
        ts.disabled = true;
      }
      row.append(ts);

      if (seg.speaker && seg.speaker !== prevSpeaker) {
        row.classList.add('has-speaker');
        const sp = document.createElement('div');
        sp.className = 'speaker';
        sp.dataset.speaker = seg.speaker;
        sp.textContent = speakerLabel(seg.speaker);
        row.append(sp);
      }
      prevSpeaker = seg.speaker;

      const p = document.createElement('p');
      p.className = 'text';
      p.textContent = seg.text;
      row.append(p);
      frag.append(row);
    });
    root.replaceChildren(frag);
  }

  function highlightAt(ms) {
    const segs = currentSegments();
    if (!segs.length || $('transcript').hidden) return;
    // binary search for last segment starting at or before ms
    let lo = 0, hi = segs.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === state.activeSeg) return;
    const root = $('transcript');
    root.querySelector('.seg.active')?.classList.remove('active');
    state.activeSeg = idx;
    if (idx >= 0) {
      const row = root.querySelector(`.seg[data-index="${idx}"]`);
      row?.classList.add('active');
      if (state.media && !state.media.paused) row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ---------- export ----------
  function buildTxt() {
    const lines = [];
    for (const seg of currentSegments()) {
      const label = speakerLabel(seg.speaker);
      lines.push(`[${formatTimestamp(seg.start)}] ${label ? label + ': ' : ''}${seg.text}`);
    }
    return lines.join('\n\n') + '\n';
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('copy-btn').addEventListener('click', async () => {
    const text = buildTxt();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(state.view === 'clean' ? 'Clean version copied' : 'Transcript copied');
  });

  $('txt-btn').addEventListener('click', () => {
    download(new Blob([buildTxt()], { type: 'text/plain;charset=utf-8' }), `${baseName(state.fileName)} - ${versionSuffix()}.txt`);
  });

  $('docx-btn').addEventListener('click', async () => {
    const btn = $('docx-btn');
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const res = await fetch('/api/export/docx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: baseName(state.fileName),
          subtitle: $('result-meta').textContent,
          segments: currentSegments(),
          speakerNames: state.speakerNames,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
      download(await res.blob(), `${baseName(state.fileName)} - ${versionSuffix()}.docx`);
    } catch (e) {
      toast(e.message || 'Could not create the DOCX file');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download DOCX';
    }
  });

  // ---------- reset ----------
  function reset() {
    clearTimeout(state.pollTimer);
    clearTimeout(state.cleanTimer);
    clearInterval(elapsedTimer);
    store(() => localStorage.removeItem(STORAGE_KEY));
    if (state.media) state.media.pause();
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    Object.assign(state, { jobId: null, result: null, mediaUrl: null, media: null, speakerNames: {}, activeSeg: -1, view: 'full', clean: null });
    $('transcript').replaceChildren();
    $('player-wrap').replaceChildren();
    clearFile();
    show('upload-view');
  }
  $('new-btn').addEventListener('click', reset);
  $('retry-btn').addEventListener('click', reset);

  // ---------- resume after refresh ----------
  const saved = store(() => JSON.parse(localStorage.getItem(STORAGE_KEY)));
  if (saved?.jobId) {
    state.jobId = saved.jobId;
    state.fileName = saved.fileName || '';
    state.startedAt = saved.startedAt || Date.now();
    setProgress('Checking your transcription…', '', null);
    show('progress-view');
    startElapsedTimer();
    poll();
  }
})();
