// HTTP layer for the two Edge Functions: CORS, sign-in check, body parsing and
// error handling. Uses only web-standard Request/Response, so the same code
// runs in Supabase (Deno) and in the Node test harness.

import { handleDemo } from './demo.ts';
import type { AuthAdmin, DemoEnv } from './demo.ts';
import { verifyScan } from './pipeline.ts';
import type { Db, HttpResult } from './pipeline.ts';

export type Deps = {
  db: Db;
  /** Returns the user id for a valid, still-signed-in access token, otherwise null. */
  authenticate(accessToken: string): Promise<string | null>;
  allowedOrigins: string[];
  now(): number;
};

export type DemoHttpDeps = Deps & { authAdmin: AuthAdmin; env: DemoEnv };

const MAX_BODY_BYTES = 4096;

export const DEFAULT_ORIGINS = ['https://maxrskk.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];

export function parseOrigins(value: string | null | undefined): string[] {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ORIGINS;
}

function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function respond(result: HttpResult, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...(result.headers ?? {}) },
  });
}

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

async function readJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, message: 'Could not read the request.' };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, message: 'Request is too large.' };
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'Send a JSON object.' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: 'Request is not valid JSON.' };
  }
}

const NOT_SIGNED_IN: HttpResult = {
  status: 401,
  body: { error: 'not_signed_in', message: 'Your session has expired. Sign in again.' },
};

function serverError(name: string, err: unknown): HttpResult {
  console.error(`${name} failed:`, err instanceof Error ? err.message : err);
  return { status: 500, body: { error: 'server_error', message: 'Something went wrong on the server. Try again.' } };
}

/** POST /functions/v1/verify-scan */
export async function serveVerify(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (req.method !== 'POST') return respond({ status: 405, body: { error: 'method_not_allowed', message: 'Use POST.' } }, cors);
    const token = bearer(req);
    const userId = token ? await deps.authenticate(token) : null;
    if (!userId) return respond(NOT_SIGNED_IN, cors);
    const body = await readJson(req);
    if (!body.ok) return respond({ status: 400, body: { error: 'invalid_request', message: body.message } }, cors);
    const result = await verifyScan(
      deps.db,
      { scannerId: userId, payload: body.value.payload, locationId: body.value.location_id },
      deps.now(),
    );
    return respond(result, cors);
  } catch (err) {
    return respond(serverError('verify-scan', err), cors);
  }
}

/** POST /functions/v1/demo */
export async function serveDemo(req: Request, deps: DemoHttpDeps): Promise<Response> {
  const cors = corsHeaders(req, deps.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (req.method !== 'POST') return respond({ status: 405, body: { error: 'method_not_allowed', message: 'Use POST.' } }, cors);
    const body = await readJson(req);
    if (!body.ok) return respond({ status: 400, body: { error: 'invalid_request', message: body.message } }, cors);

    const setupToken = req.headers.get('x-setup-token');
    let userId: string | null = null;
    if (body.value.action !== 'seed') {
      const token = bearer(req);
      userId = token ? await deps.authenticate(token) : null;
      if (!userId) return respond(NOT_SIGNED_IN, cors);
    }
    const result = await handleDemo(
      { db: deps.db, authAdmin: deps.authAdmin, env: deps.env, now: deps.now },
      { userId, setupToken },
      body.value,
    );
    return respond(result, cors);
  } catch (err) {
    return respond(serverError('demo', err), cors);
  }
}
