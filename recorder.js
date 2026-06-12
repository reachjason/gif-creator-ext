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

  await clearSession();
  setupCanvas();
  beginCapture();
}

function setupCanvas() {
  const scale = QUALITY_SCALE[settings.quality] ?? 0.75;
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
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

    // Snapshot the canvas synchronously, encode async so the loop stays on time.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const myIndex = frameIndex++;
    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: webpQuality,
    });
    await addFrame(myIndex, blob);

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
