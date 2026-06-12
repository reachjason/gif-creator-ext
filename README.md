# Window GIF Creator

A Manifest V3 Chrome extension that records a region of your screen, a browser
tab, or any application window and exports it as a GIF — entirely offline, no
server.

## How it works

1. **Popup** — pick a frame rate (10/15/24 fps), quality, and max duration
   (default 30s @ 15fps), then **Start Recording**.
2. **Recorder** — the native picker lets you share a **tab, window, or full
   screen**. Frames are captured at your chosen FPS into IndexedDB (so the
   capture survives the popup closing and handles long clips without eating
   memory). Auto-stops at the max duration, or hit **Stop & Edit**.
3. **Editor** — record-now / export-later:
   - Drag a **crop box** to define the exact window you want.
   - **Trim** start/end on the filmstrip timeline.
   - Re-adjust **FPS / quality**, preview playback, then **Export GIF**.
   - Encoding runs in a Web Worker (`gif.js`) with a progress bar, then
     auto-downloads.

The "defined window" is the crop box, applied at export time — so it works
uniformly across every capture source.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select this folder.

## Project layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 config & permissions (`storage`, `tabs`) |
| `popup.*` | Settings + start |
| `recorder.*` | `getDisplayMedia` capture → frames in IndexedDB |
| `editor.*` | Crop, trim, FPS/quality, encode → download |
| `storage.js` | IndexedDB frame store + settings |
| `lib/gif.js`, `lib/gif.worker.js` | Vendored [gif.js](https://github.com/jnordberg/gif.js) (MIT) encoder |

## Notes

- No host permissions required — capture is via `getDisplayMedia`, which always
  prompts the user.
- Frames are stored as WebP blobs and decoded to `ImageBitmap` in the editor for
  instant scrubbing.
- `gif.js` is MIT-licensed and vendored unmodified.
