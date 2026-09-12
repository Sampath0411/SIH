/**
 * Exposes nothing privileged; the web app talks to its server over HTTP on
 * loopback like it always did. Present so future desktop-only features have a
 * safe seam, and so contextIsolation stays configured from day one.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('aeroDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.AERO_DESKTOP_VERSION || '1.0.0',
});
