#!/usr/bin/env bash
# Sets up (or updates) the Supabase side of Gaucho Pass. Safe to run again.
#
# Before the first run, sign the CLI in once:   npx supabase login
# Then:                                         bash tools/setup-supabase.sh
#
# Nothing here uses a service_role or secret key: the CLI uses your login, and
# the Edge Functions get their server key from Supabase itself.

set -euo pipefail
cd "$(dirname "$0")/.."

REF="$(sed -n "s|.*SUPABASE_URL = 'https://\([a-z0-9]*\)\.supabase\.co'.*|\1|p" js/config.js)"
if [ -z "$REF" ]; then echo "Could not read the project ref from js/config.js"; exit 1; fi

if [ ! -f .env.demo.local ]; then
  echo "== Making private passwords (git-ignored)"
  node tools/make-logins.mjs
fi

echo "== 1/6 Linking project $REF (if it asks for the database password, press Enter to skip)"
npx --yes supabase link --project-ref "$REF"

echo "== 2/6 Applying the database migration"
npx --yes supabase db push --remote --yes

echo "== 3/6 Sending the private settings to Supabase secrets"
npx --yes supabase secrets set --env-file .env.demo.local

echo "== 4/6 Deploying the Edge Functions"
npx --yes supabase functions deploy verify-scan demo --use-api --yes

echo "== 5/6 Creating the test accounts"
node tools/seed.mjs

echo "== 6/6 Removing the one-time setup token, so nobody can seed again"
npx --yes supabase secrets unset SETUP_TOKEN --yes

echo
echo "Done. Next: npm run test:attack:live   (tries to break the real backend)"
