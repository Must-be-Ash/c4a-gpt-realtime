const promptElement = document.querySelector("#setupPrompt");
const copyButton = document.querySelector("#copyPrompt");
const copyLabel = copyButton?.querySelector(".copy-label");
const hint = document.querySelector("#setupHint");
const webSeg = document.querySelector("#webSeg");
const demoFrame = document.querySelector("#demoFrame");
const demoLink = document.querySelector("#demoLink");

// Three setup paths, each with its own agent-readable skill and demo video.
const OPTIONS = {
  local: {
    skill: "/skill",
    ask: "help me set up my own trading agent locally.",
    hint: "Runs on your laptop in the browser. OpenAI Realtime, Coinbase, Exa. Nothing to deploy.",
    video: "k0WlIw-uEJc",
  },
  "web-vapi": {
    skill: "/skill-web-vapi",
    ask: "help me deploy my own trading agent as a web dashboard with a phone number I can call, using Vapi.",
    hint: "Fastest hosted path. A phone number via Vapi, a private dashboard on Fly.io. Your agent guides accounts, keys, and deploys it for you.",
    video: "Olq0bqVwBgk",
  },
  "web-openai": {
    skill: "/skill-web-openai",
    ask: "help me deploy my own trading agent as a web dashboard with a phone number that connects directly to OpenAI (gpt-live-1 or gpt-realtime-2.1 over SIP via Telnyx).",
    hint: "OpenAI's newest voice models, no voice platform in between. Switch between gpt-live-1 and gpt-realtime-2.1 from the dashboard. Telnyx number, Fly.io hosting.",
    video: "Olq0bqVwBgk",
  },
};

let mode = "web";
let web = "vapi";
let prompt = "";

function currentKey() { return mode === "local" ? "local" : `web-${web}`; }

function render() {
  const option = OPTIONS[currentKey()];
  prompt = `Read ${new URL(option.skill, window.location.origin).href} and ${option.ask}`;
  promptElement.textContent = prompt;
  hint.textContent = option.hint;
  webSeg.hidden = mode !== "web";
  for (const button of document.querySelectorAll("[data-mode]")) button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  for (const button of document.querySelectorAll("[data-web]")) button.setAttribute("aria-checked", String(button.dataset.web === web));
  const embed = `https://www.youtube-nocookie.com/embed/${option.video}?rel=0`;
  if (demoFrame.getAttribute("src") !== embed) demoFrame.setAttribute("src", embed);
  demoLink.href = `https://www.youtube.com/watch?v=${option.video}`;
}

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => { mode = button.dataset.mode; render(); });
}
for (const button of document.querySelectorAll("[data-web]")) {
  button.addEventListener("click", () => { web = button.dataset.web; render(); });
}
render();

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
