# AERO-VIEW — Windows Desktop App

The 3D ULPIN web app packaged as a native Windows application (Electron).
No browser needed — double-click and the app opens in its own window.

Everything the desktop app needs lives in this `desktop/` folder; the web app
at the repo root stays a plain Next.js site (that is what Vercel deploys).

## Layout

| Path | What it is |
|---|---|
| `electron/main.js`, `electron/preload.js` | The Electron shell (server bootstrap, window) |
| `scripts/build-desktop.js` | Builds the Next app at the repo root, assembles `app-bundle/`, runs electron-builder |
| `scripts/afterPack.js` | electron-builder hook: carries the server `node_modules` into the output |
| `scripts/make-icons.mjs` | Regenerates `build/icon.*` from the web app's `app/icon.svg` |
| `build/icon.ico` | The exe/installer icon (auto-picked-up by electron-builder) |
| `dist/` | Build output (gitignored) |
| `app-bundle/` | Assembled standalone server (gitignored, created by the build) |

## What was produced

| File | What it is |
|---|---|
| `desktop/dist/AERO-VIEW-Setup-1.0.0.exe` | **Installer** — Start-menu shortcut, uninstaller, optional install directory |
| `desktop/dist/AERO-VIEW-Portable-1.0.0.exe` | **Portable** — single exe, runs from anywhere (USB stick etc.), nothing installed |
| `desktop/dist/win-unpacked/AERO-VIEW.exe` | Unpacked build (same thing, as a folder) |

Both exes are ~131 MB and self-contained: Electron runtime + Next.js standalone
server + the committed data snapshots. Internet is only needed for the map
imagery/terrain tiles; the cadastre itself works fully offline.

## How it works

1. The Electron main process (`desktop/electron/main.js`) starts the bundled
   Next standalone server on `127.0.0.1:47219` (falls back to the next few
   ports).
2. Server-only secrets (`SESSION_SECRET`, `DATABASE_URL`) are passed to it from
   `resources/app-bundle/server.env` — they are not baked into the exe.
3. It waits for `GET /api/projects` to answer, then opens a window on the app.
4. Manual edits (the building-edit feature) are written under
   `%APPDATA%/AERO-VIEW/edits/` because the install directory is not writable.

## Logins (demo data, committed in the repo)

- Government: `admin@sampath.gov.in` / `ulpin-gov-2026`
- Citizens (Siripuram): `111122223333 / 9876543210` (Ravi Kumar, Flat 201),
  `222233334444 / 9876543211` (Priya Sharma, Flat 502),
  `333344445555 / 9876543212` (Anand Rao, Flat 903)

## Rebuilding from source

```bash
# from the repo root — install web deps and prepare Cesium assets
npm install

# one-time: desktop toolchain (Electron + electron-builder, isolated here)
cd desktop && npm install && cd ..

# build installers + portable exe -> desktop/dist/
cd desktop && npm run pack
```

`npm run dir` (inside desktop/) skips the installers and only produces
`desktop/dist/win-unpacked/`. `npm run icons` regenerates the icon files from
the web app's `app/icon.svg`.

## Notes

- The database (Neon PostGIS) is optional: if unreachable, the server serves
  the committed snapshots in `data/api/`, so the app always works.
- `vercel build` output was NOT used — it lacks server route files. The app is
  built locally with `next build` (standalone output) instead.
- The demo credentials block on `/login` is shown because `.env.local` keeps
  the app in its demonstration configuration; remove it for a public release.
