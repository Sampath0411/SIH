/**
 * Packages AERO-VIEW as a Windows desktop app.
 *
 *   cd desktop
 *   npm install            (first time only)
 *   npm run pack           (next build at the repo root, then electron-builder)
 *
 * It produces `desktop/dist/win-unpacked/AERO-VIEW.exe` — a self-contained
 * folder with the Electron runtime, the Next standalone server bundle and the
 * data snapshots — plus an NSIS installer and a portable exe.
 *
 * The web app lives at the repo root and is untouched: this script only READS
 * its build output (.next/standalone, .next/static, public/, data/) and its
 * .env.local. The standalone server is assembled into desktop/app-bundle,
 * which electron-builder then packs as extraResources.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');

function step(msg) {
  console.log(`\n[desktop] ${msg}`);
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function rm(p) {
  fs.rmSync(path.join(DESKTOP, p), { recursive: true, force: true });
}

function copyFromRoot(src, dest) {
  fs.cpSync(path.join(ROOT, src), path.join(DESKTOP, dest), { recursive: true });
}

// ---------------------------------------------------------------- build next
step('building the Next.js app (standalone output, at the repo root)');
run('npx next build', {
  env: { ...process.env, DESKTOP_BUILD: '1' },
});

// Next mirrors the project's path under .next/standalone when the project
// does not sit at a drive root (e.g. C:\Users\me\Downloads\AERO-VIEW), so
// locate the directory that actually holds server.js instead of assuming.
function findStandaloneRoot() {
  const base = path.join(ROOT, '.next', 'standalone');
  if (!fs.existsSync(base)) return null;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
  return null;
}
const standaloneRoot = findStandaloneRoot();
if (!standaloneRoot) {
  console.error('[desktop] standalone output missing — is DESKTOP_BUILD=1 reaching next.config.mjs?');
  process.exit(1);
}
console.log(`[desktop] standalone root: ${path.relative(ROOT, standaloneRoot)}`);

// ------------------------------------------------------- assemble the bundle
step('assembling desktop/app-bundle (standalone server + static + public + data)');
rm('app-bundle');
rm('dist');

copyFromRoot(path.relative(ROOT, standaloneRoot), 'app-bundle');
// Standalone already carries .next/server; the static assets are separate.
copyFromRoot('.next/static', 'app-bundle/.next/static');
copyFromRoot('public', 'app-bundle/public');
// Overwrite whatever tracing picked up with the complete data directory
// (snapshots, registries, residents, survey plans) so the app runs with the
// database unreachable.
copyFromRoot('data', 'app-bundle/data');

// Server-only secrets sit beside the bundle, NOT inside the installed program
// files, so packaging them into the exe directory keeps them out of the exe
// itself. electron-builder copies extraResources verbatim.
const envFile = path.join(DESKTOP, 'app-bundle', 'server.env');
if (fs.existsSync(path.join(ROOT, '.env.local'))) {
  fs.copyFileSync(path.join(ROOT, '.env.local'), envFile);
  console.log('[desktop] copied .env.local -> desktop/app-bundle/server.env');
} else {
  console.warn('[desktop] WARNING: no .env.local found — login (SESSION_SECRET) will not work');
}

// The BrowserWindow/taskbar icon lives with the bundle so electron/main.js can
// load it from resources/ at runtime (the exe's own icon is build/icon.ico,
// embedded by electron-builder at link time).
for (const f of ['icon.ico', 'icon-256.png']) {
  const src = path.join(DESKTOP, 'build', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DESKTOP, 'app-bundle', f));
}

// ------------------------------------------------------------------- package
// `npm run dir` passes --dir through here: unpacked build only, no installers.
const targets = process.argv.includes('--dir') ? '--dir' : 'nsis portable';
step(`running electron-builder (from desktop/, targets: ${targets})`);
run(`npx electron-builder --win ${targets}`, { cwd: DESKTOP });

step(`done — see desktop/dist/${process.argv.includes('--dir') ? 'win-unpacked/' : ': AERO-VIEW Setup.exe (installer) and AERO-VIEW portable.exe'}`);
