// Edge Function: demo
//
// Demo-only helpers: seed the test accounts (setup token), reset the demo data
// (admin), and run the one-tap security tests (scanner or admin, while demo
// tools are on). A real deployment would not ship this function.

import { serveDemo } from '../_shared/handlers.ts';
import { demoEnv, makeAuthAdmin, makeDeps } from '../_shared/supa.ts';

Deno.serve((req) => serveDemo(req, { ...makeDeps(), authAdmin: makeAuthAdmin(), env: demoEnv() }));
