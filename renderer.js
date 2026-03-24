document.addEventListener("DOMContentLoaded", () => {

  const messages = document.getElementById("messages");
  const input = document.getElementById("user-input");
  const button = document.getElementById("send-button");

  button.onclick = async () => {
    const text = input.value;
    if (!text) return;

    addMessage(text, "user");
    input.value = "";

    const loadingMessage = addMessage("Thinking...", "ai");

    const res = await window.electronAPI.sendPrompt(text);

    loadingMessage.remove();
    addMessage(res, "ai");
  };

  function addMessage(text, type) {
    const div = document.createElement("div");
    div.className = "message " + type;
    div.innerText = text;
    messages.appendChild(div);
    return div;
  }

});