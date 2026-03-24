const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config();

// Fix for GPU/Cache creation errors on Windows
app.disableHardwareAcceleration();

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {

  ipcMain.handle('send-prompt', async (event, prompt) => {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();

    } catch (err) {
      return "Error: " + err.message;
    }
  });

  createWindow();

});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});