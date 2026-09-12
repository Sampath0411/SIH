// One-shot desktop build for Windows:
//
//   npm run build:desktop
//
// 1. `next build` with output:'standalone' (next.config.mjs)
// 2. Copy standalone/ + .next/static + public/ + data/ into the shape
//    electron-builder ships as resources/app (see package.json `build`).
//    The static assets are copied here rather than left in place because
//    extraResources snapshots the standalone tree as-is.
// 3. electron-builder --win nsis -> dist-desktop/AERO-VIEW Setup 1.0.0.exe
//
// The installer is self-contained: no Node, no Docker, no network needed at
// runtime. PostGIS is optional (lib/db.ts falls back to data/api snapshots).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\n${cmd} exited with ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// 1. next build (standalone). DESKTOP_BUILD=1 is what switches next.config.mjs
// to output:'standalone' -- a plain build must stay a plain web build (Vercel).
run('npm', ['run', 'build'], {
  env: { ...process.env, DESKTOP_BUILD: '1' },
});

// 2. Verify the standalone output exists, then assemble extras.
const standalone = path.join(ROOT, '.next', 'standalone');
if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error('standalone output missing server.js — did next build succeed?');
  process.exit(1);
}

// The standalone tree already contains a minimal node_modules and the
// compiled server; Next does NOT copy public/ or .next/static into it, so we
// place them where server.js expects them. electron-builder then ships the
// whole tree via extraResources (standalone -> resources/app).
console.log('\n[desktop] copying static assets into the standalone tree');
fs.cpSync(path.join(ROOT, 'public'), path.join(standalone, 'public'), { recursive: true });
fs.cpSync(path.join(ROOT, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true });
fs.cpSync(path.join(ROOT, 'data'), path.join(standalone, 'data'), { recursive: true });

// package.json inside the standalone tree: electron-builder does not need it,
// but keeping "private" metadata out avoids confusion when inspecting the
// installed folder. Nothing at runtime reads it (the Next server does not).
console.log('[desktop] standalone tree ready\n');

// 3. electron-builder
// The `build` config in package.json maps standalone -> resources/app, so the
// executable finds server.js at resources/app/server.js with cwd resources/app.
run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never']);

console.log('\n[desktop] done — see dist-desktop/');
