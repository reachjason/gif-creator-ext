import { getSettings, saveSettings } from "./storage.js";

const fpsEl = document.getElementById("fps");
const qualityEl = document.getElementById("quality");
const durationEl = document.getElementById("maxDuration");
const durationLabel = document.getElementById("maxDurationLabel");
const startBtn = document.getElementById("start");

async function init() {
  const s = await getSettings();
  fpsEl.value = String(s.fps);
  qualityEl.value = s.quality;
  durationEl.value = String(s.maxDuration);
  durationLabel.textContent = `${s.maxDuration}s`;
}

durationEl.addEventListener("input", () => {
  durationLabel.textContent = `${durationEl.value}s`;
});

async function persist() {
  await saveSettings({
    fps: Number(fpsEl.value),
    quality: qualityEl.value,
    maxDuration: Number(durationEl.value),
  });
}

[fpsEl, qualityEl, durationEl].forEach((el) =>
  el.addEventListener("change", persist)
);

startBtn.addEventListener("click", async () => {
  await persist();
  // Open the recorder in its own tab — getDisplayMedia needs a stable page
  // (the popup closes on focus loss and would kill the stream).
  await chrome.tabs.create({ url: chrome.runtime.getURL("recorder.html") });
  window.close();
});

init();
