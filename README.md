# Drawing Compare

A small static web app for artists: load a photo of your drawing and the reference you worked from, then compare them side by side, stacked, or overlaid.

Plain HTML/CSS/JS. No build step, no backend, no dependencies.

## Privacy: your images never leave your device

The website hosts only the code. Images you load are decoded and drawn entirely in your browser; nothing is uploaded anywhere.

To survive a page reload, the app saves your two images and their view settings (mirror/flip/rotation, gray/contrast, pan/zoom, layout, overlay opacity and order) in **your browser's own IndexedDB storage**, on your device only. Use **Clear saved images** in the top bar to remove them. If the browser refuses storage (private mode, quota), the app keeps working and simply won't restore the session next time.

## Features

- **Two slots, Drawing and Reference.** Load each by file picker, drag and drop, clipboard paste (Ctrl/⌘+V or the Paste button) or camera capture (live preview with front/back switch; falls back to the phone's native camera via a file input when the live camera is unavailable or denied).
- **Layouts:** Side by side, Stacked, Overlay (with opacity slider and swap of which image is on top).
- **Per image:** Mirror, Flip, Rotate 90°, Grayscale, Contrast boost, Fit, Clear. **Gray all** toggles grayscale globally for value checks.
- **Navigation:** images auto-fit and centre on load. Drag to pan, scroll wheel or pinch to zoom, double-click/tap to re-fit. **Link** (on by default) keeps both images in sync; turn it off to move one image alone. In Overlay mode, **Move** picks which layer unlinked gestures affect so you can align them.
- **Extras:** grid overlay (thirds + sixths), PNG export of the current comparison, keyboard shortcuts (press `?`), dark UI, touch support, responsive layout.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Side / Stacked / Overlay |
| `L` | Link pan & zoom |
| `F` | Fit all |
| `G` | Grid |
| `V` | Gray all |
| `E` | Export PNG |
| `A` | Switch active image |
| `M` / `Shift+M` | Mirror / flip active image |
| `R` / `Shift+R` | Rotate active image clockwise / counter-clockwise |
| `B` / `C` | Gray / contrast on active image |
| `0` | Fit active image |
| Arrow keys | Nudge (Shift = 10 px) |
| `+` / `-` | Zoom |
| `O` | Overlay: swap top layer |
| `[` / `]` | Overlay: opacity |
| `?` | Help |

## Running it

**Locally:** either open `index.html` directly in a browser, or serve the folder with any static server (for example `python -m http.server` or `npx serve`) and open the printed URL. The live camera needs a secure context, which `localhost` and `file://` count as.

**GitHub Pages:**

1. Push these files to a repository (the app lives at the repo root; all paths are relative, so a project subpath such as `https://<user>.github.io/<repo>/` works).
2. In the repository go to **Settings → Pages**, choose **Deploy from a branch**, pick your branch and the `/ (root)` folder, and save.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`. GitHub Pages serves over HTTPS, which the camera and clipboard APIs require.

## Files

```
index.html       markup, dialogs, control-strip template
css/style.css    dark theme, responsive layout
js/app.js        state, UI wiring, persistence, keyboard shortcuts
js/layer.js      Layer: image + orientation/filter/transform, fit & draw
js/pane.js       Pane: DPR-aware canvas, renders layers + grid
js/gestures.js   pointer/pinch/wheel gesture recogniser
js/loaders.js    file / clipboard decoding (downscales to 2048 px)
js/camera.js     getUserMedia dialog with capture and fallback
js/storage.js    IndexedDB key/value wrapper
js/export.js     compose panes into one PNG and download
```

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). Grayscale/contrast use the Canvas `filter` property where available and fall back to per-pixel processing elsewhere.
