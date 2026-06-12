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
let crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }; // normalized 0..1, starts inset
let lockedAspect = null; // pixel aspect (w/h) when a social preset is active
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
  try {
    await load();
  } catch (err) {
    console.error("Editor init failed:", err);
    loading.style.whiteSpace = "pre-wrap";
    loading.style.padding = "0 24px";
    loading.textContent =
      `Couldn't open the editor.\n\n${err && err.message ? err.message : err}` +
      `\n\nTry recording again. If it keeps happening, copy this and send it over.`;
  }
}

async function load() {
  meta = await getMeta();
  const keys = await getFrameKeys();
  if (!meta || keys.length === 0) {
    loading.textContent = "No recording found. Close this tab and record again.";
    return;
  }
  captureFps = meta.fps || 15;

  // Decode all stored frames to ImageBitmaps for instant scrubbing/preview.
  // Iterate the real keys (which may have gaps) and skip any frame that fails
  // to decode, so one bad write can't stall the whole editor.
  let failed = 0;
  for (let i = 0; i < keys.length; i++) {
    try {
      const blob = await getFrame(keys[i]);
      if (blob && blob.size > 0) {
        frames.push(await createImageBitmap(blob));
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.warn(`Skipping undecodable frame ${keys[i]}`, err);
    }
    loading.textContent = `Loading frames… ${i + 1}/${keys.length}`;
  }

  frameCount = frames.length;
  if (frameCount === 0) {
    loading.textContent =
      `Recording could not be decoded (${failed} empty/invalid frame(s)).\n` +
      `This usually means the capture started before the shared screen was ` +
      `ready. Please record again.`;
    loading.style.whiteSpace = "pre-wrap";
    return;
  }

  // Frame dimensions come from the decoded bitmaps, not just meta, so a bad
  // meta.width/height can't break the canvas.
  canvas.width = meta.width || frames[0].width;
  canvas.height = meta.height || frames[0].height;
  scrub.max = String(frameCount - 1);
  trimEnd = frameCount - 1;

  buildFpsOptions();
  if (meta.quality) exportQualitySel.value = meta.quality;
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
  hideCropHint();
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
    } else if (lockedAspect) {
      // Aspect-locked resize: anchor the opposite corner and keep the ratio.
      // Edge handles are hidden when locked, so mode is always a corner.
      crop = resizeLocked(mode, orig, dx, dy);
      applyCropBox();
      updateStats();
      return;
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

function hideCropHint() {
  const hint = cropBox.querySelector(".crop-hint");
  if (hint) hint.remove();
}

// Convert a pixel aspect (w/h) into normalized width-per-height, accounting for
// the frame's own pixel dimensions so squares look square on any source.
function aspectNorm(pxAspect) {
  return pxAspect * (meta.height / meta.width);
}

// Largest centered rect of the given pixel aspect that fits in the frame.
function centeredRect(pxAspect) {
  const an = aspectNorm(pxAspect);
  let h = 1;
  let w = an;
  if (w > 1) {
    w = 1;
    h = 1 / an;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// Resize a corner while preserving lockedAspect, anchored at the opposite corner.
function resizeLocked(mode, orig, dx, dy) {
  const MIN = 0.05;
  const an = aspectNorm(lockedAspect);
  const anchorX = mode.includes("w") ? orig.x + orig.w : orig.x;
  const anchorY = mode.includes("n") ? orig.y + orig.h : orig.y;
  const movingX = clamp01((mode.includes("w") ? orig.x : orig.x + orig.w) + dx);
  const movingY = clamp01((mode.includes("n") ? orig.y : orig.y + orig.h) + dy);

  const dirX = mode.includes("w") ? -1 : 1;
  const dirY = mode.includes("n") ? -1 : 1;

  // Drive size from whichever axis the pointer pushed further, then derive the
  // other axis from the aspect ratio.
  let h = Math.max(Math.abs(movingY - anchorY), Math.abs(movingX - anchorX) / an, MIN);
  let w = an * h;

  // Clamp to the space available from the anchor toward the drag direction.
  const maxW = dirX > 0 ? 1 - anchorX : anchorX;
  const maxH = dirY > 0 ? 1 - anchorY : anchorY;
  if (w > maxW) { w = maxW; h = w / an; }
  if (h > maxH) { h = maxH; w = an * h; }

  const x = dirX > 0 ? anchorX : anchorX - w;
  const y = dirY > 0 ? anchorY : anchorY - h;
  return { x, y, w, h };
}

// ---- Crop presets ----
const presetsEl = el("presets");
presetsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset");
  if (!btn) return;
  [...presetsEl.querySelectorAll(".preset")].forEach((b) =>
    b.classList.toggle("active", b === btn)
  );

  const aspect = btn.dataset.aspect;
  hideCropHint();
  if (aspect === "free") {
    lockedAspect = null;
    cropBox.classList.remove("locked");
  } else {
    lockedAspect = Number(aspect);
    cropBox.classList.add("locked");
    crop = centeredRect(lockedAspect);
  }
  applyCropBox();
  updateStats();
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

// ---- Planning / stats ----
// Source frame indices for the output, sampled across the trimmed range at fps f.
function frameIndices(f) {
  const n = trimEnd - trimStart + 1;
  const duration = n / captureFps;
  const outCount = Math.max(1, Math.round(duration * f));
  const idx = [];
  for (let k = 0; k < outCount; k++) {
    const srcOffset = Math.round(k * (captureFps / f));
    idx.push(Math.min(trimEnd, trimStart + srcOffset));
  }
  return { idx, duration, outCount };
}

// Crop dimensions in source pixels and the base scale from the max-side cap.
function baseGeometry() {
  const cropW = Math.max(1, Math.round(crop.w * meta.width));
  const cropH = Math.max(1, Math.round(crop.h * meta.height));
  const longest = Math.max(cropW, cropH);
  const maxSide = Number(el("maxSide").value);
  const scale = maxSide > 0 ? Math.min(1, maxSide / longest) : 1;
  return { cropW, cropH, longest, scale };
}

function exportPlan() {
  const f = Number(exportFpsSel.value);
  const { cropW, cropH, scale } = baseGeometry();
  const { duration, outCount } = frameIndices(f);
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));
  return { f, duration, outCount, cropW, cropH, outW, outH, scale };
}

// Rough size guess (~0.6 bytes/px/frame for typical screen content). The
// auto-fit loop measures the real size, so this is only a pre-encode hint.
function estimateBytes(outW, outH, outCount) {
  return outW * outH * outCount * 0.6;
}

function fmtSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function updateStats() {
  const { duration, outCount, outW, outH } = exportPlan();
  el("statCrop").textContent = `${outW} × ${outH}px`;
  el("statLength").textContent = `${duration.toFixed(1)}s`;
  el("statFrames").textContent = `${outCount}`;
  el("statSize").textContent = `~${fmtSize(estimateBytes(outW, outH, outCount))}`;
}

["change", "input"].forEach((evt) => {
  exportFpsSel.addEventListener(evt, updateStats);
  el("maxSide").addEventListener(evt, updateStats);
});

// ---- Export ----
exportBtn.addEventListener("click", runExport);

// Encode one GIF at a given output scale; resolves with the Blob.
function encodeAt(scale, f) {
  return new Promise((resolve) => {
    const { cropW, cropH } = baseGeometry();
    const outW = Math.max(1, Math.round(cropW * scale));
    const outH = Math.max(1, Math.round(cropH * scale));
    const quality = GIF_QUALITY[exportQualitySel.value] ?? 10;
    const delay = Math.round(1000 / f);

    const gif = new GIF({
      workers: 2,
      quality,
      width: outW,
      height: outH,
      workerScript: chrome.runtime.getURL("lib/gif.worker.js"),
    });

    const cropX = Math.round(crop.x * meta.width);
    const cropY = Math.round(crop.y * meta.height);
    const tmp = document.createElement("canvas");
    tmp.width = outW;
    tmp.height = outH;
    const tctx = tmp.getContext("2d");

    for (const srcIdx of frameIndices(f).idx) {
      tctx.clearRect(0, 0, outW, outH);
      tctx.drawImage(frames[srcIdx], cropX, cropY, cropW, cropH, 0, 0, outW, outH);
      gif.addFrame(tctx, { copy: true, delay });
    }

    gif.on("progress", (p) => {
      exportBar.style.width = `${Math.round(p * 100)}%`;
    });
    gif.on("finished", (blob) => resolve(blob));
    gif.render();
  });
}

async function runExport() {
  stopPlayback();
  exportBtn.disabled = true;
  exportProgress.hidden = false;
  exportBar.style.width = "0%";

  const f = Number(exportFpsSel.value);
  const targetMB = Number(el("targetSize").value);
  const targetBytes = targetMB > 0 ? targetMB * 1048576 : 0;
  const { scale: startScale, longest } = baseGeometry();
  // Never shrink below ~160px on the longest side (it stops being watchable).
  const minScale = Math.min(startScale, 160 / longest);

  let scale = startScale;
  let blob = null;
  const MAX_PASSES = 6;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    exportStatus.textContent = pass === 0 ? "Encoding…" : `Encoding (pass ${pass + 1})…`;
    blob = await encodeAt(scale, f);
    if (!targetBytes || blob.size <= targetBytes) break;

    // GIF size scales ~ with pixel area (scale²), so aim straight for the target.
    const ratio = Math.sqrt(targetBytes / blob.size) * 0.92;
    const next = Math.max(minScale, scale * ratio);
    if (next >= scale - 0.005) break; // already as small as we'll go
    exportStatus.textContent =
      `${fmtSize(blob.size)} > ${targetMB} MB — shrinking & re-encoding…`;
    scale = next;
  }

  // Always hand over the best result we produced.
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.download = `screen-capture-${stamp()}.gif`;
  downloadLink.click();

  exportBar.style.width = "100%";
  el("statSize").textContent = fmtSize(blob.size);
  if (!targetBytes || blob.size <= targetBytes) {
    const ok = targetBytes ? " ✓ under limit" : "";
    exportStatus.textContent = `Done — ${fmtSize(blob.size)}${ok}. Saved to downloads.`;
  } else {
    exportStatus.textContent =
      `Saved at ${fmtSize(blob.size)} — couldn't reach ${targetMB} MB. ` +
      `Lower the frame rate or trim the clip shorter.`;
  }
  exportBtn.disabled = false;
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
