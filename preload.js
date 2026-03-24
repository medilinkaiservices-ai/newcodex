const { ipcRenderer } = require('electron');

window.electronAPI = {
  sendPrompt: (prompt, model) => ipcRenderer.invoke('send-prompt', prompt, model),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  restartApp: () => ipcRenderer.send('restart-app'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  }
};