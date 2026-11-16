// Unit tests for the verification rules. Run with: npm run test:unit
// Node runs the Edge Function's TypeScript file directly, so this tests the
// exact code that is deployed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAD_ATTEMPT_LIMIT, STEP_SECONDS, decideGuest, decideStudent, guestPayload, matchCode, parsePayload,
  safeEqual, sha256Hex, studentPayload, totp, windowAt,
} from '../../supabase/functions/_shared/core.ts';
import { verifyScan } from '../../supabase/functions/_shared/pipeline.ts';

const SECRET = 'a1'.repeat(20);
const OLD_SECRET = 'b2'.repeat(20);
const NOW = 1_800_000_000_000 + 7_000; // 7 seconds into a window
const W = windowAt(NOW);

const dining = { id: 'carrillo', name: 'Carrillo Dining Commons', short_name: 'Carrillo', type: 'dining' };
const rec = { id: 'rec', name: 'Recreation Center', short_name: 'Rec Cen', type: 'rec' };
const library = { id: 'lib', name: 'UCSB Library', short_name: 'Library', type: 'library' };

function student(extra = {}) {
  return {
    user_id: '00000000-0000-4000-8000-000000000001', perm: '9900142', first_name: 'Jordan', last_name: 'Reyes',
    year: 'Second year', major: 'Mechanical Engineering', avatar: 'jordan', status: 'active',
    access: ['dining', 'rec', 'bus', 'library'], meal_plan: '14 meals a week', swipes_per_week: 14, swipes_left: 9,
    secret: SECRET, previous_secret: null, bad_attempts: 0, ...extra,
  };
}

function guest(extra = {}, host = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000aa', guest_name: 'Alex', location_type: 'dining',
    expires_at: new Date(NOW + 3_600_000).toISOString(), used_at: null, revoked_at: null,
    host: {
      user_id: '00000000-0000-4000-8000-000000000001', first_name: 'Jordan', last_name: 'Reyes', status: 'active',
      access: ['dining', 'rec', 'bus', 'library'], meal_plan: '14 meals a week', swipes_per_week: 14, swipes_left: 9, ...host,
    },
    ...extra,
  };
}

// ---------- TOTP ----------

test('TOTP matches the RFC 6238 test vectors (SHA-1, last 6 digits)', async () => {
  const rfcSecret = Buffer.from('12345678901234567890').toString('hex');
  const vectors = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(await totp(rfcSecret, Math.floor(seconds / STEP_SECONDS)), expected, `at t=${seconds}`);
  }
});

test('codes change every window and differ between secrets', async () => {
  const codes = new Set();
  for (let k = 0; k < 20; k++) codes.add(await totp(SECRET, W + k));
  assert.ok(codes.size >= 19, 'consecutive windows give different codes');
  assert.notEqual(await totp(SECRET, W), await totp(OLD_SECRET, W));
});

test('safeEqual compares whole strings', () => {
  assert.equal(safeEqual('123456', '123456'), true);
  assert.equal(safeEqual('123456', '123457'), false);
  assert.equal(safeEqual('123456', '12345'), false);
  assert.equal(safeEqual('', ''), true);
});

// ---------- Payload parsing ----------

test('parses a student code with and without the shown-at time', () => {
  assert.deepEqual(parsePayload('GAUCHOPASS|v2|9900142|493817'), { kind: 'student', perm: '9900142', code: '493817', shownAt: null });
  const shown = 1_800_000_000_000;
  assert.deepEqual(parsePayload(studentPayload('9900142', '000001', shown)), { kind: 'student', perm: '9900142', code: '000001', shownAt: shown });
  assert.equal(parsePayload('  GAUCHOPASS|v2|9900142|493817  ').kind, 'student', 'surrounding spaces are ignored');
});

test('parses a guest pass', () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(parsePayload(guestPayload(token)), { kind: 'guest', token });
});

test('rejects anything that is not a well-formed Gaucho Pass code', () => {
  const bad = [
    null, undefined, 42, {}, [], '', '   ',
    'https://example.com/menu', 'GAUCHOPASS', 'GAUCHOPASS|v2', 'gauchopass|v2|9900142|493817',
    'GAUCHOPASS|v1|9900142|493817', 'GAUCHOPASS|v3|9900142|493817',
    'GAUCHOPASS|v2|990014|493817', 'GAUCHOPASS|v2|99001422|493817', 'GAUCHOPASS|v2|99001a2|493817',
    'GAUCHOPASS|v2|9900142|49381', 'GAUCHOPASS|v2|9900142|4938170', 'GAUCHOPASS|v2|9900142|49381x',
    'GAUCHOPASS|v2|9900142|493817|', 'GAUCHOPASS|v2|9900142|493817|ABC', 'GAUCHOPASS|v2|9900142|493817|abc|extra',
    'GAUCHOPASS|v2|9900142|493817|zzzzzzzzzzz',
    "GAUCHOPASS|v2|9900142'; drop table students;--|493817", 'GAUCHOPASS|v2|<script>|493817',
    'GAUCHOPASS|v2|９９００１４２|493817', 'GAUCHOPASS|v2|9900142|493817\n|x',
    'GAUCHOPASS|g1|short', 'GAUCHOPASS|g1|0123456789ABCDEF0123456789ABCDEF', 'GAUCHOPASS|g1|0123456789abcdef0123456789abcdef|x',
    'GAUCHOPASS|v2|9900142|493817' + 'x'.repeat(300),
  ];
  for (const value of bad) assert.equal(parsePayload(value).kind, 'bad', JSON.stringify(value));
  assert.equal(parsePayload('GAUCHOPASS|v1|9900142|493817').why, 'old_version');
});

// ---------- Matching a code to a window ----------

test('matchCode finds the window and the secret that produced a code', async () => {
  assert.deepEqual(await matchCode(await totp(SECRET, W), SECRET, null, W), { secret: 'current', offset: 0 });
  assert.deepEqual(await matchCode(await totp(SECRET, W - 1), SECRET, null, W), { secret: 'current', offset: -1 });
  assert.deepEqual(await matchCode(await totp(SECRET, W + 1), SECRET, null, W), { secret: 'current', offset: 1 });
  assert.deepEqual(await matchCode(await totp(SECRET, W - 7), SECRET, null, W), { secret: 'current', offset: -7 });
  assert.deepEqual(await matchCode(await totp(OLD_SECRET, W), SECRET, OLD_SECRET, W), { secret: 'previous', offset: 0 });
  assert.equal(await matchCode(await totp(OLD_SECRET, W), SECRET, null, W), null);
  assert.equal(await matchCode(await totp(SECRET, W - 500), SECRET, null, W), null, 'far too old to recognise');
});

// ---------- Student decisions ----------

test('a live code is granted, and the previous and next window are allowed for clock drift', async () => {
  for (const offset of [0, -1, 1]) {
    const d = await decideStudent(student(), rec, await totp(SECRET, W + offset), NOW);
    assert.equal(d.decision, 'grant', `offset ${offset}`);
    assert.equal(d.timeWindow, W + offset);
    assert.equal(d.identity, true);
    assert.equal(d.useSwipe, false, 'the Rec Cen never takes a meal swipe');
  }
});

test('an old screenshot is denied as expired, with its age', async () => {
  for (const offset of [-2, -3, -20]) {
    const d = await decideStudent(student(), rec, await totp(SECRET, W + offset), NOW);
    assert.equal(d.decision, 'deny');
    assert.equal(d.reason, 'expired', `offset ${offset}`);
    assert.equal(d.identity, true);
    assert.ok(d.detail.age_seconds >= 30, 'age is reported');
  }
  const d = await decideStudent(student(), rec, await totp(SECRET, W - 3), NOW);
  assert.equal(d.detail.age_seconds, 67, '3 windows back, 7 seconds into this one: expired 67 seconds ago');
});

test('a code from the future means the phone clock is ahead', async () => {
  const d = await decideStudent(student(), rec, await totp(SECRET, W + 4), NOW);
  assert.equal(d.reason, 'clock_ahead');
  assert.ok(d.detail.ahead_seconds > 60);
});

test('a forged code is denied, counted, and reveals nothing about the student', async () => {
  let code = '000000';
  while (await matchCode(code, SECRET, null, W)) code = String(Number(code) + 1).padStart(6, '0');
  const d = await decideStudent(student(), rec, code, NOW);
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'invalid_code');
  assert.equal(d.identity, false);
  assert.equal(d.countBad, true);
});

test('after too many wrong codes the student is locked, even for a correct code', async () => {
  const d = await decideStudent(student({ bad_attempts: BAD_ATTEMPT_LIMIT }), rec, await totp(SECRET, W), NOW);
  assert.equal(d.reason, 'too_many_attempts');
  assert.equal(d.identity, false);
  assert.equal(d.countBad, false);
  const ok = await decideStudent(student({ bad_attempts: BAD_ATTEMPT_LIMIT - 1 }), rec, await totp(SECRET, W), NOW);
  assert.equal(ok.decision, 'grant');
});

test('a lost phone: its old-secret code is denied as card_lost while the card is lost', async () => {
  const lost = student({ status: 'lost', previous_secret: OLD_SECRET });
  const d = await decideStudent(lost, rec, await totp(OLD_SECRET, W), NOW);
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'card_lost');
  assert.equal(d.identity, true);
});

test('a lost phone: after reactivation its old-secret code is denied as revoked_device', async () => {
  const reactivated = student({ status: 'active', previous_secret: OLD_SECRET });
  const d = await decideStudent(reactivated, rec, await totp(OLD_SECRET, W), NOW);
  assert.equal(d.reason, 'revoked_device');
  const fresh = await decideStudent(reactivated, rec, await totp(SECRET, W), NOW);
  assert.equal(fresh.decision, 'grant', 'the new phone works');
});

test('a lost card is denied even with the current secret', async () => {
  const d = await decideStudent(student({ status: 'lost' }), rec, await totp(SECRET, W), NOW);
  assert.equal(d.reason, 'card_lost');
});

test('access rules: no meal plan, no access, no swipes left', async () => {
  const code = await totp(SECRET, W);
  const noPlan = student({ access: ['rec', 'bus', 'library'], meal_plan: null, swipes_per_week: null, swipes_left: null });
  assert.equal((await decideStudent(noPlan, dining, code, NOW)).reason, 'no_meal_plan');
  assert.equal((await decideStudent(noPlan, rec, code, NOW)).decision, 'grant');
  assert.equal((await decideStudent(student({ access: ['library'] }), rec, code, NOW)).reason, 'no_access');
  assert.equal((await decideStudent(student({ swipes_left: 0 }), dining, code, NOW)).reason, 'no_swipes');
  assert.equal((await decideStudent(student({ swipes_left: 0 }), library, code, NOW)).decision, 'grant', 'zero swipes only matters at dining');
});

test('dining takes a swipe on a counted plan and none on an unlimited plan', async () => {
  const code = await totp(SECRET, W);
  assert.equal((await decideStudent(student(), dining, code, NOW)).useSwipe, true);
  const unlimited = student({ meal_plan: 'Unlimited meals', swipes_per_week: null, swipes_left: null });
  const d = await decideStudent(unlimited, dining, code, NOW);
  assert.equal(d.decision, 'grant');
  assert.equal(d.useSwipe, false);
});

test('check order: expired beats access problems, lost beats expired', async () => {
  const old = await totp(SECRET, W - 5);
  assert.equal((await decideStudent(student({ access: [] }), rec, old, NOW)).reason, 'expired');
  assert.equal((await decideStudent(student({ status: 'lost' }), rec, old, NOW)).reason, 'card_lost');
});

// ---------- Guest decisions ----------

test('a valid guest pass is granted at the right kind of place', () => {
  const d = decideGuest(guest(), dining, NOW);
  assert.equal(d.decision, 'grant');
  assert.equal(d.useSwipe, true, "a dining guest uses one of the host's swipes");
  assert.equal(decideGuest(guest({ location_type: 'rec' }), rec, NOW).useSwipe, false);
});

test('guest pass denials: used, expired, revoked, wrong place, host problems', () => {
  assert.equal(decideGuest(guest({ used_at: new Date(NOW - 1000).toISOString() }), dining, NOW).reason, 'guest_used');
  assert.equal(decideGuest(guest({ expires_at: new Date(NOW - 1).toISOString() }), dining, NOW).reason, 'guest_expired');
  assert.equal(decideGuest(guest({ expires_at: new Date(NOW).toISOString() }), dining, NOW).reason, 'guest_expired', 'expires exactly at the hour');
  assert.equal(decideGuest(guest({ expires_at: 'not a date' }), dining, NOW).reason, 'guest_expired');
  assert.equal(decideGuest(guest({ revoked_at: new Date(NOW - 1000).toISOString() }), dining, NOW).reason, 'guest_revoked');
  assert.equal(decideGuest(guest(), rec, NOW).reason, 'guest_wrong_place');
  assert.equal(decideGuest(guest({}, { status: 'lost' }), dining, NOW).reason, 'guest_revoked');
  assert.equal(decideGuest(guest({}, { swipes_left: 0 }), dining, NOW).reason, 'no_swipes');
  assert.equal(decideGuest(guest({}, { meal_plan: null, access: ['rec'] }), dining, NOW).reason, 'no_meal_plan');
});

// ---------- Request validation in the pipeline ----------

test('verifyScan rejects malformed requests before touching the database', async () => {
  const db = { rpc: async () => { throw new Error('database must not be called'); } };
  const scannerId = '00000000-0000-4000-8000-0000000000ff';
  const cases = [
    { payload: 'GAUCHOPASS|v2|9900142|493817', locationId: undefined },
    { payload: 'GAUCHOPASS|v2|9900142|493817', locationId: 'Carrillo; drop' },
    { payload: 'GAUCHOPASS|v2|9900142|493817', locationId: 42 },
    { payload: undefined, locationId: 'carrillo' },
    { payload: 12345, locationId: 'carrillo' },
    { payload: '', locationId: 'carrillo' },
    { payload: 'x'.repeat(2001), locationId: 'carrillo' },
  ];
  for (const c of cases) {
    const out = await verifyScan(db, { scannerId, ...c }, NOW);
    assert.equal(out.status, 400, JSON.stringify(c).slice(0, 80));
    assert.equal(out.body.error, 'invalid_request');
  }
});

test('sha256Hex matches a known value', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
