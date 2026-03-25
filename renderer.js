const marked = require('marked');
const hljs = require('highlight.js');

// Configure marked with highlight.js
const renderer = new marked.Renderer();
renderer.code = (code, lang) => {
  const language = hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlightedCode = hljs.highlight(code, { language, ignoreIllegals: true }).value;

  return `
    <div class="code-block">
      <div class="code-header">
        <span class="lang-label">${lang || 'code'}</span>
        <div class="code-actions">
          <button class="run-btn">Run</button>
          <button class="diff-btn">Diff</button>
          <button class="save-btn">Save</button>
          <button class="copy-btn">Copy Code</button>
        </div>
      </div>
      <pre><code class="hljs ${language}">${highlightedCode}</code></pre>
    </div>`;
};
marked.use({ renderer });

document.addEventListener("DOMContentLoaded", () => {

  const messages = document.getElementById("messages");
  const input = document.getElementById("user-input");
  const button = document.getElementById("send-button");
  const stopButton = document.getElementById("stop-button");
  const regenButton = document.getElementById("regen-button");
  const updateButton = document.getElementById("update-btn");
  const openFolderButton = document.getElementById("open-folder-btn");
  const changeDirButton = document.getElementById("change-dir-btn");
  const deployButton = document.getElementById("deploy-btn");
  const clearChatButton = document.getElementById("clear-chat-btn");
  const updateNotification = document.getElementById("update-notification");
  const updateText = document.getElementById("update-text");
  const progressBar = document.getElementById("progress-bar");
  const modelSelect = document.getElementById("model-select");
  const tabChat = document.getElementById("tab-chat");
  const tabCode = document.getElementById("tab-code");
  const tabPreview = document.getElementById("tab-preview");
  const chatView = document.getElementById("chat-view");
  const codeView = document.getElementById("code-view");
  const previewView = document.getElementById("preview-view");
  const previewFrame = document.getElementById("preview-frame");
  const fileList = document.getElementById("file-list");
  const fileSearch = document.getElementById("file-search");
  const scriptsList = document.getElementById("scripts-list");
  const newFolderBtn = document.getElementById("new-folder-btn");
  const collapseAllBtn = document.getElementById("collapse-all-btn");
  const formatBtn = document.getElementById("format-btn");
  const editorFilenameLabel = document.getElementById("editor-filename");
  const editorStatusBar = document.getElementById("editor-status-bar");
  
  // Terminal elements
  const terminalInput = document.getElementById("terminal-input");
  const terminalOutput = document.getElementById("terminal-output");
  const clearTermBtn = document.getElementById("clear-term");
  const autoFixBtn = document.getElementById("term-auto-fix");
  const watchToggle = document.getElementById("watch-mode-toggle");
  const watchInput = document.getElementById("watch-command-input");
  const agentModeToggle = document.getElementById("agent-mode-toggle");

  let lastPrompt = "";

  // 🔥 MONACO EDITOR SETUP
  let editorInstance = null;
  let diffEditorInstance = null;
  let currentOpenFileName = null;
  let filesCache = [];
  let collapsedPaths = new Set();

  // 🔥 AUTONOMOUS AGENT SYSTEM PROMPT
  const AGENT_SYSTEM_PROMPT = `
YOU ARE AN AUTONOMOUS AI AGENT.
Your goal is to complete the user's task by planning and executing steps.

You have access to these TOOLS. You must output a single, valid JSON object to use a tool.

**TOOLS:**

1.  **think**: Outline your plan or thoughts. This helps you structure your work. Use this first.
    \`\`\`json
    {
      "tool": "think",
      "plan": [
        "First, I will do X.",
        "Next, I will do Y.",
        "Finally, I will do Z."
      ]
    }
    \`\`\`

2.  **write_file**: Write or overwrite a file.
    \`\`\`json
    {
      "tool": "write_file",
      "path": "path/to/file.ext",
      "content": "file content here"
    }
    \`\`\`

3.  **read_file**: Read the content of a file.
    \`\`\`json
    {
      "tool": "read_file",
      "path": "path/to/file.ext"
    }
    \`\`\`

4.  **run_command**: Execute a shell command.
    \`\`\`json
    {
      "tool": "run_command",
      "command": "npm install"
    }
    \`\`\`

5.  **git_push**: Stage, commit, and push changes to git. You will be prompted for a final commit message.
    \`\`\`json
    {
      "tool": "git_push",
      "message": "A descriptive commit message"
    }
    \`\`\`

6.  **done**: Use this tool when the task is fully complete.
    \`\`\`json
    {
      "tool": "done",
      "message": "I have successfully completed the task."
    }
    \`\`\`

RULES:
- OUTPUT ONLY VALID JSON. Do not write markdown text outside the JSON.
- Do one step at a time. Wait for the result.
- DO NOT run commands that do not exit (like 'npm start' or 'node server.js') directly. They will freeze the agent. Use build commands or test commands.
- Check file structure before writing.
`;

  // 🔥 AGENT LOOP LOGIC
  async function runAgentLoop(initialGoal) {
    let conversationHistory = AGENT_SYSTEM_PROMPT + "\n\nUser Task: Execute this plan:\n" + initialGoal;
    let stepCount = 0;
    const maxSteps = 15; // Safety limit

    addMessage("🤖 **Agent Mode Activated** - Analyzing task...", "ai");

    // Toggle UI State
    input.disabled = true;
    button.classList.add("hidden");
    stopButton.classList.remove("hidden");

    while (stepCount < maxSteps) {
      stepCount++;
      
      // 1. Get AI Plan/Action
      const contextData = {
        fileTree: window.currentProjectFiles || []
      };
      
      // We send the FULL accumulated history as the prompt to maintain state
      const aiResponse = await window.electronAPI.sendPrompt(conversationHistory, modelSelect.value, contextData);
      
      // 2. Parse JSON Response
      let action = null;
      try {
        // Try to find JSON block if AI wraps it in markdown
        const codeBlockMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/);
        if (codeBlockMatch) {
           action = JSON.parse(codeBlockMatch[1]);
        } else {
           const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
           if (jsonMatch) {
             action = JSON.parse(jsonMatch[0]);
           } else {
             action = JSON.parse(aiResponse);
           }
        }
      } catch (e) {
        console.log("Agent parsing error, retrying as text...");
      }

      // 3. Execute Action
      if (action) {
        addMessage(`🤖 Step ${stepCount}: Executing **${action.tool}**...`, "ai");
        
        let toolOutput = "";

        if (action.tool === "think") {
          const planText = "🤖 **Planning...**\n" + action.plan.map(p => `• ${p}`).join('\n');
          const thinkMessage = messages.lastElementChild;
          if (thinkMessage.textContent.includes("Executing **think**")) {
              thinkMessage.innerHTML = marked.parse(planText);
          }
          toolOutput = `System: I have formulated a plan. I will now execute the next step.`;
        }
        else if (action.tool === "write_file") {
          await window.electronAPI.createFiles([{ name: action.path, content: action.content }]);
          toolOutput = `System: Successfully wrote file '${action.path}'.`;
          addMessage(`📝 Wrote: ${action.path}`, "ai");
          
          // Refresh UI
          await loadFiles();
          if (action.path === currentOpenFileName) openFileInEditor({name: action.path, content: action.content});
        } 
        else if (action.tool === "run_command") {
          terminalInput.value = action.command;
          const cmdResult = await window.electronAPI.runCommand(action.command);
          terminalOutput.innerText += `> ${action.command}\n${cmdResult}\n`;
          terminalOutput.scrollTop = terminalOutput.scrollHeight;
          toolOutput = `System: Command '${action.command}' executed. Output:\n${cmdResult}`;
        }
        else if (action.tool === "read_file") {
          const files = await window.electronAPI.readFiles();
          const targetFile = files.find(f => f.name === action.path);
          if (targetFile) {
            // 🔥 SAFETY: Truncate large files to prevent context overflow
            const contentPreview = targetFile.content.length > 5000 ? targetFile.content.substring(0, 5000) + "\n...[Content Truncated]..." : targetFile.content;
            toolOutput = `System: Content of '${action.path}':\n\`\`\`\n${contentPreview}\n\`\`\``;
            addMessage(`📖 Read: ${action.path}`, "ai");
          } else {
            toolOutput = `System: File '${action.path}' not found.`;
            addMessage(`Mw File not found: ${action.path}`, "ai");
          }
        }
        else if (action.tool === "git_push") {
          // AI asks user permission automatically
          const commitMsg = prompt(`🤖 Agent wants to push code.\nCommit Message:`, action.message || "Update by AI Agent");
          
          if (commitMsg !== null) {
            const cmd = `git add . && git commit -m "${commitMsg}" && git push`;
            terminalInput.value = cmd;
            const cmdResult = await window.electronAPI.runCommand(cmd);
            
            terminalOutput.innerText += `> ${cmd}\n${cmdResult}\n`;
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
            toolOutput = `System: Git push executed. Output:\n${cmdResult}`;
            addMessage(`☁️ **Git Push:** Executed with message "${commitMsg}"`, "ai");
          } else {
            toolOutput = `System: User denied git push request.`;
            addMessage(`Mw Git Push denied by user.`, "ai");
          }
        }
        else if (action.tool === "done") {
          addMessage(`✅ **Task Completed:** ${action.message}`, "ai");
          break; // EXIT LOOP
        }

        // 4. Feed result back to AI
        // 🔥 SAFETY: Truncate tool output if huge (e.g. npm install logs)
        if (toolOutput.length > 2000) toolOutput = toolOutput.substring(0, 2000) + "\n...[Output Truncated]";
        
        conversationHistory += `\n\nAssistant: ${JSON.stringify(action)}\nSystem: ${toolOutput}`;

      } else {
        // Fallback if AI just talks
        addMessage(aiResponse, "ai");
        conversationHistory += `\n\nAssistant: ${aiResponse}`;
        // If AI asks a question or stops using tools, we break to let user reply
        break;
      }
      
      // Short delay to prevent API flooding
      await new Promise(r => setTimeout(r, 1000));
    }

    if (stepCount >= maxSteps) addMessage("⚠️ Agent stopped (Max steps reached).", "ai");

    // Restore UI
    input.disabled = false;
    input.value = "";
    stopButton.classList.add("hidden");
    button.classList.remove("hidden");
  }

  function renderPlanOptions(plans) {
    const container = document.createElement('div');
    container.className = 'message ai';

    let html = 'I have a few ideas for how to approach this. Which one do you prefer?<br><br>';
    html += '<div class="plan-options-container">';

    plans.forEach((plan, index) => {
        html += `
            <div class="plan-option">
                <h4>${plan.title || `Plan ${index + 1}`}</h4>
                <p>${plan.description || 'No description provided.'}</p>
                <button class="plan-execute-btn" data-plan-index="${index}">Execute This Plan</button>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
    messages.appendChild(container);
    messages.scrollTop = messages.scrollHeight;

    // Add event listeners to the new buttons
    container.querySelectorAll('.plan-execute-btn').forEach(button => {
        button.onclick = (e) => {
            const planIndex = e.target.getAttribute('data-plan-index');
            const selectedPlan = plans[planIndex];
            
            // Disable all plan buttons after one is chosen
            container.querySelectorAll('.plan-execute-btn').forEach(btn => {
              btn.disabled = true;
              btn.style.backgroundColor = '#555';
            });
            e.target.innerText = "Executing...";
            e.target.style.backgroundColor = '#059669';
            
            // Construct the goal from the plan's steps
            const goal = selectedPlan.steps.join('\n');
            runAgentLoop(goal);
        };
    });
  }


  // 🔥 WATCHER HELPER
  function triggerWatchCommand() {
    if (watchToggle && watchToggle.checked) {
      const cmd = watchInput.value;
      if (cmd) {
        terminalInput.value = cmd;
        terminalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    }
  }

  function createStandardEditor() {
    if (typeof monaco === 'undefined') return;

    // Dispose Diff Editor if active
    if (diffEditorInstance) {
      diffEditorInstance.dispose();
      diffEditorInstance = null;
      document.getElementById('monaco-editor-container').innerHTML = '';
    }

    // If already exists, just return (or layout)
    if (editorInstance) {
      editorInstance.layout();
      return;
    }

    document.getElementById('monaco-editor-container').innerHTML = '';
    editorInstance = monaco.editor.create(document.getElementById('monaco-editor-container'), {
      value: "// Select a file to view code...",
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true }
    });

    // 🔥 SAVE SHORTCUT (Ctrl+S)
    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      if (currentOpenFileName) {
        const content = editorInstance.getValue();
        await window.electronAPI.createFiles([{ name: currentOpenFileName, content: content }]);
        terminalOutput.innerText += `> Saved file: ${currentOpenFileName}\n`;
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
        
        // Trigger Watch
        triggerWatchCommand();
      }
    });

    // 🔥 CURSOR POSITION UPDATE
    editorInstance.onDidChangeCursorPosition((e) => {
      if (editorStatusBar) {
        const { lineNumber, column } = e.position;
        editorStatusBar.textContent = `Ln ${lineNumber}, Col ${column}`;
      }
    });
  }

  function createDiffEditor(originalContent, modifiedContent, language) {
    if (typeof monaco === 'undefined') return;

    // Dispose Standard Editor if active
    if (editorInstance) {
      editorInstance.dispose();
      editorInstance = null;
    }
    if (diffEditorInstance) {
      diffEditorInstance.dispose();
    }

    document.getElementById('monaco-editor-container').innerHTML = '';
    diffEditorInstance = monaco.editor.createDiffEditor(document.getElementById('monaco-editor-container'), {
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: false,
      originalEditable: false
    });

    diffEditorInstance.setModel({
      original: monaco.editor.createModel(originalContent, language),
      modified: monaco.editor.createModel(modifiedContent, language)
    });
  }

  if (window.monacoRequire) {
    window.monacoRequire(['vs/editor/editor.main'], function () {
      // 🔥 CONFIGURE INTELLISENSE (Node.js)
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false
      });

      monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2016,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowJs: true
      });

      // Add basic Node.js types
      const nodeTypes = `
        declare module 'fs' {
          export function readFileSync(path: string, encoding?: string): string;
          export function writeFileSync(path: string, data: string, options?: any): void;
          export function existsSync(path: string): boolean;
          export function mkdirSync(path: string, options?: any): void;
          export function readdirSync(path: string): string[];
        }
        declare module 'path' {
          export function join(...paths: string[]): string;
          export function resolve(...paths: string[]): string;
          export function dirname(path: string): string;
          export function basename(path: string, ext?: string): string;
        }
        declare module 'child_process' {
          export function exec(command: string, options?: any, callback?: any): any;
        }
        declare const process: {
          platform: string;
          env: { [key: string]: string };
          cwd(): string;
        };
        declare const require: (module: string) => any;
        declare const module: any;
        declare const __dirname: string;
      `;
      monaco.languages.typescript.javascriptDefaults.addExtraLib(nodeTypes, 'ts:filename/node.d.ts');

      createStandardEditor();
    });
  }

  // Handle Update Events
  window.electronAPI.onUpdateStatus((data) => {
    if (data.status === 'available') {
      updateNotification.classList.remove('hidden');
      updateText.innerText = "Update available. Downloading...";
      progressBar.style.width = "0%";
    } else if (data.status === 'progress') {
      updateNotification.classList.remove('hidden');
      progressBar.style.width = data.percent + "%";
    } else if (data.status === 'downloaded') {
      updateText.innerText = "Update downloaded. Restarting soon...";
      progressBar.style.width = "100%";
      setTimeout(() => window.electronAPI.restartApp(), 3000);
    }
  });

  // 🔥 CONTEXT MENU LOGIC
  let selectedFileForCtx = null;
  const ctxMenu = document.createElement('div');
  ctxMenu.id = 'context-menu';
  ctxMenu.innerHTML = `
    <div class="ctx-item" id="ctx-rename">Rename</div>
    <div class="ctx-item" id="ctx-delete" style="color: #ff6b6b;">Delete</div>
  `;
  document.body.appendChild(ctxMenu);

  // Close menu on click anywhere
  document.addEventListener('click', () => {
    ctxMenu.style.display = 'none';
  });

  document.getElementById('ctx-rename').onclick = async () => {
    const newName = prompt(`Rename ${selectedFileForCtx} to:`, selectedFileForCtx);
    if (newName && newName !== selectedFileForCtx) {
      await window.electronAPI.renameFile(selectedFileForCtx, newName);
      loadFiles();
    }
  };

  document.getElementById('ctx-delete').onclick = async () => {
    if (confirm(`Are you sure you want to delete ${selectedFileForCtx}?`)) {
      await window.electronAPI.deleteFile(selectedFileForCtx);
      loadFiles();
      // Clear editor if deleted file was open
      if (currentOpenFileName === selectedFileForCtx) {
        currentOpenFileName = null;
        if (editorInstance) editorInstance.setValue("// File deleted");
      }
    }
  };

  function isFileVisible(path) {
    const parts = path.split('/');
    parts.pop(); // Remove self
    while (parts.length > 0) {
      if (collapsedPaths.has(parts.join('/'))) return false;
      parts.pop();
    }
    return true;
  }

  function renderFileList(files) {
    const isSearching = fileSearch.value.trim().length > 0;
    fileList.innerHTML = "";
    files.forEach(file => {
      // Collapse check: If not searching and parent is collapsed, hide
      if (!isSearching && !isFileVisible(file.name)) return;

      const div = document.createElement("div");
      div.className = "file-item" + (file.isDirectory ? " folder" : "");
      
      // Indentation logic
      const depth = file.name.split('/').length - 1;
      div.style.paddingLeft = (20 + (depth * 10)) + "px";

      // Icon & Name (Show only basename in tree view)
      const icon = file.isDirectory 
        ? (collapsedPaths.has(file.name) ? "📁 " : "📂 ") 
        : "📄 ";
      div.textContent = icon + file.name.split('/').pop();

      if (!file.isDirectory) {
        div.onclick = () => openFileInEditor(file);
        div.draggable = true;
        
        // Drag Start
        div.ondragstart = (e) => {
          e.dataTransfer.setData("text/plain", file.name);
          div.style.opacity = "0.5";
        };
        
        div.ondragend = () => {
          div.style.opacity = "1";
        };
      } else {
        // Folder toggle logic
        div.onclick = () => {
          if (collapsedPaths.has(file.name)) collapsedPaths.delete(file.name);
          else collapsedPaths.add(file.name);
          filterFiles();
        };

        // Folder Drop Zone
        div.ondragover = (e) => {
          e.preventDefault(); // Allow drop
          div.classList.add("drag-over");
        };

        div.ondragleave = () => {
          div.classList.remove("drag-over");
        };

        div.ondrop = async (e) => {
          e.preventDefault();
          div.classList.remove("drag-over");
          const draggedFileName = e.dataTransfer.getData("text/plain");
          
          if (!draggedFileName) return;
          
          // Calculate new path: TargetFolder + OriginalBasename
          // Example: Drag 'src/utils.js' to 'dist' -> 'dist/utils.js'
          const fileNameOnly = draggedFileName.split('/').pop();
          const newPath = file.name + "/" + fileNameOnly; // file.name is the folder path

          if (draggedFileName !== newPath) {
             if (confirm(`Move '${fileNameOnly}' to '${file.name}'?`)) {
                await window.electronAPI.renameFile(draggedFileName, newPath);
                loadFiles();
             }
          }
        };
      }
      
      // Right click handler
      div.oncontextmenu = (e) => {
        e.preventDefault();
        selectedFileForCtx = file.name;
        ctxMenu.style.top = `${e.clientY}px`;
        ctxMenu.style.left = `${e.clientX}px`;
        ctxMenu.style.display = 'block';
      };
      
      fileList.appendChild(div);
    });
  }

  // 🔥 LOAD NPM SCRIPTS AUTOMATION
  function loadNpmScripts(files) {
    scriptsList.innerHTML = "";
    const packageJson = files.find(f => f.name === 'package.json');
    
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson.content);
        if (pkg.scripts) {
          Object.keys(pkg.scripts).forEach(scriptName => {
            const div = document.createElement("div");
            div.className = "script-item";
            div.innerText = scriptName;
            div.title = pkg.scripts[scriptName];
            div.onclick = () => {
              // Run script
              terminalInput.value = `npm run ${scriptName}`;
              terminalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
            };
            scriptsList.appendChild(div);
          });
        }
      } catch (e) { console.error("Error parsing package.json", e); }
    }
  }

  // 🔥 FILE LIST SIDEBAR LOGIC
  async function loadFiles() {
    if (!fileList) return;
    filesCache = await window.electronAPI.readFiles();
    
    // Sort: Hierarchical (Alphabetical by path) for proper tree structure
    filesCache.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

    // Pass file list to global var for context usage if needed
    window.currentProjectFiles = filesCache.filter(f => !f.isDirectory).map(f => f.name);
    loadNpmScripts(filesCache);

    filterFiles();
  }

  function filterFiles() {
    const query = fileSearch.value.toLowerCase();
    const filtered = filesCache.filter(f => f.name.toLowerCase().includes(query));
    renderFileList(filtered);
  }

  fileSearch.addEventListener('input', filterFiles);

  // 🔥 NEW FOLDER LOGIC
  if (newFolderBtn) {
    newFolderBtn.onclick = async () => {
      const folderName = prompt("Enter folder name:");
      if (folderName) {
        await window.electronAPI.createFolder(folderName);
        loadFiles();
      }
    };
  }

  // 🔥 COLLAPSE ALL LOGIC
  if (collapseAllBtn) {
    collapseAllBtn.onclick = () => {
      filesCache.forEach(f => {
        if (f.isDirectory) collapsedPaths.add(f.name);
      });
      filterFiles();
    };
  }

  function openFileInEditor(file) {
    currentOpenFileName = file.name;
    if (editorFilenameLabel) editorFilenameLabel.innerText = file.name;

    createStandardEditor();
    if (editorInstance) {
      // Determine language
      let lang = 'plaintext';
      if (file.name.endsWith('.js')) lang = 'javascript';
      else if (file.name.endsWith('.html')) lang = 'html';
      else if (file.name.endsWith('.css')) lang = 'css';
      else if (file.name.endsWith('.py')) lang = 'python';
      else if (file.name.endsWith('.json')) lang = 'json';
      
      monaco.editor.setModelLanguage(editorInstance.getModel(), lang);
      editorInstance.setValue(file.content);
    }
    switchTab('code');
  }

  loadFiles();

  const sendMessage = async () => {
    const text = input.value;
    if (!text) return;

    lastPrompt = text;
    addMessage(text, "user");
    input.value = "";

    // 🔥 NEW "PLAN & EXECUTE" AGENT FLOW
    if (agentModeToggle && agentModeToggle.checked) {
      const loadingMessage = addMessage("🤖 Thinking of a plan...", "ai");
      try {
          const plansResponse = await window.electronAPI.getPlan(text, modelSelect.value);
          // Robustly parse JSON, even if it's inside a markdown block
          const jsonMatch = plansResponse.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No valid JSON plan found in AI response.");

          const plansData = JSON.parse(jsonMatch[0]);
          loadingMessage.remove();
          renderPlanOptions(plansData.plans);
      } catch (e) {
          loadingMessage.innerHTML = "Sorry, I couldn't create a valid plan. The AI might be offline or the response was malformed. Please try a different prompt.";
          console.error("Planning phase failed:", e);
      }
      return;
    }

    // Fallback to old "Normal Chat" flow
    button.classList.add("hidden");
    stopButton.classList.remove("hidden");

    await getResponse(text);
    
    // Reset Buttons
    stopButton.classList.add("hidden");
    button.classList.remove("hidden");
  };

  const getResponse = async (text) => {
    const loadingMessage = addMessage("Thinking...", "ai");
    const model = modelSelect.value;
    
    // 🔥 SMART CONTEXT
    const contextData = {
      activeFileName: currentOpenFileName,
      activeFileContent: getEditorContent(),
      fileTree: window.currentProjectFiles || []
    };

    const res = await window.electronAPI.sendPrompt(text, model, contextData);
    loadingMessage.remove();
    typeMessage(res, "ai");
    await handleAIResponse(res);
  };

  stopButton.onclick = async () => {
    await window.electronAPI.stopGeneration();
  };

  regenButton.onclick = async () => {
    if (!lastPrompt) return;
    
    const lastMsg = messages.lastElementChild;
    if (lastMsg && lastMsg.classList.contains("ai")) {
      lastMsg.remove();
    }
    await getResponse(lastPrompt);
  };

  updateButton.onclick = () => {
    window.electronAPI.checkForUpdates();
    updateNotification.classList.remove('hidden');
    updateText.innerText = "Checking for updates...";
    progressBar.style.width = "0%";
  };

  clearChatButton.onclick = () => {
    messages.innerHTML = "";
    lastPrompt = "";
    addMessage("Chat cleared. Ready for new task.", "ai");
  };

  openFolderButton.onclick = () => {
    window.electronAPI.openFolder();
  };

  changeDirButton.onclick = async () => {
    const newPath = await window.electronAPI.selectDirectory();
    if (newPath) {
      addMessage(`📂 Project folder switched to: **${newPath}**`, "ai");
      loadFiles();
      messages.innerHTML = ""; // Clear chat on project switch
    }
  };

  // 🔥 DEPLOY BUTTON LOGIC
  if (deployButton) {
    deployButton.onclick = () => {
      const platform = prompt("Deploy to Vercel or Netlify? (Enter 'vercel' or 'netlify')", "vercel");
      if (!platform) return;
      
      let cmd = "";
      if (platform.toLowerCase().includes("vercel")) cmd = "npx vercel --prod";
      else if (platform.toLowerCase().includes("netlify")) cmd = "npx netlify deploy --prod";
      
      if (cmd) {
        terminalInput.value = cmd;
        terminalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    };
  }

  // 🔥 TAB SWITCHING LOGIC
  function switchTab(tabName) {
    [tabChat, tabPreview, tabCode].forEach(t => t.classList.remove("active"));
    [chatView, previewView, codeView].forEach(v => v.classList.add("hidden"));

    if (tabName === 'chat') {
      tabChat.classList.add("active");
      chatView.classList.remove("hidden");
    } else if (tabName === 'preview') {
      tabPreview.classList.add("active");
      previewView.classList.remove("hidden");
    } else if (tabName === 'code') {
      tabCode.classList.add("active");
      codeView.classList.remove("hidden");
    }
  }

  tabChat.onclick = () => {
    switchTab('chat');
  };

  tabPreview.onclick = () => {
    switchTab('preview');
  };

  tabCode.onclick = () => {
    switchTab('code');
  };

  button.onclick = sendMessage;

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  function addMessage(text, type) {
    const div = document.createElement("div");
    div.className = "message " + type;
    // 🔥 markdown render
    div.innerHTML = marked.parse(text);
    messages.appendChild(div);
    return div;
  }

  function typeMessage(text, type) {
    const div = document.createElement("div");
    div.className = "message " + type;
    messages.appendChild(div);

    let i = 0;
    const interval = setInterval(() => {
      div.innerText += text.charAt(i);
      messages.scrollTop = messages.scrollHeight;
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        div.innerHTML = marked.parse(text);
      }
    }, 20);
  }

  async function copyCodeToClipboard(btn) {
    const codeElement = btn.closest(".code-block").querySelector("code");
    if (!codeElement) return;
    await navigator.clipboard.writeText(codeElement.textContent);
    btn.innerText = "Copied!";
    setTimeout(() => btn.innerText = "Copy Code", 2000);
  }

  async function saveCodeToFile(btn) {
    const codeBlock = btn.closest(".code-block");
    const code = codeBlock.querySelector("code").innerText;
    
    let filename = "untitled.txt";
    // Attempt to find "File: filename" in the previous element (markdown usually renders it in a <p>)
    const prev = codeBlock.previousElementSibling;
    if (prev && prev.textContent.match(/File:\s*(.+)/)) {
      filename = prev.textContent.match(/File:\s*(.+)/)[1].trim();
    }

    await window.electronAPI.createFiles([{ name: filename, content: code }]);
    
    btn.innerText = "Saved!";
    setTimeout(() => btn.innerText = "Save", 2000);

    // Trigger Watch
    triggerWatchCommand();
  }

  async function runCodeInTerminal(btn) {
    const codeBlock = btn.closest(".code-block");
    const code = codeBlock.querySelector("code").innerText;
    const lang = codeBlock.querySelector(".lang-label").innerText.toLowerCase();
    
    let command = "";

    // 1. Shell commands
    if (['bash', 'sh', 'zsh', 'powershell', 'cmd', 'shell', 'console'].includes(lang)) {
      command = code;
    } 
    // 2. Saved files (JS/Python)
    else {
      let filename = null;
      const prev = codeBlock.previousElementSibling;
      if (prev && prev.textContent.match(/File:\s*(.+)/)) {
        filename = prev.textContent.match(/File:\s*(.+)/)[1].trim();
      }

      if (filename) {
        if (filename.endsWith('.js')) command = `node ${filename}`;
        else if (filename.endsWith('.py')) command = `python ${filename}`;
      }
    }

    if (command) {
      terminalInput.value = command;
      terminalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    } else {
      alert("Cannot run this code automatically. Try pasting it into the terminal.");
    }
  }

  async function handleDiffClick(btn) {
    const codeBlock = btn.closest(".code-block");
    const newCode = codeBlock.querySelector("code").innerText;
    
    let filename = "untitled";
    const prev = codeBlock.previousElementSibling;
    if (prev && prev.textContent.match(/File:\s*(.+)/)) {
      filename = prev.textContent.match(/File:\s*(.+)/)[1].trim();
    }
    
    // Find original content
    const file = filesCache.find(f => f.name === filename);
    const originalContent = file ? file.content : "";

    switchTab('code');
    
    // Determine language
    let lang = 'plaintext';
    if (filename.endsWith('.js')) lang = 'javascript';
    else if (filename.endsWith('.html')) lang = 'html';
    else if (filename.endsWith('.css')) lang = 'css';
    else if (filename.endsWith('.py')) lang = 'python';
    else if (filename.endsWith('.json')) lang = 'json';

    createDiffEditor(originalContent, newCode, lang);
    currentOpenFileName = filename;
  }

  document.addEventListener("click", async (event) => {
    if (event.target.classList.contains("copy-btn")) {
      await copyCodeToClipboard(event.target);
    }
    if (event.target.classList.contains("save-btn")) {
      await saveCodeToFile(event.target);
    }
    if (event.target.classList.contains("run-btn")) {
      await runCodeInTerminal(event.target);
    }
    if (event.target.classList.contains("diff-btn")) {
      await handleDiffClick(event.target);
    }
  });

  // 🔥 FILE PARSING & CREATION LOGIC
  function parseFiles(aiText) {
    const files = [];
    // Regex to find "File: filename" followed by a code block
    const regex = /File:\s*(.+?)\n```[\w]*\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(aiText)) !== null) {
      files.push({
        name: match[1].trim(),
        content: match[2].trim()
      });
    }

    return files;
  }

  async function handleAIResponse(text) {
    const files = parseFiles(text);
    if (files.length > 0) {
      await window.electronAPI.createFiles(files);
      // 🔥 Auto-load preview with timestamp to force refresh
      previewFrame.src = "generated/index.html?t=" + new Date().getTime();
      loadFiles();
      alert("Project created 🚀 Check the 'generated' folder!");
    }
  }

  // 🔥 TERMINAL LOGIC
  terminalInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const cmd = terminalInput.value;
      if (!cmd) return;
      
      terminalOutput.innerText += `> ${cmd}\n`;
      terminalInput.value = "";
      
      // DANGEROUS COMMAND CHECK (frontend)
      const blockedCommands = ['rm', 'del', 'format', 'shutdown'];
      const blockedCommandRegex = new RegExp(`\\b(${blockedCommands.join('|')})\\b`, 'i');
      if (blockedCommandRegex.test(cmd)) {
        const match = cmd.match(blockedCommandRegex);
        terminalOutput.innerText += `Error: Command "${match[0]}" is blocked for safety.\n`;
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
        return;
      }
      
      // RISKY COMMAND CONFIRMATION
      const riskyCommands = ['git reset', 'git clean', 'npm uninstall', 'git checkout .'];
      if (riskyCommands.some(risk => cmd.includes(risk))) {
        const proceed = confirm(`⚠️ CAUTION: The command "${cmd}" is potentially destructive.\nAre you sure you want to run it?`);
        if (!proceed) {
          terminalOutput.innerText += "Aborted by user.\n";
          terminalOutput.scrollTop = terminalOutput.scrollHeight;
          return;
        }
      }

      // Execute
      const result = await window.electronAPI.runCommand(cmd);
      terminalOutput.innerText += result + "\n";
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }
  });

  clearTermBtn.onclick = () => {
    terminalOutput.innerText = "";
  };

  // 🔥 AUTO FIX ERROR LOGIC
  autoFixBtn.onclick = async () => {
    const terminalContent = terminalOutput.innerText;
    if (!terminalContent.trim()) {
      alert("Terminal is empty. Nothing to fix!");
      return;
    }

    // Grab the last 1000 characters of terminal output to avoid token limits
    const errorLog = terminalContent.slice(-2000); 
    
    const fixPrompt = `
I ran a command and encountered an error. 
Here is the terminal output:
\`\`\`
${errorLog}
\`\`\`
Please analyze the error and fix the code in the project files to resolve it.
`;
    input.value = fixPrompt;
    button.click(); // Trigger send
  };

  // 🔥 FORMAT CODE (PRETTIER)
  if (formatBtn) {
    formatBtn.onclick = () => {
      if (!editorInstance) return;
      
      const code = editorInstance.getValue();
      let parser = null;
      
      // Map filename extension to Prettier parser
      if (currentOpenFileName.endsWith('.js') || currentOpenFileName.endsWith('.json')) parser = 'babel';
      else if (currentOpenFileName.endsWith('.html')) parser = 'html';
      else if (currentOpenFileName.endsWith('.css')) parser = 'css';
      
      if (parser && window.prettier && window.prettierPlugins) {
        try {
          const formatted = prettier.format(code, {
            parser: parser,
            plugins: window.prettierPlugins,
            singleQuote: true,
            tabWidth: 2
          });
          editorInstance.setValue(formatted);
          // Trigger save/watch if needed, or let user save manually
        } catch (err) {
          console.error('Prettier formatting failed:', err);
          alert('Formatting failed: ' + err.message);
        }
      } else {
        alert('Formatting not supported for this file type or Prettier not loaded.');
      }
    };
  }

});