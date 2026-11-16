// App shell: sign-in, roles, and which screen is showing.
//
// The tabs and the route guard here are for convenience only. What a signed-in
// user can actually read or do is enforced on the server (Row Level Security
// and role checks inside every server function).

import * as admin from './admin.js';
import * as api from './api.js';
import { APP_VERSION, TEST_ACCOUNTS } from './config.js';
import * as demo from './demo.js';
import { unlock } from './feedback.js';
import { hideGuest, parseGuestLink, showGuest } from './guest.js';
import { errorText } from './reasons.js';
import { closeResult, wireResult } from './result.js';
import * as scanner from './scanner.js';
import * as student from './student.js';
import { $, closeSheet, html, store, toast, wireSheets } from './ui.js';

const ROUTES = {
  student: ['id', 'guests'],
  scanner: ['scan', 'log', 'demo'],
  admin: ['live', 'people', 'stats', 'scan', 'demo'],
};
const LABELS = { id: 'My ID', guests: 'Guest passes', scan: 'Scan', log: 'Log', live: 'Live', people: 'Students', stats: 'Stats', demo: 'Demo' };
const ALIASES = { student: 'id', scanner: 'scan', admin: 'live', students: 'people', script: 'demo' };
const MODULES = { student: [student], scanner: [scanner, demo], admin: [admin, scanner, demo] };
const ROLE_NAME = { student: 'student', scanner: 'scanner', admin: 'admin' };

const state = { me: null, route: 'loading', leaving: false };

const modules = () => (state.me ? MODULES[state.me.role] ?? [] : []);

// ---------- Screens ----------

function showView(name) {
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
  for (const tab of document.querySelectorAll('#tabs .tab')) tab.setAttribute('aria-selected', String(tab.dataset.route === name));
  state.route = name;
  window.scrollTo(0, 0);
}

function renderTabs() {
  const tabs = $('tabs');
  const routes = state.me ? ROUTES[state.me.role] ?? [] : [];
  tabs.hidden = routes.length === 0;
  tabs.innerHTML = html`${routes.map((r) => html`<button class="tab" role="tab" type="button" data-route="${r}" aria-selected="false">${LABELS[r]}</button>`)}`;
}

function setHash(route) {
  try { history.replaceState(null, '', '#' + route); } catch { /* file:// pages */ }
}

/** Go to a screen, if this account's role includes it. */
function go(requested) {
  if (!state.me) { showLogin(); return; }
  const allowed = ROUTES[state.me.role] ?? [];
  let route = ALIASES[requested] ?? requested;
  if (!allowed.includes(route)) {
    if (route && Object.hasOwn(LABELS, route)) toast(`The ${LABELS[route]} screen isn't available for ${ROLE_NAME[state.me.role]} accounts.`);
    route = allowed[0];
  }
  if (route === state.route) { setHash(route); return; }
  const previous = state.route;
  for (const m of modules()) if (m.hide) m.hide(previous);
  showView(route);
  setHash(route);
  for (const m of modules()) if (m.show) m.show(route);
}

function showLogin(message = '') {
  hideGuest();
  showView('login');
  $('tabs').hidden = true;
  const box = $('login-msg');
  box.textContent = message;
  box.hidden = !message;
  $('login-password').value = '';
  if (location.hash && !parseGuestLink(location.hash)) setHash('login');
}

// ---------- Session ----------

function start(me) {
  state.me = me;
  store.setJSON('me', { user_id: me.user_id, role: me.role, display_name: me.display_name, demo_tools: me.demo_tools, locations: me.locations });
  for (const el of document.querySelectorAll('[data-me]')) el.textContent = me.display_name;
  renderTabs();
  for (const m of modules()) if (m.enter) m.enter(me);
  state.route = 'loading';
  go(location.hash.slice(1) || ROUTES[me.role][0]);
}

/** Forget everything about the signed-in user on this device. */
async function cleanup() {
  const mods = modules();
  closeResult();
  for (const sheet of document.querySelectorAll('.sheet')) closeSheet(sheet.id);
  for (const m of mods) if (m.hide) m.hide(state.route);
  for (const m of mods) if (m.leave) await m.leave();
  state.me = null;
  store.del('me');
  $('tabs').innerHTML = '';
}

async function signOutHere(message = '') {
  if (state.leaving) return;
  state.leaving = true;
  try {
    await cleanup();
    await api.signOut();
    showLogin(message);
  } finally {
    state.leaving = false;
  }
}

/** Ask the server who we are. Catches a role change, a revoked session, and updated settings. */
async function refreshMe() {
  if (!state.me) return;
  try {
    const me = await api.rpc('bootstrap');
    if (!state.me) return;
    if (me.user_id !== state.me.user_id || me.role !== state.me.role) {
      await cleanup();
      start(me);
      return;
    }
    Object.assign(state.me, me);
    store.setJSON('me', { user_id: me.user_id, role: me.role, display_name: me.display_name, demo_tools: me.demo_tools, locations: me.locations });
    for (const m of modules()) if (m.show) m.show(state.route);
  } catch (err) {
    if (err.code === 'not_signed_in') await signOutHere('Your session has expired. Sign in again.');
    else if (err.code === 'no_profile') await signOutHere("This account isn't set up for Gaucho Pass.");
    // offline or a server hiccup: keep going with what is saved on this device
  }
}

/** One place for errors from any screen. */
function fail(err, { quiet = false } = {}) {
  if (err?.code === 'not_signed_in') { signOutHere('Your session has expired. Sign in again.'); return; }
  if (err?.code === 'device_blocked') { signOutHere('This device was signed out because the ID was reported lost or deactivated. Sign in again to use your ID here.'); return; }
  if (!quiet) toast(errorText(err));
}

const app = {
  me: () => state.me,
  route: () => state.route,
  go,
  fail,
  refreshMe,
  forceSignOut: signOutHere,
};

// ---------- Sign-in form ----------

function wireLogin() {
  const pick = $('login-pick');
  const groups = [...new Set(TEST_ACCOUNTS.map((a) => a.group))];
  pick.innerHTML = html`<option value="">Choose a test account…</option>${groups.map((g) => html`<optgroup label="${g}">${
    TEST_ACCOUNTS.filter((a) => a.group === g).map((a) => html`<option value="${a.email}">${a.label}</option>`)}</optgroup>`)}`;
  pick.addEventListener('change', () => {
    if (!pick.value) return;
    $('login-email').value = pick.value;
    $('login-password').focus();
  });
  $('login-email').addEventListener('input', () => { pick.value = ''; });

  $('login-show').addEventListener('click', (e) => {
    const input = $('login-password');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    e.currentTarget.textContent = showing ? 'Show' : 'Hide';
    e.currentTarget.setAttribute('aria-pressed', String(!showing));
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('login-submit');
    if (button.disabled) return;
    const email = $('login-email').value.trim().toLowerCase();
    const password = $('login-password').value;
    const box = $('login-msg');
    const say = (text) => { box.textContent = text; box.hidden = false; };
    box.hidden = true;
    if (!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(email)) { say('Enter the email of a test account.'); return; }
    if (!password) { say('Enter the password.'); return; }
    if (password.length > 200) { say('Wrong email or password.'); return; }

    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      await api.signIn(email, password);
      const me = await api.rpc('bootstrap');
      $('login-password').value = '';
      $('login-password').type = 'password';
      $('login-show').textContent = 'Show';
      start(me);
    } catch (err) {
      if (err.code === 'offline') say("You're offline. You need a connection to sign in.");
      else if (err.code === 'bad_login' || err.code === 'rate_limited') say(err.message);
      else if (err.code === 'no_profile') { await api.signOut(); say("This account isn't set up for Gaucho Pass."); }
      else { await api.signOut(); say('Sign-in failed. Try again in a moment.'); }
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}

// ---------- Start-up ----------

async function resume() {
  const cached = store.getJSON('me', null);
  const signedIn = await api.hasSession();
  if (signedIn && cached && ROUTES[cached.role] && typeof cached.user_id === 'string') {
    start(cached); // instant, and works offline; the server confirms in the background
    refreshMe();
    return;
  }
  if (signedIn) {
    try {
      start(await api.rpc('bootstrap'));
      return;
    } catch (err) {
      if (err.code === 'offline') { showLogin("You're offline. Connect to the internet to sign in."); return; }
      await api.signOut();
    }
  }
  store.del('me');
  showLogin();
}

function openGuestLink(pass) {
  for (const m of modules()) if (m.hide) m.hide(state.route);
  showGuest(pass);
  showView('guest');
  $('tabs').hidden = true;
}

function boot() {
  // Never run inside another site's frame, where taps could be hijacked.
  if (window.top !== window.self) {
    document.body.textContent = 'Gaucho Pass cannot be shown inside another page. Open it directly.';
    return;
  }
  wireSheets();
  wireResult();
  wireLogin();
  for (const m of [student, scanner, admin, demo]) m.init(app);

  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-route]');
    if (tab) go(tab.dataset.route);
  });
  for (const b of document.querySelectorAll('[data-signout]')) b.addEventListener('click', () => signOutHere());
  $('g-signin').addEventListener('click', () => {
    hideGuest();
    setHash('');
    if (state.me) { renderTabs(); state.route = 'guest'; go(ROUTES[state.me.role][0]); } else resume();
  });
  document.addEventListener('pointerdown', unlock, { passive: true });

  window.addEventListener('hashchange', () => {
    const pass = parseGuestLink(location.hash);
    if (pass) { openGuestLink(pass); return; }
    const route = location.hash.slice(1);
    if (route === 'login' || route === '') return;
    if (state.me) go(route);
  });

  api.onSignedOut(() => {
    if (state.me && !state.leaving) signOutHere('You were signed out. Sign in again.');
  });

  const guestPass = parseGuestLink(location.hash);
  if (guestPass) {
    openGuestLink(guestPass);
  } else {
    resume();
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  document.documentElement.dataset.version = APP_VERSION;
}

boot();
