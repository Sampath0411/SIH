// ---------------------------------------------------------------------------
// Electron main process for the ULPIN 3D / AERO-VIEW desktop app.
//
// One child process runs the Next.js standalone server (`server.js` from the
// `next build` standalone output) on a loopback port; the BrowserWindow loads
// http://127.0.0.1:<port>/ and nothing else.
//
// Resource paths: the packaged app is
//   <install>/AERO-VIEW.exe            (Electron)
//   <install>/resources/app.asar       (main process + node_modules)
//   <install>/resources/app/           (unpacked: Next standalone server,
//                                       public/, .next/static, data/)
//
// The Next server lives OUTSIDE the asar so Node's require() of server.js,
// Cesium's asset copies in public/, and lib/*'s process.cwd()-relative reads
// of data/ all resolve against real files on disk.
//
// In dev (npm run desktop) ELECTRON_START_URL is unset and we spawn
// `next dev` from PROJECT_ROOT, then wait for it to answer on :3000.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const isDev = !app.isPackaged;
const PROJECT_ROOT = isDev
  ? path.join(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

// Window/taskbar icon. electron-builder embeds the same .ico into the exe,
// but the BrowserWindow still needs an explicit icon for the taskbar and the
// title-bar in dev (where the exe resource is not involved). electron-builder
// copies build-res/ into <install>/resources/, so the packaged path resolves
// there; dev resolves it in the working tree.
const WINDOW_ICON = isDev
  ? path.join(PROJECT_ROOT, 'build-res', 'aeroview.ico')
  : path.join(process.resourcesPath, 'aeroview.ico');

// Writable state lives in %APPDATA%/AERO-VIEW, never in the install folder:
//  * desktop-env.json keeps a per-install SESSION_SECRET. lib/auth/session.ts
//    throws in production when SESSION_SECRET is unset, and the key must be
//    stable across restarts or every login loops back to /login.
//  * ULPIN_EDITS_PATH redirects lib/data/edits.ts (the only runtime writer)
//    so viewer edits survive under a normal user account even when the app
//    is installed to the read-only Program Files directory.
function ensureDesktopEnv() {
  const userData = app.getPath('userData');
  const envPath = path.join(userData, 'desktop-env.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    // first run or unreadable: regenerate below
  }
  if (!stored.SESSION_SECRET || stored.SESSION_SECRET.length < 32) {
    stored.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(envPath, JSON.stringify(stored, null, 2));
  }
  return {
    SESSION_SECRET: stored.SESSION_SECRET,
    ULPIN_EDITS_PATH: path.join(userData, 'edits'),
  };
}

const STANDALONE_DIR = path.join(PROJECT_ROOT, 'standalone');
const SERVER_ENTRY = path.join(STANDALONE_DIR, 'server.js');

// Standalone server.js resolves its dist dir relative to process.cwd(), and
// lib/* resolves data/ the same way, so the child is spawned with cwd at the
// standalone root rather than relying on __dirname.
const CHILD_CWD = STANDALONE_DIR;

let win = null;
let serverProcess = null;
let quitting = false;
let desktopEnv = {};

const PORT = 34567; // fixed loopback port; nothing else is bound to it

function spawnNextDev() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));
  child.on('exit', (code) => {
    log(`next dev exited with code ${code}`);
    if (!quitting) {
      log('attempting restart in 2s');
      setTimeout(() => {
        serverProcess = spawnNextDev();
      }, 2000);
    }
  });
  return child;
}

function spawnStandalone() {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: CHILD_CWD,
    env: {
      ...process.env,
      ...desktopEnv,
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));
  child.on('exit', (code) => {
    log(`standalone server exited with code ${code}`);
    if (!quitting) {
      log('attempting restart in 2s');
      setTimeout(() => {
        serverProcess = spawnStandalone();
      }, 2000);
    }
  });
  return child;
}

function log(msg) {
  console.log(`[ulpin-desktop] ${msg}`);
}

function waitForServer(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 1500 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`server did not come up on :${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
      req.on('timeout', () => {
        req.destroy();
      });
    };
    tryOnce();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0f1c',
    title: 'AERO-VIEW',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require('electron') only; sandbox stays off for Cesium's big heap
    },
  });

  win.once('ready-to-show', () => win.show());

  // Open target=_blank / window.open in the user's default browser, not a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // keep the app shell pointed at the local server
    if (
      !url.startsWith(`http://127.0.0.1:${PORT}`) &&
      !url.startsWith(`http://localhost:${PORT}`)
    ) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const startUrl =
    process.env.ELECTRON_START_URL || `http://127.0.0.1:${PORT}/`;
  win.loadURL(startUrl);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} ${url} — retrying in 2s`);
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(startUrl).catch(() => {});
    }, 2000);
  });

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ])
  );

  log(`isDev=${isDev} PROJECT_ROOT=${PROJECT_ROOT}`);

  if (!isDev) {
    desktopEnv = ensureDesktopEnv();
  }

  if (isDev) {
    serverProcess = spawnNextDev();
  } else {
    if (!fs.existsSync(SERVER_ENTRY)) {
      log(`FATAL: standalone server not found at ${SERVER_ENTRY}`);
      app.quit();
      return;
    }
    serverProcess = spawnStandalone();
  }

  try {
    await waitForServer(PORT, 30000);
  } catch (err) {
    log(`server wait failed: ${err.message}`);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  quitting = true;
  app.quit();
});

app.on('quit', () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // already gone
    }
  }
});

process.on('exit', () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // already gone
    }
  }
});
