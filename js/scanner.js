// Scanner screens: pick a location, read QR codes from the live camera (or an
// uploaded screenshot), and ask the server to verify each one.
//
// The scanner never decides anything and never holds a student's secret.

import { fn, rpc } from './api.js';
import { setSoundOn, soundOn, unlock } from './feedback.js';
import { reasonTitle } from './reasons.js';
import { autoNext, resultOpen, setAutoNext, showScanResult, showSystemResult } from './result.js';
import { $, fmtTime, html, store, toast } from './ui.js';

const SCAN_EVERY_MS = 140;
const SAME_PERSON_MS = 60000; // don't re-scan the same ID by accident while it is still held up

let app = null;
const state = {
  locations: [],
  locId: null,
  stream: null,
  detector: null,
  scanning: false,
  resumeOnVisible: false,
  busy: false,
  last: null, // { text, who, at } of the last submitted code
  loopTimer: null,
  canvas: null,
};

const loc = () => state.locations.find((l) => l.id === state.locId) ?? state.locations[0];
const HOLD_TEXT = "Hold the student's QR code inside the frame";
const IDLE_TEXT = "Start the camera, then hold the student's QR code inside the frame";

// ---------- Start and stop ----------

export function enter(me) {
  state.locations = me.locations ?? [];
  const saved = store.get('loc');
  state.locId = state.locations.some((l) => l.id === saved) ? saved : state.locations[0]?.id ?? null;
  state.last = null;
  renderLocs();
  $('demo-tools').hidden = !me.demo_tools;
  $('sound-on').checked = soundOn();
  $('auto-next').checked = autoNext();
}

export function leave() {
  stopCamera();
  state.last = null;
  $('log').innerHTML = '';
}

export function show(route) {
  if (route === 'log') loadLog();
  if (route === 'scan') $('demo-tools').hidden = !app.me()?.demo_tools;
}

export function hide(route) {
  if (route === 'scan') stopCamera();
}

// ---------- Location ----------

function renderLocs() {
  $('loc-chips').innerHTML = html`${state.locations.map((l) =>
    html`<button class="chip" type="button" data-loc="${l.id}" aria-pressed="${l.id === state.locId}">${l.short_name}</button>`)}`;
  $('reader-loc').textContent = loc()?.name ?? '';
}

// ---------- Camera ----------

const CAMERA_PROBLEMS = {
  NotAllowedError: 'Camera permission is blocked. Allow the camera for this site in your browser settings, or use Upload screenshot.',
  SecurityError: 'Camera permission is blocked. Allow the camera for this site in your browser settings, or use Upload screenshot.',
  NotFoundError: 'No camera was found on this device. Use Upload screenshot instead.',
  OverconstrainedError: 'No camera was found on this device. Use Upload screenshot instead.',
  NotReadableError: 'The camera is busy in another app. Close it and try again.',
};

function setFrameText(text) {
  $('frame-text').textContent = text;
}

async function makeDetector() {
  try {
    if ('BarcodeDetector' in window) {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) return new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { /* fall back to jsQR */ }
  return null;
}

async function startCamera() {
  unlock();
  if (state.scanning) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setFrameText("This browser can't open the camera here. Use Upload screenshot instead.");
    return;
  }
  setFrameText('Starting camera…');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    setFrameText(CAMERA_PROBLEMS[err?.name] ?? "Couldn't start the camera. Use Upload screenshot instead.");
    return;
  }
  if (app.route() !== 'scan') { stopCamera(); return; } // left the screen while the permission prompt was open
  const video = $('cam');
  video.srcObject = state.stream;
  video.hidden = false;
  // Not awaited: on some browsers play() only settles once frames arrive, and the
  // frame loop below already waits for the video to have data.
  const playing = video.play();
  if (playing && playing.catch) playing.catch(() => {});
  state.detector = await makeDetector();
  if (!state.stream) return; // stopped while the detector was loading
  state.scanning = true;
  $('frame').classList.add('live');
  $('cam-btn').textContent = 'Stop camera';
  setFrameText(HOLD_TEXT);
  keepAwake();
  scheduleFrame();
}

function stopCamera() {
  state.scanning = false;
  clearTimeout(state.loopTimer);
  if (state.stream) for (const track of state.stream.getTracks()) track.stop();
  state.stream = null;
  const video = $('cam');
  video.srcObject = null;
  video.hidden = true;
  $('frame').classList.remove('live', 'busy');
  $('cam-btn').textContent = 'Start camera';
  $('rescan-row').hidden = true;
  setFrameText(IDLE_TEXT);
}

function scheduleFrame() {
  clearTimeout(state.loopTimer);
  if (state.scanning) state.loopTimer = setTimeout(scanFrame, SCAN_EVERY_MS);
}

function readWithJsQR(video) {
  if (typeof jsQR === 'undefined') return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, 640 / Math.max(vw, vh));
  state.canvas = state.canvas || document.createElement('canvas');
  const canvas = state.canvas;
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hit = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
  return hit && hit.data ? hit.data : null;
}

async function scanFrame() {
  if (!state.scanning) return;
  const video = $('cam');
  try {
    if (!state.busy && !resultOpen() && video.readyState >= 2) {
      let text = null;
      if (state.detector) {
        try {
          const found = await state.detector.detect(video);
          text = found.length > 0 ? found[0].rawValue : null;
        } catch {
          state.detector = null; // this browser's detector failed: use jsQR from now on
        }
      } else {
        text = readWithJsQR(video);
      }
      if (text) onDecoded(text);
    }
  } finally {
    scheduleFrame();
  }
}

/** The perm or guest token inside a code, used only to avoid double-scanning the same person. */
const whoIn = (text) => {
  const parts = String(text).split('|');
  return parts[0] === 'GAUCHOPASS' && parts.length >= 3 ? `${parts[1]}:${parts[2]}` : text;
};

function onDecoded(text) {
  const last = state.last;
  // The exact same code never needs sending twice. After a granted scan, the same
  // person's next code is also held back, so an ID left in front of the camera
  // isn't let in (and charged a meal swipe) again every 30 seconds.
  if (last && Date.now() - last.at < SAME_PERSON_MS && (last.text === text || (last.granted && last.who === whoIn(text)))) {
    $('rescan-row').hidden = false;
    $('rescan-row').firstChild.textContent = last.text === text ? 'Same code as the last scan. ' : 'This ID was just scanned. ';
    return;
  }
  submit(text);
}

// ---------- Verifying ----------

async function submit(text) {
  if (state.busy) return;
  const here = loc();
  if (!here) { toast('Choose a reader location first.'); return; }
  state.busy = true;
  $('frame').classList.add('busy');
  $('rescan-row').hidden = true;
  if (state.scanning) setFrameText('Checking…');
  const started = performance.now();
  try {
    const body = await fn('verify-scan', { payload: text, location_id: here.id });
    const elapsed = Math.round(performance.now() - started);
    state.last = { text, who: whoIn(text), at: Date.now(), granted: body.result === 'granted' };
    showScanResult(body, { elapsedMs: elapsed });
    if (body.scan_id) rpc('log_scan_timing', { p_scan_id: body.scan_id, p_verify_ms: elapsed }).catch(() => {});
  } catch (err) {
    handleScanError(err, here);
  } finally {
    state.busy = false;
    $('frame').classList.remove('busy');
    if (state.scanning) setFrameText(HOLD_TEXT);
  }
}

function handleScanError(err, here) {
  if (err.code === 'not_signed_in') { app.fail(err); return; }
  showSystemResult(err.code, { err, locationName: here?.name ?? '' });
}

// ---------- Upload a screenshot (backup when there is no camera) ----------

async function decodeImage(file) {
  if (typeof jsQR === 'undefined') throw new Error('lib');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const max of [1400, 900, 600]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (hit && hit.data) return hit.data;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    showSystemResult('bad_image', { locationName: loc()?.name ?? '' });
    return;
  }
  setFrameText('Reading code…');
  let text = null;
  try {
    text = await decodeImage(file);
  } catch {
    showSystemResult('bad_image', { locationName: loc()?.name ?? '' });
    return;
  } finally {
    setFrameText(state.scanning ? HOLD_TEXT : IDLE_TEXT);
  }
  if (!text) showSystemResult('no_qr', { locationName: loc()?.name ?? '' });
  else await submit(text);
}

// ---------- Demo tools (server-run test scenarios) ----------

async function runTest(scenario, button) {
  if (state.busy || button.disabled) return;
  unlock();
  const here = loc();
  state.busy = true;
  button.disabled = true;
  const started = performance.now();
  try {
    const body = await fn('demo', { action: 'run_test', scenario, location_id: here.id }, { timeoutMs: 15000 });
    showScanResult(body, { elapsedMs: Math.round(performance.now() - started) });
  } catch (err) {
    if (err.code === 'demo_off') $('demo-tools').hidden = true;
    handleScanError(err, here);
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

// ---------- Log ----------

async function loadLog() {
  try {
    const rows = await rpc('my_recent_scans', { p_limit: 30 });
    $('log-empty').hidden = rows.length > 0;
    $('log').innerHTML = scanRows(rows);
  } catch (err) {
    app.fail(err, { quiet: err.code === 'offline' });
    if (err.code === 'offline') $('log-empty').textContent = "You're offline. The log will load when you reconnect.";
  }
}

/** Shared with the admin dashboard. */
export function scanRows(rows, { showScanner = false } = {}) {
  return html`${rows.map((x) => {
    const person = x.kind === 'guest'
      ? `${x.name ?? 'Guest'}${x.host ? ` (guest of ${x.host})` : ''}`
      : x.name ?? (x.claimed_perm ? `Perm ${x.claimed_perm} (not verified)` : null);
    const bits = [person, x.location, showScanner ? x.scanner : null, x.is_test ? 'demo test' : null].filter(Boolean);
    return html`<li>
      <span class="dot ${x.result === 'granted' ? 'ok' : 'bad'}"></span>
      <div class="what"><b>${reasonTitle(x.reason)}</b><span>${bits.join(' · ')}</span></div>
      <time class="mono">${fmtTime(x.at)}</time>
    </li>`;
  })}`;
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported */ }
}

// ---------- Wiring ----------

export function init(appApi) {
  app = appApi;
  $('loc-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-loc]');
    if (!b) return;
    state.locId = b.dataset.loc;
    store.set('loc', state.locId);
    state.last = null;
    renderLocs();
  });
  $('cam-btn').addEventListener('click', () => (state.scanning ? stopCamera() : startCamera()));
  $('file-btn').addEventListener('click', () => { unlock(); $('file-input').click(); });
  $('file-input').addEventListener('change', (e) => handleFile(e.target));
  $('rescan').addEventListener('click', () => { state.last = null; $('rescan-row').hidden = true; });
  $('sound-on').addEventListener('change', (e) => { setSoundOn(e.target.checked); if (e.target.checked) unlock(); });
  $('auto-next').addEventListener('change', (e) => setAutoNext(e.target.checked));
  $('log-refresh').addEventListener('click', loadLog);
  for (const b of document.querySelectorAll('[data-test]')) b.addEventListener('click', () => runTest(b.dataset.test, b));

  // Release the camera when the page is hidden, and bring it back afterwards.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.scanning) {
      state.resumeOnVisible = true;
      stopCamera();
    } else if (document.visibilityState === 'visible' && state.resumeOnVisible) {
      state.resumeOnVisible = false;
      if (app.route() === 'scan') startCamera();
    }
  });
}
