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
  const improvementList = document.getElementById('improvement-list');
  const goalSummary = document.getElementById('goal-summary');
  const businessProfileEl = document.getElementById('business-profile');
  const opportunityMapEl = document.getElementById('opportunity-map');
  const dailyGuideList = document.getElementById('daily-guide-list');
  const dailyGuideButton = document.getElementById('daily-guide-btn');
  const assessGoalsButton = document.getElementById('assess-goals-btn');
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
    knowledgeNotes: [],
    personalGoals: null,
    dailyGuide: [],
    businessProfile: null,
    opportunityMap: []
  };
  let taskQueue = [];
  let queueRunning = false;
  let projectSummary = null;
  let knowledgeCache = [];
  let improvementProposals = [];
  const MAX_PARALLEL_TASKS = 2;

  function getDefaultPersonalGoals() {
    return {
      primaryMission: 'Use NewCodex as a life-line workspace to build web applications, apps, websites, custom AI tools, and business software for freelancing income, client delivery, and long-term product growth.',
      incomeFocus: 'Earn through freelancing first, complete client work with NewCodex, then grow into custom business applications, automation services, and productized AI offerings.',
      priorityServices: [
        'business websites',
        'web applications',
        'custom AI assistants',
        'automation tools',
        'small business software'
      ],
      preferredMarkets: [
        'freelancing clients',
        'local businesses',
        'startup founders',
        'service businesses'
      ],
      guidanceStyle: 'Act like a personal guide: suggest practical earning ideas, remind the user about the next best moves, recommend the next build, and explain in simple Telugu and English.',
      operatingRules: [
        'Become more powerful through safe incremental improvements',
        'Ask permission before app-level updates or risky changes',
        'Never lose the ability to open projects, read files, edit files, run commands, and continue core coding work',
        'Keep memory, goals, and business guidance persistent across sessions',
        'Prefer reversible changes and fallback paths so the app does not die during improvement'
      ]
    };
  }

  function getDefaultBusinessProfile() {
    return {
      skillLevel: 'beginner-coder, strong with direction and AI-assisted execution',
      strengths: [
        'clear ambition',
        'AI-assisted execution mindset',
        'focus on freelancing income',
        'interest in useful business apps',
        'persistence'
      ],
      constraints: [
        'limited coding depth right now',
        'needs simple guidance',
        'should start with high-value low-complexity client work'
      ]
    };
  }

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
{"tool":"search_knowledge","query":"electron ipc examples"}
{"tool":"search_web","query":"latest Electron ipcMain docs"}
{"tool":"read_web","url":"https://example.com/docs"}
{"tool":"remember_note","title":"Electron IPC docs","content":"Short reusable summary","tags":["electron","docs"]}
{"tool":"propose_improvement","title":"Add Playwright helper","summary":"This task would be easier with browser navigation helpers. Ask the user for approval before changing the app.","scope":"app"}
{"tool":"browser_open","url":"https://example.com/docs"}
{"tool":"browser_navigate","url":"https://example.com/reference"}
{"tool":"browser_snapshot","message":"Inspect the currently open browser page"}
{"tool":"browser_click","selector":"button[type='submit']"}
{"tool":"browser_type","selector":"input[name='q']","text":"electron ipc"}
{"tool":"browser_extract","selector":"main, article, pre"}
{"tool":"capture_page","url":"https://example.com/docs","message":"Capture the page for visual inspection"}
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

  function setSessionTitle(rawName) {
    const fallback = 'Workspace';
    const cleanName = (rawName || '').trim();
    if (!cleanName || cleanName.toLowerCase() === 'generated') {
      sessionName.textContent = fallback;
      return;
    }

    const normalized = cleanName
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    sessionName.textContent = normalized.charAt(0).toUpperCase() + normalized.slice(1);
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
      title.textContent = task.worker ? `[${task.worker}] ${task.title}` : task.title;
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

  function renderImprovementProposals() {
    if (!improvementList) {
      return;
    }

    improvementList.innerHTML = '';
    improvementProposals.forEach((proposal) => {
      const card = document.createElement('div');
      card.className = `improvement-card ${proposal.status || 'pending'}`;

      const title = document.createElement('div');
      title.className = 'improvement-title';
      title.textContent = proposal.title;
      card.appendChild(title);

      const summary = document.createElement('div');
      summary.className = 'improvement-summary';
      summary.textContent = proposal.summary || '';
      card.appendChild(summary);

      const status = document.createElement('div');
      status.className = 'improvement-status';
      status.textContent = proposal.status || 'pending';
      card.appendChild(status);

      if ((proposal.status || 'pending') === 'pending') {
        const actions = document.createElement('div');
        actions.className = 'improvement-actions';

        const approveButton = document.createElement('button');
        approveButton.className = 'mini-action-btn';
        approveButton.textContent = 'Approve';
        approveButton.onclick = async () => {
          improvementProposals = await window.electronAPI.respondImprovement(proposal.id, 'approved');
          renderImprovementProposals();
          addMessage(`Approved improvement: ${proposal.title}`, 'ai', 'system');
        };
        actions.appendChild(approveButton);

        const dismissButton = document.createElement('button');
        dismissButton.className = 'mini-action-btn';
        dismissButton.textContent = 'Dismiss';
        dismissButton.onclick = async () => {
          improvementProposals = await window.electronAPI.respondImprovement(proposal.id, 'dismissed');
          renderImprovementProposals();
          addMessage(`Dismissed improvement: ${proposal.title}`, 'ai', 'system');
        };
        actions.appendChild(dismissButton);

        card.appendChild(actions);
      }

      improvementList.appendChild(card);
    });
  }

  function renderGoalGuide() {
    if (goalSummary) {
      const goals = workspaceMemory.personalGoals;
      goalSummary.textContent = goals
        ? `${goals.primaryMission.split('. ')[0]}. Income focus: ${goals.incomeFocus}`
        : 'Set your mission so NewCodex can guide your daily work and earning path.';
    }

    if (dailyGuideList) {
      dailyGuideList.innerHTML = '';
      const guideItems = Array.isArray(workspaceMemory.dailyGuide) ? workspaceMemory.dailyGuide.slice(0, 3) : [];
      guideItems.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'daily-guide-item';
        item.textContent = entry;
        dailyGuideList.appendChild(item);
      });
    }

    if (businessProfileEl) {
      const profile = workspaceMemory.businessProfile;
      businessProfileEl.textContent = profile
        ? `Profile: ${profile.skillLevel}. Strengths: ${(profile.strengths || []).slice(0, 3).join(', ')}.`
        : '';
    }

    if (opportunityMapEl) {
      opportunityMapEl.innerHTML = '';
      const opportunityItems = Array.isArray(workspaceMemory.opportunityMap) ? workspaceMemory.opportunityMap.slice(0, 3) : [];
      opportunityItems.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'daily-guide-item';
        item.textContent = entry;
        opportunityMapEl.appendChild(item);
      });
    }
  }

  async function persistQueueState() {
    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      successfulPatterns: workspaceMemory.successfulPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      improvementProposals: improvementProposals,
      personalGoals: workspaceMemory.personalGoals,
      dailyGuide: workspaceMemory.dailyGuide,
      businessProfile: workspaceMemory.businessProfile,
      opportunityMap: workspaceMemory.opportunityMap,
      taskQueue
    });
  }

  async function enqueueTasks(steps) {
    taskQueue = steps.map((step, index) => ({
      id: `${Date.now()}-${index}`,
      title: step,
      status: 'pending',
      retries: 0,
      worker: null
    }));
    await persistQueueState();
    renderTaskQueue();
  }

  function getTaskExecutionMode(task) {
    const title = (task?.title || '').toLowerCase();
    const parallelSignals = [
      'research',
      'inspect',
      'analyze',
      'review',
      'read docs',
      'read documentation',
      'search',
      'plan',
      'summarize',
      'explore'
    ];
    const sequentialSignals = [
      'implement',
      'edit',
      'write',
      'create',
      'delete',
      'rename',
      'refactor',
      'run',
      'test',
      'build',
      'deploy',
      'push',
      'commit',
      'migrate',
      'fix'
    ];

    if (sequentialSignals.some((signal) => title.includes(signal))) {
      return 'sequential';
    }
    if (parallelSignals.some((signal) => title.includes(signal))) {
      return 'parallel';
    }
    return 'sequential';
  }

  function getNextRunnableTasks(limit) {
    const pendingTasks = taskQueue.filter((task) => task.status === 'pending');
    if (!pendingTasks.length) {
      return [];
    }

    const firstSequential = pendingTasks.find((task) => getTaskExecutionMode(task) === 'sequential');
    if (firstSequential) {
      return [firstSequential];
    }

    return pendingTasks.slice(0, limit);
  }

  async function persistExecutionLearning({ successTask, failedTask, failureReason, verificationCommand }) {
    const nextMistakes = failedTask
      ? Array.from(new Set([
        ...(workspaceMemory.mistakesToAvoid || []),
        `Failure pattern: ${failedTask.title}${failureReason ? ` -> ${failureReason}` : ''}`.slice(0, 280)
      ])).slice(-20)
      : workspaceMemory.mistakesToAvoid;

    const nextSuccessPatterns = successTask
      ? Array.from(new Set([
        ...(workspaceMemory.successfulPatterns || []),
        `Successful task flow: ${successTask.title}${verificationCommand ? ` -> verified with ${verificationCommand}` : ''}`.slice(0, 280)
      ])).slice(-30)
      : workspaceMemory.successfulPatterns;

    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: nextMistakes,
      successfulPatterns: nextSuccessPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      improvementProposals,
      personalGoals: workspaceMemory.personalGoals,
      dailyGuide: workspaceMemory.dailyGuide,
      businessProfile: workspaceMemory.businessProfile,
      opportunityMap: workspaceMemory.opportunityMap,
      taskQueue
    });
  }

  async function createRecoveryTask(task, reason) {
    const recoveryTask = {
      id: `${Date.now()}-recovery-${Math.random().toString(36).slice(2, 7)}`,
      title: `Recover from failure in "${task.title}": inspect cause, patch the issue, then re-run verification`,
      status: 'pending',
      retries: 0,
      worker: null,
      recoveryFor: task.id,
      failureReason: (reason || 'Unknown error').slice(0, 500)
    };

    const existingRecovery = taskQueue.find((entry) => entry.recoveryFor === task.id && entry.status !== 'completed');
    if (existingRecovery) {
      return existingRecovery;
    }

    const taskIndex = taskQueue.findIndex((entry) => entry.id === task.id);
    if (taskIndex >= 0) {
      taskQueue.splice(taskIndex + 1, 0, recoveryTask);
    } else {
      taskQueue.push(recoveryTask);
    }
    await persistQueueState();
    renderTaskQueue();
    return recoveryTask;
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
        'Ask permission before app-level self-improvement or updates',
        'Guide the user toward freelancing income and product-building',
        'Improve power safely without breaking the core app'
      ])).slice(0, 12),
      recentTasks: nextRecentTasks,
      mistakesToAvoid: Array.from(new Set([
        ...(workspaceMemory.mistakesToAvoid || []),
        'Do not say you cannot read files when project tools are available',
        'Do not auto-refuse large tasks; break them down first',
        'Do not stop after one failed approach if another reasonable path exists',
        'Do not break core app flows while trying to self-improve',
        'Do not remove fallback behavior before a replacement is proven stable'
      ])).slice(-12),
      successfulPatterns: Array.from(new Set([
        ...(workspaceMemory.successfulPatterns || []),
        'Use planner -> queue -> execute -> verify flow for large tasks',
        'Use Gemini first and Ollama fallback when needed',
        'Keep offline memory so project help continues without internet',
        'Use safe incremental upgrades and preserve rollback-friendly behavior'
      ])).slice(-20),
      knowledgeNotes: Array.from(new Set([
        ...(workspaceMemory.knowledgeNotes || []),
        'User prefers Codex-like autonomous coding behavior.',
        'User wants bilingual Telugu/English chat.',
        'Self-improvement suggestions need explicit approval before changing app behavior.',
        'User wants NewCodex to act like a personal guide for earning money through freelancing and building applications.',
        'NewCodex should become more powerful without dying during updates or losing core capabilities.'
      ])).slice(-25),
      personalGoals: workspaceMemory.personalGoals || getDefaultPersonalGoals(),
      dailyGuide: workspaceMemory.dailyGuide || [],
      businessProfile: workspaceMemory.businessProfile || getDefaultBusinessProfile(),
      opportunityMap: workspaceMemory.opportunityMap || []
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
      personalGoals: workspaceMemory.personalGoals,
      dailyGuide: workspaceMemory.dailyGuide,
      businessProfile: workspaceMemory.businessProfile,
      opportunityMap: workspaceMemory.opportunityMap,
      taskQueue
    });
  }

  async function loadKnowledgeState() {
    const result = await window.electronAPI.getKnowledgeState();
    knowledgeCache = Array.isArray(result?.items) ? result.items : [];
  }

  async function loadImprovementProposals() {
    improvementProposals = await window.electronAPI.getImprovements();
    renderImprovementProposals();
  }

  async function ensurePersonalGoals() {
    if (workspaceMemory.personalGoals) {
      renderGoalGuide();
      return;
    }

    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      successfulPatterns: workspaceMemory.successfulPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      improvementProposals,
      taskQueue,
      personalGoals: getDefaultPersonalGoals(),
      dailyGuide: workspaceMemory.dailyGuide || [],
      businessProfile: workspaceMemory.businessProfile || getDefaultBusinessProfile(),
      opportunityMap: workspaceMemory.opportunityMap || []
    });
    renderGoalGuide();
  }

  async function generateDailyGuide() {
    const goals = workspaceMemory.personalGoals || getDefaultPersonalGoals();
    const guidePrompt = [
      'You are NewCodex, a personal business and execution guide.',
      'Create exactly 5 short daily guidance points for the user.',
      'Focus on freelancing income, building useful applications, simple next actions, and product opportunities.',
      'Keep the advice practical for a non-coder who depends on NewCodex.',
      'Write in simple Telugu-English mixed style.',
      `Primary mission: ${goals.primaryMission}`,
      `Income focus: ${goals.incomeFocus}`,
      `Priority services: ${(goals.priorityServices || []).join(', ')}`,
      `Preferred markets: ${(goals.preferredMarkets || []).join(', ')}`
    ].join('\n');

    const result = extractResponse(await window.electronAPI.sendPrompt(guidePrompt, modelSelect.value, getCurrentContext()));
    const lines = result.text
      .split('\n')
      .map((line) => line.replace(/^\s*[-*0-9.]+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 5);

    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: Array.from(new Set([
        ...(workspaceMemory.preferences || []),
        'Guide the user toward freelancing income and product-building'
      ])).slice(0, 20),
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      successfulPatterns: workspaceMemory.successfulPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      improvementProposals,
      taskQueue,
      personalGoals: goals,
      dailyGuide: lines,
      businessProfile: workspaceMemory.businessProfile || getDefaultBusinessProfile(),
      opportunityMap: workspaceMemory.opportunityMap || []
    });
    renderGoalGuide();
    addMessage(`Daily guide refreshed for your goals.\n\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`, 'ai', result.provider);
  }

  async function assessStrengthsAndOpportunities() {
    const goals = workspaceMemory.personalGoals || getDefaultPersonalGoals();
    const profile = workspaceMemory.businessProfile || getDefaultBusinessProfile();
    const assessPrompt = [
      'You are a practical freelance business strategist and AI product guide.',
      'Return exactly 6 short opportunity lines.',
      'Each line must say what to sell, to whom, and why it fits the user now.',
      'Focus on realistic services and product ideas that can be built with AI assistance.',
      'Write in simple Telugu-English mixed style.',
      `Mission: ${goals.primaryMission}`,
      `Income focus: ${goals.incomeFocus}`,
      `Skill level: ${profile.skillLevel}`,
      `Strengths: ${(profile.strengths || []).join(', ')}`,
      `Constraints: ${(profile.constraints || []).join(', ')}`
    ].join('\n');

    const result = extractResponse(await window.electronAPI.sendPrompt(assessPrompt, modelSelect.value, getCurrentContext()));
    const lines = result.text
      .split('\n')
      .map((line) => line.replace(/^\s*[-*0-9.]+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 6);

    workspaceMemory = await window.electronAPI.updateMemory({
      summary: workspaceMemory.summary,
      preferences: workspaceMemory.preferences,
      recentTasks: workspaceMemory.recentTasks,
      mistakesToAvoid: workspaceMemory.mistakesToAvoid,
      successfulPatterns: workspaceMemory.successfulPatterns,
      knowledgeNotes: workspaceMemory.knowledgeNotes,
      improvementProposals,
      taskQueue,
      personalGoals: goals,
      dailyGuide: workspaceMemory.dailyGuide,
      businessProfile: profile,
      opportunityMap: lines
    });
    renderGoalGuide();
    addMessage(`Opportunity map refreshed.\n\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`, 'ai', result.provider);
  }

  async function rememberKnowledge({ title, content, url = '', source = 'research', tags = [] }) {
    const saved = await window.electronAPI.saveKnowledge({
      title,
      content,
      url,
      source,
      tags
    });
    knowledgeCache = [saved, ...knowledgeCache.filter((item) => item.id !== saved.id)].slice(0, 20);
    return saved;
  }

  function summarizeForKnowledge(text, limit = 1000) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
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

  async function attachImageData(dataUrl, mimeType = 'image/png', name = 'capture.png') {
    const image = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      mimeType,
      dataUrl
    };
    attachedImages = [...attachedImages, image];
    renderAttachments();
    return image;
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
    return attachImageData(image.dataUrl, image.mimeType, image.name);
  }

  async function attachWebCapture(url) {
    const result = await window.electronAPI.captureWebPage(url);
    if (!result?.ok || !result.dataUrl) {
      throw new Error(result?.error || 'Web page capture failed.');
    }
    await attachImageData(result.dataUrl, result.mimeType || 'image/png', 'web-capture.png');
    return result;
  }

  async function attachBrowserSnapshot(snapshotResult) {
    if (!snapshotResult?.ok || !snapshotResult.dataUrl) {
      throw new Error(snapshotResult?.error || 'Browser snapshot failed.');
    }

    await attachImageData(
      snapshotResult.dataUrl,
      snapshotResult.mimeType || 'image/png',
      'browser-snapshot.png'
    );
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
      } else if (action.tool === 'search_knowledge') {
        const knowledgeResults = await window.electronAPI.searchKnowledge(action.query);
        toolOutput = JSON.stringify(knowledgeResults, null, 2);
        addMessage(`Searched saved knowledge: \`${action.query}\``, 'ai', 'tool');
      } else if (action.tool === 'search_web') {
        const searchResult = await window.electronAPI.searchWeb(action.query);
        toolOutput = searchResult.ok
          ? JSON.stringify(searchResult.results, null, 2)
          : `Web search failed: ${searchResult.error || 'unknown error'}`;
        if (searchResult.ok && searchResult.results?.length) {
          await rememberKnowledge({
            title: `Search: ${action.query}`,
            content: searchResult.results.map((item) => `${item.title} - ${item.url}`).join('\n'),
            source: 'search',
            tags: ['search', 'web', ...action.query.toLowerCase().split(/\s+/).slice(0, 4)]
          });
        }
        addMessage(`Searched web: \`${action.query}\``, 'ai', 'tool');
      } else if (action.tool === 'read_web') {
        const webResult = await window.electronAPI.readWebPage(action.url);
        toolOutput = webResult.ok ? webResult.content : `Web read failed: ${webResult.content}`;
        if (webResult.ok) {
          await rememberKnowledge({
            title: action.url,
            content: summarizeForKnowledge(webResult.content, 3000),
            url: action.url,
            source: 'web',
            tags: ['web', 'docs']
          });
        }
        addMessage(`Read web page: \`${action.url}\``, 'ai', 'tool');
      } else if (action.tool === 'remember_note') {
        const saved = await rememberKnowledge({
          title: action.title || 'Agent note',
          content: action.content || '',
          source: 'agent',
          tags: Array.isArray(action.tags) ? action.tags : []
        });
        toolOutput = `Saved note: ${saved.title}`;
        addMessage(`Saved knowledge note: \`${saved.title}\``, 'ai', 'tool');
      } else if (action.tool === 'propose_improvement') {
        const proposal = await window.electronAPI.proposeImprovement({
          title: action.title || 'Suggested improvement',
          summary: action.summary || '',
          scope: action.scope || 'app'
        });
        improvementProposals = [proposal, ...improvementProposals.filter((item) => item.id !== proposal.id)];
        renderImprovementProposals();
        toolOutput = `Created approval request: ${proposal.title}`;
        addMessage(`Proposed app improvement: \`${proposal.title}\``, 'ai', 'tool');
      } else if (action.tool === 'browser_open') {
        const snapshot = await window.electronAPI.browserOpen(action.url);
        toolOutput = snapshot.ok ? `${snapshot.title}\n${snapshot.url}\n${snapshot.content}` : `Browser open failed: ${snapshot.error || 'unknown error'}`;
        if (snapshot.ok) {
          await attachBrowserSnapshot(snapshot);
          await rememberKnowledge({
            title: snapshot.title || action.url,
            content: summarizeForKnowledge(snapshot.content, 3000),
            url: snapshot.url || action.url,
            source: 'browser',
            tags: ['browser', 'web']
          });
        }
        addMessage(`Opened browser page: \`${action.url}\``, 'ai', 'tool');
      } else if (action.tool === 'browser_navigate') {
        const snapshot = await window.electronAPI.browserNavigate(action.url);
        toolOutput = snapshot.ok ? `${snapshot.title}\n${snapshot.url}\n${snapshot.content}` : `Browser navigate failed: ${snapshot.error || 'unknown error'}`;
        if (snapshot.ok) {
          await attachBrowserSnapshot(snapshot);
        }
        addMessage(`Navigated browser to: \`${action.url}\``, 'ai', 'tool');
      } else if (action.tool === 'browser_snapshot') {
        const snapshot = await window.electronAPI.browserSnapshot();
        toolOutput = snapshot.ok ? `${snapshot.title}\n${snapshot.url}\n${snapshot.content}` : `Browser snapshot failed: ${snapshot.error || 'unknown error'}`;
        if (snapshot.ok) {
          await attachBrowserSnapshot(snapshot);
        }
        addMessage(action.message || 'Captured current browser page state.', 'ai', 'tool');
      } else if (action.tool === 'browser_click') {
        const snapshot = await window.electronAPI.browserClick(action.selector);
        toolOutput = snapshot.ok ? `${snapshot.title}\n${snapshot.url}\n${snapshot.content}` : `Browser click failed: ${snapshot.error || 'unknown error'}`;
        if (snapshot.ok) {
          await attachBrowserSnapshot(snapshot);
        }
        addMessage(`Clicked selector: \`${action.selector}\``, 'ai', 'tool');
      } else if (action.tool === 'browser_type') {
        const snapshot = await window.electronAPI.browserType(action.selector, action.text || '');
        toolOutput = snapshot.ok ? `${snapshot.title}\n${snapshot.url}\n${snapshot.content}` : `Browser type failed: ${snapshot.error || 'unknown error'}`;
        if (snapshot.ok) {
          await attachBrowserSnapshot(snapshot);
        }
        addMessage(`Typed into selector: \`${action.selector}\``, 'ai', 'tool');
      } else if (action.tool === 'browser_extract') {
        const extraction = await window.electronAPI.browserExtract(action.selector);
        toolOutput = extraction.ok ? JSON.stringify(extraction.items, null, 2) : `Browser extract failed: ${extraction.error || 'unknown error'}`;
        if (extraction.ok) {
          await rememberKnowledge({
            title: `Extract: ${action.selector}`,
            content: extraction.items.map((item) => item.text).join('\n\n'),
            source: 'browser',
            tags: ['browser', 'extract']
          });
        }
        addMessage(`Extracted page content with selector: \`${action.selector}\``, 'ai', 'tool');
      } else if (action.tool === 'capture_page') {
        const captureResult = await attachWebCapture(action.url);
        toolOutput = captureResult.ok
          ? `Captured page ${action.url} and attached it to context.`
          : `Page capture failed: ${captureResult.error || 'unknown error'}`;
        addMessage(action.message || `Captured page: \`${action.url}\``, 'ai', 'tool');
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
    task.worker = task.worker || `Worker ${Math.floor(Math.random() * MAX_PARALLEL_TASKS) + 1}`;
    await persistQueueState();
    renderTaskQueue();
    addMessage(`Executing task (${task.worker}): ${task.title}`, 'ai', 'tool');
    try {
      await runAgentLoop([task.title]);
      if (projectSummary?.verificationCommands?.length) {
        const verifyCommand = projectSummary.verificationCommands[0];
        addMessage(`Verifying task with \`${verifyCommand}\``, 'ai', 'tool');
        const verifyOutput = await runTerminalCommand(verifyCommand);
        if (/error|failed|exception/i.test(verifyOutput)) {
          task.status = 'failed';
          task.worker = null;
          await persistExecutionLearning({
            failedTask: task,
            failureReason: `Verification failed using ${verifyCommand}`
          });
          await createRecoveryTask(task, `Verification failed using ${verifyCommand}`);
          addMessage(`Verification reported issues for: ${task.title}`, 'ai', 'system');
          await persistQueueState();
          renderTaskQueue();
          return;
        }
        await persistExecutionLearning({
          successTask: task,
          verificationCommand: verifyCommand
        });
      } else {
        await persistExecutionLearning({
          successTask: task
        });
      }
      task.status = 'completed';
    } catch (error) {
      task.retries = (task.retries || 0) + 1;
      if (task.retries <= 2) {
        task.status = 'pending';
        task.worker = null;
        await persistExecutionLearning({
          failedTask: task,
          failureReason: error.message
        });
        if (task.retries === 1) {
          await createRecoveryTask(task, error.message);
        }
        addMessage(`Task failed, retrying (${task.retries}/2): ${task.title}`, 'ai', 'system');
      } else {
        task.status = 'failed';
        task.worker = null;
        await persistExecutionLearning({
          failedTask: task,
          failureReason: error.message
        });
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
      while (taskQueue.some((task) => task.status === 'pending')) {
        const runnableTasks = getNextRunnableTasks(MAX_PARALLEL_TASKS);
        if (!runnableTasks.length) {
          break;
        }

        await Promise.all(runnableTasks.map((task, index) => {
          task.worker = `Worker ${index + 1}`;
          return executeSingleTask(task);
        }));

        for (const task of runnableTasks) {
          if (task.status === 'pending') {
            task.worker = 'Worker 1';
            await executeSingleTask(task);
          }
          if (task.status === 'pending') {
            task.worker = 'Worker 1';
            await executeSingleTask(task);
          }
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
    setSessionTitle(selected.split('\\').pop());
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
      setSessionTitle(result.path.split('\\').pop());
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

    const pageButton = document.createElement('button');
    pageButton.className = 'tool-chip';
    pageButton.textContent = 'Capture Page';
    pageButton.onclick = async () => {
      const url = window.prompt('Enter a page URL to capture');
      if (!url) {
        return;
      }
      try {
        await attachWebCapture(url);
        addMessage(`Captured page and added it to the composer: \`${url}\``, 'ai', 'tool');
      } catch (error) {
        addMessage(`Page capture failed: ${error.message}`, 'ai', 'system');
      }
    };
    toolRail.appendChild(pageButton);
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
  assessGoalsButton?.addEventListener('click', assessStrengthsAndOpportunities);
  dailyGuideButton?.addEventListener('click', generateDailyGuide);

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
  workspaceMemory.businessProfile = workspaceMemory.businessProfile || getDefaultBusinessProfile();
  workspaceMemory.opportunityMap = workspaceMemory.opportunityMap || [];
  projectSummary = projectState.projectSummary || null;
  taskQueue = Array.isArray(workspaceMemory.taskQueue) ? workspaceMemory.taskQueue : [];
  improvementProposals = Array.isArray(workspaceMemory.improvementProposals) ? workspaceMemory.improvementProposals : [];
  updateProviderPill(currentProviderMode === 'gemini+ollama' ? 'gemini' : 'ollama');
  setSessionTitle(projectState.currentProjectDir.split('\\').pop());

  modelSelect.innerHTML = `
    <option value="auto">Auto</option>
    <option value="gemini">Gemini</option>
    <option value="ollama:llama3">Ollama Llama 3</option>
    <option value="ollama:codellama">Ollama Code Llama</option>
    <option value="ollama:mistral">Ollama Mistral</option>
  `;
  modelSelect.value = 'auto';

  ensureEditor();
  await ensurePersonalGoals();
  await loadFiles();
  await loadKnowledgeState();
  await loadImprovementProposals();
  await syncProjectSummaryToMemory();
  renderTaskQueue();
  renderImprovementProposals();
  renderGoalGuide();
  renderToolRail(await window.electronAPI.listToolPresets());
  await refreshPreview();
  if (!Array.isArray(workspaceMemory.dailyGuide) || workspaceMemory.dailyGuide.length === 0) {
    await generateDailyGuide();
  }
  addMessage('Workspace ready. NewCodex now remembers your mission: use freelancing and product builds to earn, grow, and ship useful applications together.', 'ai', currentProviderMode === 'gemini+ollama' ? 'auto' : currentProviderMode);
});
