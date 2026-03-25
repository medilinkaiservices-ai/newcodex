const marked = require('marked');
const hljs = require('highlight.js');
const { desktopCapturer } = require('electron');

const markdownRenderer = new marked.Renderer();
markdownRenderer.code = (code, lang) => {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(code, {
    language,
    ignoreIllegals: true
  }).value;

  return `
    <div class="code-block">
      <div class="code-header">
        <span class="lang-label">${lang || 'code'}</span>
        <div class="code-actions">
          <button class="run-btn">Run</button>
          <button class="diff-btn">Diff</button>
          <button class="save-btn">Save</button>
          <button class="copy-btn">Copy</button>
        </div>
      </div>
      <pre><code class="hljs ${language}">${highlighted}</code></pre>
    </div>
  `;
};
marked.use({ renderer: markdownRenderer });

document.addEventListener('DOMContentLoaded', async () => {
  const messages = document.getElementById('messages');
  const input = document.getElementById('user-input');
  const attachmentTray = document.getElementById('attachment-tray');
  const sendButton = document.getElementById('send-button');
  const stopButton = document.getElementById('stop-button');
  const modelSelect = document.getElementById('model-select');
  const agentModeToggle = document.getElementById('agent-mode-toggle');
  const fileList = document.getElementById('file-list');
  const fileSearch = document.getElementById('file-search');
  const openProjectButton = document.getElementById('open-project-btn');
  const cloneRepoButton = document.getElementById('clone-repo-btn');
  const newFileButton = document.getElementById('new-file-btn');
  const newFolderButton = document.getElementById('new-folder-btn');
  const runQueueButton = document.getElementById('run-queue-btn');
  const taskQueueList = document.getElementById('task-queue-list');
  const sessionName = document.querySelector('.session-name');
  const providerPill = document.getElementById('provider-pill');
  const editorContainer = document.getElementById('monaco-editor-container');
  const editorFilenameLabel = document.getElementById('editor-filename');
  const editorStatusBar = document.getElementById('editor-status-bar');
  const previewFrame = document.getElementById('preview-frame');
  const terminalContainer = document.getElementById('terminal-container');
  const terminalOutput = document.getElementById('terminal-output');
  const terminalInput = document.getElementById('terminal-input');
  const toolRail = document.getElementById('tool-rail');

  let filesCache = [];
  let currentOpenFileName = null;
  let editorTextarea = null;
  let lastPrompt = '';
  let currentProviderMode = 'ollama';
  let attachedImages = [];
  let chatHistory = [];
  let workspaceMemory = {
    summary: '',
    preferences: [],
    recentTasks: [],
    mistakesToAvoid: [],
    successfulPatterns: [],
    knowledgeNotes: []
  };
  let taskQueue = [];
  let queueRunning = false;
  let projectSummary = null;

  const AGENT_SYSTEM_PROMPT = `You are NewCodex, a Codex-style autonomous engineering agent.
Use tools deliberately and keep moving the task forward.
If the task is large, split it into smaller execution slices.
Do not stop just because the task is broad; reduce it into solvable parts.
When something fails, recover, patch, and continue.
Avoid repeating previous mistakes stored in workspace memory.

Available JSON tools:
{"tool":"think","plan":["step 1","step 2"]}
{"tool":"read_file","path":"src/app.js"}
{"tool":"write_file","path":"src/app.js","content":"..."}
{"tool":"run_command","command":"npm test"}
{"tool":"read_web","url":"https://example.com/docs"}
{"tool":"capture_screen","message":"Capture the current browser or app screen for visual debugging"}
{"tool":"done","message":"Task complete"}
`;

  function ensureEditor() {
    if (editorTextarea) {
      return editorTextarea;
    }

    editorContainer.innerHTML = '';
    editorTextarea = document.createElement('textarea');
    editorTextarea.id = 'code-editor';
    editorTextarea.spellcheck = false;
    editorContainer.appendChild(editorTextarea);

    const updateCursor = () => {
      const lines = editorTextarea.value.slice(0, editorTextarea.selectionStart).split('\n');
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      editorStatusBar.textContent = `Ln ${line}, Col ${col}`;
    };

    editorTextarea.addEventListener('input', updateCursor);
    editorTextarea.addEventListener('click', updateCursor);
    editorTextarea.addEventListener('keydown', async (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (currentOpenFileName) {
          await window.electronAPI.createFiles([{ name: currentOpenFileName, content: editorTextarea.value }]);
          await loadFiles();
          addTerminalLine(`Saved ${currentOpenFileName}`);
        }
      }
    });

    return editorTextarea;
  }

  function addTerminalLine(text) {
    if (!terminalOutput) {
      return;
    }
    terminalOutput.textContent += `${text}\n`;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function setBusy(isBusy) {
    input.disabled = isBusy;
    sendButton.classList.toggle('hidden', isBusy);
    stopButton.classList.toggle('hidden', !isBusy);
  }

  function extractResponse(result) {
    if (typeof result === 'string') {
      return { provider: 'ollama', text: result };
    }

    return {
      provider: result?.provider || 'system',
      text: result?.response || ''
    };
  }

  function updateProviderPill(provider) {
    const label = provider === 'gemini'
      ? 'Gemini'
      : provider === 'ollama'
        ? 'Ollama'
        : currentProviderMode === 'gemini+ollama'
          ? 'Auto'
          : 'Local';

    if (providerPill) {
      providerPill.textContent = label;
    }
  }

  function addMessage(text, type, provider) {
    const message = document.createElement('div');
    message.className = `message ${type}`;

    if (type === 'ai' && provider) {
      const providerBadge = document.createElement('div');
      providerBadge.className = 'message-provider';
      providerBadge.textContent = provider;
      message.appendChild(providerBadge);
    }

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = marked.parse(text);
    message.appendChild(body);

    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;

    const plainText = (text || '').replace(/\s+/g, ' ').trim();
    if (plainText) {
      chatHistory.push({
        role: type === 'user' ? 'user' : 'assistant',
        text: plainText.slice(0, 2000)
      });
      chatHistory = chatHistory.slice(-12);
    }

    return message;
  }

  function renderTaskQueue() {
    if (!taskQueueList) {
      return;
    }

    taskQueueList.innerHTML = '';
    taskQueue.forEach((task) => {
      const item = document.createElement('div');
      item.className = `task-item ${task.status}`;

      const title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = task.title;
      item.appendChild(title);

      const status = document.createElement('div');
      status.className = 'task-status';
      status.textContent = task.status.replace('_', ' ');
      item.appendChild(status);

      if (task.status === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'mini-action-btn';
        retry.textContent = 'Retry';
        retry.onclick = async () => {
          task.status = 'pending';
          await persistQueueState();
          renderTaskQueue();
        };
        item.appendChild(retry);
      }

      taskQueueList.appendChild(item);
    });
  }

  async function persistQueueState() {
    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      taskQueue
    });
  }

  async function enqueueTasks(steps) {
    taskQueue = steps.map((step, index) => ({
      id: `${Date.now()}-${index}`,
      title: step,
      status: 'pending',
      retries: 0
    }));
    await persistQueueState();
    renderTaskQueue();
  }

  function parseFiles(aiText) {
    const files = [];
    const regex = /File:\s*(.+?)\n```[\w-]*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(aiText)) !== null) {
      files.push({
        name: match[1].trim(),
        content: match[2].trim()
      });
    }
    return files;
  }

  function getCurrentContext() {
    return {
      activeFileName: currentOpenFileName,
      activeFileContent: editorTextarea ? editorTextarea.value : '',
      fileTree: filesCache.filter((file) => !file.isDirectory).map((file) => file.name),
      images: attachedImages,
      chatHistory
    };
  }

  async function persistMemoryFromPrompt(promptText) {
    const nextRecentTasks = [...(workspaceMemory.recentTasks || []), promptText].slice(-12);
    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary || `User wants NewCodex to behave like Codex: project-aware, action-oriented, able to inspect, create, edit, debug, and finish large tasks by breaking them into smaller parts.${projectSummary ? ` Current project type: ${projectSummary.likelyType}.` : ''}`,
      preferences: Array.from(new Set([
        ...(workspaceMemory.preferences || []),
        'Behave like Codex',
        'Prefer project inspection and concrete action over refusal',
        'Use workspace context, files, and tools proactively',
        'Split large tasks into smaller milestones',
        'Self-heal after failed attempts and continue',
        'Support Telugu and English naturally',
        'Ask permission before app-level self-improvement or updates'
      ])).slice(0, 12),
      recentTasks: nextRecentTasks,
      mistakesToAvoid: Array.from(new Set([
        ...(workspaceMemory.mistakesToAvoid || []),
        'Do not say you cannot read files when project tools are available',
        'Do not auto-refuse large tasks; break them down first',
        'Do not stop after one failed approach if another reasonable path exists'
      ])).slice(-12),
      successfulPatterns: Array.from(new Set([
        ...(workspaceMemory.successfulPatterns || []),
        'Use planner -> queue -> execute -> verify flow for large tasks',
        'Use Gemini first and Ollama fallback when needed',
        'Keep offline memory so project help continues without internet'
      ])).slice(-20),
      knowledgeNotes: Array.from(new Set([
        ...(workspaceMemory.knowledgeNotes || []),
        'User prefers Codex-like autonomous coding behavior.',
        'User wants bilingual Telugu/English chat.',
        'Self-improvement suggestions need explicit approval before changing app behavior.'
      ])).slice(-25)
    });
  }

  async function syncProjectSummaryToMemory() {
    projectSummary = await window.electronAPI.getProjectSummary();
    workspaceMemory = await window.electronAPI.updateMemory({
      summary: `Current project root: ${projectSummary.root}. Likely project type: ${projectSummary.likelyType}. Verification commands: ${(projectSummary.verificationCommands || []).join(', ')}.`,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      successfulPatterns: workspaceMemory.successfulPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      taskQueue
    });
  }

  function renderAttachments() {
    if (!attachmentTray) {
      return;
    }

    attachmentTray.innerHTML = '';
    attachmentTray.classList.toggle('hidden', attachedImages.length === 0);

    attachedImages.forEach((image) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      const img = document.createElement('img');
      img.src = image.dataUrl;
      img.alt = image.name || 'attachment';
      chip.appendChild(img);

      const remove = document.createElement('button');
      remove.className = 'attachment-remove';
      remove.type = 'button';
      remove.textContent = 'x';
      remove.onclick = () => {
        attachedImages = attachedImages.filter((entry) => entry.id !== image.id);
        renderAttachments();
      };
      chip.appendChild(remove);

      attachmentTray.appendChild(chip);
    });
  }

  function fileToAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name || 'clipboard-image',
          mimeType: file.type || 'image/png',
          dataUrl: reader.result
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function captureScreenAttachment() {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: 1920,
        height: 1080
      }
    });

    if (!sources.length) {
      throw new Error('No screen source available.');
    }

    const source = sources[0];
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: 'screen-capture.png',
      mimeType: 'image/png',
      dataUrl: source.thumbnail.toDataURL()
    };
  }

  async function attachScreenCapture() {
    const image = await captureScreenAttachment();
    attachedImages = [...attachedImages, image];
    renderAttachments();
    return image;
  }

  async function handleImagePaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) {
      return;
    }

    event.preventDefault();
    const images = await Promise.all(
      imageItems
        .map((item) => item.getAsFile())
        .filter(Boolean)
        .map((file) => fileToAttachment(file))
    );
    attachedImages = [...attachedImages, ...images];
    renderAttachments();
  }

  async function handleAIResponse(text, options = {}) {
    const { autoApply = false } = options;
    const files = parseFiles(text);
    if (!files.length) {
      return;
    }

    if (!autoApply) {
      addMessage(`Detected ${files.length} proposed file(s). Review them first, then use the code-block Save buttons or Agent mode to apply changes.`, 'ai', 'system');
      return;
    }

    await window.electronAPI.createFiles(files);
    await loadFiles();
    await refreshPreview();
    addMessage(`Created ${files.length} file(s).`, 'ai', 'tool');
  }

  function renderFileList(files) {
    fileList.innerHTML = '';

    files.forEach((file) => {
      const item = document.createElement('div');
      item.className = `file-item${file.isDirectory ? ' folder' : ''}`;
      item.style.paddingLeft = `${14 + file.name.split('/').length * 10}px`;
      item.textContent = `${file.isDirectory ? '▸' : '•'} ${file.name.split('/').pop()}`;

      if (file.isDirectory) {
        item.onclick = () => {
          const name = file.name;
          filesCache = filesCache.map((entry) => entry.name === name ? { ...entry, collapsed: !entry.collapsed } : entry);
          filterFiles();
        };
      } else {
        item.onclick = () => openFile(file);
        item.oncontextmenu = async (event) => {
          event.preventDefault();
          const action = prompt(`Action for ${file.name}: rename or delete`, 'rename');
          if (action === 'rename') {
            const nextName = prompt('New file name', file.name);
            if (nextName && nextName !== file.name) {
              await window.electronAPI.renameFile(file.name, nextName);
              await loadFiles();
            }
          }
          if (action === 'delete') {
            const confirmed = confirm(`Delete ${file.name}?`);
            if (confirmed) {
              await window.electronAPI.deleteFile(file.name);
              await loadFiles();
            }
          }
        };
      }

      fileList.appendChild(item);
    });
  }

  function filterFiles() {
    const query = fileSearch.value.trim().toLowerCase();
    const filtered = filesCache.filter((file) => file.name.toLowerCase().includes(query));
    renderFileList(filtered);
  }

  async function loadFiles() {
    filesCache = await window.electronAPI.readFiles();
    filesCache.sort((a, b) => a.name.localeCompare(b.name));
    filterFiles();
  }

  function openFile(file) {
    currentOpenFileName = file.name;
    editorFilenameLabel.textContent = file.name;
    const editor = ensureEditor();
    editor.value = file.content || '';
    editor.dispatchEvent(new Event('input'));
  }

  async function refreshPreview() {
    if (!previewFrame) {
      return;
    }

    const previewUrl = await window.electronAPI.getPreviewUrl();
    if (previewUrl) {
      previewFrame.src = previewUrl;
      return;
    }

    previewFrame.srcdoc = `
      <html>
        <body style="margin:0;font-family:Segoe UI,system-ui;background:#0f172a;color:#cbd5e1;display:grid;place-items:center;height:100vh;">
          <div style="text-align:center;max-width:520px;padding:24px;">
            <h2 style="margin:0 0 8px;">No preview available</h2>
            <p style="margin:0;color:#94a3b8;">Create an index.html file, or build a web app into dist/ or build/ to preview it here.</p>
          </div>
        </body>
      </html>
    `;
  }

  async function runTerminalCommand(command) {
    if (terminalContainer) {
      terminalContainer.classList.remove('hidden');
    }
    addTerminalLine(`> ${command}`);
    const output = await window.electronAPI.runCommand(command);
    addTerminalLine(output);
    return output;
  }

  async function getResponse(text) {
    const loading = addMessage('Thinking...', 'ai', 'system');
    try {
      const result = extractResponse(await window.electronAPI.sendPrompt(text, modelSelect.value, getCurrentContext()));
      loading.remove();
      updateProviderPill(result.provider);
      addMessage(result.text, 'ai', result.provider);
      await handleAIResponse(result.text, { autoApply: false });
    } catch (error) {
      loading.remove();
      addMessage(`Error: ${error.message}`, 'ai', 'system');
    }
  }

  async function runAgentFlow(task) {
    const planning = addMessage('Planning...', 'ai', 'system');
    const result = extractResponse(await window.electronAPI.getPlan(task, modelSelect.value, getCurrentContext()));
    planning.remove();
    updateProviderPill(result.provider);

    const planMatch = result.text.match(/\{[\s\S]*\}/);
    if (!planMatch) {
      addMessage(result.text, 'ai', result.provider);
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(planMatch[0]);
    } catch (error) {
      addMessage('Planner returned malformed JSON.', 'ai', 'system');
      return;
    }

    const plan = parsed.plans?.[0];
    if (!plan) {
      addMessage('No plan returned.', 'ai', 'system');
      return;
    }

    const planText = [`**${plan.title}**`, plan.description, ...(plan.steps || []).map((step, index) => `${index + 1}. ${step}`)].join('\n\n');
    addMessage(planText, 'ai', result.provider);
    await enqueueTasks(plan.steps || [task]);
    await executeTaskQueue();
  }

  async function runAgentLoop(steps) {
    let conversationHistory = `${AGENT_SYSTEM_PROMPT}\n\nUser task:\n${steps.join('\n')}`;

    for (let count = 0; count < 12; count += 1) {
      const result = extractResponse(await window.electronAPI.sendPrompt(conversationHistory, modelSelect.value, getCurrentContext()));
      let action = null;

      try {
        const codeMatch = result.text.match(/```json\n([\s\S]*?)\n```/);
        action = codeMatch ? JSON.parse(codeMatch[1]) : JSON.parse(result.text.match(/\{[\s\S]*\}/)[0]);
      } catch (error) {
        addMessage(result.text, 'ai', result.provider);
        break;
      }

      if (!action?.tool) {
        addMessage(result.text, 'ai', result.provider);
        break;
      }

      let toolOutput = '';
      if (action.tool === 'think') {
        toolOutput = (action.plan || []).join('\n');
        addMessage(`Working plan:\n\n${toolOutput}`, 'ai', 'tool');
      } else if (action.tool === 'read_file') {
        toolOutput = await window.electronAPI.readFile(action.path);
        addMessage(`Read \`${action.path}\``, 'ai', 'tool');
      } else if (action.tool === 'write_file') {
        await window.electronAPI.createFiles([{ name: action.path, content: action.content || '' }]);
        await loadFiles();
        toolOutput = `Wrote ${action.path}`;
        addMessage(toolOutput, 'ai', 'tool');
      } else if (action.tool === 'run_command') {
        toolOutput = await runTerminalCommand(action.command);
      } else if (action.tool === 'read_web') {
        const webResult = await window.electronAPI.readWebPage(action.url);
        toolOutput = webResult.ok ? webResult.content : `Web read failed: ${webResult.content}`;
        addMessage(`Read web page: \`${action.url}\``, 'ai', 'tool');
      } else if (action.tool === 'capture_screen') {
        await attachScreenCapture();
        toolOutput = 'Captured the current screen and attached it to context.';
        addMessage(action.message || 'Captured screen for visual context.', 'ai', 'tool');
      } else if (action.tool === 'done') {
        addMessage(action.message || 'Task completed.', 'ai', 'tool');
        break;
      } else {
        addMessage(result.text, 'ai', result.provider);
        break;
      }

      conversationHistory += `\n\nAssistant: ${JSON.stringify(action)}\nSystem: ${toolOutput.slice(0, 5000)}`;
    }
  }

  async function executeSingleTask(task) {
    task.status = 'in_progress';
    await persistQueueState();
    renderTaskQueue();
    addMessage(`Executing task: ${task.title}`, 'ai', 'tool');
    try {
      await runAgentLoop([task.title]);
      if (projectSummary?.verificationCommands?.length) {
        const verifyCommand = projectSummary.verificationCommands[0];
        addMessage(`Verifying task with \`${verifyCommand}\``, 'ai', 'tool');
        const verifyOutput = await runTerminalCommand(verifyCommand);
        if (/error|failed|exception/i.test(verifyOutput)) {
          task.status = 'failed';
          addMessage(`Verification reported issues for: ${task.title}`, 'ai', 'system');
          await persistQueueState();
          renderTaskQueue();
          return;
        }
      }
      task.status = 'completed';
    } catch (error) {
      task.retries = (task.retries || 0) + 1;
      if (task.retries <= 2) {
        task.status = 'pending';
        addMessage(`Task failed, retrying (${task.retries}/2): ${task.title}`, 'ai', 'system');
      } else {
        task.status = 'failed';
        addMessage(`Task failed: ${task.title}\n\n${error.message}`, 'ai', 'system');
      }
    }
    await persistQueueState();
    renderTaskQueue();
  }

  async function executeTaskQueue() {
    if (queueRunning || !taskQueue.length) {
      return;
    }

    queueRunning = true;
    try {
      for (const task of taskQueue) {
        if (task.status === 'completed') {
          continue;
        }
        await executeSingleTask(task);
        if (task.status === 'pending') {
          await executeSingleTask(task);
        }
        if (task.status === 'pending') {
          await executeSingleTask(task);
        }
      }
    } finally {
      queueRunning = false;
    }
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text && attachedImages.length === 0) {
      return;
    }

    lastPrompt = text || '[image attachment]';
    addMessage(text || `Attached ${attachedImages.length} image(s).`, 'user');
    input.value = '';
    setBusy(true);

    try {
      await persistMemoryFromPrompt(text || '[image attachment]');
      if (agentModeToggle.checked) {
        await runAgentFlow(text);
      } else {
        await getResponse(text);
      }
      attachedImages = [];
      renderAttachments();
    } finally {
      setBusy(false);
    }
  }

  async function openProject() {
    const selected = await window.electronAPI.selectDirectory();
    if (!selected) {
      return;
    }
    sessionName.textContent = selected.split('\\').pop();
    addMessage(`Project folder switched to **${selected}**`, 'ai', 'system');
    await loadFiles();
    await refreshPreview();
    await syncProjectSummaryToMemory();
  }

  async function cloneRepository() {
    const repoUrl = prompt('Repository URL');
    if (!repoUrl) {
      return;
    }
    addMessage(`Cloning **${repoUrl}**...`, 'ai', 'tool');
    const result = await window.electronAPI.cloneRepository(repoUrl);
    addMessage(result.message || (result.ok ? 'Repository cloned.' : 'Clone failed.'), 'ai', result.ok ? 'tool' : 'system');
    if (result.ok && result.path) {
      sessionName.textContent = result.path.split('\\').pop();
      await loadFiles();
      await refreshPreview();
      await syncProjectSummaryToMemory();
    }
  }

  async function createNewFile() {
    const fileName = prompt('New file path', 'src/index.js');
    if (!fileName) {
      return;
    }
    await window.electronAPI.createFiles([{ name: fileName, content: '' }]);
    await loadFiles();
    const file = filesCache.find((entry) => entry.name === fileName);
    if (file) {
      openFile(file);
    }
  }

  async function createNewFolder() {
    const folderName = prompt('New folder path', 'src');
    if (!folderName) {
      return;
    }
    await window.electronAPI.createFolder(folderName);
    await loadFiles();
  }

  async function copyCodeToClipboard(button) {
    const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
    await navigator.clipboard.writeText(code);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1200);
  }

  async function saveCodeToFile(button) {
    const block = button.closest('.code-block');
    const code = block?.querySelector('code')?.textContent || '';
    const previous = block?.previousElementSibling?.textContent || '';
    const match = previous.match(/File:\s*(.+)/);
    const filename = match ? match[1].trim() : 'generated.txt';
    await window.electronAPI.createFiles([{ name: filename, content: code }]);
    await loadFiles();
  }

  async function runCodeInTerminal(button) {
    const block = button.closest('.code-block');
    const code = block?.querySelector('code')?.textContent || '';
    const lang = (block?.querySelector('.lang-label')?.textContent || '').toLowerCase();
    const previous = block?.previousElementSibling?.textContent || '';
    const match = previous.match(/File:\s*(.+)/);
    const filename = match ? match[1].trim() : '';

    let command = '';
    if (['bash', 'sh', 'zsh', 'powershell', 'cmd', 'shell', 'console'].includes(lang)) {
      command = code;
    } else if (filename.endsWith('.js')) {
      command = `node ${filename}`;
    } else if (filename.endsWith('.py')) {
      command = `python ${filename}`;
    }

    if (command) {
      await runTerminalCommand(command);
    }
  }

  function showDiff(button) {
    const block = button.closest('.code-block');
    const newCode = block?.querySelector('code')?.textContent || '';
    const previous = block?.previousElementSibling?.textContent || '';
    const match = previous.match(/File:\s*(.+)/);
    const filename = match ? match[1].trim() : 'untitled';
    const existing = filesCache.find((file) => file.name === filename);
    const editor = ensureEditor();

    currentOpenFileName = filename;
    editorFilenameLabel.textContent = `${filename} (diff)`;
    editor.value = `--- current ---\n${existing?.content || ''}\n\n--- proposed ---\n${newCode}`;
    editor.dispatchEvent(new Event('input'));
  }

  function renderToolRail(presets) {
    if (!toolRail) {
      return;
    }
    toolRail.innerHTML = '';
    presets.forEach((preset) => {
      const button = document.createElement('button');
      button.className = 'tool-chip';
      button.textContent = preset.label;
      button.onclick = async () => {
        await runTerminalCommand(preset.command);
      };
      toolRail.appendChild(button);
    });

    const screenButton = document.createElement('button');
    screenButton.className = 'tool-chip';
    screenButton.textContent = 'Capture Screen';
    screenButton.onclick = async () => {
      await attachScreenCapture();
      addMessage('Screen capture added to the composer.', 'ai', 'tool');
    };
    toolRail.appendChild(screenButton);
  }

  sendButton.onclick = sendMessage;
  stopButton.onclick = async () => {
    await window.electronAPI.stopGeneration();
    setBusy(false);
    addMessage('Generation stopped.', 'ai', 'system');
  };

  openProjectButton?.addEventListener('click', openProject);
  cloneRepoButton?.addEventListener('click', cloneRepository);
  newFileButton?.addEventListener('click', createNewFile);
  newFolderButton?.addEventListener('click', createNewFolder);
  runQueueButton?.addEventListener('click', executeTaskQueue);

  fileSearch.addEventListener('input', filterFiles);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  document.addEventListener('keydown', async (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') {
      return;
    }

    const selection = window.getSelection()?.toString() || '';
    if (!selection.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selection);
    } catch (error) {
      console.error('Copy failed', error);
    }
  });

  input.addEventListener('paste', handleImagePaste);

  terminalInput?.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      const command = terminalInput.value.trim();
      terminalInput.value = '';
      if (command) {
        await runTerminalCommand(command);
      }
    }
  });

  document.addEventListener('click', async (event) => {
    if (event.target.classList.contains('copy-btn')) {
      await copyCodeToClipboard(event.target);
    } else if (event.target.classList.contains('save-btn')) {
      await saveCodeToFile(event.target);
    } else if (event.target.classList.contains('run-btn')) {
      await runCodeInTerminal(event.target);
    } else if (event.target.classList.contains('diff-btn')) {
      showDiff(event.target);
    }
  });

  window.electronAPI.onUpdateStatus((data) => {
    const updateText = document.getElementById('update-text');
    const progressBar = document.getElementById('progress-bar');
    const updateNotification = document.getElementById('update-notification');
    updateNotification.classList.remove('hidden');

    if (data.status === 'available') {
      updateText.textContent = 'Update available. Downloading...';
    } else if (data.status === 'progress') {
      updateText.textContent = 'Downloading update...';
      progressBar.style.width = `${data.percent}%`;
    } else if (data.status === 'downloaded') {
      updateText.textContent = 'Update ready. Restarting...';
      progressBar.style.width = '100%';
      setTimeout(() => window.electronAPI.restartApp(), 2500);
    } else if (data.status === 'not-available') {
      updateText.textContent = 'Already up to date.';
      progressBar.style.width = '100%';
    }
  });

  const projectState = await window.electronAPI.getProjectState();
  currentProviderMode = projectState.providerMode;
  workspaceMemory = projectState.memory || workspaceMemory;
  projectSummary = projectState.projectSummary || null;
  taskQueue = Array.isArray(workspaceMemory.taskQueue) ? workspaceMemory.taskQueue : [];
  updateProviderPill(currentProviderMode === 'gemini+ollama' ? 'gemini' : 'ollama');
  sessionName.textContent = projectState.currentProjectDir.split('\\').pop();

  modelSelect.innerHTML = `
    <option value="auto">Auto</option>
    <option value="gemini">Gemini</option>
    <option value="ollama:llama3">Ollama Llama 3</option>
    <option value="ollama:codellama">Ollama Code Llama</option>
    <option value="ollama:mistral">Ollama Mistral</option>
  `;
  modelSelect.value = 'auto';

  ensureEditor();
  await loadFiles();
  await syncProjectSummaryToMemory();
  renderTaskQueue();
  renderToolRail(await window.electronAPI.listToolPresets());
  await refreshPreview();
  addMessage('Workspace ready. Open or clone a project, then ask for implementation, debugging, git, Firebase, or full automation work.', 'ai', currentProviderMode === 'gemini+ollama' ? 'auto' : currentProviderMode);
});
