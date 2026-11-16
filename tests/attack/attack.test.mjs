// Attack suite: tries to break Gaucho Pass from the outside, using only what a
// real attacker has: the public URL, the publishable key, and a login.
//
//   npm run test:attack:mock   in-memory backend (no network)
//   npm run test:attack:live   the real Supabase project (needs .env.demo.local)
//
// The live run resets the demo data several times. Don't run it mid-presentation.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { guestPayload, matchCode, studentPayload, totp, windowAt } from '../../supabase/functions/_shared/core.ts';
import { EMAIL_DOMAIN } from '../../supabase/functions/_shared/seed.ts';

const TARGET = process.env.ATTACK_TARGET ?? 'mock';
const root = new URL('../../', import.meta.url);

let base = '';
let apiKey = 'sb_publishable_mock';
let passwords = {};
let mock = null;
let clockOffset = 0; // server time minus this computer's time

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

before(async () => {
  if (TARGET === 'live') {
    const config = readFileSync(new URL('js/config.js', root), 'utf8');
    base = /SUPABASE_URL\s*=\s*'([^']+)'/.exec(config)[1];
    apiKey = /SUPABASE_KEY\s*=\s*'([^']+)'/.exec(config)[1];
    const envPath = new URL('.env.demo.local', root);
    assert.ok(existsSync(envPath), 'Run "npm run logins" first: .env.demo.local is missing');
    const env = readEnvFile(envPath);
    passwords = { student: env.DEMO_STUDENT_PASSWORD, scanner: env.DEMO_SCANNER_PASSWORD, admin: env.DEMO_ADMIN_PASSWORD };
  } else {
    const { startMockServer, MOCK_PASSWORDS } = await import('../mock/backend.mjs');
    mock = await startMockServer();
    base = mock.url;
    passwords = MOCK_PASSWORDS;
  }
  const adminSession = await signIn('admin');
  const boot = await rpc(adminSession, 'bootstrap');
  assert.equal(boot.status, 200, `bootstrap failed: ${JSON.stringify(boot.body)}`);
  clockOffset = boot.body.server_now - Date.now();
  await resetDemo();
});

after(async () => {
  try { await resetDemo(); } catch { /* leave it */ }
  if (mock) await mock.close();
});

// ---------- tiny client ----------

const roleOfAccount = (name) => (name === 'admin' ? 'admin' : name.startsWith('scanner') ? 'scanner' : 'student');
const sessions = new Map();

async function call(path, { method = 'POST', token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      apikey: apiKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Sign in fresh (a new session every time). */
async function signInNew(name) {
  const out = await call('/auth/v1/token?grant_type=password', {
    body: { email: `${name}@${EMAIL_DOMAIN}`, password: passwords[roleOfAccount(name)] },
  });
  assert.equal(out.status, 200, `sign-in failed for ${name}: ${JSON.stringify(out.body)}`);
  return { name, token: out.body.access_token, refresh: out.body.refresh_token, userId: out.body.user.id };
}

/** Sign in once per account and reuse the session. */
async function signIn(name) {
  if (!sessions.has(name)) sessions.set(name, await signInNew(name));
  return sessions.get(name);
}

const rpc = (session, name, args = {}) => call(`/rest/v1/rpc/${name}`, { token: session?.token, body: args });
const table = (session, name, query = 'select=*') => call(`/rest/v1/${name}?${query}`, { method: 'GET', token: session?.token });
const verify = (session, payload, locationId) =>
  call('/functions/v1/verify-scan', { token: session?.token, body: { payload, location_id: locationId } });
const demo = (session, body, headers) => call('/functions/v1/demo', { token: session?.token, body, headers });

async function resetDemo() {
  const out = await demo(await signIn('admin'), { action: 'reset' });
  assert.equal(out.status, 200, `reset failed: ${JSON.stringify(out.body)}`);
}

const serverNow = () => Date.now() + clockOffset;
const currentWindow = () => windowAt(serverNow());

/** Wait until we are safely inside a window, so a test's codes don't straddle a change. */
async function settle() {
  const into = (serverNow() / 1000) % 30;
  if (into > 24) await new Promise((r) => setTimeout(r, (30 - into + 0.5) * 1000));
}

/** A student's pass, as their own phone would fetch it. */
async function passOf(name, session) {
  const s = session ?? (await signIn(name));
  const out = await rpc(s, 'get_my_pass');
  assert.equal(out.status, 200, `get_my_pass failed for ${name}: ${JSON.stringify(out.body)}`);
  return out.body;
}

async function codeOf(name, offset = 0, shownAt) {
  const pass = await passOf(name);
  assert.ok(pass.secret, `${name} has no secret (card not active?)`);
  return studentPayload(pass.student.perm, await totp(pass.secret, currentWindow() + offset), shownAt);
}

const noRows = (out) => !(out.status === 200 && Array.isArray(out.body) && out.body.length > 0);
const refused = (out) => out.status >= 400;
const rpcRefused = (out, code) => out.status >= 400 && (code === undefined || out.body?.message === code);

// ---------- 1. Not signed in ----------

test('not signed in: no tables, no functions, no scans', async () => {
  for (const name of ['profiles', 'students', 'student_secrets', 'scans', 'used_codes', 'guest_passes', 'card_events', 'rate_limits']) {
    assert.ok(noRows(await table(null, name)), `anonymous read of ${name} returned rows`);
  }
  for (const name of ['bootstrap', 'get_my_pass', 'admin_overview', 'scan_prepare', 'demo_seed']) {
    assert.ok(refused(await rpc(null, name)), `anonymous call of ${name} was accepted`);
  }
  assert.equal((await verify(null, 'GAUCHOPASS|v2|9900142|000000', 'rec')).status, 401);
  assert.equal((await verify({ token: 'not.a.realtoken-not.a.realtoken' }, 'GAUCHOPASS|v2|9900142|000000', 'rec')).status, 401);
  assert.equal((await demo(null, { action: 'reset' })).status, 401);
  assert.equal((await demo(null, { action: 'run_test', scenario: 'live', location_id: 'rec' })).status, 401);
});

test('seeding needs the setup token', async () => {
  assert.equal((await demo(null, { action: 'seed' })).status, 403);
  assert.equal((await demo(null, { action: 'seed' }, { 'x-setup-token': 'guess-guess-guess-guess' })).status, 403);
  assert.equal((await demo(await signIn('admin'), { action: 'seed' })).status, 403, 'even an admin login is not enough');
});

// ---------- 2. One student reading another student's data ----------

test('a student can read only their own rows', async () => {
  const jordan = await signIn('jordan');
  const students = await table(jordan, 'students');
  if (students.status === 200) {
    assert.equal(students.body.length, 1, 'exactly one student row is visible');
    assert.equal(students.body[0].perm, '9900142');
  }
  const profiles = await table(jordan, 'profiles');
  if (profiles.status === 200) assert.deepEqual(profiles.body.map((p) => p.user_id), [jordan.userId]);

  for (const name of ['student_secrets', 'used_codes', 'rate_limits', 'scans']) {
    assert.ok(noRows(await table(jordan, name)), `student could read ${name}`);
  }
  // Another student's row by id or perm.
  const sam = await signIn('sam');
  assert.ok(noRows(await table(jordan, 'students', `select=*&user_id=eq.${sam.userId}`)));
  assert.ok(noRows(await table(jordan, 'students', 'select=*&perm=eq.9900503')));
  assert.ok(noRows(await table(jordan, 'student_secrets', `select=*&user_id=eq.${jordan.userId}`)), 'not even their own secret row directly');
});

test('nobody can write to a table directly', async () => {
  const jordan = await signIn('jordan');
  const attempts = [
    call(`/rest/v1/students?user_id=eq.${jordan.userId}`, { method: 'PATCH', token: jordan.token, body: { status: 'active', swipes_left: 999 } }),
    call('/rest/v1/profiles', { method: 'POST', token: jordan.token, body: { user_id: jordan.userId, role: 'admin', display_name: 'x' } }),
    call(`/rest/v1/profiles?user_id=eq.${jordan.userId}`, { method: 'PATCH', token: jordan.token, body: { role: 'admin' } }),
    call('/rest/v1/used_codes?time_window=gt.0', { method: 'DELETE', token: jordan.token }),
    call('/rest/v1/scans', { method: 'POST', token: jordan.token, body: { result: 'granted' } }),
    call('/rest/v1/guest_passes', { method: 'POST', token: jordan.token, body: { guest_name: 'x' } }),
  ];
  for (const out of await Promise.all(attempts)) assert.ok(refused(out), `a direct write got status ${out.status}`);
  const boot = await rpc(jordan, 'bootstrap');
  assert.equal(boot.body.role, 'student', 'role is unchanged');
});

test('each student receives only their own secret', async () => {
  const jordan = await passOf('jordan');
  const sam = await passOf('sam');
  assert.match(jordan.secret, /^[0-9a-f]{40}$/);
  assert.equal(jordan.student.perm, '9900142');
  assert.equal(sam.student.perm, '9900503');
  assert.notEqual(jordan.secret, sam.secret);
  assert.equal(JSON.stringify(jordan).includes(sam.secret), false);
});

// ---------- 3. A student opening scanner or admin functions ----------

test('a student cannot use scanner or admin functions', async () => {
  const jordan = await signIn('jordan');
  const out = await verify(jordan, await codeOf('jordan'), 'rec');
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'wrong_role');

  assert.ok(rpcRefused(await rpc(jordan, 'admin_overview'), 'wrong_role'));
  assert.ok(rpcRefused(await rpc(jordan, 'my_recent_scans'), 'wrong_role'));
  assert.ok(rpcRefused(await rpc(jordan, 'admin_set_demo_tools', { p_on: false }), 'wrong_role'));
  assert.ok(rpcRefused(await rpc(jordan, 'admin_set_card_status', { p_student: (await signIn('sam')).userId, p_status: 'lost' }), 'wrong_role'));
  assert.ok(rpcRefused(await rpc(jordan, 'log_scan_timing', { p_scan_id: 1, p_verify_ms: 5 }), 'wrong_role'));
  for (const name of ['scan_prepare', 'scan_commit', 'demo_context', 'demo_guest_pass', 'demo_seed', 'demo_reset']) {
    assert.ok(refused(await rpc(jordan, name, {})), `student could call ${name}`);
  }
  assert.equal((await demo(jordan, { action: 'reset' })).status, 403);
  assert.equal((await demo(jordan, { action: 'run_test', scenario: 'live', location_id: 'rec' })).status, 403);
  assert.equal((await passOf('sam')).student.status, 'active', "Sam's card was not touched");
});

test('a scanner cannot see student data or act as a student or admin', async () => {
  const scanner = await signIn('scanner1');
  for (const name of ['students', 'student_secrets', 'guest_passes', 'card_events', 'used_codes']) {
    assert.ok(noRows(await table(scanner, name)), `scanner could read ${name}`);
  }
  const profiles = await table(scanner, 'profiles');
  if (profiles.status === 200) assert.equal(profiles.body.length, 1, 'a scanner sees only its own profile');
  for (const name of ['get_my_pass', 'report_lost', 'reactivate_card']) {
    assert.ok(rpcRefused(await rpc(scanner, name), 'wrong_role'), `scanner could call ${name}`);
  }
  assert.ok(rpcRefused(await rpc(scanner, 'create_guest_pass', { p_guest_name: 'A', p_location_type: 'rec' }), 'wrong_role'));
  assert.ok(rpcRefused(await rpc(scanner, 'admin_overview'), 'wrong_role'));
  assert.equal((await demo(scanner, { action: 'reset' })).status, 403);
  for (const name of ['scan_prepare', 'scan_commit', 'demo_context']) {
    assert.ok(refused(await rpc(scanner, name, {})), `scanner could call ${name} directly`);
  }
});

// ---------- 4. Codes ----------

test('a live code is granted, with the student shown to the scanner', async () => {
  await settle();
  const out = await verify(await signIn('scanner1'), await codeOf('aiko', 0, serverNow() - 2500), 'rec');
  assert.equal(out.status, 200);
  assert.equal(out.body.result, 'granted');
  assert.equal(out.body.reason, 'ok');
  assert.equal(out.body.person.name, 'Aiko Tanaka');
  assert.equal(out.body.person.avatar, 'aiko');
  assert.equal(out.body.location.id, 'rec');
  assert.ok(out.body.shown_ms >= 2000 && out.body.shown_ms < 15000, `shown_ms was ${out.body.shown_ms}`);
  assert.equal(JSON.stringify(out.body).includes((await passOf('aiko')).secret), false, 'the secret never reaches the scanner');
});

test('the same code twice on two different scanners: the second is denied', async () => {
  await settle();
  const payload = await codeOf('jordan');
  const first = await verify(await signIn('scanner1'), payload, 'lib');
  assert.equal(first.body.result, 'granted');
  const second = await verify(await signIn('scanner2'), payload, 'rec');
  assert.equal(second.body.result, 'denied');
  assert.equal(second.body.reason, 'already_used');
  assert.equal(second.body.detail.first_used_where, 'Library');
  const third = await verify(await signIn('admin'), payload, 'bus');
  assert.equal(third.body.reason, 'already_used');
});

test('ten simultaneous submissions of one code: exactly one is granted', async () => {
  await settle();
  const payload = await codeOf('priya');
  const scanners = [await signIn('scanner1'), await signIn('scanner2')];
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(scanners[i % 2], payload, i % 2 ? 'rec' : 'lib')));
  for (const r of results) assert.equal(r.status, 200);
  assert.equal(results.filter((r) => r.body.result === 'granted').length, 1);
  assert.equal(results.filter((r) => r.body.reason === 'already_used').length, 9);
});

test('an old screenshot is denied as expired', async () => {
  const out = await verify(await signIn('scanner1'), await codeOf('sam', -3), 'rec');
  assert.equal(out.body.result, 'denied');
  assert.equal(out.body.reason, 'expired');
  assert.ok(out.body.detail.age_seconds >= 60, `age was ${out.body.detail.age_seconds}`);
  assert.equal(out.body.person.name, 'Sam Okafor');
  const stillGood = await verify(await signIn('scanner1'), await codeOf('sam', 0), 'rec');
  assert.equal(stillGood.body.result, 'granted', 'an expired attempt does not burn the live code');
});

test('clock drift: one window either way is accepted, a phone far ahead is told so', async () => {
  await resetDemo();
  await settle();
  const scanner = await signIn('scanner1');
  assert.equal((await verify(scanner, await codeOf('sam', -1), 'rec')).body.result, 'granted');
  assert.equal((await verify(scanner, await codeOf('sam', 1), 'rec')).body.result, 'granted');
  const ahead = await verify(scanner, await codeOf('sam', 5), 'rec');
  assert.equal(ahead.body.reason, 'clock_ahead');
});

test('a forged code is denied and reveals nothing', async () => {
  const pass = await passOf('jordan');
  let code = '111111';
  while (await matchCode(code, pass.secret, null, currentWindow())) code = String(Number(code) + 7).padStart(6, '0');
  const out = await verify(await signIn('scanner1'), studentPayload('9900142', code), 'rec');
  assert.equal(out.body.result, 'denied');
  assert.equal(out.body.reason, 'invalid_code');
  assert.equal(out.body.person, null, 'no name or photo for an unproven code');
});

test('unknown IDs and non-Gaucho-Pass codes are denied and logged', async () => {
  const scanner = await signIn('scanner1');
  assert.equal((await verify(scanner, 'GAUCHOPASS|v2|1234567|000000', 'rec')).body.reason, 'unknown_id');
  for (const payload of ['https://example.com/menu', 'GAUCHOPASS|v1|9900142|123456', "GAUCHOPASS|v2|9900142' or 1=1--|123456", '<img src=x onerror=alert(1)>']) {
    const out = await verify(scanner, payload, 'rec');
    assert.equal(out.status, 200);
    assert.equal(out.body.reason, 'bad_format', payload);
    assert.equal(out.body.person, null);
  }
  assert.equal((await verify(scanner, guestPayload('0'.repeat(32)), 'rec')).body.reason, 'invalid_code', 'a made-up guest token');
});

test('malformed requests get a clear 400', async () => {
  const scanner = await signIn('scanner1');
  const payload = 'GAUCHOPASS|v2|9900142|000000';
  const bad = [
    await verify(scanner, payload, undefined),
    await verify(scanner, payload, 'no-such-place'),
    await verify(scanner, payload, '../../etc/passwd'),
    await verify(scanner, 12345, 'rec'),
    await verify(scanner, 'x'.repeat(2500), 'rec'),
    await call('/functions/v1/verify-scan', { token: scanner.token, raw: '{not json' }),
    await call('/functions/v1/verify-scan', { token: scanner.token, raw: '[1,2,3]' }),
    await call('/functions/v1/verify-scan', { token: scanner.token, raw: JSON.stringify({ payload: 'y'.repeat(6000), location_id: 'rec' }) }),
  ];
  for (const out of bad) {
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'invalid_request');
    assert.equal(typeof out.body.message, 'string');
  }
  assert.equal((await call('/functions/v1/verify-scan', { method: 'GET', token: scanner.token })).status, 405);
});

test('CORS: only the app origins are allowed', async () => {
  const ok = await call('/functions/v1/verify-scan', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST' } });
  assert.ok(ok.status < 300);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  const evil = await call('/functions/v1/verify-scan', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

// ---------- 5. Lost phone ----------

test("a lost phone's old code is denied, and the old phone can't get the new secret", async () => {
  await resetDemo();
  await settle();
  const scanner = await signIn('scanner1');

  // Phone A is the one that gets lost. Phone B is where the student signs in to report it.
  const phoneA = await signInNew('dev');
  const before = await passOf('dev', phoneA);
  const codeFromA = async (offset = 0) => studentPayload(before.student.perm, await totp(before.secret, currentWindow() + offset));

  const phoneB = await signInNew('dev');
  const reported = await rpc(phoneB, 'report_lost');
  assert.equal(reported.status, 200);
  assert.equal(reported.body.student.status, 'lost');
  assert.equal(reported.body.secret, null, 'no secret is handed out while the card is lost');

  // The lost phone still shows a code. It must not work.
  const denied = await verify(scanner, await codeFromA(), 'lib');
  assert.equal(denied.body.result, 'denied');
  assert.equal(denied.body.reason, 'card_lost');

  // The lost phone asks the server for its pass again: blocked. Refreshing its login doesn't help.
  const blocked = await rpc(phoneA, 'get_my_pass');
  assert.ok(blocked.status >= 400 || blocked.body.device_blocked === true, 'old phone was not blocked');
  assert.equal(blocked.body?.secret ?? null, null);
  const refreshed = await call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: phoneA.refresh } });
  const phoneA2 = refreshed.status === 200 ? { ...phoneA, token: refreshed.body.access_token } : phoneA;
  const stillBlocked = await rpc(phoneA2, 'get_my_pass');
  assert.ok(stillBlocked.status >= 400 || stillBlocked.body.device_blocked === true, 'old phone got back in after a token refresh');
  assert.ok(refused(await rpc(phoneA2, 'reactivate_card')), 'old phone could reactivate the card');
  assert.ok(refused(await rpc(phoneA2, 'create_guest_pass', { p_guest_name: 'Thief', p_location_type: 'rec' })), 'old phone could make a guest pass');

  // The student reactivates from phone B and gets a brand new secret.
  const active = await rpc(phoneB, 'reactivate_card');
  assert.equal(active.body.student.status, 'active');
  assert.match(active.body.secret, /^[0-9a-f]{40}$/);
  assert.notEqual(active.body.secret, before.secret, 'the secret was rotated');

  // Old phone: still dead, now recognised as a deactivated device. New phone: works.
  const stale = await verify(scanner, await codeFromA(1), 'lib');
  assert.equal(stale.body.result, 'denied');
  assert.equal(stale.body.reason, 'revoked_device');
  const fresh = await verify(scanner, studentPayload(before.student.perm, await totp(active.body.secret, currentWindow())), 'lib');
  assert.equal(fresh.body.result, 'granted');
  const afterReactivation = await rpc(phoneA2, 'get_my_pass');
  assert.ok(afterReactivation.status >= 400 || afterReactivation.body.device_blocked === true, 'old phone got the new secret after reactivation');
  sessions.delete('dev');
});

test('an admin can deactivate any card; the student cannot undo it', async () => {
  await resetDemo();
  await settle();
  const admin = await signIn('admin');
  const scanner = await signIn('scanner1');
  const aiko = await signInNew('aiko');
  const before = await passOf('aiko', aiko);
  const overview = await rpc(admin, 'admin_overview');
  const row = overview.body.students.find((s) => s.perm === '9900851');

  assert.equal((await rpc(admin, 'admin_set_card_status', { p_student: row.user_id, p_status: 'lost' })).status, 200);
  const denied = await verify(scanner, studentPayload('9900851', await totp(before.secret, currentWindow())), 'lib');
  assert.equal(denied.body.reason, 'card_lost');
  const blocked = await rpc(aiko, 'get_my_pass');
  assert.ok(blocked.status >= 400 || blocked.body.device_blocked === true, 'the old sign-in should be blocked');

  const again = await signInNew('aiko');
  const lost = await passOf('aiko', again);
  assert.equal(lost.student.status, 'lost');
  assert.equal(lost.student.lost_by, 'admin');
  assert.equal(lost.secret, null);
  assert.ok(rpcRefused(await rpc(again, 'reactivate_card'), 'admin_locked'));

  assert.equal((await rpc(admin, 'admin_set_card_status', { p_student: row.user_id, p_status: 'active' })).status, 200);
  const active = await passOf('aiko', again);
  assert.equal(active.student.status, 'active');
  assert.notEqual(active.secret, before.secret);
  const ok = await verify(scanner, studentPayload('9900851', await totp(active.secret, currentWindow())), 'lib');
  assert.equal(ok.body.result, 'granted');
  sessions.delete('aiko');
});

// ---------- 6. Meal swipes ----------

test('meal swipes count down at dining and are denied at zero', async () => {
  await resetDemo();
  await settle();
  const scanner = await signIn('scanner1');
  assert.equal((await passOf('maya')).student.swipes_left, 1);

  const first = await verify(scanner, await codeOf('maya', 0), 'carrillo');
  assert.equal(first.body.result, 'granted');
  assert.equal(first.body.swipes_left, 0);

  const second = await verify(scanner, await codeOf('maya', 1), 'dlg');
  assert.equal(second.body.result, 'denied');
  assert.equal(second.body.reason, 'no_swipes');
  assert.equal(second.body.swipes_left, 0);
  assert.equal((await passOf('maya')).student.swipes_left, 0);

  const recStillWorks = await verify(scanner, await codeOf('maya', 1), 'rec');
  assert.equal(recStillWorks.body.result, 'granted', 'zero swipes only blocks dining, and the denied code was not used up');

  const noPlan = await verify(scanner, await codeOf('theo'), 'carrillo');
  assert.equal(noPlan.body.reason, 'no_meal_plan');

  const unlimited = await verify(scanner, await codeOf('priya'), 'carrillo');
  assert.equal(unlimited.body.result, 'granted');
  assert.equal(unlimited.body.swipes_left, null);
  assert.equal(unlimited.body.unlimited, true);

  const jordanBefore = (await passOf('jordan')).student.swipes_left;
  const jordan = await verify(scanner, await codeOf('jordan'), 'carrillo');
  assert.equal(jordan.body.swipes_left, jordanBefore - 1);
  const library = await verify(scanner, await codeOf('jordan', 1), 'lib');
  assert.equal(library.body.result, 'granted');
  assert.equal((await passOf('jordan')).student.swipes_left, jordanBefore - 1, 'the library does not take a swipe');
});

// ---------- 7. Guest passes ----------

test('a guest pass works once, at the right place, and never again', async () => {
  await resetDemo();
  const jordan = await signIn('jordan');
  const scanner1 = await signIn('scanner1');
  const scanner2 = await signIn('scanner2');

  const made = await rpc(jordan, 'create_guest_pass', { p_guest_name: 'Alex Rivera', p_location_type: 'rec' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(made.body.token, /^[0-9a-f]{32}$/);
  const payload = guestPayload(made.body.token);

  const wrongPlace = await verify(scanner1, payload, 'lib');
  assert.equal(wrongPlace.body.reason, 'guest_wrong_place');

  const first = await verify(scanner1, payload, 'rec');
  assert.equal(first.body.result, 'granted');
  assert.equal(first.body.person.kind, 'guest');
  assert.equal(first.body.person.name, 'Alex Rivera');
  assert.equal(first.body.person.host_name, 'Jordan Reyes');

  const second = await verify(scanner2, payload, 'rec');
  assert.equal(second.body.result, 'denied');
  assert.equal(second.body.reason, 'guest_used');

  const list = (await passOf('jordan')).guest_passes;
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'used');
  assert.equal(JSON.stringify(list).includes(made.body.token), false, 'the token is not stored or listed');
});

test('guest passes: expired, revoked, dining swipe, limits and bad names', async () => {
  await resetDemo();
  const jordan = await signIn('jordan');
  const scanner = await signIn('scanner1');

  const expired = await demo(scanner, { action: 'run_test', scenario: 'guest_expired', location_id: 'rec' });
  assert.equal(expired.status, 200, JSON.stringify(expired.body));
  assert.equal(expired.body.result, 'denied');
  assert.equal(expired.body.reason, 'guest_expired');

  const toRevoke = await rpc(jordan, 'create_guest_pass', { p_guest_name: 'Sky', p_location_type: 'library' });
  assert.equal((await rpc(jordan, 'revoke_guest_pass', { p_id: toRevoke.body.id })).status, 200);
  assert.equal((await verify(scanner, guestPayload(toRevoke.body.token), 'lib')).body.reason, 'guest_revoked');

  const swipesBefore = (await passOf('jordan')).student.swipes_left;
  const meal = await rpc(jordan, 'create_guest_pass', { p_guest_name: "D'Angelo", p_location_type: 'dining' });
  const fed = await verify(scanner, guestPayload(meal.body.token), 'carrillo');
  assert.equal(fed.body.result, 'granted');
  assert.equal(fed.body.swipes_left, swipesBefore - 1, "a dining guest uses one of the host's swipes");

  for (const name of ['', '   ', '<script>alert(1)</script>', 'x'.repeat(41), 'a|b', 'tab\there']) {
    assert.ok(rpcRefused(await rpc(jordan, 'create_guest_pass', { p_guest_name: name, p_location_type: 'rec' }), 'bad_guest_name'), JSON.stringify(name));
  }
  assert.ok(rpcRefused(await rpc(jordan, 'create_guest_pass', { p_guest_name: 'A', p_location_type: 'bus' }), 'bad_location_type'));
  assert.ok(rpcRefused(await rpc(await signIn('theo'), 'create_guest_pass', { p_guest_name: 'A', p_location_type: 'dining' })), 'no meal plan, no dining guest');

  assert.equal((await rpc(jordan, 'create_guest_pass', { p_guest_name: 'One', p_location_type: 'rec' })).status, 200);
  assert.equal((await rpc(jordan, 'create_guest_pass', { p_guest_name: 'Two', p_location_type: 'rec' })).status, 200);
  assert.ok(rpcRefused(await rpc(jordan, 'create_guest_pass', { p_guest_name: 'Three', p_location_type: 'rec' }), 'too_many_active'));

  const sam = await signIn('sam');
  assert.equal((await rpc(sam, 'revoke_guest_pass', { p_id: meal.body.id })).status, 200);
  const jordanPasses = (await passOf('jordan')).guest_passes;
  assert.equal(jordanPasses.filter((p) => p.state === 'active').length, 2, "another student cannot revoke Jordan's passes");
});

test("reporting a phone lost also cancels that student's unused guest passes", async () => {
  await resetDemo();
  const sam = await signInNew('sam');
  const made = await rpc(sam, 'create_guest_pass', { p_guest_name: 'Robin', p_location_type: 'rec' });
  await rpc(sam, 'report_lost');
  assert.equal((await verify(await signIn('scanner1'), guestPayload(made.body.token), 'rec')).body.reason, 'guest_revoked');
  await rpc(sam, 'reactivate_card');
  sessions.delete('sam');
});

// ---------- 8. Demo tools ----------

test('every one-tap demo test gives the result it promises', async () => {
  await resetDemo();
  await settle();
  const scanner = await signIn('scanner1');
  const expected = {
    live: ['granted', 'ok'], expired: ['denied', 'expired'], reuse: ['denied', 'already_used'], forged: ['denied', 'invalid_code'],
    lost: ['denied', 'card_lost'], mealplan: ['denied', 'no_meal_plan'], no_swipes: ['denied', 'no_swipes'],
    guest_reuse: ['denied', 'guest_used'], guest_expired: ['denied', 'guest_expired'],
  };
  for (const [scenario, [result, reason]] of Object.entries(expected)) {
    const out = await demo(scanner, { action: 'run_test', scenario, location_id: 'lib' });
    assert.equal(out.status, 200, `${scenario}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.result, result, scenario);
    assert.equal(out.body.reason, reason, scenario);
    assert.equal(out.body.is_test, true);
    if (['reuse', 'no_swipes', 'guest_reuse'].includes(scenario)) assert.equal(out.body.first.result, 'granted', `${scenario}: first scan`);
  }
  const again = await demo(scanner, { action: 'run_test', scenario: 'live', location_id: 'lib' });
  assert.equal(again.body.result, 'granted', 'a second live test in the same 30 seconds still works');

  assert.equal((await demo(scanner, { action: 'run_test', scenario: 'nope', location_id: 'lib' })).status, 400);
  assert.equal((await demo(scanner, { action: 'run_test', scenario: 'live', location_id: 'nowhere' })).status, 400);
  assert.equal((await demo(scanner, { action: 'launch_missiles' })).status, 400);
});

test('an admin can switch the demo tools off', async () => {
  const admin = await signIn('admin');
  const scanner = await signIn('scanner1');
  assert.equal((await rpc(admin, 'admin_set_demo_tools', { p_on: false })).status, 200);
  const off = await demo(scanner, { action: 'run_test', scenario: 'live', location_id: 'lib' });
  assert.equal(off.status, 403);
  assert.equal(off.body.error, 'demo_off');
  assert.equal((await rpc(scanner, 'bootstrap')).body.demo_tools, false);
  assert.equal((await rpc(admin, 'admin_set_demo_tools', { p_on: true })).status, 200);
});

// ---------- 9. Dashboard, logs and speed stats ----------

test('scans appear in the right logs, with speed stats', async () => {
  await resetDemo();
  await settle();
  const scanner1 = await signIn('scanner1');
  const scanner2 = await signIn('scanner2');
  const admin = await signIn('admin');

  const granted = await verify(scanner1, await codeOf('jordan', 0, serverNow() - 3000), 'rec');
  assert.equal(granted.body.result, 'granted');
  await verify(scanner2, 'GAUCHOPASS|v2|9900142|000000', 'lib');

  assert.equal((await rpc(scanner2, 'log_scan_timing', { p_scan_id: granted.body.scan_id, p_verify_ms: 5 })).status < 300, true);
  assert.equal((await rpc(scanner1, 'log_scan_timing', { p_scan_id: granted.body.scan_id, p_verify_ms: 99999999 })).status < 300, true);
  assert.equal((await rpc(scanner1, 'log_scan_timing', { p_scan_id: granted.body.scan_id, p_verify_ms: 420 })).status < 300, true);
  assert.equal((await rpc(scanner1, 'log_scan_timing', { p_scan_id: granted.body.scan_id, p_verify_ms: 1 })).status < 300, true);

  const mine = await rpc(scanner1, 'my_recent_scans');
  assert.equal(mine.body.length, 1, 'a scanner sees only its own scans');
  assert.equal(mine.body[0].name, 'Jordan Reyes');
  assert.equal(mine.body[0].verify_ms, 420, "only the scanner that made the scan can time it, once, with a sane value");

  const theirs = await rpc(scanner2, 'my_recent_scans');
  assert.equal(theirs.body.length, 1);
  assert.equal(theirs.body[0].name, null, 'no name for a code that proved nothing');
  assert.equal(theirs.body[0].claimed_perm, '9900142');

  const overview = await rpc(admin, 'admin_overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.feed.length, 2);
  assert.deepEqual(overview.body.totals, { granted: 1, denied: 1 });
  assert.equal(overview.body.locations.find((l) => l.id === 'rec').granted, 1);
  assert.equal(overview.body.locations.find((l) => l.id === 'lib').denied, 1);
  assert.equal(overview.body.reasons.invalid_code, 1);
  assert.equal(overview.body.speed.verify_n, 1);
  assert.equal(overview.body.speed.verify_median, 420);
  assert.equal(overview.body.speed.shown_n, 1);
  assert.ok(overview.body.speed.shown_median >= 2500 && overview.body.speed.shown_median < 15000);
  assert.equal(overview.body.students.length, 8);
  assert.equal(JSON.stringify(overview.body).includes((await passOf('jordan')).secret), false, 'no secrets in the dashboard');
});

test('too many wrong codes lock the student for a while, even against the right code', async () => {
  await resetDemo();
  await settle();
  const admin = await signIn('admin');
  const pass = await passOf('sam');
  let n = 0;
  for (let i = 0; n < 10; i++) {
    const code = String(100000 + i * 37).padStart(6, '0');
    if (await matchCode(code, pass.secret, null, currentWindow())) continue;
    const out = await verify(admin, studentPayload('9900503', code), 'rec');
    assert.equal(out.body.reason, 'invalid_code');
    n++;
  }
  const locked = await verify(admin, await codeOf('sam'), 'rec');
  assert.equal(locked.body.result, 'denied');
  assert.equal(locked.body.reason, 'too_many_attempts');
  assert.equal(locked.body.person, null);
  await resetDemo();
  assert.equal((await verify(admin, await codeOf('sam'), 'rec')).body.result, 'granted', 'the lock lifts');
});

test('Reset demo data puts everything back', async () => {
  const admin = await signIn('admin');
  await verify(admin, await codeOf('jordan'), 'carrillo');
  await resetDemo();
  const overview = (await rpc(admin, 'admin_overview')).body;
  assert.deepEqual(overview.totals, { granted: 0, denied: 0 });
  assert.equal(overview.feed.length, 0);
  const byPerm = Object.fromEntries(overview.students.map((s) => [s.perm, s]));
  assert.equal(byPerm['9900419'].status, 'lost', 'Lena starts as reported lost');
  assert.equal(byPerm['9900618'].swipes_left, 1, 'Maya starts with one swipe');
  assert.equal(byPerm['9900142'].swipes_left, 9);
  assert.equal(byPerm['9900142'].status, 'active');
  assert.equal(overview.demo_tools, true);
});

// ---------- 10. Sessions and spam (last, because they burn the rate limit) ----------

test('a signed-out scanner can no longer verify', async () => {
  const scanner = await signInNew('scanner2');
  assert.equal((await verify(scanner, 'GAUCHOPASS|v2|9900142|000000', 'rec')).status, 200);
  const out = await call('/auth/v1/logout?scope=local', { token: scanner.token });
  assert.ok(out.status < 300, `logout returned ${out.status}`);
  assert.equal((await verify(scanner, 'GAUCHOPASS|v2|9900142|000000', 'rec')).status, 401);
});

test('spamming verify-scan gets rate limited', async () => {
  await resetDemo();
  const scanner = await signIn('scanner2');
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(...(await Promise.all(Array.from({ length: 10 }, () => verify(scanner, 'spam', 'rec')))));
  }
  const limited = results.filter((r) => r.status === 429);
  assert.ok(limited.length >= 5, `expected 429s, got ${limited.length}`);
  assert.equal(limited[0].body.error, 'rate_limited');
  assert.ok(limited[0].body.retry_after >= 1 && limited[0].body.retry_after <= 60);
  assert.ok(results.filter((r) => r.status === 200).length <= 30, 'at most 30 scans a minute get through');
  const other = await verify(await signIn('scanner1'), 'spam', 'rec');
  assert.equal(other.status, 200, 'other scanners are not affected');
});

test('reporting lost and reactivating over and over is rate limited', async () => {
  await resetDemo();
  const theo = await signInNew('theo');
  let limited = false;
  for (let i = 0; i < 14 && !limited; i++) {
    const lost = await rpc(theo, 'report_lost');
    const back = await rpc(theo, 'reactivate_card');
    limited = rpcRefused(lost, 'rate_limited') || rpcRefused(back, 'rate_limited');
  }
  assert.equal(limited, true, 'the 21st change within an hour is refused');
  await resetDemo();
  assert.equal((await passOf('theo', theo)).student.status, 'active');
  sessions.delete('theo');
});

test('the secret is sent to a device once, not on every refresh', async () => {
  await resetDemo();
  const jordan = await signIn('jordan');
  const first = await rpc(jordan, 'get_my_pass');
  assert.match(first.body.secret, /^[0-9a-f]{40}$/);
  const again = await rpc(jordan, 'get_my_pass', { p_have_version: first.body.secret_version });
  assert.equal(again.status, 200);
  assert.equal(again.body.secret, null, 'a device that already has this version is not sent it again');
  assert.equal(again.body.student.perm, '9900142');
  const stale = await rpc(jordan, 'get_my_pass', { p_have_version: first.body.secret_version - 1 });
  assert.equal(stale.body.secret, first.body.secret, 'a device with an old version gets the current one');
});
