const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  print: () => ipcRenderer.invoke('print'),
  setTitle: (t) => ipcRenderer.invoke('set-title', t),
  readWasm: () => ipcRenderer.invoke('read-wasm'),
  readFont: (fontFile, drawingPath) => ipcRenderer.invoke('read-font', fontFile, drawingPath),
  readXref: (xrefPath, hostPath) => ipcRenderer.invoke('read-xref', xrefPath, hostPath),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  on: (channel, fn) => {
    const allowed = ['file-opened', 'before-print', 'after-print', 'zoom-in', 'zoom-out', 'zoom-fit', 'toggle-bg',
      'toggle-guides', 'toggle-lineweights', 'close-tab', 'next-tab', 'prev-tab'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
