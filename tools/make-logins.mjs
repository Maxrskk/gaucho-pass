// Makes the private passwords for the test accounts and the one-time setup token.
//
//   node tools/make-logins.mjs           create the files (refuses if they exist)
//   node tools/make-logins.mjs --force   replace them (you must re-run the Supabase setup after)
//
// It writes two files, both git-ignored, so nothing secret reaches GitHub:
//   .env.demo.local    sent to Supabase secrets with:  npx supabase secrets set --env-file .env.demo.local
//   LOGINS.local.md    a readable list of the logins to share with your group

import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { ACCOUNTS } from '../supabase/functions/_shared/seed.ts';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env.demo.local', root);
const loginsFile = new URL('LOGINS.local.md', root);

// Short, common words that are easy to read out and type on a phone.
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'bamboo', 'banjo', 'basil', 'beach', 'berry', 'birch', 'bison', 'bloom',
  'breeze', 'brook', 'cabin', 'cactus', 'canoe', 'canyon', 'cedar', 'cherry', 'cliff', 'cloud', 'clover', 'cobalt', 'comet', 'coral',
  'cotton', 'creek', 'daisy', 'delta', 'desert', 'dolphin', 'dune', 'eagle', 'ember', 'falcon', 'fern', 'field', 'flint', 'forest',
  'fossil', 'garden', 'ginger', 'glacier', 'gold', 'granite', 'harbor', 'hazel', 'heron', 'hill', 'honey', 'island', 'ivory', 'jade',
  'jasper', 'juniper', 'kelp', 'kettle', 'lagoon', 'lantern', 'laurel', 'lemon', 'lilac', 'linen', 'lotus', 'lunar', 'maple', 'marble',
  'meadow', 'mesa', 'mint', 'mango', 'moss', 'nectar', 'ocean', 'olive', 'onyx', 'orbit', 'orchid', 'otter', 'palm', 'panda',
  'pebble', 'pepper', 'pine', 'planet', 'plum', 'pond', 'poppy', 'prairie', 'quartz', 'quill', 'rain', 'raven', 'reef', 'ridge',
  'river', 'robin', 'rocket', 'sage', 'sail', 'salmon', 'sand', 'shell', 'shore', 'silver', 'sky', 'slate', 'snow', 'solar',
  'spruce', 'star', 'stone', 'storm', 'summit', 'sunset', 'surf', 'thistle', 'tide', 'timber', 'trail', 'tulip', 'valley', 'violet',
  'walnut', 'wave', 'willow', 'zephyr',
];

function passphrase(words) {
  const parts = Array.from({ length: words }, () => WORDS[randomInt(WORDS.length)]);
  return `${parts.join('-')}-${String(randomInt(10000)).padStart(4, '0')}`;
}

if ((existsSync(envFile) || existsSync(loginsFile)) && !process.argv.includes('--force')) {
  console.error('The login files already exist. Keeping them.');
  console.error('To make new passwords, run again with --force, then redo the Supabase secrets and seed steps in README.md.');
  process.exit(1);
}

const passwords = { student: passphrase(3), scanner: passphrase(3), admin: passphrase(4) };
const setupToken = randomBytes(24).toString('hex');
const origins = ['https://maxrskk.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];

writeFileSync(envFile, [
  '# Private. Never commit this file (it is git-ignored).',
  '# Send it to Supabase with: npx supabase secrets set --env-file .env.demo.local',
  `DEMO_STUDENT_PASSWORD=${passwords.student}`,
  `DEMO_SCANNER_PASSWORD=${passwords.scanner}`,
  `DEMO_ADMIN_PASSWORD=${passwords.admin}`,
  `SETUP_TOKEN=${setupToken}`,
  `ALLOWED_ORIGINS=${origins.join(',')}`,
  '',
].join('\n'), { mode: 0o600 });

const row = (a) => `| ${a.display_name} | \`${a.email}\` | ${a.role} |`;
writeFileSync(loginsFile, [
  '# Gaucho Pass test logins (private, git-ignored)',
  '',
  'Share these with your group. Do not put them in the repo or on a public page.',
  '',
  `- **Student password** (all 8 students): \`${passwords.student}\``,
  `- **Scanner password** (both scanners): \`${passwords.scanner}\``,
  `- **Admin password**: \`${passwords.admin}\``,
  '',
  '| Who | Email | Role |',
  '|---|---|---|',
  ...ACCOUNTS.map(row),
  '',
  'Tip for the presentation: on the sign-in screen, pick the account from the "Test account" list and type only the password.',
  '',
].join('\n'), { mode: 0o600 });

console.log('Wrote .env.demo.local and LOGINS.local.md (both git-ignored).');
console.log('Next: npx supabase secrets set --env-file .env.demo.local');
