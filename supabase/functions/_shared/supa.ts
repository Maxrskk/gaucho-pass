// Supabase wiring for the Edge Functions (Deno only).
//
// The server key comes from the environment Supabase injects into every Edge
// Function. It never appears in the repo or in the browser.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import type { AuthAdmin, DemoEnv } from './demo.ts';
import { parseOrigins } from './handlers.ts';
import type { Deps } from './handlers.ts';

function serverKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const chosen = typeof keys.default === 'string' ? keys.default : Object.values(keys).find((v) => typeof v === 'string');
      if (typeof chosen === 'string' && chosen.length > 0) return chosen;
    } catch {
      // fall through to the legacy variable
    }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('No server key found in the Edge Function environment');
}

let cached: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (!cached) {
    const url = Deno.env.get('SUPABASE_URL');
    if (!url) throw new Error('SUPABASE_URL is not set');
    cached = createClient(url, serverKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cached;
}

export function makeDeps(): Deps {
  const admin = adminClient();
  return {
    db: {
      async rpc(name, args) {
        const { data, error } = await admin.rpc(name, args);
        if (error) throw new Error(`${name}: ${error.message}`);
        return data;
      },
    },
    // Asks Supabase Auth, which also rejects tokens whose session was signed out.
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data?.user ? null : data.user.id;
    },
    allowedOrigins: parseOrigins(Deno.env.get('ALLOWED_ORIGINS')),
    now: () => Date.now(),
  };
}

export function makeAuthAdmin(): AuthAdmin {
  const admin = adminClient();
  return {
    async ensureUser(email, password) {
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (!created.error && created.data.user) return created.data.user.id;

      // Already exists: find it and set the password to the configured one.
      for (let page = 1; page <= 10; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`listUsers: ${error.message}`);
        const found = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
        if (found) {
          const updated = await admin.auth.admin.updateUserById(found.id, { password, email_confirm: true });
          if (updated.error) throw new Error(`updateUser ${email}: ${updated.error.message}`);
          return found.id;
        }
        if (data.users.length < 200) break;
      }
      throw new Error(`createUser ${email}: ${created.error?.message ?? 'unknown error'}`);
    },
  };
}

export function demoEnv(): DemoEnv {
  return {
    setupToken: Deno.env.get('SETUP_TOKEN') ?? null,
    passwords: {
      student: Deno.env.get('DEMO_STUDENT_PASSWORD') ?? null,
      scanner: Deno.env.get('DEMO_SCANNER_PASSWORD') ?? null,
      admin: Deno.env.get('DEMO_ADMIN_PASSWORD') ?? null,
    },
  };
}
