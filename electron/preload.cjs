'use strict';
/**
 * Preload：向渲染进程暴露最小 API
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kkApp', {
  selftest: () => ipcRenderer.invoke('selftest'),
  discover: () => ipcRenderer.invoke('discover'),
  inspectAppstate: (p) => ipcRenderer.invoke('inspect-appstate', p),
  listEdbs: (dir) => ipcRenderer.invoke('list-edbs', dir),
  pickFile: (opts) => ipcRenderer.invoke('pick-file', opts),
  readTextFile: (p) => ipcRenderer.invoke('read-text-file', p),
  parseKeysJson: (text) => ipcRenderer.invoke('parse-keys-json', text),
  unwrapWithRoot: (opts) => ipcRenderer.invoke('unwrap-with-root', opts),
  decryptAccount: (opts) => ipcRenderer.invoke('decrypt-account', opts),
  findRootStart: (opts) => ipcRenderer.invoke('find-root-start', opts),
  findRootStop: () => ipcRenderer.invoke('find-root-stop'),
  runAuto: (opts) => ipcRenderer.invoke('run-auto', opts || {}),
  resolveMedia: (opts) => ipcRenderer.invoke('resolve-media', opts || {}),

  onDecryptProgress: (cb) => {
    ipcRenderer.removeAllListeners('decrypt-progress');
    ipcRenderer.on('decrypt-progress', (_e, d) => cb(d));
  },
  onFindRootProgress: (cb) => {
    ipcRenderer.removeAllListeners('find-root-progress');
    ipcRenderer.on('find-root-progress', (_e, d) => cb(d));
  },
  onFindRootDone: (cb) => {
    ipcRenderer.removeAllListeners('find-root-done');
    ipcRenderer.on('find-root-done', (_e, d) => cb(d));
  },
  onAutoProgress: (cb) => {
    ipcRenderer.removeAllListeners('auto-progress');
    ipcRenderer.on('auto-progress', (_e, d) => cb(d));
  },
});
