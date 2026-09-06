#!/usr/bin/env node
// scripts/mint_session.mjs
//
// Print a signed gov `ulpin_session` cookie value for the browser harness:
//
//   ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
//   npm run verify:ui && npm run check:rwd
//
// Signed with SESSION_SECRET from the environment or .env.local -- the same
// secret the running server verifies with, so the cookie is accepted as a real
// sign-in and nothing in the auth path is bypassed. A citizen session:
//
//   node --experimental-strip-types scripts/mint_session.mjs --citizen
//
// Refuses to run against a production deployment. The script reads
// SESSION_SECRET from the same sources the server does, so the printed cookie
// is a REAL session for whatever environment the env points at. A developer
// who runs this against a production .env.local -- or a CI step that shares
// env with staging -- would mint a real gov cookie for prod. NODE_ENV=production
// is the only signal that script-side: skip the gate and the rest is up to
// the operator.
if (process.env.NODE_ENV === 'production') {
  console.error('mint_session.mjs refuses to run under NODE_ENV=production; '
    + 'a signed session cookie printed by this script would be a real '
    + 'production session.');
  process.exit(2);
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.SESSION_SECRET) {
  try {
    const env = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8');
    const m = env.match(/^SESSION_SECRET=(.+)$/m);
    if (m) process.env.SESSION_SECRET = m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no .env.local: session.ts falls back to a per-process secret */ }
}

const { encodeSession, makeCitizenSession, makeGovSession } =
  await import('../lib/auth/session.ts');

const claims = process.argv.includes('--citizen')
  ? makeCitizenSession({ aadhar: '000000000000', name: 'Harness Citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' })
  : makeGovSession({ email: 'harness@ulpin.local', name: 'UI harness' });
process.stdout.write(encodeSession(claims));
