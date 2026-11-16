// The full-screen green / red / amber scan result.

import { signal } from './feedback.js';
import { describe, systemResult } from './reasons.js';
import { $, fmtMs, fmtTime, setAvatar, store } from './ui.js';

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M12 6v8M12 18h.01"/></svg>',
};

let lastFocus = null;
let autoTimer = null;
let onClose = null;

export const autoNext = () => store.get('auto-next', '0') === '1';
export const setAutoNext = (on) => store.set('auto-next', on ? '1' : '0');
export const resultOpen = () => !$('result').hidden;

function show(view, { person = null, meta = '', closed = null } = {}) {
  const el = $('result');
  el.className = 'result ' + view.tone;
  $('r-icon').innerHTML = ICONS[view.tone];
  $('r-title').textContent = view.title;
  $('r-reason').textContent = view.text;
  $('r-extra').textContent = view.extra ?? '';
  $('r-extra').hidden = !view.extra;

  if (person) {
    $('r-who').hidden = false;
    setAvatar($('r-avatar'), person.avatar, person.name);
    $('r-name').textContent = person.name;
    $('r-perm').textContent = person.kind === 'guest' ? 'Guest pass' : `Perm ${person.perm}`;
    $('r-detail').textContent = person.kind === 'guest' ? `Host: ${person.host_name}` : person.detail ?? '';
  } else {
    $('r-who').hidden = true;
  }
  $('r-meta').textContent = meta;

  onClose = closed;
  if (el.hidden) lastFocus = document.activeElement;
  el.hidden = false;
  $('r-close').focus();
  signal(view.tone);

  clearTimeout(autoTimer);
  if (view.tone === 'ok' && autoNext()) autoTimer = setTimeout(closeResult, 3000);
}

export function closeResult() {
  clearTimeout(autoTimer);
  const el = $('result');
  if (el.hidden) return;
  el.hidden = true;
  if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  const cb = onClose;
  onClose = null;
  if (cb) cb();
}

/** Show the server's answer to a scan. */
export function showScanResult(body, { elapsedMs = null, closed = null } = {}) {
  const view = describe(body);
  const bits = [];
  if (body.location?.name) bits.push(body.location.name);
  bits.push(fmtTime(body.server_time ?? Date.now()));
  if (elapsedMs !== null) bits.push(`checked in ${fmtMs(elapsedMs)}`);
  if (body.is_test) bits.push('demo test');
  let text = view.text;
  if (body.first) {
    const where = body.first.location?.short_name ? ` at ${body.first.location.short_name}` : '';
    text = `First scan${where}: ${body.first.result}. Second scan: ${view.text}`;
  }
  show({ ...view, text }, { person: body.person, meta: bits.join(' · '), closed });
}

/** Show a problem that is not a decision about a code (offline, no QR found, ...). */
export function showSystemResult(code, { err = null, locationName = '', closed = null } = {}) {
  const meta = [locationName, fmtTime(Date.now())].filter(Boolean).join(' · ');
  show(systemResult(code, err), { meta, closed });
}

export function wireResult() {
  $('r-close').addEventListener('click', closeResult);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && resultOpen()) closeResult();
  });
}
