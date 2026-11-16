// Rotating codes on the student's phone (TOTP, RFC 6238, HMAC-SHA1, 6 digits).
// The server makes the same calculation with the same secret; see
// supabase/functions/_shared/core.ts. A unit test checks the two always agree.

import { store } from './ui.js';

export const STEP = 30; // seconds each code lives

export const windowAt = (ms) => Math.floor(ms / 1000 / STEP);

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Secret is not valid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Turn the secret into a key the browser can use but not read back.
 * "extractable: false" means even this app's own code cannot export it again.
 */
export function importSecret(hex) {
  return crypto.subtle.importKey('raw', hexToBytes(hex), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
}

export async function codeFor(key, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[sig.length - 1] & 15;
  const bin = ((sig[o] & 127) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3];
  return String(bin % 1e6).padStart(6, '0');
}

/** The text inside a student's QR code. The last field is when the ID was opened (for speed stats). */
export function studentPayload(perm, code, shownAtMs) {
  const base = `GAUCHOPASS|v2|${perm}|${code}`;
  return shownAtMs > 0 ? `${base}|${Math.floor(shownAtMs).toString(36)}` : base;
}

export const guestPayload = (token) => `GAUCHOPASS|g1|${token}`;

// ---------- Clock check ----------
// Codes depend on the time. Whenever the phone hears from the server it compares
// clocks. If the phone is more than 5 seconds off, the app corrects for it and
// shows a warning.

const TOLERANCE_MS = 5000;
let measuredMs = Number(store.get('clock-skew', '0')) || 0; // server time minus phone time

export function noteServerTime(serverNowMs, sentAt, receivedAt) {
  if (!Number.isFinite(serverNowMs) || receivedAt - sentAt > 4000) return; // too slow a reply to trust
  measuredMs = Math.round(serverNowMs - (sentAt + receivedAt) / 2);
  store.set('clock-skew', measuredMs);
}

const correction = () => (Math.abs(measuredMs) > TOLERANCE_MS ? measuredMs : 0);

/** The current time, corrected if this phone's clock is known to be wrong. */
export const serverNow = () => Date.now() + correction();

/** How many seconds this phone's clock is off, or 0 if it is close enough. */
export const clockSkewSeconds = () => Math.round(correction() / 1000);
