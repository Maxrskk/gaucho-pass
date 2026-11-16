// One scan, start to finish: validate the input, load context from the
// database, decide with the pure rules in core.ts, then let the database
// commit the result in a single transaction.
//
// Runtime-agnostic: the database is passed in, so the Edge Function uses the
// real Supabase project and the tests use an in-memory stand-in.

import { decideGuest, decideStudent, parsePayload, sha256Hex } from './core.ts';
import type { Decision, GuestCtx, LocationCtx, StudentCtx } from './core.ts';

export type Db = { rpc(name: string, args: Record<string, unknown>): Promise<unknown> };

export type HttpResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type VerifyInput = { scannerId: string; payload: unknown; locationId: unknown; isTest?: boolean };

const LOCATION_ID_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_REQUEST_PAYLOAD = 2000;

export function invalid(message: string): HttpResult {
  return { status: 400, body: { error: 'invalid_request', message } };
}

type Prepared = {
  error?: string;
  retry_after?: number;
  location?: LocationCtx;
  student?: StudentCtx | null;
  guest?: GuestCtx | null;
};

type Committed = {
  scan_id: number;
  result: 'granted' | 'denied';
  reason: string;
  swipes_left: number | null;
  detail: Record<string, unknown> | null;
  shown_ms: number | null;
};

function denyWithoutContext(reason: Decision['reason']): Decision {
  return { decision: 'deny', reason, identity: false, timeWindow: null, useSwipe: false, countBad: false, detail: {} };
}

export async function verifyScan(db: Db, input: VerifyInput, nowMs: number): Promise<HttpResult> {
  // 1. Input shape and size.
  if (typeof input.locationId !== 'string' || !LOCATION_ID_RE.test(input.locationId)) {
    return invalid('Choose a reader location first.');
  }
  if (typeof input.payload !== 'string' || input.payload.length === 0) {
    return invalid('No QR code text was sent.');
  }
  if (input.payload.length > MAX_REQUEST_PAYLOAD) {
    return invalid('That QR code is too long to be a Gaucho Pass code.');
  }

  const parsed = parsePayload(input.payload);

  // 2. Scanner role, rate limit, location and the scanned person, in one database call.
  const prepared = (await db.rpc('scan_prepare', {
    p_scanner: input.scannerId,
    p_location: input.locationId,
    p_kind: parsed.kind === 'bad' ? 'none' : parsed.kind,
    p_perm: parsed.kind === 'student' ? parsed.perm : null,
    p_token_hash: parsed.kind === 'guest' ? await sha256Hex(parsed.token) : null,
  })) as Prepared;

  if (prepared.error === 'wrong_role') {
    return { status: 403, body: { error: 'wrong_role', message: 'Only scanner and admin accounts can verify scans.' } };
  }
  if (prepared.error === 'rate_limited') {
    const retry = Math.max(1, Math.min(60, Number(prepared.retry_after) || 60));
    return {
      status: 429,
      body: { error: 'rate_limited', message: `Too many scans. Try again in ${retry} seconds.`, retry_after: retry },
      headers: { 'Retry-After': String(retry) },
    };
  }
  if (prepared.error === 'unknown_location' || !prepared.location) return invalid('That reader location does not exist.');
  if (prepared.error) throw new Error(`scan_prepare returned ${prepared.error}`);

  const location = prepared.location;
  const student = prepared.student ?? null;
  const guest = prepared.guest ?? null;

  // 3. Decide.
  let decision: Decision;
  if (parsed.kind === 'bad') decision = denyWithoutContext('bad_format');
  else if (parsed.kind === 'student') {
    decision = student ? await decideStudent(student, location, parsed.code, nowMs) : denyWithoutContext('unknown_id');
  } else {
    decision = guest ? decideGuest(guest, location, nowMs) : denyWithoutContext('invalid_code');
  }
  if (parsed.kind === 'bad') decision.detail = { why: parsed.why };

  const swipeOwner = parsed.kind === 'guest' ? guest?.host.user_id ?? null : student?.user_id ?? null;

  // 4. Commit atomically. The database enforces one-time use and the swipe count,
  //    so it can still turn a tentative grant into a denial.
  const committed = (await db.rpc('scan_commit', {
    p: {
      scanner_id: input.scannerId,
      location_id: location.id,
      kind: parsed.kind === 'bad' ? 'unknown' : parsed.kind,
      decision: decision.decision,
      reason: decision.reason,
      student_id: parsed.kind === 'student' && decision.identity && student ? student.user_id : null,
      claimed_perm: parsed.kind === 'student' ? parsed.perm : null,
      time_window: decision.timeWindow,
      guest_pass_id: parsed.kind === 'guest' && guest ? guest.id : null,
      use_swipe: decision.useSwipe,
      swipe_owner: decision.useSwipe ? swipeOwner : null,
      bad_target: decision.countBad && student ? student.user_id : null,
      shown_at_ms: parsed.kind === 'student' ? parsed.shownAt : null,
      is_test: input.isTest === true,
    },
  })) as Committed;

  // 5. Build the answer. Name and photo only when the code proved who it belongs to.
  let person: Record<string, unknown> | null = null;
  if (decision.identity && parsed.kind === 'student' && student) {
    person = {
      kind: 'student',
      name: `${student.first_name} ${student.last_name}`,
      first_name: student.first_name,
      perm: student.perm,
      avatar: student.avatar,
      detail: `${student.year} · ${student.major}`,
    };
  } else if (decision.identity && parsed.kind === 'guest' && guest) {
    person = {
      kind: 'guest',
      name: guest.guest_name,
      first_name: guest.guest_name,
      host_name: `${guest.host.first_name} ${guest.host.last_name}`,
    };
  }

  const holder = parsed.kind === 'guest' ? guest?.host ?? null : student;
  const showSwipes = decision.identity && location.type === 'dining' && holder !== null && holder.meal_plan !== null;
  let swipesLeft: number | null = null;
  if (showSwipes && holder) swipesLeft = committed.swipes_left ?? holder.swipes_left ?? null;

  return {
    status: 200,
    body: {
      scan_id: committed.scan_id,
      result: committed.result,
      reason: committed.reason,
      person,
      location: { id: location.id, name: location.name, short_name: location.short_name, type: location.type },
      swipes_left: swipesLeft,
      unlimited: showSwipes && holder ? holder.swipes_per_week === null : false,
      detail: { ...decision.detail, ...(committed.detail ?? {}) },
      shown_ms: committed.shown_ms,
      server_time: nowMs,
      is_test: input.isTest === true,
    },
  };
}
