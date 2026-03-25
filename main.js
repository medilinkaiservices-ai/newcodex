const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const fetch = require('node-fetch');
const { exec } = require('child_process');

// Load .env correctly (for dev + build)
const envPath = app.isPackaged 
  ? path.join(process.resourcesPath, '.env') 
  : path.join(__dirname, '.env');

require('dotenv').config({ path: envPath });

// Fix GPU/cache issues
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const SYSTEM_PROMPT = `
You are an AI coding agent.

Output ONLY in this format:

File: filename
\`\`\`language
code
\`\`\`

Rules:
- No explanation
- Multiple files allowed
- Always complete code
`;

const PLANNING_SYSTEM_PROMPT = `
You are a world-class software architect. Your task is to analyze the user's request and propose several implementation plans.

For the user's request, provide 2-3 distinct plans with a title, a short description, and a list of high-level steps for each.

Output ONLY a single valid JSON object in the following format. Do not add any other text.

{
  "plans": [
    {
      "title": "Plan A: Simple & Quick",
      "description": "A basic implementation using standard libraries.",
      "steps": ["Create file A.", "Add content to file A.", "Install dependency B."]
    },
    {
      "title": "Plan B: Advanced & Scalable",
      "description": "A more robust implementation using a popular framework.",
      "steps": ["Initialize a new project with framework X.", "Create component Y.", "Run the development server."]
    }
  ]
}
`;

// 🔥 GLOBAL STATE
let currentProjectDir = path.join(__dirname, 'generated'); // Default
let abortController = null; // For stopping AI

// Helper: Read all files recursively
function getProjectFiles(dir, fileList = [], rootDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');

    if (stat.isDirectory()) {
      fileList.push({
        name: relativePath,
        isDirectory: true
      });
      getProjectFiles(filePath, fileList, rootDir);
    } else {
      fileList.push({
        name: relativePath,
        content: fs.readFileSync(filePath, 'utf-8')
      });
    }
  });
  return fileList;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
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
  ipcMain.handle('send-prompt', async (event, prompt, model, contextData) => {
    abortController = new AbortController();
    try {
      // 🔥 SMART CONTEXT CONSTRUCTION
      let context = "";
      
      // 1. Add File Tree (always useful)
      if (contextData && contextData.fileTree && contextData.fileTree.length > 0) {
        context += "\n\n--- PROJECT STRUCTURE ---\n" + contextData.fileTree.join("\n");
      }

      // 2. Add Active File Content (only the one open)
      if (contextData && contextData.activeFileName && contextData.activeFileContent) {
        context += `\n\n--- ACTIVE FILE: ${contextData.activeFileName} ---\n\`\`\`\n${contextData.activeFileContent}\n\`\`\``;
      } else {
        context += "\n\n(No active file open in editor)";
      }

      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3',
          // If prompt starts with "YOU ARE NOW", it's Agent Mode (send raw history + context)
          prompt: prompt.startsWith("YOU ARE NOW") 
            ? context + "\n" + prompt 
            : SYSTEM_PROMPT + context + "\nUser: " + prompt,
          stream: false
        }),
        signal: abortController.signal
      });

      const data = await res.json();
      return data.response;

    } catch (err) {
      if (err.name === 'AbortError') return "⚠️ Generation stopped by user.";
      return "Error: Ollama not running!";
    } finally {
      abortController = null;
    }
  });
  
  // 🔥 GET PLAN HANDLER
  ipcMain.handle('get-plan', async (event, prompt, model) => {
    abortController = new AbortController();
    try {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3',
          prompt: PLANNING_SYSTEM_PROMPT + "\n\nUser Request: " + prompt,
          stream: false
        }),
        signal: abortController.signal
      });

      const data = await res.json();
      return data.response;
    } catch (err) {
      if (err.name === 'AbortError') return "⚠️ Generation stopped by user.";
      return "Error: Could not get a plan from Ollama.";
    } finally {
      abortController = null;
    }
  });

  // 🔥 STOP GENERATION
  ipcMain.handle('stop-generation', () => {
    if (abortController) abortController.abort();
    return true;
  });

  // 🔥 READ FILES HANDLER
  ipcMain.handle('read-files', async () => {
    if (!fs.existsSync(currentProjectDir)) fs.mkdirSync(currentProjectDir, { recursive: true });
    return getProjectFiles(currentProjectDir);
  });

  // 🔥 FILE CREATION HANDLER
  ipcMain.handle('create-files', async (event, files) => {
    if (!fs.existsSync(currentProjectDir)) {
      fs.mkdirSync(currentProjectDir, { recursive: true });
    }

    for (const file of files) {
      const filePath = path.join(currentProjectDir, file.name);
      const dir = path.dirname(filePath);
      
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, file.content);
    }

    return true;
  });

  // 🔥 OPEN FOLDER (EXPLORER)
  ipcMain.handle('open-folder', async () => {
    if (!fs.existsSync(currentProjectDir)) fs.mkdirSync(currentProjectDir, { recursive: true });
    await shell.openPath(currentProjectDir);
  });

  // 🔥 SELECT NEW PROJECT FOLDER
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      currentProjectDir = result.filePaths[0];
      return currentProjectDir;
    }
    return null;
  });

  // 🔥 CREATE FOLDER
  ipcMain.handle('create-folder', async (event, folderName) => {
    if (!fs.existsSync(currentProjectDir)) return false;
    const folderPath = path.join(currentProjectDir, folderName);
    try {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        return true;
      }
    } catch (e) { console.error(e); }
    return false;
  });

  // 🔥 RENAME FILE
  ipcMain.handle('rename-file', async (event, oldName, newName) => {
    if (!fs.existsSync(currentProjectDir)) return false;
    const oldPath = path.join(currentProjectDir, oldName);
    const newPath = path.join(currentProjectDir, newName);
    try {
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
        return true;
      }
    } catch (e) { console.error(e); }
    return false;
  });

  // 🔥 DELETE FILE
  ipcMain.handle('delete-file', async (event, filename) => {
    if (!fs.existsSync(currentProjectDir)) return false;
    const filePath = path.join(currentProjectDir, filename);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch (e) { console.error(e); }
    return false;
  });

  // 🔥 TERMINAL COMMAND HANDLER
  ipcMain.handle('run-command', async (event, command) => {
    if (!fs.existsSync(currentProjectDir)) fs.mkdirSync(currentProjectDir, { recursive: true });
    
    // DANGEROUS COMMAND CHECK
    const blockedCommands = ['rm', 'del', 'format', 'shutdown'];
    const blockedCommandRegex = new RegExp(`\\b(${blockedCommands.join('|')})\\b`, 'i');
    if (blockedCommandRegex.test(command)) {
      const match = command.match(blockedCommandRegex);
      return `Error: Command "${match[0]}" is blocked for safety.`;
    }
    
    return new Promise((resolve) => {
      // 🔥 SAFETY: Add maxBuffer to handle large outputs and timeout
      exec(command, { cwd: currentProjectDir, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        const output = stdout + (stderr ? `\nError: ${stderr}` : '');
        resolve(output);
      });
    });
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