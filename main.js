const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const fetch = require('node-fetch');

// Load .env correctly (for dev + build)
const envPath = app.isPackaged 
  ? path.join(process.resourcesPath, '.env') 
  : path.join(__dirname, '.env');

require('dotenv').config({ path: envPath });

// Fix GPU/cache issues
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }
  });

  win.loadFile('index.html');

  // Auto update events
  autoUpdater.on('update-available', () => {
    win.webContents.send('update-status', { status: 'available' });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    win.webContents.send('update-status', { 
      status: 'progress', 
      percent: progressObj.percent 
    });
  });

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update-status', { status: 'downloaded' });
  });

  autoUpdater.on('update-not-available', () => {
    win.webContents.send('update-status', { status: 'not-available' });
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

app.whenReady().then(() => {

  // 🔥 MAIN CHANGE → Gemini ❌ → Ollama ✅
  ipcMain.handle('send-prompt', async (event, prompt, model) => {
    try {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3',
          prompt: prompt,
          stream: false
        })
      });

      const data = await res.json();
      return data.response;

    } catch (err) {
      return "Error: Ollama not running!";
    }
  });

  // Update check
  ipcMain.handle('check-for-updates', () => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });

  ipcMain.on('restart-app', () => {
    autoUpdater.quitAndInstall();
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});