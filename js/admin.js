// Admin dashboard: live scans from every reader, students, stats, and the
// demo controls. Every number comes from one server call, admin_overview(),
// which refuses anyone who is not an admin.

import { fn, rpc } from './api.js';
import { reasonTitle } from './reasons.js';
import { scanRows } from './scanner.js';
import { $, avatarHtml, busy, confirmSheet, fmtMs, html, toast } from './ui.js';

const POLL_MS = 3000;
const ADMIN_VIEWS = ['live', 'people', 'stats', 'demo'];

let app = null;
const state = {
  data: null,
  deniedOnly: false,
  timer: null,
  loading: false,
  lastOk: 0,
  drawn: {}, // last rendered JSON per section, so unchanged sections are left alone
};

export const overview = () => state.data;

export function enter() {
  state.data = null;
  state.drawn = {};
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && ADMIN_VIEWS.includes(app.route())) refresh();
    markFreshness();
  }, POLL_MS);
}

export function leave() {
  clearInterval(state.timer);
  state.data = null;
  state.drawn = {};
  for (const id of ['feed', 'people', 'loc-bars', 'reason-list', 'speed-detail']) $(id).innerHTML = '';
}

export function show(route) {
  if (ADMIN_VIEWS.includes(route)) refresh();
}

export async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    state.data = await rpc('admin_overview', { p_limit: 60 });
    state.lastOk = Date.now();
    render();
  } catch (err) {
    app.fail(err, { quiet: err.code === 'offline' });
  } finally {
    state.loading = false;
    markFreshness();
  }
}

function markFreshness() {
  const dot = $('live-dot');
  const stale = Date.now() - state.lastOk > POLL_MS * 3;
  dot.classList.toggle('stale', stale);
  dot.textContent = stale ? 'Reconnecting…' : 'Live';
}

/** Re-draw a section only when its data changed, so buttons don't flicker under a finger. */
function draw(key, data, paint) {
  const json = JSON.stringify(data);
  if (state.drawn[key] === json) return;
  state.drawn[key] = json;
  paint();
}

function render() {
  const d = state.data;
  if (!d) return;

  // Live
  $('t-granted').textContent = d.totals.granted;
  $('t-denied').textContent = d.totals.denied;
  const rows = state.deniedOnly ? d.feed.filter((x) => x.result === 'denied') : d.feed;
  draw('feed', [rows, state.deniedOnly], () => {
    $('feed').innerHTML = scanRows(rows, { showScanner: true });
    $('feed-empty').hidden = rows.length > 0;
    $('feed-empty').textContent = state.deniedOnly && d.feed.length > 0
      ? 'No denied scans.'
      : 'Scans from every reader show up here as they happen.';
  });

  // Students
  draw('people', d.students, () => {
    $('people').innerHTML = html`${d.students.map((s) => {
      const lost = s.status === 'lost';
      const meal = !s.meal_plan ? 'No meal plan' : s.swipes_per_week === null ? 'Unlimited meals' : `${s.swipes_left} of ${s.swipes_per_week} swipes left`;
      const tag = lost ? html`<span class="tag no">${s.lost_by === 'admin' ? 'Deactivated' : 'Reported lost'}</span>` : html`<span class="tag yes">Active</span>`;
      return html`<li>
        ${avatarHtml(s.avatar, s.name)}
        <div class="who"><b>${s.name}</b><span>Perm ${s.perm} · ${meal}</span><span>${tag}</span></div>
        <button class="btn small ${lost ? '' : 'quiet'}" type="button" data-student="${s.user_id}" data-name="${s.name}" data-to="${lost ? 'active' : 'lost'}">${lost ? 'Reactivate' : 'Deactivate'}</button>
      </li>`;
    })}`;
  });

  // Stats: scans by location
  draw('bars', d.locations, () => {
    const max = Math.max(1, ...d.locations.map((l) => l.granted + l.denied));
    const any = d.locations.some((l) => l.granted + l.denied > 0);
    $('bars-empty').hidden = any;
    $('loc-bars').innerHTML = html`${d.locations.map((l) => {
      const total = l.granted + l.denied;
      const width = (n) => `${((n / max) * 100).toFixed(1)}%`;
      return html`<div class="bar-row">
        <div class="bar-top"><b>${l.name}</b><span>${l.granted} granted · ${l.denied} denied</span></div>
        <div class="bar-track ${total === 0 ? 'empty' : ''}" role="img" aria-label="${l.name}: ${l.granted} granted, ${l.denied} denied">
          ${l.granted > 0 ? html`<div class="bar-seg bar-ok" style="width:${width(l.granted)}" title="${l.name}: ${l.granted} granted"></div>` : ''}
          ${l.denied > 0 ? html`<div class="bar-seg bar-bad" style="width:${width(l.denied)}" title="${l.name}: ${l.denied} denied"></div>` : ''}
        </div>
      </div>`;
    })}`;
  });

  // Stats: why scans were denied
  draw('reasons', d.reasons, () => {
    const list = Object.entries(d.reasons).sort((a, b) => b[1] - a[1]);
    $('reasons-empty').hidden = list.length > 0;
    $('reason-list').innerHTML = html`${list.map(([reason, n]) => html`<dt>${reasonTitle(reason)}</dt><dd>${n}</dd>`)}`;
  });

  // Stats: speed
  draw('speed', d.speed, () => {
    const sp = d.speed;
    $('sp-shown').textContent = sp.shown_n > 0 ? fmtMs(sp.shown_median) : '–';
    $('sp-verify').textContent = sp.verify_n > 0 ? fmtMs(sp.verify_median) : '–';
    $('speed-detail').innerHTML = html`
      <dt>ID opened to answer, slowest 10%</dt><dd>${sp.shown_n > 0 ? fmtMs(sp.shown_p90) : '–'}</dd>
      <dt>QR read to answer, slowest 10%</dt><dd>${sp.verify_n > 0 ? fmtMs(sp.verify_p90) : '–'}</dd>
      <dt>Scans measured</dt><dd>${Math.max(sp.shown_n, sp.verify_n)}</dd>`;
  });

  // Demo controls
  $('demo-tools-on').checked = d.demo_tools === true;
}

// ---------- Actions ----------

async function setCardStatus(button) {
  const { student, name, to } = button.dataset;
  const deactivate = to === 'lost';
  const yes = await confirmSheet(deactivate
    ? { title: `Deactivate ${name}'s ID?`, text: 'Their codes stop working at once and they are signed out on every device. Only an admin can turn the ID back on.', yes: 'Deactivate', danger: true }
    : { title: `Reactivate ${name}'s ID?`, text: 'They get a brand new code the next time they sign in.', yes: 'Reactivate' });
  if (!yes) return;
  try {
    await rpc('admin_set_card_status', { p_student: student, p_status: to });
    toast(deactivate ? `${name}'s ID is deactivated.` : `${name}'s ID is active again.`);
    await refresh();
  } catch (err) {
    app.fail(err);
  }
}

async function resetDemo(button) {
  const yes = await confirmSheet({
    title: 'Reset demo data?',
    text: 'This clears the scan log, guest passes and lockouts, and puts every test student back to the starting state. Sign-ins and passwords stay as they are.',
    yes: 'Reset',
    danger: true,
  });
  if (!yes) return;
  await busy(button, async () => {
    try {
      await fn('demo', { action: 'reset' }, { timeoutMs: 20000 });
      state.drawn = {};
      await refresh();
      toast('Demo data reset. Ready to present.');
      app.refreshMe();
    } catch (err) {
      app.fail(err);
    }
  });
}

async function setDemoTools(input) {
  try {
    await rpc('admin_set_demo_tools', { p_on: input.checked });
    toast(input.checked ? 'Demo tools are on.' : 'Demo tools are off.');
    app.refreshMe();
  } catch (err) {
    input.checked = !input.checked;
    app.fail(err);
  }
}

export function init(appApi) {
  app = appApi;
  const setFilter = (deniedOnly) => {
    state.deniedOnly = deniedOnly;
    $('f-all').setAttribute('aria-pressed', String(!deniedOnly));
    $('f-denied').setAttribute('aria-pressed', String(deniedOnly));
    render();
  };
  $('f-all').addEventListener('click', () => setFilter(false));
  $('f-denied').addEventListener('click', () => setFilter(true));
  $('people').addEventListener('click', (e) => {
    const b = e.target.closest('[data-student]');
    if (b) setCardStatus(b);
  });
  $('demo-reset').addEventListener('click', (e) => resetDemo(e.currentTarget));
  $('demo-tools-on').addEventListener('change', (e) => setDemoTools(e.target));
}
