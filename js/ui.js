// Small DOM helpers shared by every screen.

export const $ = (id) => document.getElementById(id);

// ---------- Safe HTML ----------
// html`...` escapes every value it is given, so text from the server can never
// become markup. Use safe() only for strings this app built itself.

class Safe {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render(value) {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

export function html(strings, ...values) {
  return new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
}

export const safe = (value) => new Safe(String(value));

// ---------- Storage (per-device convenience only, never the source of truth) ----------

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('gp:' + key); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('gp:' + key, String(value)); } catch { /* storage full or blocked */ } },
  del(key) { try { localStorage.removeItem('gp:' + key); } catch { /* ignore */ } },
  getJSON(key, fallback = null) {
    try { const v = localStorage.getItem('gp:' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  setJSON(key, value) { this.set(key, JSON.stringify(value)); },
  /** Remove every key that starts with the prefix. */
  clear(prefix) {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('gp:' + prefix)) localStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

// ---------- Formatting ----------

export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '–';
  const n = Number(ms);
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
}

export const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// ---------- Avatars ----------
// Avatar keys come from the server, so they are checked before being used in a URL.

const AVATAR_RE = /^[a-z0-9-]{1,32}$/;

export function setAvatar(el, avatar, name) {
  el.textContent = '';
  el.classList.remove('fallback');
  const fallback = () => { el.textContent = initials(name); el.classList.add('fallback'); };
  if (typeof avatar === 'string' && AVATAR_RE.test(avatar)) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', fallback, { once: true });
    img.src = `avatars/${avatar}.svg`;
    el.appendChild(img);
  } else {
    fallback();
  }
}

export function avatarHtml(avatar, name, extraClass = '') {
  const ok = typeof avatar === 'string' && AVATAR_RE.test(avatar);
  return ok
    ? html`<div class="avatar photo ${extraClass}"><img alt="" src="avatars/${avatar}.svg"></div>`
    : html`<div class="avatar photo fallback ${extraClass}">${initials(name)}</div>`;
}

// ---------- QR ----------

export function qrSvg(text) {
  if (typeof qrcode === 'undefined') return '<p class="hint">The QR library didn\'t load. Check your connection and reload.</p>';
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}

// ---------- Toast ----------

let toastTimer = null;
export function toast(message, ms = 3800) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Sheets (bottom dialogs) ----------

const sheetFocus = new Map();

export function openSheet(id, focusId) {
  const el = $(id);
  sheetFocus.set(id, document.activeElement);
  el.hidden = false;
  const target = focusId ? $(focusId) : el.querySelector('button, input, select');
  if (target) target.focus();
}

export function closeSheet(id) {
  const el = $(id);
  if (el.hidden) return;
  el.hidden = true;
  const back = sheetFocus.get(id);
  if (back && back.focus && document.contains(back)) back.focus();
  el.dispatchEvent(new CustomEvent('sheet-close'));
}

export function wireSheets() {
  for (const sheet of document.querySelectorAll('.sheet')) {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(sheet.id); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.hidden).pop();
    if (open) closeSheet(open.id);
  });
}

/** Ask "are you sure?". Resolves true only if the person taps the confirm button. */
export function confirmSheet({ title, text, yes = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const yesBtn = $('confirm-yes');
    yesBtn.textContent = yes;
    yesBtn.className = danger ? 'btn danger' : 'btn primary';
    let answer = false;
    const onYes = () => { answer = true; closeSheet('confirm'); };
    const onNo = () => closeSheet('confirm');
    const done = () => {
      yesBtn.removeEventListener('click', onYes);
      $('confirm-no').removeEventListener('click', onNo);
      $('confirm').removeEventListener('sheet-close', done);
      resolve(answer);
    };
    yesBtn.addEventListener('click', onYes);
    $('confirm-no').addEventListener('click', onNo);
    $('confirm').addEventListener('sheet-close', done);
    openSheet('confirm', 'confirm-no');
  });
}

/** Disable a button while an async action runs, so a double tap can't send it twice. */
export async function busy(button, work) {
  if (button.disabled) return undefined;
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.disabled = false;
  }
}
