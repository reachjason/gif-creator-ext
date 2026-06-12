import { getSettings, clearSession, addFrame, setMeta } from "./storage.js";

const QUALITY_SCALE = { low: 0.5, medium: 0.75, high: 1 };
const WEBP_QUALITY = { low: 0.7, medium: 0.85, high: 0.95 };

const statusEl = document.getElementById("status");
const video = document.getElementById("preview");
const timerEl = document.getElementById("timer");
const framesEl = document.getElementById("frames");
const stopBtn = document.getElementById("stop");
const cancelBtn = document.getElementById("cancel");
const progressTrack = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");

let stream = null;
let captureTimer = null;
let startTime = 0;
let frameIndex = 0;
let canvas = null;
let ctx = null;
let settings = null;
let finished = false;
const pendingWrites = []; // in-flight encode+store promises to flush on stop

async function start() {
  settings = await getSettings();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: Math.max(settings.fps, 30) } },
      audio: false,
    });
  } catch (err) {
    statusEl.textContent =
      "Screen share was cancelled or blocked. Close this tab and try again.";
    return;
  }

  video.srcObject = stream;
  await video.play();

  // If the user stops sharing via the browser's native control, wrap up.
  stream.getVideoTracks()[0].addEventListener("ended", () => finish());

  // A getDisplayMedia track often reports 0×0 for a beat after play() resolves.
  // Capturing then would produce empty frames, so wait for real dimensions.
  const ready = await waitForVideoDimensions();
  if (!ready) {
    statusEl.textContent =
      "Couldn't read the shared video dimensions. Close this tab and try again.";
    if (stream) stream.getTracks().forEach((t) => t.stop());
    return;
  }

  await clearSession();
  setupCanvas();
  beginCapture();
}

function waitForVideoDimensions(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(true);
      } else if (performance.now() - start > timeoutMs) {
        resolve(false);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

function setupCanvas() {
  const scale = QUALITY_SCALE[settings.quality] ?? 0.75;
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  canvas = new OffscreenCanvas(w, h);
  ctx = canvas.getContext("2d", { alpha: false });
}

function beginCapture() {
  statusEl.textContent = "Recording — capturing frames…";
  stopBtn.disabled = false;
  timerEl.classList.add("recording");
  progressTrack.hidden = false;
  startTime = performance.now();

  const intervalMs = 1000 / settings.fps;
  const webpQuality = WEBP_QUALITY[settings.quality] ?? 0.85;
  const maxMs = settings.maxDuration * 1000;

  captureTimer = setInterval(async () => {
    const elapsed = performance.now() - startTime;
    if (elapsed >= maxMs) {
      finish();
      return;
    }

    // Snapshot the canvas synchronously, encode + store async so the loop stays
    // on time. Track each write so finish() can flush them before navigating —
    // otherwise an in-flight frame is lost and leaves a gap in the keys.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const myIndex = frameIndex++;
    const write = canvas
      .convertToBlob({ type: "image/webp", quality: webpQuality })
      .then((blob) => addFrame(myIndex, blob));
    pendingWrites.push(write);

    timerEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;
    framesEl.textContent = `${frameIndex} frames`;
    progressBar.style.width = `${Math.min(100, (elapsed / maxMs) * 100)}%`;
  }, intervalMs);
}

async function finish() {
  if (finished) return;
  finished = true;
  clearInterval(captureTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());

  if (frameIndex === 0) {
    statusEl.textContent = "No frames captured.";
    return;
  }

  // Flush every pending frame write before we read the count / navigate.
  statusEl.textContent = "Finishing up…";
  await Promise.allSettled(pendingWrites);

  await setMeta({
    fps: settings.fps,
    quality: settings.quality,
    frameCount: frameIndex,
    width: canvas.width,
    height: canvas.height,
  });

  // Hand off to the editor in this same tab.
  window.location.href = chrome.runtime.getURL("editor.html");
}

stopBtn.addEventListener("click", () => finish());
cancelBtn.addEventListener("click", async () => {
  finished = true;
  clearInterval(captureTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  await clearSession();
  window.close();
});

start();
