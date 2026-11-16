// Demo-only actions: first-time seeding, "Reset demo data", and the one-tap
// security tests. The tests run each scenario through the real verifyScan()
// on the server, so a scanner never needs to hold a student's secret.
//
// Runtime-agnostic, like pipeline.ts.

import { guestPayload, matchCode, randomCode, safeEqual, studentPayload, totp, windowAt } from './core.ts';
import type { LocationCtx } from './core.ts';
import { invalid, verifyScan } from './pipeline.ts';
import type { Db, HttpResult } from './pipeline.ts';
import { ACCOUNTS, LOCATIONS, SCENARIO_PERMS, isScenario } from './seed.ts';
import type { Scenario } from './seed.ts';

/** Creates the login if it is missing, sets its password, and returns its user id. */
export type AuthAdmin = { ensureUser(email: string, password: string): Promise<string> };

export type DemoEnv = {
  setupToken: string | null;
  passwords: { student: string | null; scanner: string | null; admin: string | null };
};

export type DemoDeps = { db: Db; authAdmin: AuthAdmin; env: DemoEnv; now(): number };
export type DemoCaller = { userId: string | null; setupToken: string | null };

const MIN_SECRET_LENGTH = 12;
const GUEST_TYPES = ['dining', 'rec', 'library'];

function fail(status: number, error: string, message: string): HttpResult {
  return { status, body: { error, message } };
}

function baseline() {
  return {
    locations: LOCATIONS,
    students: ACCOUNTS.filter((a) => a.student).map((a) => a.student),
  };
}

export async function handleDemo(deps: DemoDeps, caller: DemoCaller, body: unknown): Promise<HttpResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('Send a JSON object.');
  const action = (body as Record<string, unknown>).action;
  if (action === 'seed') return seed(deps, caller);
  if (action === 'reset') return reset(deps, caller);
  if (action === 'run_test') return runTest(deps, caller, body as Record<string, unknown>);
  return invalid('Unknown action.');
}

// ---------- seed: create the 11 test accounts (one-time setup) ----------

async function seed(deps: DemoDeps, caller: DemoCaller): Promise<HttpResult> {
  const expected = deps.env.setupToken;
  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    return fail(503, 'not_configured', 'SETUP_TOKEN is not set in Supabase secrets.');
  }
  if (!caller.setupToken || !safeEqual(caller.setupToken, expected)) {
    return fail(403, 'forbidden', 'Wrong setup token.');
  }
  const pw = deps.env.passwords;
  for (const role of ['student', 'scanner', 'admin'] as const) {
    if (!pw[role] || pw[role].length < MIN_SECRET_LENGTH) {
      return fail(503, 'not_configured', `The ${role} demo password is not set in Supabase secrets.`);
    }
  }

  const users = [];
  for (const account of ACCOUNTS) {
    const userId = await deps.authAdmin.ensureUser(account.email, pw[account.role] as string);
    users.push({ user_id: userId, role: account.role, display_name: account.display_name, student: account.student });
  }
  await deps.db.rpc('demo_seed', { p: { locations: LOCATIONS, users } });
  return { status: 200, body: { ok: true, accounts: ACCOUNTS.map((a) => ({ email: a.email, role: a.role })) } };
}

// ---------- reset: admin puts the data back to the starting state ----------

async function reset(deps: DemoDeps, caller: DemoCaller): Promise<HttpResult> {
  if (!caller.userId) return fail(401, 'not_signed_in', 'Sign in first.');
  const out = (await deps.db.rpc('demo_reset', { p_caller: caller.userId, p: baseline() })) as { error?: string };
  if (out?.error === 'wrong_role') return fail(403, 'wrong_role', 'Only an admin can reset the demo data.');
  if (out?.error) throw new Error(`demo_reset returned ${out.error}`);
  return { status: 200, body: { ok: true } };
}

// ---------- run_test: one-tap security scenarios ----------

type DemoContext = {
  error?: string;
  student?: { user_id: string; perm: string; secret: string; previous_secret: string | null; status: string };
  locations?: LocationCtx[];
};

async function runTest(deps: DemoDeps, caller: DemoCaller, body: Record<string, unknown>): Promise<HttpResult> {
  if (!caller.userId) return fail(401, 'not_signed_in', 'Sign in first.');
  const scenario = body.scenario;
  if (!isScenario(scenario)) return invalid('Unknown test scenario.');
  if (typeof body.location_id !== 'string') return invalid('Choose a reader location first.');

  const ctx = (await deps.db.rpc('demo_context', {
    p_caller: caller.userId,
    p_perm: SCENARIO_PERMS[scenario],
  })) as DemoContext;
  if (ctx?.error === 'wrong_role') return fail(403, 'wrong_role', 'Only scanner and admin accounts can run the demo tests.');
  if (ctx?.error === 'demo_off') return fail(403, 'demo_off', 'Demo tools are turned off. An admin can turn them on.');
  if (ctx?.error || !ctx?.student || !ctx.locations) {
    return fail(409, 'not_seeded', 'The demo data is missing. Ask an admin to reset the demo data.');
  }

  const locations = ctx.locations;
  const here = locations.find((l) => l.id === body.location_id);
  if (!here) return invalid('That reader location does not exist.');

  const scannerId = caller.userId;
  const run = (payload: string, locationId: string) =>
    verifyScan(deps.db, { scannerId, payload, locationId, isTest: true }, deps.now());

  const out = await playScenario(scenario, ctx.student, here, locations, deps, scannerId, run);
  if (out.last.status !== 200) return out.last;
  const first = out.first && out.first.status === 200
    ? { result: out.first.body.result, reason: out.first.body.reason, location: out.first.body.location }
    : null;
  return { status: 200, body: { ...out.last.body, scenario, first } };
}

type Run = (payload: string, locationId: string) => Promise<HttpResult>;
type Played = { first?: HttpResult; last: HttpResult };

async function playScenario(
  scenario: Scenario,
  student: NonNullable<DemoContext['student']>,
  here: LocationCtx,
  locations: LocationCtx[],
  deps: DemoDeps,
  scannerId: string,
  run: Run,
): Promise<Played> {
  const w = windowAt(deps.now());
  const codeAt = async (window: number) => studentPayload(student.perm, await totp(student.secret, window));
  const dining = locations.find((l) => l.type === 'dining') ?? here;
  // A different reader for "the same code at a second scanner": same kind of place if there is one.
  const elsewhere = locations.find((l) => l.id !== here.id && l.type === here.type) ??
    locations.find((l) => l.id !== here.id) ?? here;

  /** Scan a live code; if this window's code was already used, use the next window's. */
  const scanFresh = async (locationId: string): Promise<{ payload: string; result: HttpResult }> => {
    let payload = await codeAt(w);
    let result = await run(payload, locationId);
    if (result.status === 200 && result.body.reason === 'already_used') {
      payload = await codeAt(w + 1);
      result = await run(payload, locationId);
    }
    return { payload, result };
  };

  switch (scenario) {
    case 'live':
      return { last: (await scanFresh(here.id)).result };

    case 'expired':
      return { last: await run(await codeAt(w - 3), here.id) };

    case 'reuse': {
      const first = await scanFresh(here.id);
      if (first.result.status !== 200) return { last: first.result };
      return { first: first.result, last: await run(first.payload, elsewhere.id) };
    }

    case 'forged': {
      let code = randomCode();
      while (await matchCode(code, student.secret, student.previous_secret, w)) code = randomCode();
      return { last: await run(studentPayload(student.perm, code), here.id) };
    }

    case 'lost': {
      // The lost phone still holds the old secret, so that is what it would show.
      const secret = student.previous_secret ?? student.secret;
      return { last: await run(studentPayload(student.perm, await totp(secret, w)), here.id) };
    }

    case 'mealplan':
      return { last: await run(await codeAt(w), dining.id) };

    case 'no_swipes': {
      const first = await run(await codeAt(w), dining.id);
      if (first.status !== 200) return { last: first };
      return { first, last: await run(await codeAt(w + 1), dining.id) };
    }

    case 'guest_reuse':
    case 'guest_expired': {
      const type = GUEST_TYPES.includes(here.type) ? here.type : 'library';
      const place = here.type === type ? here : locations.find((l) => l.type === type) ?? here;
      const pass = (await deps.db.rpc('demo_guest_pass', {
        p_caller: scannerId,
        p_host_perm: student.perm,
        p_name: 'Demo Guest',
        p_type: type,
        p_ttl_seconds: scenario === 'guest_expired' ? -60 : 3600,
      })) as { error?: string; token?: string };
      if (!pass?.token) throw new Error(`demo_guest_pass returned ${pass?.error ?? 'nothing'}`);
      const payload = guestPayload(pass.token);
      if (scenario === 'guest_expired') return { last: await run(payload, place.id) };
      const first = await run(payload, place.id);
      if (first.status !== 200) return { last: first };
      return { first, last: await run(payload, place.id) };
    }
  }
  throw new Error(`Unhandled scenario ${scenario}`);
}
