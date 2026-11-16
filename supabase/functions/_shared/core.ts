// Gaucho Pass verification rules.
//
// Pure logic only: no database, no network, no Deno APIs. The Edge Function
// imports this file, and so do the Node unit tests, so what is tested is
// exactly what runs on the server.

export const STEP_SECONDS = 30; // each code lives for one 30-second window
export const DIGITS = 6;
export const DRIFT_WINDOWS = 1; // accept the previous, current and next window
export const LOOK_BACK_WINDOWS = 20; // 10 minutes: tells "expired" from "forged"
export const LOOK_AHEAD_WINDOWS = 20; // 10 minutes: tells "clock ahead" from "forged"
export const MAX_PAYLOAD_LENGTH = 200;
export const BAD_ATTEMPT_LIMIT = 10; // wrong codes per student per 5 minutes

export type Reason =
  | 'ok'
  | 'bad_format'
  | 'unknown_id'
  | 'invalid_code'
  | 'expired'
  | 'clock_ahead'
  | 'already_used'
  | 'card_lost'
  | 'revoked_device'
  | 'no_access'
  | 'no_meal_plan'
  | 'no_swipes'
  | 'too_many_attempts'
  | 'guest_used'
  | 'guest_expired'
  | 'guest_revoked'
  | 'guest_wrong_place';

export type Parsed =
  | { kind: 'student'; perm: string; code: string; shownAt: number | null }
  | { kind: 'guest'; token: string }
  | { kind: 'bad'; why: string };

export type LocationCtx = { id: string; name: string; short_name: string; type: string };

export type StudentCtx = {
  user_id: string;
  perm: string;
  first_name: string;
  last_name: string;
  year: string;
  major: string;
  avatar: string;
  status: string;
  access: string[];
  meal_plan: string | null;
  swipes_per_week: number | null;
  swipes_left: number | null;
  secret: string; // hex
  previous_secret: string | null; // hex, the secret a deactivated phone still holds
  bad_attempts: number;
};

export type GuestCtx = {
  id: string;
  guest_name: string;
  location_type: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  host: {
    user_id: string;
    first_name: string;
    last_name: string;
    status: string;
    access: string[];
    meal_plan: string | null;
    swipes_per_week: number | null;
    swipes_left: number | null;
  };
};

export type Decision = {
  decision: 'grant' | 'deny';
  reason: Reason;
  identity: boolean; // may the scanner be told who this is?
  timeWindow: number | null; // the 30-second window the code belongs to
  useSwipe: boolean; // take one meal swipe if the scan is granted
  countBad: boolean; // count this as a wrong-code attempt against the student
  detail: Record<string, unknown>;
};

export type Match = { secret: 'current' | 'previous'; offset: number } | null;

// ---------- QR payload ----------

const PERM_RE = /^[0-9]{7}$/;
const CODE_RE = /^[0-9]{6}$/;
const SHOWN_RE = /^[0-9a-z]{1,10}$/;
const GUEST_TOKEN_RE = /^[0-9a-f]{32}$/;

/** Turn the text inside a QR code into a typed value. Never throws. */
export function parsePayload(raw: unknown): Parsed {
  if (typeof raw !== 'string') return { kind: 'bad', why: 'not_text' };
  const text = raw.trim();
  if (text.length === 0) return { kind: 'bad', why: 'empty' };
  if (text.length > MAX_PAYLOAD_LENGTH) return { kind: 'bad', why: 'too_long' };
  const parts = text.split('|');
  if (parts[0] !== 'GAUCHOPASS') return { kind: 'bad', why: 'not_gaucho_pass' };

  if (parts[1] === 'v2') {
    if (parts.length !== 4 && parts.length !== 5) return { kind: 'bad', why: 'wrong_shape' };
    const perm = parts[2];
    const code = parts[3];
    if (!PERM_RE.test(perm) || !CODE_RE.test(code)) return { kind: 'bad', why: 'wrong_shape' };
    let shownAt: number | null = null;
    if (parts.length === 5) {
      if (!SHOWN_RE.test(parts[4])) return { kind: 'bad', why: 'wrong_shape' };
      const n = parseInt(parts[4], 36);
      shownAt = Number.isSafeInteger(n) ? n : null;
    }
    return { kind: 'student', perm, code, shownAt };
  }

  if (parts[1] === 'g1') {
    if (parts.length !== 3 || !GUEST_TOKEN_RE.test(parts[2])) return { kind: 'bad', why: 'wrong_shape' };
    return { kind: 'guest', token: parts[2] };
  }

  if (parts[1] === 'v1') return { kind: 'bad', why: 'old_version' };
  return { kind: 'bad', why: 'unknown_version' };
}

/** Build the text a student's QR code carries. */
export function studentPayload(perm: string, code: string, shownAtMs?: number | null): string {
  const base = `GAUCHOPASS|v2|${perm}|${code}`;
  return typeof shownAtMs === 'number' && shownAtMs > 0 ? `${base}|${Math.floor(shownAtMs).toString(36)}` : base;
}

export function guestPayload(token: string): string {
  return `GAUCHOPASS|g1|${token}`;
}

// ---------- Time-based one-time codes (TOTP, RFC 6238, HMAC-SHA1) ----------

export function windowAt(ms: number): number {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Secret is not valid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function importKey(secretHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexToBytes(secretHex), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
}

async function codeFor(key: CryptoKey, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[sig.length - 1] & 15;
  const bin = ((sig[o] & 127) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The 6-digit code for one secret and one 30-second window. */
export async function totp(secretHex: string, window: number): Promise<string> {
  return codeFor(await importKey(secretHex), window);
}

/** Compare two strings without stopping at the first difference. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Window offsets to try, nearest first: 0, -1, +1, then older, then newer. */
function offsetsToTry(): number[] {
  const out = [0];
  for (let k = 1; k <= DRIFT_WINDOWS; k++) out.push(-k, k);
  for (let k = DRIFT_WINDOWS + 1; k <= LOOK_BACK_WINDOWS; k++) out.push(-k);
  for (let k = DRIFT_WINDOWS + 1; k <= LOOK_AHEAD_WINDOWS; k++) out.push(k);
  return out;
}

/**
 * Find which secret and which window produced this code, if any.
 * The current secret is tried first, then the secret of a deactivated phone.
 */
export async function matchCode(
  code: string,
  currentSecretHex: string,
  previousSecretHex: string | null,
  nowWindow: number,
): Promise<Match> {
  const offsets = offsetsToTry();
  const candidates: Array<['current' | 'previous', string | null]> = [
    ['current', currentSecretHex],
    ['previous', previousSecretHex],
  ];
  for (const [name, secretHex] of candidates) {
    if (!secretHex) continue;
    const key = await importKey(secretHex);
    for (const offset of offsets) {
      if (safeEqual(code, await codeFor(key, nowWindow + offset))) return { secret: name, offset };
    }
  }
  return null;
}

// ---------- Decisions ----------

function deny(reason: Reason, identity: boolean, extra: Partial<Decision> = {}): Decision {
  return { decision: 'deny', reason, identity, timeWindow: null, useSwipe: false, countBad: false, detail: {}, ...extra };
}

type MealHolder = { access: string[]; meal_plan: string | null; swipes_per_week: number | null; swipes_left: number | null };

/** Access rules shared by students and guest hosts. Null means access is allowed. */
function accessProblem(holder: MealHolder, location: LocationCtx): Reason | null {
  const dining = location.type === 'dining';
  if (!holder.access.includes(location.type)) return dining ? 'no_meal_plan' : 'no_access';
  if (dining) {
    if (!holder.meal_plan) return 'no_meal_plan';
    if (holder.swipes_per_week !== null && (holder.swipes_left ?? 0) <= 0) return 'no_swipes';
  }
  return null;
}

function usesSwipe(holder: MealHolder, location: LocationCtx): boolean {
  return location.type === 'dining' && holder.swipes_per_week !== null;
}

/** Decide a student scan. The database still has the final say on one-time use and swipes. */
export async function decideStudent(
  student: StudentCtx,
  location: LocationCtx,
  code: string,
  nowMs: number,
): Promise<Decision> {
  if (student.bad_attempts >= BAD_ATTEMPT_LIMIT) return deny('too_many_attempts', false);

  const nowWindow = windowAt(nowMs);
  const match = await matchCode(code, student.secret, student.previous_secret, nowWindow);
  if (!match) return deny('invalid_code', false, { countBad: true });

  const codeWindow = nowWindow + match.offset;

  // A code made with the old secret proves it came from the phone that was deactivated.
  if (match.secret === 'previous') {
    return deny(student.status === 'lost' ? 'card_lost' : 'revoked_device', true, { timeWindow: codeWindow });
  }
  if (student.status !== 'active') return deny('card_lost', true, { timeWindow: codeWindow });

  if (match.offset < -DRIFT_WINDOWS) {
    const ageSeconds = Math.max(0, Math.round(nowMs / 1000 - (codeWindow + 1) * STEP_SECONDS));
    return deny('expired', true, { timeWindow: codeWindow, detail: { age_seconds: ageSeconds } });
  }
  if (match.offset > DRIFT_WINDOWS) {
    const aheadSeconds = Math.max(0, Math.round(codeWindow * STEP_SECONDS - nowMs / 1000));
    return deny('clock_ahead', true, { timeWindow: codeWindow, detail: { ahead_seconds: aheadSeconds } });
  }

  const problem = accessProblem(student, location);
  if (problem) return deny(problem, true, { timeWindow: codeWindow });

  return {
    decision: 'grant',
    reason: 'ok',
    identity: true,
    timeWindow: codeWindow,
    useSwipe: usesSwipe(student, location),
    countBad: false,
    detail: {},
  };
}

/** Decide a guest pass scan. */
export function decideGuest(guest: GuestCtx, location: LocationCtx, nowMs: number): Decision {
  if (guest.revoked_at) return deny('guest_revoked', true);
  if (guest.used_at) return deny('guest_used', true, { detail: { used_at: guest.used_at } });
  const expires = Date.parse(guest.expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) return deny('guest_expired', true, { detail: { expired_at: guest.expires_at } });
  if (guest.host.status !== 'active') return deny('guest_revoked', true);
  if (guest.location_type !== location.type) {
    return deny('guest_wrong_place', true, { detail: { valid_for: guest.location_type } });
  }
  const problem = accessProblem(guest.host, location);
  if (problem) return deny(problem, true);
  return {
    decision: 'grant',
    reason: 'ok',
    identity: true,
    timeWindow: null,
    useSwipe: usesSwipe(guest.host, location),
    countBad: false,
    detail: {},
  };
}

// ---------- Small helpers ----------

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}
