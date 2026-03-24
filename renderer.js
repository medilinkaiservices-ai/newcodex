const { ipcRenderer } = require('electron');
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
        <button class="copy-btn">Copy Code</button>
      </div>
      <pre><code class="hljs ${language}">${highlightedCode}</code></pre>
    </div>`;
};
marked.use({ renderer });

document.addEventListener("DOMContentLoaded", () => {

  const messages = document.getElementById("messages");
  const input = document.getElementById("user-input");
  const button = document.getElementById("send-button");
  const regenButton = document.getElementById("regen-button");
  const updateButton = document.getElementById("update-btn");
  const updateNotification = document.getElementById("update-notification");
  const updateText = document.getElementById("update-text");
  const progressBar = document.getElementById("progress-bar");
  const modelSelect = document.getElementById("model-select");

  let lastPrompt = "";

  // Handle Update Events
  ipcRenderer.on('update-status', (event, data) => {
    if (data.status === 'available') {
      updateNotification.classList.remove('hidden');
      updateText.innerText = "Update found. Downloading...";
    } 
    else if (data.status === 'not-available') {
      updateNotification.classList.remove('hidden');
      updateText.innerText = "No updates available.";
      progressBar.style.width = "0%";
      setTimeout(() => updateNotification.classList.add('hidden'), 3000);
    }
    else if (data.status === 'progress') {
      updateNotification.classList.remove('hidden');
      progressBar.style.width = data.percent + "%";
    } 
    else if (data.status === 'downloaded') {
      updateText.innerText = "Update downloaded. Restarting soon...";
      progressBar.style.width = "100%";
      setTimeout(() => ipcRenderer.send('restart-app'), 3000);
    }
  });

  const sendMessage = async () => {
    const text = input.value;
    if (!text) return;

    lastPrompt = text;
    addMessage(text, "user");
    input.value = "";

    await getResponse(text);
  };

  const getResponse = async (text) => {
    const loadingMessage = addMessage("Thinking...", "ai");
    const model = modelSelect.value;
    const res = await ipcRenderer.invoke('send-prompt', text, model);
    loadingMessage.remove();
    typeMessage(res, "ai");
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
    ipcRenderer.invoke('check-for-updates');
    updateNotification.classList.remove('hidden');
    updateText.innerText = "Checking for updates...";
    progressBar.style.width = "0%";
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

  document.addEventListener("click", async (event) => {
    if (event.target.classList.contains("copy-btn")) {
      const btn = event.target;
      const code = btn.closest(".code-block").querySelector("code").innerText;
      
      await navigator.clipboard.writeText(code);
      
      btn.innerText = "Copied!";
      setTimeout(() => btn.innerText = "Copy Code", 2000);
    }
  });

});