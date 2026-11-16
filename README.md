# Gaucho Pass

A working prototype of a digital campus ID: instead of swiping a plastic access card, a student shows a QR code on their phone that changes every 30 seconds. It is built for a UCSB Writing 50E group project that proposes this idea for dining commons, the Rec Cen, MTD buses and the library.

**This is a student prototype. It is not affiliated with or endorsed by UC Santa Barbara, and every name, perm number and face in it is made up.**

Live site: https://maxrskk.github.io/gaucho-pass/

For a plain-language explanation of how it works and what a real rollout would need, read [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## What it does

- **Students** sign in and see their own ID card with a photo and a rotating QR code. The code still appears with no internet connection.
- **Scanners** (staff) pick a location and scan codes with the phone camera. A full-screen green or red result shows who it is and why.
- **The server decides every scan.** A screenshot, a reused code, a forged code or a lost phone's code is refused, at every scanner.
- **Lost phone:** the student signs in on any other device and taps "Report my ID lost". The old phone's codes stop working at once.
- **Extras:** an admin dashboard with a live scan log, a weekly meal swipe counter, one-time guest passes, scan speed stats, and a demo screen with a script and a reset button.

## Test accounts

Every test account uses the domain `gauchopass.example`. There are three passwords, one per role. They are private: your group has them in `LOGINS.local.md`, which is never uploaded to GitHub.

| Account | Email | Notes |
|---|---|---|
| Jordan Reyes | `jordan@gauchopass.example` | Student, 14 meals a week |
| Priya Natarajan | `priya@gauchopass.example` | Student, unlimited meals |
| Theo Whitfield | `theo@gauchopass.example` | Student, no meal plan |
| Lena Park | `lena@gauchopass.example` | Student, starts as "reported lost" |
| Sam Okafor | `sam@gauchopass.example` | Student, 14 meals a week |
| Maya Castellanos | `maya@gauchopass.example` | Student, 1 meal swipe left |
| Dev Malhotra | `dev@gauchopass.example` | Graduate student, no meal plan |
| Aiko Tanaka | `aiko@gauchopass.example` | Student, 14 meals a week |
| Scanner 1 | `scanner1@gauchopass.example` | Dining Commons Staff |
| Scanner 2 | `scanner2@gauchopass.example` | Rec Cen Front Desk |
| Admin | `admin@gauchopass.example` | Access Office Admin |

On the sign-in screen, choose the account from the "Test account" list and type only the password.

## Running the demo

Sign in as the admin and open the **Demo** tab. It has three things:

1. **Pre-flight check.** Confirms the server answers, the clock is right, the camera and sound work, and the demo data is at its starting state.
2. **Reset demo data.** Clears the scan log and puts every test student back to the start. Tap it right before you present.
3. **Demo script.** Twelve steps listing exactly what to tap, with a tick box for each.

You need a student phone, a scanner phone, and a laptop for the second scanner, the student's "other device" and the admin dashboard. If a second device isn't available, the scanner's **Demo tools** run each security test with one tap.

Before the presentation:

- **Wake the backend.** Free Supabase projects pause after a week without activity. Open the Supabase dashboard the day before, and restore the project if it says paused.
- **Raise the sign-in limit if the whole class will log in.** Supabase limits sign-ins per network. In the dashboard, go to Authentication > Rate Limits and raise the sign-in limit for the day.
- **Test accounts are shared.** Two people signed in as the same student show the same codes, and one tapping "Report my ID lost" signs the other out.

## How it is built

- **The site** is plain static files (`index.html`, `css/`, `js/`, `vendor/`, `fonts/`, `avatars/`) with no build step, hosted on GitHub Pages. It installs to a phone's home screen and works offline through `sw.js`. Nothing loads from a third party.
- **The backend** is a free Supabase project: Auth for sign-in, Postgres with Row Level Security on every table, and two Edge Functions.
- **The only key in the site** is Supabase's publishable key, in `js/config.js`. It is safe to publish. The server key never leaves Supabase.

### What each role can read

Clients cannot insert, update or delete any row directly. Every change goes through a server function that checks who is calling.

| Table | Student | Scanner | Admin |
|---|---|---|---|
| `profiles` | own row | own row | all |
| `students` | own row | nothing | all |
| `student_secrets` | nothing | nothing | nothing |
| `locations`, `app_settings` | read | read | read |
| `scans` | nothing | own scans | all |
| `guest_passes`, `card_events` | own | nothing | all |
| `used_codes`, `rate_limits` | nothing | nothing | nothing |

### The `verify-scan` Edge Function

All verification happens here, never in the browser.

Request, from a signed-in scanner or admin:

```json
POST /functions/v1/verify-scan
{ "payload": "GAUCHOPASS|v2|9900142|493817|lq1x2abc", "location_id": "carrillo" }
```

Answer, for every scan that reached a decision:

```json
{
  "scan_id": 1234,
  "result": "denied",
  "reason": "already_used",
  "person": { "kind": "student", "name": "Jordan Reyes", "perm": "9900142", "avatar": "jordan", "detail": "Second year · Mechanical Engineering" },
  "location": { "id": "carrillo", "name": "Carrillo Dining Commons" },
  "swipes_left": 8,
  "detail": { "first_used_where": "De La Guerra", "first_used_at": "2026-11-16T20:14:03Z" },
  "shown_ms": 2840
}
```

Reasons: `ok`, `bad_format`, `unknown_id`, `invalid_code`, `expired`, `clock_ahead`, `already_used`, `card_lost`, `revoked_device`, `no_access`, `no_meal_plan`, `no_swipes`, `too_many_attempts`, `guest_used`, `guest_expired`, `guest_revoked`, `guest_wrong_place`.

Errors: 400 `invalid_request`, 401 `not_signed_in`, 403 `wrong_role`, 429 `rate_limited`, 500 `server_error`.

The name and photo are only returned when the code proved who it belongs to, so guessing perm numbers reveals nothing.

## Setting up Supabase from scratch

You need Node.js. Nothing is installed globally: the Supabase CLI runs through `npx`.

1. **Create a project** at supabase.com (free plan, a West US region). In its settings keep the Data API on. "Automatically expose new tables" can stay off: the migration grants exactly what the app needs.
2. **Turn off public sign-ups.** Authentication > Sign In / Providers > turn off "Allow new users to sign up". Only the test accounts should exist.
3. **Put the project's URL and publishable key in the site.** Edit `js/config.js`, and change the same URL in the `Content-Security-Policy` line near the top of `index.html`. Use the publishable key (it starts with `sb_publishable_`). Never put a secret or `service_role` key in this repo.
4. **Sign the CLI in:** `npx supabase login`
5. **Run the setup:** `bash tools/setup-supabase.sh`

   It makes the private passwords (`.env.demo.local` and `LOGINS.local.md`, both git-ignored), links the project, applies `supabase/migrations/`, sends the passwords to Supabase secrets, deploys both Edge Functions, and creates the 11 test accounts.
6. **Check it:** `npm run test:attack:live` tries to break the real backend (see Tests below).
7. **Lock the setup door.** Seeding is protected by a setup token. Once the accounts exist, remove it: `npx supabase secrets unset SETUP_TOKEN`. Seeding then stops working until you set it again.

The same steps by hand, if you prefer to run them one at a time:

```bash
node tools/make-logins.mjs
npx supabase link --project-ref <your-project-ref>
npx supabase db push --remote
npx supabase secrets set --env-file .env.demo.local
npx supabase functions deploy verify-scan demo --use-api
node tools/seed.mjs
```

If the CLI can't reach your database, paste the whole file in `supabase/migrations/` into the dashboard's SQL Editor and run it. It is safe to run more than once. The Edge Functions share code in `supabase/functions/_shared/`, so they are deployed with the CLI.

To change the passwords later, run `node tools/make-logins.mjs --force`, then repeat the `secrets set` and `seed` steps.

## Running it on your computer

```bash
node tools/serve.mjs        # then open http://localhost:8080
```

Use `localhost`, not your computer's network address: the camera and the code generator only work on https or localhost.

## Tests

```bash
npm install                  # once: installs the browser test runner
npm test                     # unit tests + attack suite against an in-memory backend
npx playwright install chromium webkit   # once: test browsers
npx playwright test          # every screen and flow, in Chromium and WebKit
npm run test:attack:live     # the attack suite against the real Supabase project
```

- **Unit tests** (`tests/unit/`) check the verification rules, including the official TOTP test vectors, and that the phone and the server always compute the same code.
- **The attack suite** (`tests/attack/`) signs in as each role and tries to break things: an old screenshot, the same code on two scanners, ten simultaneous uses of one code, a forged code, a lost phone's code, a revoked phone asking for the new secret, a student calling scanner and admin functions, a student reading another student's rows, a guest pass used twice or after it expired, and spamming the verify function. The live run resets the demo data several times, so don't run it during a presentation.
- **Browser tests** (`tests/e2e/`) drive the real pages at phone size, with a simulated camera pointed at a real rotating code.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The app. `js/app.js` is the shell; one file per screen. |
| `vendor/`, `fonts/`, `avatars/` | Libraries, fonts and avatar drawings, all served from this site. |
| `sw.js`, `manifest.webmanifest` | Offline support and home-screen install. |
| `supabase/migrations/` | Tables, Row Level Security and server functions. |
| `supabase/functions/verify-scan/` | The Edge Function that verifies scans. |
| `supabase/functions/demo/` | Demo-only: seed accounts, reset data, one-tap tests. |
| `supabase/functions/_shared/core.ts` | The verification rules, as pure logic. |
| `tools/` | Setup, password and avatar scripts, and a local web server. |
| `tests/` | Unit tests, attack suite, browser tests, and the in-memory backend they use. |

## Known limits

- It is a prototype with fake data. It has not had a professional security review.
- A screenshot that is shown to a scanner within about a minute, before the owner scans, works once. Rotating codes limit how long a copy lasts; one-time use stops the second scan.
- iPhones do not let web pages vibrate, so iPhone scanners get sound only.
- The camera needs https, so it works on the live site and on `localhost`, not on a plain `http://` address.
- The `demo` Edge Function and the Demo tools exist only for presenting. A real system would not ship them.

## Credits

Fonts: Bricolage Grotesque, Public Sans and JetBrains Mono, under the SIL Open Font License (texts in `fonts/`). Libraries: supabase-js and qrcode-generator (MIT) and jsQR (Apache 2.0), listed with versions in `vendor/README.md`. The avatar illustrations were drawn for this project by `tools/make-avatars.mjs`.
