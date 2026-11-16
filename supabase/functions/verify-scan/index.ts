// Edge Function: verify-scan
//
// The only place a scan is ever accepted or refused. Input and output are
// documented in README.md; the rules live in ../_shared/core.ts.

import { serveVerify } from '../_shared/handlers.ts';
import { makeDeps } from '../_shared/supa.ts';

Deno.serve((req) => serveVerify(req, makeDeps()));
