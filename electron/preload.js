// Electron preload: the page gets a small, explicit surface area and nothing
// else. No Node, no remote, no ipcRenderer — the web app already runs fine in
// a plain browser, so the shell only adds platform info and a server-death
// event the window can listen for if the child process dies.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ulpinDesktop', {
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
  isDesktop: true,
  version: process.versions.electron,
  onServerDown: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('ulpin:server-down', handler);
    return () => ipcRenderer.removeListener('ulpin:server-down', handler);
  },
});
