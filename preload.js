const { ipcRenderer } = require('electron');

window.electronAPI = {
  sendPrompt: (prompt, model, contextData) => ipcRenderer.invoke('send-prompt', prompt, model, contextData),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getPlan: (prompt, model) => ipcRenderer.invoke('get-plan', prompt, model),
  createFiles: (files) => ipcRenderer.invoke('create-files', files),
  readFiles: () => ipcRenderer.invoke('read-files'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  restartApp: () => ipcRenderer.send('restart-app'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
  runCommand: (command) => ipcRenderer.invoke('run-command', command),
  renameFile: (oldName, newName) => ipcRenderer.invoke('rename-file', oldName, newName),
  deleteFile: (filename) => ipcRenderer.invoke('delete-file', filename),
  createFolder: (folderName) => ipcRenderer.invoke('create-folder', folderName)
};