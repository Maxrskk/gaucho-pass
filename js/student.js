// Student screens: the ID card with its rotating code, the lost-phone flow,
// the wallet preview, and guest passes.
//
// The phone holds only this student's own key. It makes codes offline; the
// server decides whether a code is accepted.

import { rpc } from './api.js';
import { clearKeys, loadKey, saveKey } from './keystore.js';
import { PLACE_LABEL, errorText } from './reasons.js';
import { STEP, clockSkewSeconds, codeFor, guestPayload, importSecret, noteServerTime, serverNow, studentPayload, windowAt } from './totp.js';
import { $, busy, closeSheet, confirmSheet, fmtDuration, html, openSheet, qrSvg, safe, setAvatar, store, toast } from './ui.js';

const POLL_MS = 8000;

let app = null;
const state = {
  userId: null,
  pass: null, // last card the server sent (never contains the secret)
  key: null, // non-extractable CryptoKey
  keyVersion: 0,
  online: true,
  lastWin: -1,
  payload: '',
  code: '',
  shownAt: 0,
  rendering: false,
  tickTimer: null,
  pollTimer: null,
};

const student = () => state.pass?.student ?? null;
const visible = () => document.visibilityState === 'visible';
const onStudentView = () => ['id', 'guests'].includes(app.route());

// ---------- Start and stop ----------

export function enter(me) {
  state.userId = me.user_id;
  state.pass = store.getJSON(`pass:${me.user_id}`, null);
  render(); // show the saved card at once; the key and fresh data follow
  clearInterval(state.tickTimer);
  clearInterval(state.pollTimer);
  state.tickTimer = setInterval(tick, 250);
  state.pollTimer = setInterval(() => { if (visible() && onStudentView() && navigator.onLine) sync(); }, POLL_MS);
  restoreKey(me.user_id);
  sync();
}

/** Load the key saved on this device, so codes work before (or without) the network. */
async function restoreKey(userId) {
  const saved = await loadKey(userId);
  if (!saved || state.userId !== userId || state.key) return; // signed out meanwhile, or the server was faster
  state.key = saved.key;
  state.keyVersion = saved.version;
  state.lastWin = -1;
  renderFlags();
  tick();
}

export async function leave({ wipe = true } = {}) {
  clearInterval(state.tickTimer);
  clearInterval(state.pollTimer);
  if (wipe) {
    if (state.userId) {
      store.del(`pass:${state.userId}`);
      store.del(`guest-tokens:${state.userId}`);
    }
    await clearKeys();
  }
  Object.assign(state, { userId: null, pass: null, key: null, keyVersion: 0, lastWin: -1, payload: '', code: '' });
  $('qr').innerHTML = '';
}

export function show(route) {
  if (route === 'id') {
    markShown();
    keepAwake();
  }
  if (route === 'guests') renderGuests();
  if (navigator.onLine) sync();
}

/** "Shown" starts when the student brings the ID up. The reader uses it for speed stats. */
function markShown() {
  state.shownAt = serverNow();
  state.lastWin = -1;
}

// ---------- Talking to the server ----------

/** Refresh from the server. If a refresh is already running, one more runs right after it. */
let syncRunning = null;
let syncQueued = false;
function sync() {
  if (syncRunning) {
    syncQueued = true;
    return syncRunning;
  }
  syncRunning = syncOnce().finally(() => {
    syncRunning = null;
    if (syncQueued) {
      syncQueued = false;
      sync();
    }
  });
  return syncRunning;
}

async function syncOnce() {
  if (!state.userId) return;
  const forUser = state.userId;
  const sent = Date.now();
  try {
    // Tell the server which secret this device already holds, so it is not sent again.
    const out = await rpc('get_my_pass', { p_have_version: state.key ? state.keyVersion : null });
    if (state.userId !== forUser) return;
    noteServerTime(out.server_now, sent, Date.now());
    state.online = true;
    if (out.device_blocked) {
      await app.forceSignOut('This device was signed out because the ID was reported lost or deactivated. Sign in again to use your ID here.');
      return;
    }
    await adopt(out);
  } catch (err) {
    if (err.code === 'offline') {
      state.online = false;
      renderFlags();
    } else {
      app.fail(err, { quiet: err.code !== 'not_signed_in' });
    }
  }
}

/** Take a fresh card from the server: keep the key locked away, cache the rest for offline use. */
async function adopt(out) {
  const { secret, ...rest } = out;
  if (secret) {
    if (!state.key || state.keyVersion !== out.secret_version) {
      state.key = await importSecret(secret);
      state.keyVersion = out.secret_version;
      await saveKey(state.userId, out.secret_version, state.key);
      forgetCode(); // never leave a code from the old key on screen
    }
  } else if (state.key && out.student?.status !== 'active') {
    // The card is not active: this device should hold nothing that can make codes.
    state.key = null;
    state.keyVersion = 0;
    forgetCode();
    await clearKeys();
  }
  state.pass = rest;
  store.setJSON(`pass:${state.userId}`, rest);
  render();
}

/** Wipe the code on screen so the next tick draws a fresh one. */
function forgetCode() {
  state.lastWin = -1;
  state.payload = '';
  state.code = '';
  $('qr').innerHTML = '';
  $('code-peek').textContent = '';
}

// ---------- The card ----------

const mealDetail = (s) => {
  if (!s.meal_plan) return 'No meal plan';
  if (s.swipes_per_week === null) return s.meal_plan;
  return `${s.swipes_left} of ${s.swipes_per_week} swipes left this week`;
};

const TYPES = {
  dining: { label: 'Dining commons', detail: mealDetail },
  rec: { label: 'Recreation Center', detail: () => 'Registered students' },
  bus: { label: 'MTD buses', detail: () => 'Covered by student fees' },
  library: { label: 'Library', detail: () => 'After-hours entry' },
};

function render() {
  const s = student();
  const loading = !s;
  $('id-clock').hidden = true;
  if (loading) {
    $('s-name').textContent = navigator.onLine ? 'Loading your ID…' : 'Offline';
    $('s-sub').textContent = navigator.onLine ? '' : 'Connect to the internet once to load your ID on this device.';
    $('s-perm').textContent = '';
    $('s-avatar').textContent = '';
    $('s-status').textContent = '';
    $('s-status').className = 'status';
    $('qr').hidden = true;
    $('timer').hidden = true;
    $('qr-dead').hidden = true;
    $('s-access').innerHTML = '';
    $('lost-panel').hidden = true;
    return;
  }

  const live = s.status === 'active';
  setAvatar($('s-avatar'), s.avatar, `${s.first_name} ${s.last_name}`);
  $('s-name').textContent = `${s.first_name} ${s.last_name}`;
  $('s-sub').textContent = `${s.year} · ${s.major}`;
  $('s-perm').textContent = s.perm;
  const st = $('s-status');
  st.textContent = live ? 'Active' : s.lost_by === 'admin' ? 'Deactivated' : 'Reported lost';
  st.className = 'status ' + (live ? 'active' : 'lost');

  $('qr').hidden = !live;
  $('timer').hidden = !live;
  $('qr-dead').hidden = live;
  if (!live) {
    forgetCode();
    const byAdmin = s.lost_by === 'admin';
    $('dead-title').textContent = byAdmin ? 'ID deactivated' : 'ID reported lost';
    $('dead-text').textContent = byAdmin
      ? 'The access office deactivated this ID. Ask them to turn it back on.'
      : 'Codes from the lost phone no longer work. Got your phone back, or set up a new one? Reactivate here.';
    $('reactivate').hidden = byAdmin;
  }
  $('lost-panel').hidden = !live;

  $('s-access').innerHTML = html`${Object.keys(TYPES).map((type) => {
    const outOfSwipes = type === 'dining' && s.meal_plan && s.swipes_per_week !== null && s.swipes_left <= 0;
    const ok = live && s.access.includes(type) && !outOfSwipes;
    const why = !live ? 'ID deactivated' : TYPES[type].detail(s);
    const tag = ok ? 'Allowed' : outOfSwipes && live ? 'No swipes' : 'No access';
    return html`<li><div class="where"><b>${TYPES[type].label}</b><span>${why}</span></div><span class="tag ${ok ? 'yes' : 'no'}">${tag}</span></li>`;
  })}`;

  renderFlags();
  if (app.route() === 'guests') renderGuests();
  if (!$('wallet').hidden) renderWallet();
  state.lastWin = -1;
  tick();
}

function renderFlags() {
  const flags = [];
  const s = student();
  if (s && (!state.online || !navigator.onLine)) {
    flags.push(html`<div class="banner info"><b>Offline.</b> ${s.status === 'active' && state.key ? 'Your code still works: the reader checks it with the server.' : 'Details may be out of date.'}</div>`);
  }
  if (s && s.status === 'active' && !state.key && state.online) {
    flags.push(html`<div class="banner warn">Setting up your code on this device…</div>`);
  }
  $('id-flags').innerHTML = html`${flags}`;

  const skew = clockSkewSeconds();
  const clock = $('id-clock');
  clock.hidden = skew === 0;
  if (skew !== 0) {
    clock.textContent = `Your phone's clock is ${fmtDuration(Math.abs(skew))} ${skew > 0 ? 'behind' : 'ahead'}. Gaucho Pass is correcting for it, but set your phone's date and time to automatic.`;
  }
}

async function tick() {
  const s = student();
  if (!s || s.status !== 'active') return;
  const now = serverNow();
  const w = windowAt(now);
  const left = STEP - ((now / 1000) % STEP);
  $('secs').textContent = Math.max(1, Math.ceil(left));
  $('timer-fill').style.transform = `scaleX(${left / STEP})`;
  if (state.rendering || w === state.lastWin || !state.key) return;
  if (app.route() !== 'id' && $('wallet').hidden) return;

  state.rendering = true;
  try {
    if (!(window.crypto && crypto.subtle)) {
      $('qr').innerHTML = '<p class="hint">Codes need a secure (https) page.</p>';
      state.lastWin = w;
      return;
    }
    const key = state.key;
    const code = await codeFor(key, w);
    if (key !== state.key || !student()) return; // signed out or re-keyed while computing
    state.code = code;
    state.payload = studentPayload(s.perm, code, state.shownAt);
    $('qr').innerHTML = qrSvg(state.payload);
    $('code-peek').textContent = code.slice(0, 3) + ' ' + code.slice(3);
    state.lastWin = w;
    if (!$('wallet').hidden) renderWallet();
  } finally {
    state.rendering = false;
  }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or not allowed */ }
}

// ---------- Lost phone ----------

async function reportLost() {
  const yes = await confirmSheet({
    title: 'Report your ID lost?',
    text: 'Every code from your other devices stops working right away, and those devices are signed out. You can reactivate from this device afterwards.',
    yes: 'Report lost',
    danger: true,
  });
  if (!yes) return;
  try {
    await adopt(await rpc('report_lost'));
    toast('ID reported lost. Old codes no longer work.');
  } catch (err) {
    app.fail(err);
  }
}

async function reactivate() {
  try {
    await adopt(await rpc('reactivate_card'));
    markShown();
    window.scrollTo(0, 0); // bring the new code into view
    toast('ID reactivated with a brand new code.');
  } catch (err) {
    app.fail(err);
  }
}

// ---------- Wallet preview ----------

function renderWallet() {
  const s = student();
  if (!s) return;
  const live = s.status === 'active';
  $('w-name').textContent = `${s.first_name} ${s.last_name}`;
  $('w-perm').textContent = s.perm;
  $('w-meal').textContent = s.meal_plan ?? 'None';
  $('w-status').textContent = live ? 'Active' : 'Deactivated';
  $('w-qr').innerHTML = live && state.payload ? qrSvg(state.payload) : '';
  $('w-qr').hidden = !(live && state.payload);
}

// ---------- Guest passes ----------

const tokens = () => store.getJSON(`guest-tokens:${state.userId}`, {});

function rememberToken(id, token) {
  const all = tokens();
  all[id] = token;
  store.setJSON(`guest-tokens:${state.userId}`, all);
}

function pruneTokens(passes) {
  const live = new Set(passes.filter((p) => p.state === 'active').map((p) => p.id));
  const all = tokens();
  let changed = false;
  for (const id of Object.keys(all)) if (!live.has(id)) { delete all[id]; changed = true; }
  if (changed) store.setJSON(`guest-tokens:${state.userId}`, all);
  return all;
}

function shareLink(pass, token) {
  const data = { t: token, n: pass.guest_name, h: student()?.first_name ?? '', w: pass.location_type, e: Math.floor(Date.parse(pass.expires_at) / 1000) };
  const packed = btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#guest=${packed}`;
}

const STATE_TAG = {
  active: ['yes', 'Active'], used: ['muted', 'Used'], expired: ['muted', 'Expired'], revoked: ['muted', 'Cancelled'],
};

function renderGuests() {
  const s = student();
  const passes = state.pass?.guest_passes ?? [];
  const known = state.userId ? pruneTokens(passes) : {};
  const now = serverNow();

  const live = s?.status === 'active';
  $('guest-new').disabled = !live;
  const note = $('guest-note');
  note.hidden = live;
  if (!live) note.textContent = 'Your ID is deactivated, so you can\'t make guest passes right now.';

  $('guest-empty').hidden = passes.length > 0;
  $('guest-list').innerHTML = html`${passes.map((p) => {
    const expiresIn = (Date.parse(p.expires_at) - now) / 1000;
    const st = p.state === 'active' && expiresIn <= 0 ? 'expired' : p.state;
    const [tone, label] = STATE_TAG[st] ?? STATE_TAG.expired;
    const token = known[p.id];
    const sub = st === 'active' ? `${PLACE_LABEL[p.location_type] ?? p.location_type} · expires in ${fmtDuration(expiresIn)}` : PLACE_LABEL[p.location_type] ?? p.location_type;
    return html`<div class="gpass" data-pass="${p.id}">
      <div class="gpass-head"><div><b>${p.guest_name}</b><span>${sub}</span></div><span class="tag ${tone}">${label}</span></div>
      ${st === 'active' && token ? html`<div class="qr" role="img" aria-label="Guest pass QR code">${safe(qrSvg(guestPayload(token)))}</div>
        <div class="btn-row"><button class="btn small" type="button" data-share="${p.id}">Share link</button><button class="btn small" type="button" data-revoke="${p.id}">Cancel pass</button></div>` : ''}
      ${st === 'active' && !token ? html`<p class="hint">Made on another device, so the code can't be shown here.</p>
        <button class="btn small" type="button" data-revoke="${p.id}">Cancel pass</button>` : ''}
    </div>`;
  })}`;
}

function openGuestSheet() {
  const s = student();
  if (!s) return;
  const options = ['dining', 'rec', 'library'].filter((t) => s.access.includes(t) && (t !== 'dining' || s.meal_plan));
  $('guest-where').innerHTML = html`${options.map((t) => html`<option value="${t}">${PLACE_LABEL[t]}${t === 'dining' && s.swipes_per_week !== null ? ' (uses one of your swipes)' : ''}</option>`)}`;
  $('guest-name').value = '';
  $('guest-error').hidden = true;
  openSheet('guest-sheet', 'guest-name');
}

async function createGuest(e) {
  e.preventDefault();
  const name = $('guest-name').value.trim();
  const errorBox = $('guest-error');
  errorBox.hidden = true;
  if (!name) {
    errorBox.textContent = "Enter your guest's name.";
    errorBox.hidden = false;
    return;
  }
  await busy($('guest-create'), async () => {
    try {
      const made = await rpc('create_guest_pass', { p_guest_name: name, p_location_type: $('guest-where').value });
      rememberToken(made.id, made.token);
      closeSheet('guest-sheet');
      await sync();
      renderGuests();
      toast(`Guest pass ready for ${made.guest_name}.`);
    } catch (err) {
      if (err.code === 'not_signed_in') { closeSheet('guest-sheet'); app.fail(err); return; }
      errorBox.textContent = errorText(err);
      errorBox.hidden = false;
    }
  });
}

async function onGuestListClick(e) {
  const share = e.target.closest('[data-share]');
  const revoke = e.target.closest('[data-revoke]');
  if (share) {
    const pass = (state.pass?.guest_passes ?? []).find((p) => p.id === share.dataset.share);
    const token = tokens()[share.dataset.share];
    if (!pass || !token) return;
    const url = shareLink(pass, token);
    try {
      if (navigator.share) await navigator.share({ title: 'Gaucho Pass guest pass', text: `Guest pass for ${pass.guest_name}`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied. Send it to your guest.'); }
    } catch (err) {
      if (err?.name !== 'AbortError') toast("Couldn't share the link. Show your guest the code on this screen instead.");
    }
  }
  if (revoke) {
    const yes = await confirmSheet({ title: 'Cancel this guest pass?', text: 'The code stops working straight away.', yes: 'Cancel pass', danger: true });
    if (!yes) return;
    try {
      await rpc('revoke_guest_pass', { p_id: revoke.dataset.revoke });
      await sync();
      toast('Guest pass cancelled.');
    } catch (err) {
      app.fail(err);
    }
  }
}

// ---------- Wiring ----------

export function init(appApi) {
  app = appApi;
  $('report-lost').addEventListener('click', (e) => busy(e.currentTarget, reportLost));
  $('reactivate').addEventListener('click', (e) => busy(e.currentTarget, reactivate));
  $('wallet-open').addEventListener('click', () => { state.lastWin = -1; renderWallet(); openSheet('wallet', 'wallet-close'); tick(); });
  $('wallet-close').addEventListener('click', () => closeSheet('wallet'));
  $('guest-new').addEventListener('click', openGuestSheet);
  $('guest-cancel').addEventListener('click', () => closeSheet('guest-sheet'));
  $('guest-form').addEventListener('submit', createGuest);
  $('guest-list').addEventListener('click', onGuestListClick);

  document.addEventListener('visibilitychange', () => {
    if (!state.userId || !visible()) return;
    if (app.route() === 'id') { markShown(); keepAwake(); }
    sync();
  });
  window.addEventListener('online', () => { if (state.userId) sync(); });
  window.addEventListener('offline', () => { if (state.userId) { state.online = false; renderFlags(); } });
  setInterval(() => { if (state.userId && app.route() === 'guests' && visible()) renderGuests(); }, 15000);
}
