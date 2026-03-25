const { ipcRenderer } = require('electron');

window.electronAPI = {
  sendPrompt: (prompt, model, contextData) => ipcRenderer.invoke('send-prompt', prompt, model, contextData),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getPlan: (prompt, model) => ipcRenderer.invoke('get-plan', prompt, model),
  createFiles: (files) => ipcRenderer.invoke('create-files', files),
  readFiles: () => ipcRenderer.invoke('read-files'),
  readFile: (fileName) => ipcRenderer.invoke('read-file', fileName),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  restartApp: () => ipcRenderer.send('restart-app'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getProjectState: () => ipcRenderer.invoke('get-project-state'),
  getProjectSummary: () => ipcRenderer.invoke('get-project-summary'),
  updateMemory: (patch) => ipcRenderer.invoke('update-memory', patch),
  getPreviewUrl: () => ipcRenderer.invoke('get-preview-url'),
  cloneRepository: (repoUrl) => ipcRenderer.invoke('clone-repository', repoUrl),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
  runCommand: (command) => ipcRenderer.invoke('run-command', command),
  runCommandBatch: (commands) => ipcRenderer.invoke('run-command-batch', commands),
  readWebPage: (url) => ipcRenderer.invoke('read-web-page', url),
  listToolPresets: () => ipcRenderer.invoke('list-tool-presets'),
  renameFile: (oldName, newName) => ipcRenderer.invoke('rename-file', oldName, newName),
  deleteFile: (filename) => ipcRenderer.invoke('delete-file', filename),
  createFolder: (folderName) => ipcRenderer.invoke('create-folder', folderName)
};
