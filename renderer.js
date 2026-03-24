document.getElementById("btn").addEventListener("click", async () => {
  const prompt = document.getElementById("prompt").value;
  const output = document.getElementById("output");

  output.textContent = "Loading...";

  try {
    const res = await window.electronAPI.sendPrompt(prompt);
    output.textContent = res;
  } catch (err) {
    output.textContent = "Error: " + err.message;
  }
});