const promptElement = document.querySelector("#setupPrompt");
const copyButton = document.querySelector("#copyPrompt");
const copyLabel = copyButton?.querySelector(".copy-label");

const prompt = `Read ${new URL("/skill", window.location.origin).href} and help me set up my own Coinbase for Agents.`;
promptElement.textContent = prompt;

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(prompt);
    copyButton.classList.add("copied");
    copyLabel.textContent = "Copied";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(promptElement);
    selection.removeAllRanges();
    selection.addRange(range);
    copyLabel.textContent = "Select & copy";
  }

  window.setTimeout(() => {
    copyButton.classList.remove("copied");
    copyLabel.textContent = "Copy";
  }, 2200);
});
