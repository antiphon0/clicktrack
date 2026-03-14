const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clicktrack', {
  saveGame: (state) => ipcRenderer.invoke('save-game', state),
  loadGame: () => ipcRenderer.invoke('load-game'),
});
