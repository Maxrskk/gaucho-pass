// Creates (or repairs) the 11 test accounts by calling the "demo" Edge Function.
// Needs .env.demo.local (run: node tools/make-logins.mjs) and the secrets already
// sent to Supabase. Prints the accounts, never the passwords or the token.

import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env.demo.local', root);
if (!existsSync(envPath)) {
  console.error('Missing .env.demo.local. Run: node tools/make-logins.mjs');
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]),
);
const config = readFileSync(new URL('js/config.js', root), 'utf8');
const url = /SUPABASE_URL\s*=\s*'([^']+)'/.exec(config)[1];
const key = /SUPABASE_KEY\s*=\s*'([^']+)'/.exec(config)[1];

const res = await fetch(`${url}/functions/v1/demo`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: key, 'x-setup-token': env.SETUP_TOKEN ?? '' },
  body: JSON.stringify({ action: 'seed' }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Seeding failed (${res.status}): ${body.message ?? body.error ?? 'no details'}`);
  process.exit(1);
}
console.log(`Seeded ${body.accounts.length} test accounts:`);
for (const a of body.accounts) console.log(`  ${a.role.padEnd(8)} ${a.email}`);
console.log('Passwords are in LOGINS.local.md.');
