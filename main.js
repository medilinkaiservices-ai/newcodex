const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const fetch = require('node-fetch');

const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');

require('dotenv').config({ path: envPath });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const DEFAULT_PROJECT_DIR = path.join(__dirname, 'generated');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `
You are NewCodex, an autonomous coding agent that behaves like a senior software engineer.

Core behavior:
- act like a hands-on coding agent, not a generic chatbot
- do not say you cannot read files, inspect the project, or create files when project context or tools are available
- assume you can inspect files, propose edits, create files, and suggest commands unless the user explicitly blocks that
- if context is missing, ask for the smallest missing detail or make a reasonable assumption and state it briefly
- prefer concrete progress over refusal language
- behave like Codex: inspect, plan, modify, verify, and continue
- for large tasks, break the work into smaller milestones and handle them one by one
- keep momentum: if one path fails, try another reasonable path before giving up
- use previous mistakes and workspace memory to avoid repeating the same failure
- read the project before making sweeping changes
- when the request is broad, start with architecture, scaffolding, then implementation slices
- treat debugging as iterative: inspect, patch, rerun, and continue
- support both Telugu and English naturally based on the user's language
- keep useful offline memory so the system can continue helping even without internet access
- you may suggest new tools or workflow improvements, but any app-level self-improvement that changes behavior or updates the app must be proposed first and requires user approval

When the user asks for implementation work:
- inspect existing project context first
- prefer editing existing files over replacing the whole project
- create or update multiple files when needed
- when useful, include shell commands to run, but keep them safe and finite
- if the task is big, propose a phased plan internally and then begin with the highest-value slice
- do not refuse just because the task is large; reduce it into solvable parts

When you emit files, use ONLY this format:

File: relative/path.ext
\`\`\`language
code
\`\`\`

You may include multiple files in one answer.
`;

const PLANNING_SYSTEM_PROMPT = `
You are a world-class software architect. Analyze the user request and produce 2-3 implementation plans.
For big tasks, split them into small, realistic milestones that can be executed incrementally.
Bias toward plans that can keep shipping progress even if some details are still unknown.

Output ONLY a single valid JSON object in this format:
{
  "plans": [
    {
      "title": "Plan name",
      "description": "Short description",
      "steps": ["Step one", "Step two"]
    }
  ]
}
`;

let currentProjectDir = DEFAULT_PROJECT_DIR;
let abortController = null;

function getMemoryFilePath() {
  ensureProjectDir();
  return path.join(currentProjectDir, '.newcodex-memory.json');
}

function readMemory() {
  try {
    const filePath = getMemoryFilePath();
    if (!fs.existsSync(filePath)) {
      return {
        summary: '',
        preferences: [],
        recentTasks: [],
        mistakesToAvoid: [],
        taskQueue: [],
        successfulPatterns: [],
        knowledgeNotes: []
      };
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      summary: '',
      preferences: [],
      recentTasks: [],
      mistakesToAvoid: [],
      taskQueue: [],
      successfulPatterns: [],
      knowledgeNotes: []
    };
  }
}

function writeMemory(memory) {
  fs.writeFileSync(getMemoryFilePath(), JSON.stringify(memory, null, 2), 'utf-8');
}

function ensureProjectDir() {
  if (!fs.existsSync(currentProjectDir)) {
    fs.mkdirSync(currentProjectDir, { recursive: true });
  }
}

function toRelativeProjectPath(targetPath) {
  return path.relative(currentProjectDir, targetPath).replace(/\\/g, '/');
}

function resolveProjectPath(relativePath = '') {
  const normalized = relativePath.replace(/\//g, path.sep);
  const fullPath = path.resolve(currentProjectDir, normalized);
  const projectRoot = path.resolve(currentProjectDir);
  if (!fullPath.startsWith(projectRoot)) {
    throw new Error('Path escapes current project directory.');
  }
  return fullPath;
}

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return '';
  }
}

function getProjectFiles(dir, fileList = [], rootDir = dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const entryPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, entryPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      fileList.push({
        name: relativePath,
        isDirectory: true
      });
      getProjectFiles(entryPath, fileList, rootDir);
      return;
    }

    fileList.push({
      name: relativePath,
      content: readTextFileSafe(entryPath)
    });
  });

  return fileList;
}

function getProjectSummary() {
  ensureProjectDir();
  const files = getProjectFiles(currentProjectDir);
  const fileNames = files.filter((file) => !file.isDirectory).map((file) => file.name);
  const packageJson = files.find((file) => file.name === 'package.json');

  let summary = {
    root: currentProjectDir,
    fileCount: fileNames.length,
    hasPackageJson: Boolean(packageJson),
    likelyType: 'generic',
    keyFiles: fileNames.slice(0, 20),
    verificationCommands: []
  };

  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content);
      summary.packageName = pkg.name || '';
      summary.scripts = Object.keys(pkg.scripts || {});
      if (pkg.dependencies?.electron || pkg.devDependencies?.electron) {
        summary.likelyType = 'electron';
      } else if (pkg.dependencies?.react || pkg.dependencies?.next) {
        summary.likelyType = 'webapp';
      } else {
        summary.likelyType = 'node';
      }

      if (pkg.scripts?.test) summary.verificationCommands.push('npm test');
      if (pkg.scripts?.build) summary.verificationCommands.push('npm run build');
      if (pkg.scripts?.lint) summary.verificationCommands.push('npm run lint');
    } catch (error) {
      // ignore parse failure
    }
  } else if (fileNames.includes('requirements.txt')) {
    summary.likelyType = 'python';
    summary.verificationCommands.push('python -m pytest');
  } else if (fileNames.includes('index.html')) {
    summary.likelyType = 'static-web';
  }

  if (!summary.verificationCommands.length) {
    summary.verificationCommands = ['git status'];
  }

  return summary;
}

async function readWebPage(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'NewCodex/1.0'
    },
    signal: abortController?.signal
  });

  if (!response.ok) {
    throw new Error(`Web request failed (${response.status})`);
  }

  const html = await response.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 12000);
}

function buildContext(contextData = {}) {
  let context = `\n\n--- CURRENT PROJECT ---\n${currentProjectDir}`;
  const memory = readMemory();

  if (memory.summary) {
    context += `\n\n--- WORKSPACE MEMORY ---\n${memory.summary}`;
  }

  if (memory.preferences?.length) {
    context += `\n\n--- USER PREFERENCES ---\n${memory.preferences.join('\n')}`;
  }

  if (memory.recentTasks?.length) {
    context += `\n\n--- RECENT TASKS ---\n${memory.recentTasks.join('\n')}`;
  }

  if (memory.mistakesToAvoid?.length) {
    context += `\n\n--- MISTAKES TO AVOID ---\n${memory.mistakesToAvoid.join('\n')}`;
  }

  if (memory.successfulPatterns?.length) {
    context += `\n\n--- SUCCESSFUL PATTERNS ---\n${memory.successfulPatterns.join('\n')}`;
  }

  if (memory.knowledgeNotes?.length) {
    context += `\n\n--- KNOWLEDGE NOTES ---\n${memory.knowledgeNotes.join('\n')}`;
  }

  if (contextData.fileTree && contextData.fileTree.length) {
    context += `\n\n--- PROJECT STRUCTURE ---\n${contextData.fileTree.join('\n')}`;
  }

  if (contextData.activeFileName && typeof contextData.activeFileContent === 'string') {
    context += `\n\n--- ACTIVE FILE: ${contextData.activeFileName} ---\n\`\`\`\n${contextData.activeFileContent}\n\`\`\``;
  }

  if (contextData.images && contextData.images.length) {
    context += `\n\n--- ATTACHED IMAGES ---\n${contextData.images.length} image attachment(s) were provided. Use them when relevant.`;
  }

  if (contextData.chatHistory && contextData.chatHistory.length) {
    context += `\n\n--- RECENT CHAT HISTORY ---\n${contextData.chatHistory
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join('\n\n')}`;
  }

  return context;
}

async function callOllama(prompt, model) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3',
      prompt,
      stream: false
    }),
    signal: abortController?.signal
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status})`);
  }

  const data = await response.json();
  return data.response || '';
}

function imagePartsFromContext(contextData = {}) {
  const images = contextData.images || [];
  return images
    .filter((image) => image && image.dataUrl && image.mimeType)
    .map((image) => {
      const base64 = image.dataUrl.split(',')[1] || '';
      return {
        inlineData: {
          mimeType: image.mimeType,
          data: base64
        }
      };
    });
}

async function callGemini(prompt, contextData = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY.');
  }

  const parts = [{ text: prompt }, ...imagePartsFromContext(contextData)];

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        temperature: 0.2
      }
    }),
    signal: abortController?.signal
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status})`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

async function generateWithProvider({ prompt, model, contextData, planningMode = false }) {
  const context = buildContext(contextData);
  const providerModel = model || 'auto';
  const basePrompt = planningMode
    ? `${PLANNING_SYSTEM_PROMPT}\n\nUser Request: ${prompt}`
    : `${SYSTEM_PROMPT}${context}\n\nUser: ${prompt}`;

  const tryGemini = providerModel === 'auto' || providerModel.startsWith('gemini');
  const tryOllama = providerModel === 'auto' || providerModel.startsWith('ollama') || (!providerModel.startsWith('gemini') && providerModel !== 'auto');

  const errors = [];

  if (tryGemini) {
    try {
      return {
        provider: 'gemini',
        response: await callGemini(basePrompt, contextData)
      };
    } catch (error) {
      errors.push(`Gemini: ${error.message}`);
    }
  }

  if (tryOllama) {
    try {
      const ollamaModel = providerModel.startsWith('ollama:')
        ? providerModel.replace('ollama:', '')
        : providerModel === 'auto' || providerModel.startsWith('gemini')
          ? 'llama3'
          : providerModel;

      return {
        provider: 'ollama',
        response: await callOllama(
          contextData?.images?.length
            ? `${basePrompt}\n\nNote: ${contextData.images.length} image attachment(s) were provided, but Ollama text fallback may not inspect them directly.`
            : basePrompt,
          ollamaModel
        )
      };
    } catch (error) {
      errors.push(`Ollama: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | ') || 'No provider available.');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1100,
    minHeight: 760,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

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

function runShellCommand(command) {
  ensureProjectDir();

  const blockedPatterns = [
    /\brm\s+-rf\b/i,
    /\bdel\s+\/f\b/i,
    /\bformat\b/i,
    /\bshutdown\b/i
  ];

  const blocked = blockedPatterns.find((pattern) => pattern.test(command));
  if (blocked) {
    return Promise.resolve('Error: That command is blocked for safety.');
  }

  return new Promise((resolve) => {
    exec(command, {
      cwd: currentProjectDir,
      shell: 'powershell.exe',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8
    }, (error, stdout, stderr) => {
      const parts = [];
      if (stdout) {
        parts.push(stdout.trimEnd());
      }
      if (stderr) {
        parts.push(stderr.trimEnd());
      }
      if (error && !stderr) {
        parts.push(error.message);
      }
      resolve(parts.join('\n') || '[command completed with no output]');
    });
  });
}

app.whenReady().then(() => {
  ensureProjectDir();

  ipcMain.handle('send-prompt', async (event, prompt, model, contextData) => {
    abortController = new AbortController();
    try {
      return await generateWithProvider({ prompt, model, contextData });
    } catch (error) {
      if (error.name === 'AbortError') {
        return { provider: 'system', response: 'Generation stopped by user.' };
      }
      return { provider: 'system', response: `Provider error: ${error.message}` };
    } finally {
      abortController = null;
    }
  });

  ipcMain.handle('get-plan', async (event, prompt, model, contextData) => {
    abortController = new AbortController();
    try {
      return await generateWithProvider({ prompt, model, contextData, planningMode: true });
    } catch (error) {
      if (error.name === 'AbortError') {
        return { provider: 'system', response: 'Generation stopped by user.' };
      }
      return { provider: 'system', response: `Plan error: ${error.message}` };
    } finally {
      abortController = null;
    }
  });

  ipcMain.handle('stop-generation', () => {
    if (abortController) {
      abortController.abort();
    }
    return true;
  });

  ipcMain.handle('read-files', async () => {
    ensureProjectDir();
    return getProjectFiles(currentProjectDir);
  });

  ipcMain.handle('read-file', async (event, fileName) => {
    const filePath = resolveProjectPath(fileName);
    return readTextFileSafe(filePath);
  });

  ipcMain.handle('create-files', async (event, files) => {
    ensureProjectDir();
    for (const file of files) {
      const filePath = resolveProjectPath(file.name);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, file.content ?? '', 'utf-8');
    }
    return true;
  });

  ipcMain.handle('open-folder', async () => {
    ensureProjectDir();
    await shell.openPath(currentProjectDir);
    return true;
  });

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

  ipcMain.handle('get-project-state', async () => ({
    currentProjectDir,
    providerMode: GEMINI_API_KEY ? 'gemini+ollama' : 'ollama',
    memory: readMemory(),
    projectSummary: getProjectSummary()
  }));

  ipcMain.handle('get-project-summary', async () => getProjectSummary());

  ipcMain.handle('update-memory', async (event, patch) => {
    const current = readMemory();
    const next = {
      summary: patch.summary ?? current.summary ?? '',
      preferences: Array.isArray(patch.preferences) ? patch.preferences.slice(0, 20) : current.preferences ?? [],
      recentTasks: Array.isArray(patch.recentTasks) ? patch.recentTasks.slice(-20) : current.recentTasks ?? [],
      mistakesToAvoid: Array.isArray(patch.mistakesToAvoid) ? patch.mistakesToAvoid.slice(-20) : current.mistakesToAvoid ?? [],
      taskQueue: Array.isArray(patch.taskQueue) ? patch.taskQueue.slice(-100) : current.taskQueue ?? [],
      successfulPatterns: Array.isArray(patch.successfulPatterns) ? patch.successfulPatterns.slice(-30) : current.successfulPatterns ?? [],
      knowledgeNotes: Array.isArray(patch.knowledgeNotes) ? patch.knowledgeNotes.slice(-40) : current.knowledgeNotes ?? []
    };
    writeMemory(next);
    return next;
  });

  ipcMain.handle('get-preview-url', async () => {
    ensureProjectDir();
    const candidates = ['index.html', 'dist/index.html', 'build/index.html'];

    for (const candidate of candidates) {
      const candidatePath = resolveProjectPath(candidate);
      if (fs.existsSync(candidatePath)) {
        return `${pathToFileURL(candidatePath).href}?t=${Date.now()}`;
      }
    }

    return null;
  });

  ipcMain.handle('clone-repository', async (event, repoUrl) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return { ok: false, message: 'Clone canceled.' };
    }

    const parentDir = result.filePaths[0];
    const repoName = repoUrl.split('/').pop().replace(/\.git$/, '') || 'repository';
    const targetDir = path.join(parentDir, repoName);
    const output = await new Promise((resolve) => {
      exec(`git clone ${repoUrl}`, {
        cwd: parentDir,
        shell: 'powershell.exe',
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 8
      }, (error, stdout, stderr) => {
        resolve((stdout || '') + (stderr ? `\n${stderr}` : '') + (error && !stderr ? `\n${error.message}` : ''));
      });
    });

    if (fs.existsSync(targetDir)) {
      currentProjectDir = targetDir;
      return { ok: true, message: output || 'Repository cloned.', path: targetDir };
    }

    return { ok: false, message: output || 'Clone failed.' };
  });

  ipcMain.handle('create-folder', async (event, folderName) => {
    const folderPath = resolveProjectPath(folderName);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      return true;
    }
    return false;
  });

  ipcMain.handle('rename-file', async (event, oldName, newName) => {
    const oldPath = resolveProjectPath(oldName);
    const newPath = resolveProjectPath(newName);
    if (!fs.existsSync(oldPath)) {
      return false;
    }
    fs.renameSync(oldPath, newPath);
    return true;
  });

  ipcMain.handle('delete-file', async (event, fileName) => {
    const filePath = resolveProjectPath(fileName);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    return true;
  });

  ipcMain.handle('run-command', async (event, command) => runShellCommand(command));

  ipcMain.handle('run-command-batch', async (event, commands) => {
    const outputs = [];
    for (const command of commands) {
      outputs.push({
        command,
        output: await runShellCommand(command)
      });
    }
    return outputs;
  });

  ipcMain.handle('list-tool-presets', async () => ([
    { id: 'git-status', label: 'Git Status', command: 'git status' },
    { id: 'git-push', label: 'Git Push', command: 'git add .; git commit -m "Update from NewCodex"; git push' },
    { id: 'npm-test', label: 'Run Tests', command: 'npm test' },
    { id: 'firebase-emulators', label: 'Firebase Emulators', command: 'firebase emulators:start' },
    { id: 'firestore-indexes', label: 'Deploy Firestore Indexes', command: 'npx firebase-tools deploy --only firestore:indexes' }
  ]));

  ipcMain.handle('read-web-page', async (event, url) => {
    try {
      return {
        ok: true,
        url,
        content: await readWebPage(url)
      };
    } catch (error) {
      return {
        ok: false,
        url,
        content: error.message
      };
    }
  });

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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
