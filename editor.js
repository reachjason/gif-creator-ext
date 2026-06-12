import { getMeta, getFrame, getFrameKeys, clearSession } from "./storage.js";

const GIF_QUALITY = { low: 20, medium: 10, high: 1 }; // gif.js: 1=best, 30=worst

// ---- State ----
let meta = null;
let frames = []; // ImageBitmap[]
let frameCount = 0;
let captureFps = 15;
let current = 0;
let trimStart = 0;
let trimEnd = 0;
let crop = { x: 0, y: 0, w: 1, h: 1 }; // normalized 0..1
let playing = false;
let playTimer = null;

// ---- Elements ----
const el = (id) => document.getElementById(id);
const loading = el("loading");
const editor = el("editor");
const previewWrap = el("previewWrap");
const canvas = el("frameCanvas");
const ctx = canvas.getContext("2d");
const cropBox = el("cropBox");
const scrub = el("scrub");
const frameLabel = el("frameLabel");
const playBtn = el("playBtn");
const filmstrip = el("filmstrip");
const shadeLeft = el("shadeLeft");
const shadeRight = el("shadeRight");
const trimStartH = el("trimStart");
const trimEndH = el("trimEnd");
const playhead = el("playhead");
const trimReadout = el("trimReadout");
const exportFpsSel = el("exportFps");
const exportQualitySel = el("exportQuality");
const exportBtn = el("exportBtn");
const restartBtn = el("restartBtn");
const exportProgress = el("exportProgress");
const exportBar = el("exportBar");
const exportStatus = el("exportStatus");
const downloadLink = el("downloadLink");

async function init() {
  meta = await getMeta();
  const keys = await getFrameKeys();
  if (!meta || keys.length === 0) {
    loading.textContent = "No recording found. Close this tab and record again.";
    return;
  }
  captureFps = meta.fps;

  // Decode all stored frames to ImageBitmaps for instant scrubbing/preview.
  // Iterate the real keys (which may have gaps) and skip any frame that fails
  // to decode, so one bad write can't stall the whole editor.
  for (let i = 0; i < keys.length; i++) {
    try {
      const blob = await getFrame(keys[i]);
      if (blob) frames.push(await createImageBitmap(blob));
    } catch (err) {
      console.warn(`Skipping undecodable frame ${keys[i]}`, err);
    }
    if (i % 20 === 0) loading.textContent = `Loading frames… ${i}/${keys.length}`;
  }

  frameCount = frames.length;
  if (frameCount === 0) {
    loading.textContent = "Recording could not be decoded. Please record again.";
    return;
  }
  trimEnd = frameCount - 1;

  canvas.width = meta.width;
  canvas.height = meta.height;
  scrub.max = String(frameCount - 1);

  buildFpsOptions();
  exportQualitySel.value = meta.quality;
  buildFilmstrip();
  applyCropBox();
  applyTrimUI();
  drawFrame(0);
  updateStats();

  loading.hidden = true;
  editor.hidden = false;
}

function buildFpsOptions() {
  const options = [10, 15, 24].filter((f) => f <= captureFps);
  if (!options.includes(captureFps)) options.push(captureFps);
  options.sort((a, b) => a - b);
  exportFpsSel.innerHTML = "";
  for (const f of options) {
    const o = document.createElement("option");
    o.value = String(f);
    o.textContent = `${f} fps`;
    exportFpsSel.appendChild(o);
  }
  exportFpsSel.value = String(captureFps);
}

function buildFilmstrip() {
  const THUMBS = Math.min(50, frameCount);
  for (let i = 0; i < THUMBS; i++) {
    const srcIdx = Math.round((i / Math.max(1, THUMBS - 1)) * (frameCount - 1));
    const c = document.createElement("canvas");
    c.width = 80;
    c.height = 56;
    drawCover(c.getContext("2d"), frames[srcIdx], 80, 56);
    filmstrip.appendChild(c);
  }
}

function drawCover(c, bmp, w, h) {
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  c.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawFrame(i) {
  current = Math.max(trimStart, Math.min(trimEnd, i));
  ctx.drawImage(frames[current], 0, 0);
  scrub.value = String(current);
  frameLabel.textContent = `${current + 1} / ${frameCount}`;
  playhead.style.left = `${(current / (frameCount - 1)) * 100}%`;
}

// ---- Crop box ----
function applyCropBox() {
  cropBox.style.left = `${crop.x * 100}%`;
  cropBox.style.top = `${crop.y * 100}%`;
  cropBox.style.width = `${crop.w * 100}%`;
  cropBox.style.height = `${crop.h * 100}%`;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function startCropDrag(e, mode) {
  e.preventDefault();
  const rect = previewWrap.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { ...crop };

  function onMove(ev) {
    const dx = (ev.clientX - startX) / rect.width;
    const dy = (ev.clientY - startY) / rect.height;
    let { x, y, w, h } = orig;

    if (mode === "move") {
      x = clamp01(orig.x + dx);
      y = clamp01(orig.y + dy);
      x = Math.min(x, 1 - w);
      y = Math.min(y, 1 - h);
    } else {
      const MIN = 0.05;
      let right = orig.x + orig.w;
      let bottom = orig.y + orig.h;
      if (mode.includes("w")) x = Math.min(clamp01(orig.x + dx), right - MIN);
      if (mode.includes("n")) y = Math.min(clamp01(orig.y + dy), bottom - MIN);
      if (mode.includes("e")) right = Math.max(clamp01(right + dx), x + MIN);
      if (mode.includes("s")) bottom = Math.max(clamp01(bottom + dy), y + MIN);
      w = right - x;
      h = bottom - y;
    }
    crop = { x, y, w, h };
    applyCropBox();
    updateStats();
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

cropBox.addEventListener("pointerdown", (e) => {
  if (e.target.classList.contains("handle")) {
    startCropDrag(e, e.target.dataset.h);
  } else {
    startCropDrag(e, "move");
  }
});

// ---- Trim handles ----
function applyTrimUI() {
  const startFrac = trimStart / (frameCount - 1);
  const endFrac = trimEnd / (frameCount - 1);
  trimStartH.style.left = `calc(${startFrac * 100}% - 5px)`;
  trimEndH.style.left = `calc(${endFrac * 100}% - 5px)`;
  shadeLeft.style.width = `${startFrac * 100}%`;
  shadeRight.style.width = `${(1 - endFrac) * 100}%`;
  const dur = (trimEnd - trimStart + 1) / captureFps;
  trimReadout.textContent =
    `Trim: frame ${trimStart + 1}–${trimEnd + 1} · ${dur.toFixed(1)}s`;
}

function startTrimDrag(e, which) {
  e.preventDefault();
  const timeline = el("timeline");
  const rect = timeline.getBoundingClientRect();

  function onMove(ev) {
    const frac = clamp01((ev.clientX - rect.left) / rect.width);
    const idx = Math.round(frac * (frameCount - 1));
    if (which === "start") trimStart = Math.min(idx, trimEnd - 1);
    else trimEnd = Math.max(idx, trimStart + 1);
    applyTrimUI();
    drawFrame(which === "start" ? trimStart : trimEnd);
    updateStats();
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

trimStartH.addEventListener("pointerdown", (e) => startTrimDrag(e, "start"));
trimEndH.addEventListener("pointerdown", (e) => startTrimDrag(e, "end"));

// ---- Scrub + play ----
scrub.addEventListener("input", () => {
  stopPlayback();
  drawFrame(Number(scrub.value));
});

playBtn.addEventListener("click", () => {
  if (playing) stopPlayback();
  else startPlayback();
});

function startPlayback() {
  playing = true;
  playBtn.innerHTML = "&#10073;&#10073; Pause";
  if (current >= trimEnd) current = trimStart;
  playTimer = setInterval(() => {
    let next = current + 1;
    if (next > trimEnd) next = trimStart;
    drawFrame(next);
  }, 1000 / captureFps);
}

function stopPlayback() {
  if (!playing) return;
  playing = false;
  playBtn.innerHTML = "&#9654; Play";
  clearInterval(playTimer);
}

// ---- Stats ----
function exportPlan() {
  const f = Number(exportFpsSel.value);
  const n = trimEnd - trimStart + 1;
  const duration = n / captureFps;
  const outCount = Math.max(1, Math.round(duration * f));
  const cropW = Math.max(1, Math.round(crop.w * meta.width));
  const cropH = Math.max(1, Math.round(crop.h * meta.height));
  return { f, duration, outCount, cropW, cropH };
}

function updateStats() {
  const { duration, outCount, cropW, cropH } = exportPlan();
  el("statCrop").textContent = `${cropW} × ${cropH}px`;
  el("statLength").textContent = `${duration.toFixed(1)}s`;
  el("statFrames").textContent = `${outCount}`;
}

exportFpsSel.addEventListener("change", updateStats);

// ---- Export ----
exportBtn.addEventListener("click", runExport);

function runExport() {
  stopPlayback();
  const { f, outCount, cropW, cropH } = exportPlan();
  const quality = GIF_QUALITY[exportQualitySel.value] ?? 10;
  const delay = Math.round(1000 / f);

  exportBtn.disabled = true;
  exportProgress.hidden = false;
  exportBar.style.width = "0%";
  exportStatus.textContent = "Encoding… 0%";

  const gif = new GIF({
    workers: 2,
    quality,
    width: cropW,
    height: cropH,
    workerScript: chrome.runtime.getURL("lib/gif.worker.js"),
  });

  const cropX = Math.round(crop.x * meta.width);
  const cropY = Math.round(crop.y * meta.height);
  const tmp = document.createElement("canvas");
  tmp.width = cropW;
  tmp.height = cropH;
  const tctx = tmp.getContext("2d");

  for (let k = 0; k < outCount; k++) {
    const srcOffset = Math.round(k * (captureFps / f));
    const srcIdx = Math.min(trimEnd, trimStart + srcOffset);
    tctx.clearRect(0, 0, cropW, cropH);
    tctx.drawImage(frames[srcIdx], cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    gif.addFrame(tctx, { copy: true, delay });
  }

  gif.on("progress", (p) => {
    const pct = Math.round(p * 100);
    exportBar.style.width = `${pct}%`;
    exportStatus.textContent = `Encoding… ${pct}%`;
  });

  gif.on("finished", (blob) => {
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = `screen-capture-${stamp()}.gif`;
    downloadLink.click();
    const kb = Math.round(blob.size / 1024);
    exportStatus.textContent = `Done — ${kb} KB. Saved to downloads.`;
    exportBar.style.width = "100%";
    exportBtn.disabled = false;
  });

  gif.render();
}

function stamp() {
  // Avoid Date in module scope issues; build a simple counter-free label.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

restartBtn.addEventListener("click", async () => {
  await clearSession();
  window.location.href = chrome.runtime.getURL("recorder.html");
});

init();
