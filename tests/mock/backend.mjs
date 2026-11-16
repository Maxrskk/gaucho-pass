// In-memory stand-in for the Supabase project, for tests only.
//
// It runs the REAL Edge Function code (handlers, pipeline, rules, demo actions)
// and replaces only the two things that live inside Supabase: the Auth service
// and the SQL functions. The SQL functions are re-implemented here in plain
// JavaScript, one for one with supabase/migrations/*.sql.
//
// The live attack suite (ATTACK_TARGET=live) is what proves the real SQL.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { serveDemo, serveVerify } from '../../supabase/functions/_shared/handlers.ts';

export const MOCK_PASSWORDS = { student: 'student-pass-1234', scanner: 'scanner-pass-1234', admin: 'admin-pass-12345' };
export const MOCK_SETUP_TOKEN = 'mock-setup-token-0123456789';
const TEST_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:8099', 'http://127.0.0.1:8099'];

class RpcError extends Error {}
const fail = (code) => { throw new RpcError(code); };

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

export function createMockBackend(options = {}) {
  const state = {
    skewMs: options.skewMs ?? 0,
    accessTtlSec: options.accessTtlSec ?? 3600,
    latencyMs: options.latencyMs ?? 0,
    users: new Map(),
    sessions: new Map(),
    profiles: new Map(),
    students: new Map(),
    secrets: new Map(),
    locations: [],
    scans: [],
    usedCodes: new Map(),
    guestPasses: new Map(),
    cardEvents: [],
    rateLimits: new Map(),
    settings: { demo_tools: true },
    nextScanId: 1,
    requests: [],
  };
  const now = () => Date.now() + state.skewMs;

  // ---------- helpers that mirror schema "app" ----------

  /** Monday of the current week in Santa Barbara time, as YYYY-MM-DD. */
  function currentWeek() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(new Date(now()));
    const get = (t) => parts.find((p) => p.type === t).value;
    const day = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
    const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[get('weekday')];
    day.setUTCDate(day.getUTCDate() - back);
    return day.toISOString().slice(0, 10);
  }

  function refreshSwipes(userId) {
    const s = state.students.get(userId);
    if (s && s.swipes_per_week !== null && (!s.swipes_week || s.swipes_week < currentWeek())) {
      s.swipes_left = s.swipes_per_week;
      s.swipes_week = currentWeek();
    }
  }

  function rateLimitHit(key, windowSeconds) {
    const start = Math.floor(now() / 1000 / windowSeconds) * windowSeconds;
    const k = `${key}|${start}`;
    const count = (state.rateLimits.get(k)?.count ?? 0) + 1;
    state.rateLimits.set(k, { key, start, count });
    return count;
  }

  function badAttempts(userId) {
    let total = 0;
    for (const r of state.rateLimits.values()) {
      if (r.key === `bad:${userId}` && r.start * 1000 > now() - 300_000) total += r.count;
    }
    return total;
  }

  const roleOf = (userId) => state.profiles.get(userId)?.role ?? null;

  function requireRole(ctx, ...allowed) {
    if (!ctx.uid) fail('not_signed_in');
    const role = roleOf(ctx.uid);
    if (!role || !allowed.includes(role)) fail('wrong_role');
    return role;
  }

  function sessionTrusted(ctx) {
    const session = state.sessions.get(ctx.sessionId);
    if (!session || session.user_id !== ctx.uid) return false;
    const sec = state.secrets.get(ctx.uid);
    if (!sec) return false;
    return ctx.sessionId === sec.trusted_session || session.created_at >= sec.sessions_valid_from - 2000;
  }

  function studentCard(userId) {
    const s = state.students.get(userId);
    if (!s) return null;
    const { user_id, swipes_week, ...card } = s;
    return { ...card, access: [...s.access] };
  }

  function passState(g) {
    if (g.revoked_at) return 'revoked';
    if (g.used_at) return 'used';
    return g.expires_at <= now() ? 'expired' : 'active';
  }

  function guestPassesJson(hostId) {
    return [...state.guestPasses.values()]
      .filter((g) => g.host_id === hostId && !g.is_test && g.created_at > now() - 86_400_000)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 10)
      .map((g) => ({
        id: g.id, guest_name: g.guest_name, location_type: g.location_type,
        created_at: iso(g.created_at), expires_at: iso(g.expires_at),
        used_at: g.used_at ? iso(g.used_at) : null, revoked_at: g.revoked_at ? iso(g.revoked_at) : null,
        state: passState(g),
      }));
  }

  function scanFeed(scannerId, limit) {
    const n = Math.min(Math.max(limit ?? 25, 1), 200);
    return state.scans
      .filter((s) => !scannerId || s.scanner_id === scannerId)
      .sort((a, b) => b.id - a.id)
      .slice(0, n)
      .map((s) => {
        const st = s.student_id ? state.students.get(s.student_id) : null;
        const g = s.guest_pass_id ? state.guestPasses.get(s.guest_pass_id) : null;
        const h = g ? state.students.get(g.host_id) : null;
        const loc = state.locations.find((l) => l.id === s.location_id);
        return {
          id: s.id, at: iso(s.created_at), result: s.result, reason: s.reason, kind: s.kind, is_test: s.is_test,
          location: loc?.short_name ?? null, location_id: s.location_id,
          scanner: state.profiles.get(s.scanner_id)?.display_name ?? null,
          name: s.kind === 'guest' ? g?.guest_name ?? null : st ? `${st.first_name} ${st.last_name}` : null,
          host: s.kind === 'guest' && h ? `${h.first_name} ${h.last_name}` : null,
          perm: st?.perm ?? null, claimed_perm: s.claimed_perm, avatar: st?.avatar ?? null,
          shown_ms: s.shown_ms, verify_ms: s.verify_ms,
        };
      });
  }

  function deactivateCard(studentId, actorId, keepSession, by) {
    const s = state.students.get(studentId);
    if (!s) fail('no_student');
    const was = s.status;
    s.lost_by = was === 'lost' && s.lost_by === 'admin' ? 'admin' : by;
    s.status = 'lost';
    s.status_changed_at = iso(now());
    const sec = state.secrets.get(studentId);
    if (was === 'active') {
      sec.previous_secret = sec.secret;
      sec.secret = randomBytes(20).toString('hex');
      sec.version += 1;
    }
    sec.sessions_valid_from = now();
    sec.trusted_session = keepSession;
    for (const g of state.guestPasses.values()) {
      if (g.host_id === studentId && !g.used_at && !g.revoked_at && g.expires_at > now()) g.revoked_at = now();
    }
    state.cardEvents.push({ created_at: now(), student_id: studentId, actor_id: actorId, action: by === 'admin' ? 'admin_deactivate' : 'report_lost' });
    for (const [id, session] of state.sessions) {
      if (session.user_id === studentId && id !== keepSession) state.sessions.delete(id);
    }
  }

  const median = (values, q) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };

  // ---------- functions the app calls (section 4 of the migration) ----------

  const clientRpc = {
    bootstrap(ctx) {
      if (!ctx.uid) fail('not_signed_in');
      const p = state.profiles.get(ctx.uid);
      if (!p) fail('no_profile');
      return {
        user_id: p.user_id, role: p.role, display_name: p.display_name, server_now: now(),
        demo_tools: state.settings.demo_tools,
        locations: state.locations.map(({ sort, ...l }) => l),
      };
    },

    get_my_pass(ctx, { p_have_version = null } = {}) {
      requireRole(ctx, 'student');
      if (!sessionTrusted(ctx)) return { device_blocked: true, server_now: now() };
      refreshSwipes(ctx.uid);
      const card = studentCard(ctx.uid);
      const sec = state.secrets.get(ctx.uid);
      if (!card || !sec) fail('no_student');
      return {
        device_blocked: false, server_now: now(), student: card,
        secret: card.status === 'active' && p_have_version !== sec.version ? sec.secret : null,
        secret_version: sec.version,
        guest_passes: guestPassesJson(ctx.uid),
      };
    },

    report_lost(ctx) {
      requireRole(ctx, 'student');
      if (!sessionTrusted(ctx)) fail('device_blocked');
      if (rateLimitHit(`card:${ctx.uid}`, 3600) > 20) fail('rate_limited');
      deactivateCard(ctx.uid, ctx.uid, ctx.sessionId, 'self');
      return clientRpc.get_my_pass(ctx);
    },

    reactivate_card(ctx) {
      requireRole(ctx, 'student');
      if (!sessionTrusted(ctx)) fail('device_blocked');
      const s = state.students.get(ctx.uid);
      if (!s) fail('no_student');
      if (s.status === 'lost') {
        if (s.lost_by === 'admin') fail('admin_locked');
        if (rateLimitHit(`card:${ctx.uid}`, 3600) > 20) fail('rate_limited');
        s.status = 'active';
        s.lost_by = null;
        s.status_changed_at = iso(now());
        state.cardEvents.push({ created_at: now(), student_id: ctx.uid, actor_id: ctx.uid, action: 'reactivate' });
      }
      return clientRpc.get_my_pass(ctx);
    },

    create_guest_pass(ctx, { p_guest_name, p_location_type }) {
      requireRole(ctx, 'student');
      if (!sessionTrusted(ctx)) fail('device_blocked');
      const name = String(p_guest_name ?? '').trim();
      if (!/^[\p{L}\p{N} .'-]{1,40}$/u.test(name)) fail('bad_guest_name');
      if (!['dining', 'rec', 'library'].includes(p_location_type)) fail('bad_location_type');
      refreshSwipes(ctx.uid);
      const s = state.students.get(ctx.uid);
      if (!s) fail('no_student');
      if (s.status !== 'active') fail('card_lost');
      if (!s.access.includes(p_location_type)) fail('no_access');
      if (p_location_type === 'dining') {
        if (!s.meal_plan) fail('no_meal_plan');
        if (s.swipes_per_week !== null && (s.swipes_left ?? 0) <= 0) fail('no_swipes');
      }
      const mine = [...state.guestPasses.values()].filter((g) => g.host_id === ctx.uid && !g.is_test);
      if (mine.filter((g) => passState(g) === 'active').length >= 2) fail('too_many_active');
      if (mine.filter((g) => g.created_at > now() - 86_400_000).length >= 6) fail('daily_limit');
      const token = randomBytes(16).toString('hex');
      const pass = {
        id: randomUUID(), host_id: ctx.uid, guest_name: name, location_type: p_location_type, token_hash: sha256(token),
        created_at: now(), expires_at: now() + 3_600_000, used_at: null, used_scan_id: null, revoked_at: null, is_test: false,
      };
      state.guestPasses.set(pass.id, pass);
      return { id: pass.id, token, guest_name: name, location_type: p_location_type, expires_at: iso(pass.expires_at), host_first_name: s.first_name };
    },

    revoke_guest_pass(ctx, { p_id }) {
      requireRole(ctx, 'student');
      if (!sessionTrusted(ctx)) fail('device_blocked');
      const g = state.guestPasses.get(p_id);
      if (g && g.host_id === ctx.uid && !g.used_at && !g.revoked_at) g.revoked_at = now();
      return { ok: true };
    },

    my_recent_scans(ctx, { p_limit } = {}) {
      requireRole(ctx, 'scanner', 'admin');
      return scanFeed(ctx.uid, Math.min(p_limit ?? 25, 100));
    },

    log_scan_timing(ctx, { p_scan_id, p_verify_ms }) {
      requireRole(ctx, 'scanner', 'admin');
      if (!Number.isInteger(p_scan_id) || !Number.isInteger(p_verify_ms) || p_verify_ms < 0 || p_verify_ms > 60000) return null;
      const scan = state.scans.find((s) => s.id === p_scan_id);
      if (scan && scan.scanner_id === ctx.uid && scan.verify_ms === null && scan.created_at > now() - 300_000) scan.verify_ms = p_verify_ms;
      return null;
    },

    admin_overview(ctx, { p_limit } = {}) {
      requireRole(ctx, 'admin');
      const week = currentWeek();
      const real = state.scans.filter((s) => s.result === 'granted' && !s.is_test);
      const shown = real.map((s) => s.shown_ms).filter((v) => v !== null && v <= 120000);
      const verify = real.map((s) => s.verify_ms).filter((v) => v !== null);
      const reasons = {};
      for (const s of state.scans) if (s.result === 'denied') reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      return {
        server_now: now(),
        demo_tools: state.settings.demo_tools,
        feed: scanFeed(null, p_limit ?? 60),
        students: [...state.students.values()]
          .sort((a, b) => (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name))
          .map((s) => ({
            user_id: s.user_id, perm: s.perm, name: `${s.first_name} ${s.last_name}`, avatar: s.avatar,
            status: s.status, lost_by: s.lost_by, meal_plan: s.meal_plan, swipes_per_week: s.swipes_per_week,
            swipes_left: s.swipes_per_week !== null && (!s.swipes_week || s.swipes_week < week) ? s.swipes_per_week : s.swipes_left,
          })),
        locations: state.locations.map((l) => ({
          id: l.id, name: l.short_name,
          granted: state.scans.filter((s) => s.location_id === l.id && s.result === 'granted').length,
          denied: state.scans.filter((s) => s.location_id === l.id && s.result === 'denied').length,
        })),
        reasons,
        totals: {
          granted: state.scans.filter((s) => s.result === 'granted').length,
          denied: state.scans.filter((s) => s.result === 'denied').length,
        },
        speed: {
          shown_n: shown.length, shown_median: median(shown, 0.5), shown_p90: median(shown, 0.9),
          verify_n: verify.length, verify_median: median(verify, 0.5), verify_p90: median(verify, 0.9),
        },
      };
    },

    admin_set_card_status(ctx, { p_student, p_status }) {
      requireRole(ctx, 'admin');
      if (!['active', 'lost'].includes(p_status)) fail('bad_status');
      const s = state.students.get(p_student);
      if (!s) fail('no_student');
      if (p_status === 'lost') deactivateCard(p_student, ctx.uid, null, 'admin');
      else if (s.status === 'lost') {
        s.status = 'active';
        s.lost_by = null;
        s.status_changed_at = iso(now());
        state.cardEvents.push({ created_at: now(), student_id: p_student, actor_id: ctx.uid, action: 'admin_reactivate' });
      }
      return { ok: true };
    },

    admin_set_demo_tools(ctx, { p_on }) {
      requireRole(ctx, 'admin');
      state.settings.demo_tools = p_on === true;
      return { ok: true, demo_tools: state.settings.demo_tools };
    },
  };

  // ---------- functions only the Edge Functions call (section 5) ----------

  const locationJson = (l) => ({ id: l.id, name: l.name, short_name: l.short_name, type: l.type });
  const staffError = (callerId) => {
    const role = roleOf(callerId);
    if (!role || !['scanner', 'admin'].includes(role)) return { error: 'wrong_role' };
    return null;
  };

  const serviceRpc = {
    scan_prepare({ p_scanner, p_location, p_kind, p_perm, p_token_hash }) {
      const denied = staffError(p_scanner);
      if (denied) return denied;
      if (rateLimitHit(`scan:${p_scanner}`, 60) > 30) {
        return { error: 'rate_limited', retry_after: 60 - (Math.floor(now() / 1000) % 60) };
      }
      const loc = state.locations.find((l) => l.id === p_location);
      if (!loc) return { error: 'unknown_location' };
      let student = null;
      let guest = null;
      if (p_kind === 'student' && p_perm) {
        const s = [...state.students.values()].find((x) => x.perm === p_perm);
        if (s) {
          refreshSwipes(s.user_id);
          const sec = state.secrets.get(s.user_id);
          student = {
            user_id: s.user_id, perm: s.perm, first_name: s.first_name, last_name: s.last_name, year: s.year, major: s.major,
            avatar: s.avatar, status: s.status, access: [...s.access], meal_plan: s.meal_plan,
            swipes_per_week: s.swipes_per_week, swipes_left: s.swipes_left,
            secret: sec.secret, previous_secret: sec.previous_secret, bad_attempts: badAttempts(s.user_id),
          };
        }
      } else if (p_kind === 'guest' && typeof p_token_hash === 'string' && /^[0-9a-f]{64}$/.test(p_token_hash)) {
        const g = [...state.guestPasses.values()].find((x) => x.token_hash === p_token_hash);
        if (g) {
          refreshSwipes(g.host_id);
          const h = state.students.get(g.host_id);
          guest = {
            id: g.id, guest_name: g.guest_name, location_type: g.location_type, expires_at: iso(g.expires_at),
            used_at: g.used_at ? iso(g.used_at) : null, revoked_at: g.revoked_at ? iso(g.revoked_at) : null,
            host: {
              user_id: h.user_id, first_name: h.first_name, last_name: h.last_name, status: h.status, access: [...h.access],
              meal_plan: h.meal_plan, swipes_per_week: h.swipes_per_week, swipes_left: h.swipes_left,
            },
          };
        }
      }
      return { location: locationJson(loc), student, guest, server_now: now() };
    },

    scan_commit({ p }) {
      let result = 'denied';
      let reason = p.reason ?? 'invalid_code';
      let detail = {};
      let swipes = null;
      let perWeek = null;
      const owner = p.swipe_owner ? state.students.get(p.swipe_owner) : null;

      if (p.decision === 'grant') {
        result = 'granted';
        reason = 'ok';
        if (p.use_swipe && owner) {
          refreshSwipes(owner.user_id);
          perWeek = owner.swipes_per_week;
          swipes = owner.swipes_left;
          if (!owner.meal_plan) { result = 'denied'; reason = 'no_meal_plan'; }
          else if (perWeek !== null && (swipes ?? 0) <= 0) { result = 'denied'; reason = 'no_swipes'; swipes = 0; }
        }
        if (result === 'granted' && p.kind === 'student') {
          if (!p.student_id || p.time_window === null || p.time_window === undefined) throw new Error('scan_commit: grant without a student or time window');
          const key = `${p.student_id}:${p.time_window}`;
          const used = state.usedCodes.get(key);
          if (used) {
            result = 'denied';
            reason = 'already_used';
            const first = state.scans.find((s) => s.id === used.scan_id);
            const loc = first ? state.locations.find((l) => l.id === first.location_id) : null;
            detail = { first_used_at: iso(used.used_at), first_used_where: loc?.short_name ?? null };
          } else {
            state.usedCodes.set(key, { used_at: now(), scan_id: null });
          }
        } else if (result === 'granted' && p.kind === 'guest') {
          const g = state.guestPasses.get(p.guest_pass_id);
          if (g && !g.used_at && !g.revoked_at && g.expires_at > now()) g.used_at = now();
          else {
            result = 'denied';
            if (!g) reason = 'invalid_code';
            else if (g.revoked_at) reason = 'guest_revoked';
            else if (g.used_at) { reason = 'guest_used'; detail = { used_at: iso(g.used_at) }; }
            else reason = 'guest_expired';
          }
        } else if (result === 'granted') {
          throw new Error(`scan_commit: cannot grant kind ${p.kind}`);
        }
        if (result === 'granted' && p.use_swipe && owner && perWeek !== null) {
          owner.swipes_left -= 1;
          swipes = owner.swipes_left;
        }
      } else if (p.bad_target) {
        rateLimitHit(`bad:${p.bad_target}`, 60);
      }

      let shownMs = null;
      if (typeof p.shown_at_ms === 'number' && p.shown_at_ms <= now() + 2000 && p.shown_at_ms >= now() - 600_000) {
        shownMs = Math.max(0, now() - p.shown_at_ms);
      }
      if (!/^[a-z_]{2,40}$/.test(reason)) throw new Error('scan_commit: bad reason');
      const scan = {
        id: state.nextScanId++, created_at: now(), scanner_id: p.scanner_id, location_id: p.location_id, kind: p.kind,
        student_id: p.student_id ?? null, claimed_perm: p.claimed_perm ?? null, guest_pass_id: p.guest_pass_id ?? null,
        result, reason, time_window: p.time_window ?? null, shown_ms: shownMs, verify_ms: null, is_test: p.is_test === true,
      };
      state.scans.push(scan);
      if (result === 'granted' && p.kind === 'student') state.usedCodes.get(`${p.student_id}:${p.time_window}`).scan_id = scan.id;
      if (result === 'granted' && p.kind === 'guest') state.guestPasses.get(p.guest_pass_id).used_scan_id = scan.id;
      return {
        scan_id: scan.id, result, reason,
        swipes_left: p.use_swipe && perWeek !== null ? swipes : null,
        detail, shown_ms: shownMs,
      };
    },

    demo_context({ p_caller, p_perm }) {
      const denied = staffError(p_caller);
      if (denied) return denied;
      if (!state.settings.demo_tools) return { error: 'demo_off' };
      const s = [...state.students.values()].find((x) => x.perm === p_perm);
      if (!s) return { error: 'not_seeded' };
      const sec = state.secrets.get(s.user_id);
      return {
        student: { user_id: s.user_id, perm: s.perm, status: s.status, secret: sec.secret, previous_secret: sec.previous_secret },
        locations: state.locations.map(locationJson),
      };
    },

    demo_guest_pass({ p_caller, p_host_perm, p_name, p_type, p_ttl_seconds }) {
      const denied = staffError(p_caller);
      if (denied) return denied;
      if (!state.settings.demo_tools) return { error: 'demo_off' };
      const host = [...state.students.values()].find((x) => x.perm === p_host_perm);
      if (!host) return { error: 'not_seeded' };
      const token = randomBytes(16).toString('hex');
      const pass = {
        id: randomUUID(), host_id: host.user_id, guest_name: String(p_name ?? 'Demo Guest').slice(0, 40), location_type: p_type,
        token_hash: sha256(token), created_at: now(), expires_at: now() + (p_ttl_seconds ?? 3600) * 1000,
        used_at: null, used_scan_id: null, revoked_at: null, is_test: true,
      };
      state.guestPasses.set(pass.id, pass);
      return { token };
    },

    demo_seed({ p }) {
      state.locations = p.locations.map((l) => ({ ...l })).sort((a, b) => a.sort - b.sort);
      for (const u of p.users) {
        state.profiles.set(u.user_id, { user_id: u.user_id, role: u.role, display_name: u.display_name });
        if (u.student) {
          state.students.set(u.user_id, {
            user_id: u.user_id, ...u.student, access: [...u.student.access],
            lost_by: u.student.status === 'lost' ? 'self' : null,
            status_changed_at: iso(now()), swipes_week: currentWeek(),
          });
          if (!state.secrets.has(u.user_id)) {
            state.secrets.set(u.user_id, {
              secret: randomBytes(20).toString('hex'), previous_secret: null, version: 1,
              sessions_valid_from: -Infinity, trusted_session: null,
            });
          }
        }
      }
      return { ok: true };
    },

    demo_reset({ p_caller, p }) {
      if (roleOf(p_caller) !== 'admin') return { error: 'wrong_role' };
      state.usedCodes.clear();
      state.scans = [];
      state.guestPasses.clear();
      state.cardEvents = [];
      state.rateLimits.clear();
      for (const st of p.students) {
        const s = [...state.students.values()].find((x) => x.perm === st.perm);
        if (!s) continue;
        const was = s.status;
        Object.assign(s, {
          status: st.status, lost_by: st.status === 'lost' ? 'self' : null, status_changed_at: iso(now()),
          access: [...st.access], meal_plan: st.meal_plan, swipes_per_week: st.swipes_per_week,
          swipes_left: st.swipes_left, swipes_week: currentWeek(),
        });
        const sec = state.secrets.get(s.user_id);
        if (st.status === 'lost' && was === 'active') {
          sec.previous_secret = sec.secret;
          sec.secret = randomBytes(20).toString('hex');
          sec.version += 1;
        }
        sec.sessions_valid_from = -Infinity;
        sec.trusted_session = null;
      }
      state.settings.demo_tools = true;
      return { ok: true };
    },
  };

  // ---------- Supabase Auth stand-in ----------

  function issueTokens(session) {
    const user = state.users.get(session.user_id);
    const iat = Math.floor(now() / 1000);
    const exp = iat + state.accessTtlSec;
    const payload = {
      sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', session_id: session.id, iat, exp,
      amr: [{ method: 'password', timestamp: Math.floor(session.created_at / 1000) }],
    };
    session.refresh_token = randomBytes(12).toString('hex');
    return {
      access_token: `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.mock`,
      token_type: 'bearer', expires_in: state.accessTtlSec, expires_at: exp, refresh_token: session.refresh_token,
      user: userJson(user),
    };
  }

  const userJson = (user) => ({
    id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
    app_metadata: { provider: 'email' }, user_metadata: {}, created_at: iso(user.created_at),
  });

  /** Decode a mock token. Returns null if it is malformed or expired. */
  function claims(token) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
      if (typeof payload.sub !== 'string' || payload.exp * 1000 <= now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  const bearerOf = (req) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

  const authAdmin = {
    async ensureUser(email, password) {
      let user = [...state.users.values()].find((u) => u.email === email);
      if (!user) {
        user = { id: randomUUID(), email, password, created_at: now() };
        state.users.set(user.id, user);
      }
      user.password = password;
      return user.id;
    },
  };

  const deps = {
    db: {
      async rpc(name, args) {
        if (!Object.hasOwn(serviceRpc, name)) throw new Error(`${name}: function does not exist`);
        return structuredClone(serviceRpc[name](structuredClone(args)));
      },
    },
    async authenticate(token) {
      const c = claims(token);
      return c && state.sessions.has(c.session_id) ? c.sub : null;
    },
    allowedOrigins: TEST_ORIGINS,
    now,
    authAdmin,
    env: { setupToken: MOCK_SETUP_TOKEN, passwords: MOCK_PASSWORDS },
  };

  // ---------- HTTP routing ----------

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });

  async function handleAuth(req, url) {
    const path = url.pathname.replace('/auth/v1', '');
    if (path === '/token' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = [...state.users.values()].find((u) => u.email === String(body.email ?? '').toLowerCase());
        if (!user || user.password !== body.password) {
          return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        }
        const session = { id: randomUUID(), user_id: user.id, created_at: now(), refresh_token: null };
        state.sessions.set(session.id, session);
        return json(200, issueTokens(session));
      }
      if (grant === 'refresh_token') {
        const session = [...state.sessions.values()].find((s) => s.refresh_token && s.refresh_token === body.refresh_token);
        if (!session) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        return json(200, issueTokens(session));
      }
      return json(400, { code: 400, error_code: 'validation_failed', msg: 'Unsupported grant type' });
    }
    if (path === '/user' && req.method === 'GET') {
      const c = claims(bearerOf(req));
      if (!c) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      if (!state.sessions.has(c.session_id)) {
        return json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' });
      }
      return json(200, userJson(state.users.get(c.sub)));
    }
    if (path === '/logout' && req.method === 'POST') {
      const c = claims(bearerOf(req));
      if (c) {
        const scope = url.searchParams.get('scope') ?? 'global';
        for (const [id, s] of state.sessions) {
          if (s.user_id !== c.sub) continue;
          if (scope === 'global' || (scope === 'local' && id === c.session_id) || (scope === 'others' && id !== c.session_id)) state.sessions.delete(id);
        }
      }
      return new Response(null, { status: 204, headers: CORS });
    }
    return json(404, { code: 404, msg: 'not found' });
  }

  /** Direct table access, following the RLS policies and grants in section 2. */
  function handleTable(req, table, ctx, url) {
    const admin = roleOf(ctx.uid) === 'admin';
    const readable = {
      locations: () => state.locations,
      app_settings: () => [{ id: true, demo_tools: state.settings.demo_tools }],
      profiles: () => [...state.profiles.values()].filter((p) => admin || p.user_id === ctx.uid),
      students: () => [...state.students.values()].filter((s) => admin || s.user_id === ctx.uid),
      scans: () => state.scans.filter((s) => admin || s.scanner_id === ctx.uid),
      guest_passes: () => [...state.guestPasses.values()].filter((g) => admin || g.host_id === ctx.uid).map(({ token_hash, ...g }) => g),
      card_events: () => state.cardEvents.filter((e) => admin || e.student_id === ctx.uid),
    };
    const known = [...Object.keys(readable), 'student_secrets', 'used_codes', 'rate_limits'];
    if (!known.includes(table)) return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}'` });
    if (!ctx.uid || req.method !== 'GET' || !readable[table]) {
      return json(ctx.uid ? 403 : 401, { code: '42501', message: `permission denied for table ${table}` });
    }
    // Simple column=eq.value filters, like PostgREST.
    let rows = readable[table]();
    for (const [column, value] of url.searchParams) {
      if (value.startsWith('eq.')) rows = rows.filter((row) => String(row[column]) === value.slice(3));
    }
    return json(200, rows);
  }

  async function handleRest(req, url) {
    const path = url.pathname.replace('/rest/v1', '');
    const token = bearerOf(req);
    const c = token.startsWith('sb_') ? null : claims(token);
    if (!c && token && !token.startsWith('sb_')) return json(401, { code: 'PGRST301', message: 'JWT expired' });
    const ctx = { uid: c?.sub ?? null, sessionId: c?.session_id ?? null };

    if (path.startsWith('/rpc/')) {
      const name = path.slice(5);
      if (Object.hasOwn(serviceRpc, name)) return json(ctx.uid ? 403 : 401, { code: '42501', message: `permission denied for function ${name}` });
      if (!Object.hasOwn(clientRpc, name)) return json(404, { code: 'PGRST202', message: `Could not find the function public.${name}` });
      if (!ctx.uid) return json(401, { code: '42501', message: `permission denied for function ${name}` });
      const args = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      try {
        const out = clientRpc[name](ctx, args ?? {});
        return out === null || out === undefined ? new Response(null, { status: 204, headers: CORS }) : json(200, out);
      } catch (err) {
        if (err instanceof RpcError) return json(400, { code: 'P0001', message: err.message, details: null, hint: null });
        throw err;
      }
    }
    return handleTable(req, path.split('/')[1] ?? '', ctx, url);
  }

  async function handle(req) {
    const url = new URL(req.url);
    state.requests.push(`${req.method} ${url.pathname}`);
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (url.pathname === '/functions/v1/verify-scan') return serveVerify(req, deps);
    if (url.pathname === '/functions/v1/demo') return serveDemo(req, deps);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, url);
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, url);
      return json(404, { message: 'not found' });
    } catch (err) {
      console.error('mock backend error:', err);
      return json(500, { message: 'mock backend error' });
    }
  }

  /** Create the 11 test accounts through the real seed code path. */
  async function seed() {
    const res = await handle(new Request('http://mock/functions/v1/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': MOCK_SETUP_TOKEN },
      body: JSON.stringify({ action: 'seed' }),
    }));
    if (res.status !== 200) throw new Error(`mock seed failed: ${res.status} ${await res.text()}`);
  }

  return { state, handle, seed, now };
}

/** Serve a mock backend over HTTP on localhost (used by the attack suite). */
export async function startMockServer(options = {}) {
  const backend = createMockBackend(options);
  await backend.seed();
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const hasBody = !['GET', 'HEAD'].includes(nodeReq.method);
    const req = new Request(`http://127.0.0.1${nodeReq.url}`, {
      method: nodeReq.method,
      headers: nodeReq.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const res = await backend.handle(req);
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
    nodeRes.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { ...backend, url, close: () => new Promise((resolve) => server.close(resolve)) };
}
