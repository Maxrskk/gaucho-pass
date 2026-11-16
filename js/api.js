// Everything that talks to Supabase goes through this file.
//
// The browser only ever holds the publishable key and the signed-in user's own
// session. What that user may read or do is decided on the server.

import { SUPABASE_KEY, SUPABASE_URL } from './config.js';

export class ApiError extends Error {
  constructor(code, message, status = 0, payload = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gp-auth' },
});

const offline = () => new ApiError('offline', "Can't reach the server. Check your connection.");
const expired = () => new ApiError('not_signed_in', 'Your session has expired. Sign in again.', 401);

function isNetworkError(error) {
  return !navigator.onLine || error?.name === 'AuthRetryableFetchError' || error?.status === 0 ||
    /failed to fetch|load failed|networkerror/i.test(String(error?.message ?? ''));
}

async function accessToken() {
  let out;
  try {
    out = await client.auth.getSession();
  } catch (err) {
    throw isNetworkError(err) ? offline() : expired();
  }
  const token = out.data?.session?.access_token;
  if (token) return token;
  throw out.error && isNetworkError(out.error) ? offline() : expired();
}

async function post(path, body, { timeoutMs = 10000, retried = false } = {}) {
  const token = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch {
    throw offline();
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  if (res.status !== 204) {
    try { payload = await res.json(); } catch { payload = null; }
  }
  if (res.ok) return payload;

  if (res.status === 401) {
    // The access token may simply be stale: refresh once and retry. If the
    // session itself is gone (signed out, or revoked after "Report lost"), stop.
    if (!retried) {
      let refreshed;
      try { refreshed = await client.auth.refreshSession(); } catch (err) { throw isNetworkError(err) ? offline() : expired(); }
      if (refreshed.data?.session) return post(path, body, { timeoutMs, retried: true });
      if (refreshed.error && isNetworkError(refreshed.error)) throw offline();
    }
    throw expired();
  }

  // Edge Functions answer { error, message }. Database functions raise a short
  // code as the message (SQLSTATE P0001).
  let code = 'server_error';
  if (typeof payload?.error === 'string') code = payload.error;
  else if (payload?.code === 'P0001' && typeof payload.message === 'string') code = payload.message;
  else if (payload?.code === '42501') code = 'wrong_role';
  const message = typeof payload?.error === 'string' && typeof payload?.message === 'string'
    ? payload.message
    : 'Something went wrong. Try again.';
  throw new ApiError(code, message, res.status, payload);
}

/** Call a database function. */
export const rpc = (name, args = {}, options) => post(`/rest/v1/rpc/${name}`, args, options);

/** Call an Edge Function. */
export const fn = (name, body = {}, options) => post(`/functions/v1/${name}`, body, options);

export async function signIn(email, password) {
  let out;
  try {
    out = await client.auth.signInWithPassword({ email, password });
  } catch (err) {
    throw isNetworkError(err) ? offline() : new ApiError('server_error', 'Sign-in failed. Try again.');
  }
  if (out.error) {
    if (out.error.status === 429) throw new ApiError('rate_limited', 'Too many sign-in attempts. Wait a minute and try again.', 429);
    if (out.error.status === 400 || out.error.status === 401 || out.error.status === 422) {
      throw new ApiError('bad_login', 'Wrong email or password.', out.error.status);
    }
    throw isNetworkError(out.error) ? offline() : new ApiError('server_error', 'Sign-in failed. Try again.', out.error.status);
  }
  return out.data.session;
}

/** Sign out this device only. Other devices on the same account stay signed in. */
export async function signOut() {
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch {
    // Even if the server can't be reached, the local session is removed.
  }
}

/** True if this device holds a session (it may need a refresh before use). */
export async function hasSession() {
  try {
    const { data } = await client.auth.getSession();
    if (data?.session) return true;
  } catch { /* fall through */ }
  try { return localStorage.getItem('gp-auth') !== null; } catch { return false; }
}

/** Runs the callback when Supabase ends the session (for example a revoked login). */
export function onSignedOut(callback) {
  client.auth.onAuthStateChange((event) => {
    // Never call back into the auth client from inside this handler.
    if (event === 'SIGNED_OUT') setTimeout(callback, 0);
  });
}
