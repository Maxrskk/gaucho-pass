// Demo screen: a pre-flight check to run before presenting, and the script of
// exactly what to tap. Ticks are saved on this device.

import { fn, rpc } from './api.js';
import { overview, refresh as refreshAdmin } from './admin.js';
import { signal, soundOn, unlock } from './feedback.js';
import { clockSkewSeconds, noteServerTime } from './totp.js';
import { $, busy, fmtMs, html, store } from './ui.js';

let app = null;

const STEPS = [
  ['Reset and check', 'Admin: tap Reset demo data below, then run the pre-flight check. Have three devices ready: phone A (student), phone B (scanner), and a laptop.'],
  ['Show the ID', 'Phone A: sign in as Jordan. Point out the photo, the Active badge, and the code changing every 30 seconds.'],
  ['Scan it', 'Phone B: sign in as Scanner 1, choose Rec Cen, tap Start camera and scan phone A. Green screen with Jordan\'s photo.'],
  ['Same code, second reader', 'Laptop: sign in as Scanner 2 and scan the same code before it changes (or on phone B tap "Scan it again"). Red: Code already used.'],
  ['Old screenshot', 'Phone A: take a screenshot of the code. Wait until the gold bar has refilled twice (about a minute), open the screenshot and scan it. Red: Code expired. Shortcut: Demo tools, Old screenshot.'],
  ['Forged code', 'Phone B: Demo tools, Forged code. Red: Invalid code, with no name or photo shown.'],
  ['Lost phone', 'Laptop: sign in as Jordan and tap Report my ID lost. Now scan phone A again. Red: Card deactivated. Within about 10 seconds phone A signs itself out.'],
  ['Reactivate', 'Laptop: tap Reactivate my ID. The laptop gets a brand new code, and scanning it is green again. Phone A would have to sign in again.'],
  ['Meal swipes', 'Phone A: sign in as Maya (1 swipe left). Phone B: choose Carrillo and scan. Green, 0 swipes left. Wait for the next code and scan again. Red: No swipes left.'],
  ['Guest pass', 'Phone A: sign in as Jordan, Guest passes, New guest pass for the Rec Cen. Phone B: choose Rec Cen and scan it. Green: Guest of Jordan Reyes. Scan it again. Red: Guest pass already used.'],
  ['Dashboard', 'Laptop: sign in as Admin. Live shows every scan you just made, with the reasons. Stats shows scans per location and the scan speed to compare with a card swipe.'],
  ['Wrap up', 'Admin: Reset demo data, so the next group starts clean.'],
];

const ticks = () => store.getJSON('script-ticks', []);

function renderScript() {
  const done = new Set(ticks());
  $('script').innerHTML = html`${STEPS.map(([title, text], i) => html`<li class="${done.has(i) ? 'done' : ''}">
    <input type="checkbox" id="step-${i}" data-step="${i}" ${done.has(i) ? 'checked' : ''} aria-label="Done: ${title}">
    <label for="step-${i}"><b>${i + 1}. ${title}</b><span>${text}</span></label>
  </li>`)}`;
}

// ---------- Pre-flight ----------

const CHECKS = [
  ['server', 'Server'],
  ['clock', 'Clock'],
  ['verify', 'Scan check'],
  ['camera', 'Camera'],
  ['sound', 'Sound'],
  ['offline', 'Offline ID'],
  ['data', 'Demo data'],
];

function renderChecks(results = {}) {
  const role = app.me()?.role;
  const rows = CHECKS.filter(([key]) => !(key === 'verify' && role === 'student') && !(key === 'data' && role !== 'admin'));
  $('preflight').innerHTML = html`${rows.map(([key, label]) => {
    const r = results[key];
    return html`<li><span class="dot ${r ? r.tone : 'idle'}"></span><span><b>${label}:</b> ${r ? r.text : 'not checked yet'}</span></li>`;
  })}`;
}

async function runChecks() {
  unlock();
  const results = {};
  const set = (key, tone, text) => { results[key] = { tone, text }; renderChecks(results); };
  const role = app.me()?.role;

  // Server reachable, and how fast.
  const sent = Date.now();
  try {
    const boot = await rpc('bootstrap');
    const took = Date.now() - sent;
    noteServerTime(boot.server_now, sent, Date.now());
    set('server', took < 1500 ? 'ok' : 'warn', `answered in ${fmtMs(took)}${took < 1500 ? '' : ' (slow: check the Wi-Fi)'}`);
    const skew = clockSkewSeconds();
    set('clock', skew === 0 ? 'ok' : 'warn', skew === 0 ? 'in sync with the server' : `this device is ${Math.abs(skew)} seconds ${skew > 0 ? 'behind' : 'ahead'} (corrected automatically)`);
  } catch (err) {
    set('server', 'bad', err.code === 'offline' ? "can't reach the server. If the Supabase project is paused, restore it in the dashboard." : 'the server returned an error');
    set('clock', 'warn', 'not checked');
  }

  // Wake the verify function with an empty request. It answers "invalid request" without logging a scan.
  if (role !== 'student') {
    const started = performance.now();
    try {
      await fn('verify-scan', {}, { timeoutMs: 15000 });
      set('verify', 'ok', 'ready');
    } catch (err) {
      const took = Math.round(performance.now() - started);
      if (err.code === 'invalid_request') set('verify', took < 2500 ? 'ok' : 'warn', `ready, answered in ${fmtMs(took)}`);
      else set('verify', 'bad', err.code === 'offline' ? "can't reach the scan function" : `problem: ${err.code}`);
    }
  }

  // Camera permission, where the browser lets us ask.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    set('camera', 'bad', 'not available in this browser. Use Upload screenshot.');
  } else {
    let cam = 'unknown';
    try { cam = (await navigator.permissions.query({ name: 'camera' })).state; } catch { /* Safari and Firefox don't support this query */ }
    if (cam === 'granted') set('camera', 'ok', 'allowed');
    else if (cam === 'denied') set('camera', 'bad', 'blocked. Allow the camera for this site in browser settings.');
    else set('camera', 'warn', 'the browser will ask the first time you tap Start camera');
  }

  // Sound
  if (!soundOn()) set('sound', 'warn', 'muted. Turn on Sound and vibration on the Scan screen.');
  else set('sound', signal('ok') ? 'ok' : 'warn', 'played a test beep. Check the volume and the silent switch.');

  // Offline
  set('offline', navigator.serviceWorker && navigator.serviceWorker.controller ? 'ok' : 'warn',
    navigator.serviceWorker && navigator.serviceWorker.controller ? 'saved on this device, the ID opens without a connection' : 'reload this page once to save it for offline use');

  // Starting state
  if (role === 'admin') {
    await refreshAdmin();
    const d = overview();
    if (!d) set('data', 'warn', 'could not load');
    else {
      const byPerm = Object.fromEntries(d.students.map((s) => [s.perm, s]));
      const fresh = d.totals.granted + d.totals.denied === 0 && byPerm['9900419']?.status === 'lost' &&
        byPerm['9900618']?.swipes_left === 1 && d.students.filter((s) => s.status === 'lost').length === 1;
      set('data', fresh ? 'ok' : 'warn', fresh ? 'at the starting state' : 'changed since the last reset. Tap Reset demo data before you present.');
    }
  }
}

export function show(route) {
  if (route !== 'demo') return;
  renderScript();
  renderChecks();
  $('demo-admin').hidden = app.me()?.role !== 'admin';
}

export function init(appApi) {
  app = appApi;
  $('script').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.step);
    if (!Number.isInteger(i)) return;
    const done = new Set(ticks());
    if (e.target.checked) done.add(i); else done.delete(i);
    store.setJSON('script-ticks', [...done]);
    e.target.closest('li').classList.toggle('done', e.target.checked);
  });
  $('script-clear').addEventListener('click', () => { store.setJSON('script-ticks', []); renderScript(); });
  $('preflight-run').addEventListener('click', (e) => busy(e.currentTarget, runChecks));
}
