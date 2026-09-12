/**
 * AERO-VIEW desktop shell (Electron).
 *
 * The web app is unchanged. This process:
 *   1. starts the bundled Next.js standalone server (node app-bundle/server.js)
 *      on 127.0.0.1 with a fixed port;
 *   2. waits for the API to answer;
 *   3. opens a frameless-normal BrowserWindow pointed at it.
 *
 * Server-only secrets (DATABASE_URL, SESSION_SECRET) are passed in through the
 * environment, never written to disk inside the installation. NEXT_PUBLIC_*
 * values are baked into the client bundle at build time by `next build`.
 *
 * `ULPIN_EDITS_PATH` points the manual-edit store into the user's own data
 * directory, because the install directory is not writable.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BUNDLE_DIR =
  // Packaged: electron-builder copies app-bundle into resources/.
  (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app-bundle', 'server.js'))
    ? path.join(process.resourcesPath, 'app-bundle')
    : null)
  // Unpackaged dev run (`npx electron .` from desktop/, after npm run dir
  // or a manual assembly of desktop/app-bundle).
  || (fs.existsSync(path.join(__dirname, '..', 'app-bundle', 'server.js'))
    ? path.join(__dirname, '..', 'app-bundle')
    : null)
  || process.resourcesPath || __dirname;

// Window/taskbar icon. The exe's own icon comes from electron-builder via
// build/icon.ico; this is for the running window (and dev mode). The ICO works
// on Windows; the PNG is the fallback elsewhere.
const ICON_DIR = fs.existsSync(path.join(process.resourcesPath || '', 'app-bundle', 'icon.png'))
  ? path.join(process.resourcesPath, 'app-bundle')
  : path.join(__dirname, '..', 'build');
const WINDOW_ICON = path.join(ICON_DIR, 'icon.ico');
const WINDOW_ICON_PNG = path.join(ICON_DIR, 'icon-256.png');
const SERVER_JS = path.join(BUNDLE_DIR, 'server.js');
const HAS_BUNDLE = fs.existsSync(SERVER_JS);

const BASE_PORT = 47219;
const MAX_PORT_TRIES = 10;

let serverProcess = null;
let mainWindow = null;
let actualPort = null;

function pickEnv(port) {
  const env = { ...process.env };
  env.NODE_ENV = 'production';
  env.PORT = String(port);
  env.HOSTNAME = '127.0.0.1';
  delete env.ELECTRON_NO_ASAR;

  // Secrets come from the env file bundled beside the server (never inside the
  // installation's program files), or from the process env at dev time.
  if (HAS_BUNDLE) {
    const envFile = path.join(BUNDLE_DIR, 'server.env');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && env[m[1]] === undefined) env[m[1]] = m[2];
      }
    }
  }

  // Manual edits must land somewhere writable. The store keeps a per-project
  // file under this directory, so give the app its own home.
  try {
    const userData = app.getPath('userData');
    const editsDir = path.join(userData, 'edits');
    fs.mkdirSync(editsDir, { recursive: true });
    env.ULPIN_EDITS_PATH = editsDir;
  } catch { /* keep the default if userData is unavailable */ }

  // Electron injects defaults that confuse Node child processes.
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}

function startServer(port, onReady, onFatal) {
  const env = pickEnv(port);
  const nodeExe = process.execPath; // Electron binary doubles as Node with ELECTRON_RUN_AS_NODE
  // Next's standalone server.js takes no CLI flags: PORT and HOSTNAME come
  // from the environment, which pickEnv sets.
  serverProcess = spawn(
    nodeExe,
    [SERVER_JS],
    {
      cwd: BUNDLE_DIR,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stderrTail = '';
  serverProcess.stderr.on('data', (d) => {
    stderrTail = (stderrTail + String(d)).slice(-4000);
    process.env.ULPIN_DEBUG && process.stderr.write(d);
  });
  serverProcess.stdout.on('data', (d) => {
    process.env.ULPIN_DEBUG && process.stdout.write(d);
  });

  serverProcess.on('error', (err) => onFatal(`server failed to start: ${err}`));
  serverProcess.on('exit', (code) => {
    if (code && code !== 0) onFatal(`server exited with code ${code}\n${stderrTail}`);
  });

  waitForServer(port, 30000)
    .then(() => onReady(port))
    .catch((err) => onFatal(err.message));
}

function waitForServer(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/projects', timeout: 2500 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve();
          else retry('unhealthy');
        },
      );
      req.on('timeout', () => { req.destroy(); retry('timeout'); });
      req.on('error', (e) => retry(e.message));
    };
    const retry = (why) => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`server on port ${port} did not become healthy (${why})`));
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function createWindow(port) {
  const iconFile = fs.existsSync(WINDOW_ICON) ? WINDOW_ICON
    : fs.existsSync(WINDOW_ICON_PNG) ? WINDOW_ICON_PNG : undefined;
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 640,
    icon: iconFile,
    backgroundColor: '#0d1219',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the user's browser, not a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

function boot() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (!HAS_BUNDLE) {
      dialog.showErrorBox(
        'AERO-VIEW',
        'The server bundle is missing (app-bundle). '
        + 'Build it with: cd desktop && npm run pack',
      );
      app.quit();
      return;
    }

    // Try BASE_PORT, then the next few, in case another copy is mid-shutdown.
    let tries = 0;
    const tryPort = (port) => {
      startServer(
        port,
        (p) => { actualPort = p; createWindow(p); },
        (msg) => {
          dialog.showErrorBox('AERO-VIEW — server error', msg);
          app.quit();
        },
      );
    };
    const portProbe = (port) => {
      const probe = http.createServer();
      probe.once('error', () => {
        tries += 1;
        if (tries < MAX_PORT_TRIES) portProbe(port + 1);
        else portProbe(port); // let the server itself report the failure
      });
      probe.once('listening', () => probe.close(() => tryPort(port)));
      probe.listen(port, '127.0.0.1');
    };
    portProbe(BASE_PORT);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (serverProcess) {
      try { serverProcess.kill(); } catch { /* already gone */ }
    }
  });
}

boot();
