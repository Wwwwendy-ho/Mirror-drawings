# Sinopia

*(A sinopia is the red-earth underdrawing beneath a fresco, the first drawing that shows through the finished work. To rename the site, see "Renaming the site" below.)*

A small static web app for artists: load a photo of your drawing and the reference you worked from, then compare them side by side, stacked, or overlaid.

Plain HTML/CSS/JS (classic scripts on a `window.DrawingCompare` namespace). No build step, no backend, no dependencies.

## Privacy: your images never leave your device

The website hosts only the code. Images you load are decoded and drawn entirely in your browser; nothing is uploaded anywhere.

To survive a page reload, the app saves each slot's **shelf** of photos (up to 12 photos for the Drawing and up to 12 for the Reference, so at most 24) and each photo's view settings (mirror/flip/rotation, gray/contrast, pan/zoom, alignment and alignment dots) plus the global settings (layout, compare mode, opacity and so on) in **your browser's own IndexedDB storage**, on your device only. Each photo is stored as a PNG, JPEG or WebP: files up to 1.5 MB are kept exactly as they are, anything larger (or any other format) is re-encoded as a JPEG (quality 0.9, long side at most 2048 px; large transparent PNGs lose their transparency), which is typically 0.4 to 1 MB per photo, so a full app is on the order of 25 MB. A small thumbnail is stored with each photo. Camera shots are saved as JPEG (quality 0.92). Automatic alignment runs in a Web Worker in your browser; no image data is sent anywhere. Use **Clear all saved photos** (top bar on desktop, under the "More" button in the bottom bar on phones) to remove every photo; it tells you how many will go before it does anything.

Nothing is ever deleted without a tap: when a shelf is full (12 photos), or the browser reports little free space, or a write fails with a quota error, the app asks whether to remove the oldest photo (never the one on the easel), let you choose which to remove, or cancel (the new photo then stays on screen for this session only, is marked as not saved, and is gone after a reload). The first time a shelf reaches 2 photos the app asks the browser to make the storage persistent (`navigator.storage.persist()`); the browser decides. If the browser refuses storage altogether (private mode), the shelves live in memory for the session and the app says once that it won't restore them next time.

## Features

- **Two slots, Drawing and Reference, each with a photo shelf.** Add photos by file picker, drag and drop, clipboard paste (Ctrl/⌘+V or the Paste button) or camera capture (live preview with front/back switch; falls back to the phone's native camera via a file input when the live camera is unavailable or blocked). Every add **appends** to the slot's shelf (up to 12 photos, oldest first, in capture order) and puts the new photo on the easel; nothing is overwritten. Photos are labelled automatically ("#3 · 10 Nov 14:32"); there is no reordering or renaming.
- **Shelf stepper and strip.** Once a slot has 2 or more photos its pane header shows `‹ 3 / 5 ›`. The chevrons (or `,` older and `.` newer for the selected image) step through the photos; the count opens a strip of thumbnails (Escape, picking a photo, or tapping outside closes it; in Overlay both strips open downward under the single header). Each photo remembers its own mirror, zoom, placement and dots. A newly added or never-viewed photo of the same shape (within 2 %) lands where the previous one was, anything else is fitted. **Remove** takes away the photo on the easel (after a confirmation); the older neighbour, else the newer one, takes its place. Placement is saved per photo, not per pair: if you switch the Reference to a different photo, the Drawing keeps its own placement and may need **Align** again.
- **Layouts:** Side by side, Stacked, Overlay. **Overlay is one framed sheet:** a single canvas under one header that carries two **layer tabs**, `Drawing` and `Reference` (the tab you press is the selected image; each tab has its own eye on desktop, the selected one also shows its photo stepper), and, at the right, the tools of the selected layer only (on phones and short landscape windows they live in a tray opened from the one tools button, captioned "Drawing tools" or "Reference tools"). An empty layer shows a dashed `Reference +` tab; select it to get File, Camera and Paste. Compare mode, Swap and the one slider are a frameless **compare strip** under the sheet (on phones one 44 px row, plus a second row only for the Blend / Outline slider). In Overlay the header band is forced to one row (tagline hidden, icon-only labels at tablet widths) and the phone masthead and desk strip give their space to the picture; Side and Stacked are unchanged.
- **Compare modes (Overlay):** **Tint** (default) draws the reference in red and your drawing in blue, multiplied: where they agree it goes dark and neutral, and a red or blue fringe is exactly where you are off. **Blend** fades one image into the other (opacity slider, Swap picks which is on top). **Wipe** is a draggable curtain with your drawing on one side and the reference on the other at full strength (drag the knob, or focus it and use the arrow keys). **Outline** lays the reference's contours as a red line drawing over your untouched drawing, with a **Detail** slider. Tint and Outline colours are fixed (reference red, drawing blue) and the two swatches in the layer tabs name them. Cycle modes with `T` / `Shift+T`; `[` / `]` adjust the mode's one slider.
- **Per image:** Mirror, Flip, Rotate 90°, Grayscale, Contrast boost, Fit, Remove (the photo on the easel). **Gray all** toggles grayscale globally for value checks.
- **Navigation:** images auto-fit and centre on load. Drag to pan, scroll wheel or pinch to zoom. **Double-tap / double-click hides or shows the selected image** (a manual blink: flick between the two to spot differences; a chip names what is hidden and brings it back, and `H` or the eye button do the same; not saved, a reload shows both). The selected image is the one you last pressed (Side, Stacked) or the layer tab you pressed in Overlay (or `A`). **Link** (on by default) keeps both images in sync; turn it off to move one image alone (in Overlay, the selected tab says which one; the first time you switch Link off there a toast explains it). There is no fit gesture; see **Fit** below.
- **Fit.** **Fit all** (`F`, top bar) means "fit the pair, then line up": both images are centred at once, then the drawing is lined up with the reference. An alignment you adjusted by hand (aligned, then panned, zoomed or nudged on one image alone) is kept. Otherwise existing **dots** win (the same alignment the **Line up** flow makes, and no automatic match is run). With no dots and no hand-tuning, the same confident-only automatic match used on load runs (an "Aligning…" chip on the canvas; pan, zoom, a layout switch or a new photo cancels it) and the drawing glides into place; the result is cached per pair of photos and orientations, so pressing it again is instant. If the match is not confident the pair is simply fitted and a toast says so, with a **Line up with dots** button. Every outcome has **Undo** (and `Z`) that restores all views exactly. **Fit** (per image, `0`) never matches: with Link on and an alignment it fits that image and the other follows, so the pair stays lined up; with Link off, or without an alignment, it fits only that image (an alignment that is dropped says so, with Undo). `Shift+F` fits every image on its own and clears the alignment. The saved per-photo view carries two extra fields, `alignSource` (`null` / `dots` / `auto`) and `tuned`; older saved views load without them.
- **Layout of controls:** each image's tools (add from file, camera, mirror, flip, rotate, gray, contrast, fit, remove photo) live in that image's own pane: in the pane header on desktop, in a slide-up tray opened from the pane header on phones. Global controls (layout, link, grid, fit all, export, clear all saved photos) sit in the top bar on desktop and in a bottom bar on phones.
- **Line up with dots (reliable, guided):** one tool, **Line up** (key `D`, in both images' tool rows), opens a four-step coach on the canvas. Step 1 and 2: tap two clear spots far apart on the **reference** (a vermilion circle, then a blue square; the reference's dots are dashed with an `R1`/`R2` tab). Step 3 and 4: tap the **same two spots** on **your drawing** (solid rings, tabs `1`/`2`). Pairs are told apart by colour *and* shape, so it works in grayscale. The app switches to the right image by itself at each step (in Overlay each step shows only the image you are marking), shows a small thumbnail of the reference spot while you mark the drawing, and after the last dot it aligns automatically (position, size and rotation) and stays open in a review state: drag any dot to fine-tune (touch drags show a magnifier), **Done**, **Undo**, **Start over**, or **Back** one dot at a time. **Use one spot** matches position only; **Cancel** (x or `Esc`) restores everything. The first time, a short picture explains "match the same two spots" (the coach's `?` shows it again). Too-close dots and a result that moved the drawing a lot get a plain-language warning. Dots are only visible while the flow is open; double-tap hiding is off while it is; pan, pinch and zoom keep working while you place dots, and a tap on the coach box moves it to the other edge. Keyboard: `Enter` drops the dot at the centre of the image, arrows move a focused dot (Shift = 10 px), `Delete` removes it, `Backspace` goes back. Dots are saved per photo; sessions saved with the old Dots toggle load cleanly.
- **Auto-align (best effort):** the **Auto** button in the Drawing pane estimates scale, rotation and position by itself, and an attempt is also made the first time a drawing and a reference are both loaded. It shows a calm "Aligning…" state, only moves anything when it is confident, and is always undoable. When it cannot match, its toast offers **Line up with dots**. See below for what it can and cannot do.
- **Retake:** **Camera** or **File** in the Drawing pane, while a drawing is already loaded, is "add a photo to the shelf, inheriting placement". The new photo is matched against the photo it follows (much easier than drawing-to-reference), inherits the alignment and the dots, and the old photo stays on the shelf one step back. **Previous** (toggle, `P`) shows the shelf entry just before the one on the easel as a ghost, for a quick compare; it is disabled when there is none. The ghost reuses the shelf's decoded image (no second copy in memory or storage). If the match is not confident the new photo simply sits where the old one was, with a hint to nudge it or re-place the dots.
- **Info bubbles:** every button has a small bubble that says what it does and shows its keyboard shortcut as key caps. It appears after a short rest of the mouse on the control, when a control gets keyboard focus (Tab), and on touch when you press and hold for about half a second (the button is then *not* pressed; a quick tap works as usual). Greyed-out buttons explain why they are disabled. Escape dismisses a bubble. The text lives in data-tip and data-key attributes in index.html (a 	itle set by script is adopted automatically, so the browser's own tooltip never doubles up).
- **Extras:** grid overlay (thirds + sixths), PNG export of the current comparison (exactly what the canvas shows: the active compare mode, a Wipe divider, a hidden image absent; no knobs, tags or chips), keyboard shortcuts (press `?`), warm paper-and-vermilion UI, touch support, responsive layout.

### Auto-align: how it works, and its limits

Everything runs locally, with no library and no server. Both images are reduced to 256 px luminance rasters; the gradient magnitude is taken (so thin pencil lines survive downscaling) and normalised against its local average (so a faint sketch and a contrasty photo become comparable). A coarse search then tries every combination of scale (0.42x to 2.4x in 9 % steps) and rotation (±32° in 4° steps); for each, the best translation comes from one FFT cross-correlation. The best two candidates are refined at 128 px with progressively finer scale/rotation steps, with sub-pixel translation. The search runs in a Web Worker (inline, chunked by a short delay, if workers are unavailable).

A result is applied only if three checks pass: normalised correlation >= 0.40, peak-to-sidelobe ratio >= 19, and the best scale/rotation is not on the edge of the searched range (which usually means the true transform is outside it).

Measured on synthetic data (a rendered 640x480 scene versus a rotated, scaled, shifted, noisy, lightened, edge-only "sketch" of it): scale error <= 0.7 %, rotation error <= 0.2°, translation error <= 1.7 px of the reference raster (mostly <= 0.5 px) over all accepted cases, and 0 of 12 unrelated image pairs accepted. **Real pencil sketches against photos are much harder** than these synthetic ones: proportions are off, shading differs, lines wobble. Expect Auto to be declined often, or to be a little off even when accepted. It does not handle rotations beyond ±32° (turn the image with Rotate first), scale ratios beyond about 0.42x to 2.4x, or mirrored images (use Mirror first). When Auto declines, **use the dots**: they are the dependable method.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Side / Stacked / Overlay |
| `L` | Link pan & zoom |
| `F` / `Shift+F` | Fit all and line up / fit each image on its own |
| `G` | Grid |
| `V` | Gray all |
| `E` | Export PNG |
| `A` | Switch active (selected) image |
| `H` | Hide / show the selected image |
| `M` / `Shift+M` | Mirror / flip active image |
| `R` / `Shift+R` | Rotate active image clockwise / counter-clockwise |
| `B` / `C` | Gray / contrast on active image |
| `D` | Line up with dots (`Esc` cancels, `Backspace` goes back a step) |
| `,` / `.` | Older / newer photo of the selected image's shelf |
| `P` | Show previous photo of the drawing |
| `Z` | Undo last alignment |
| `0` | Fit active image (with Link on and aligned, the other follows) |
| Arrow keys | Nudge (Shift = 10 px) |
| `+` / `-` | Zoom |
| `T` / `Shift+T` | Overlay: next / previous compare mode |
| `O` | Overlay: swap top layer (Blend, Wipe) |
| `[` / `]` | Overlay: opacity (Blend), curtain (Wipe), detail (Outline) |
| `?` | Help |

### Camera permission

The app asks for the camera **at most once per session**, and only from a tap (the Camera button, the Front/Back switch, or **Resume camera**), never at page load. One shared `CameraSession` owns the stream:

- Closing the camera dialog (after a capture or Cancel) does **not** stop the camera. It goes on **standby**: the preview is paused and the tracks are disabled, not stopped, so the next photo or retake within 2 minutes reopens instantly and no browser prompts again. While it is on standby a small vermilion dot marks every Camera button. Be aware that some browsers keep their camera indicator lit during standby; that is the deliberate cost of not re-prompting, and it is bounded.
- Standby ends, and the camera is really stopped, after **120 seconds** with the dialog closed, when the page is hidden for 30 seconds, and immediately on `pagehide` (closing the tab or navigating away). If the page is hidden while the dialog is open, the preview switches off at once. When you come back within 30 seconds it resumes by itself; if the camera was released (or the system interrupted it, as iOS does when Safari goes to the background) the dialog says "Camera paused" and shows a **Resume camera** button, so the request is always made from a tap.
- The chosen camera (`deviceId`) and the last Front/Back choice are remembered with the settings and requested exactly next time. If that device is gone the id is forgotten and the app silently retries once with a plain Front/Back request (normal on Safari, which issues new ids when permission is not persistent).
- The Permissions API (`navigator.permissions.query({ name: 'camera' })`) is read, where supported, without prompting. `granted`: the preview just starts. `prompt` or unknown: one line explains that the browser will ask. `denied`: the app does **not** call `getUserMedia`; on phones it opens the native camera through a file input with a toast, on desktop it opens the dialog in its error state ("allow the camera in the site settings, then press Resume camera") with a file-picker fallback. Browsers that reject the `camera` name are treated as "unknown" and behave as before.
- Captures are JPEG (quality 0.92) rather than PNG.

The app cannot make any browser remember a choice; it can only avoid asking more often than the browser requires. Whether your browser remembers the answer for next time is up to the browser: Chrome does by default on this site, Firefox and Safari need you to choose "remember" / "Allow" for the website. Permission is per origin, `https://<user>.github.io`, so it is shared by every project page of that user and survives redeploys.

| Browser | After the user allows once | Still asks again when |
| --- | --- | --- |
| Chrome / Edge (desktop, Android) on **https** (GitHub Pages is https) | "Allow while visiting the site" is remembered for the origin across reloads and visits; the app then never prompts again. | The user picked "Allow this time" (lasts for that visit only); the page is opened from `file://` (not remembered); site data or permissions were reset. |
| Firefox **(not verified against current Firefox documentation)** | Allowed for the current use only, unless the user ticks "Remember this decision". | Typically on a later camera request once the stream has been released (after the 2-minute standby, page hide or a reload), unless remembered. Keeping the stream on standby is what avoids prompts between retakes. |
| Safari, macOS and iOS / iPadOS **(not verified against current Safari documentation)** | Allowed for the current page load. | On each new page load or visit, unless the user sets the site to Allow (macOS: Safari > Settings for This Website > Camera; iOS: the "aA" / page menu > Website Settings > Camera). iOS also pauses the camera when Safari goes to the background; Resume camera covers that. |

The Chrome / Edge row is well-established behaviour, but none of the rows has been tested on real hardware for this app. The Firefox and Safari rows describe how those browsers are generally understood to behave and have **not** been checked against their current documentation; treat them as a starting point and check them before relying on them. Permissions API support is also uneven (older Firefox and Safari reject the `camera` name).

## Running it

**Locally:** either open `index.html` directly in a browser, or serve the folder with any static server (for example `python -m http.server` or `npx serve`) and open the printed URL. The live camera needs a secure context, which `localhost` and `file://` count as.

**GitHub Pages:**

1. Push these files to a repository (the app lives at the repo root; all paths are relative, so a project subpath such as `https://<user>.github.io/<repo>/` works).
2. In the repository go to **Settings → Pages**, choose **Deploy from a branch**, pick your branch and the `/ (root)` folder, and save.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`. GitHub Pages serves over HTTPS, which the camera and clipboard APIs require.

If the site does not update after a push, open the repository's **Actions** tab and look at the latest "pages build and deployment" run. A run that failed at startup is usually a temporary GitHub outage (check githubstatus.com); use **Re-run all jobs**, or push any small commit to start a fresh build. After it succeeds, hard-reload the page (Ctrl+Shift+R) because Pages caches files for several minutes.

## Files

```
index.html       markup, SVG icon sprite, dialogs, per-pane tools template
css/style.css    warm paper theme, responsive layout, alignment dots
css/decor.css    the "sketch desk" decoration: the page is a printed teal graph-paper desk covered edge to edge by ONE fixed layer of overlapping pencil sketches (an inline `<svg class="desk">` at the top of index.html: loose sheets of paper at angles, big ellipses and perspective construction lines, hatched value masses, and clusters of studies such as buildings, cubes, spheres, a face, hands, eyes, a book and pencils, drawn in red chalk, graphite and a blue pencil). It sits under everything (z-index -1, pointer-events none, hidden in forced-colors and print). The two panes, the title, the toolbar and the Overlay compare strip are opaque paper slips laid on top of it, with contact shadows and tape, so the sketches visibly run under the panes and out the other side; the desk shows in the margins, the gap between the panes and the header band. Chrome only: nothing is drawn over a loaded image, the desk is one static layer (a 900 ms fade-in on load, skipped with reduced motion). The sketch symbols (s-*) live in the SVG sprite in index.html
css/tips.css     info bubbles: the tooltip's look, plus the no-callout/no-select rules that make long-press safe on touch
js/brand.js      the one place the site name lives (SITE.name, SITE.slug)
js/app.js        state, UI wiring, persistence, shelf UI, alignment, retake, keyboard shortcuts
js/tips.js       info bubbles: one shared tooltip (hover, keyboard focus, touch long-press); reads data-tip / data-key, adopts any title attribute
js/align.js      auto-align: FFT correlation search, confidence, Web Worker plumbing
js/compare.js    overlay compare modes: render planner, tinted bitmaps, outline edge map
js/layer.js      Layer: image + orientation/filter/similarity transform, dots, fit & draw
js/pane.js       Pane: DPR-aware canvas, renders layers, clips, blend scratch, wipe divider, grid
js/gestures.js   pointer/pinch/wheel gesture recogniser (tap, double-tap, drag slop)
js/loaders.js    file / clipboard decoding (downscales to 2048 px)
js/camera.js     CameraSession (one stream, standby, device memory, permission) and the capture dialog
js/shelf.js      photo shelves: per-slot lists, storage keys, migration, limits, decode cache
js/storage.js    IndexedDB key/value wrapper (atomic batch, key listing)
js/export.js     compose panes into one PNG and download
```

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). Grayscale/contrast use the Canvas `filter` property where available and fall back to per-pixel processing elsewhere.

## Renaming the site

Edit the two strings in `js/brand.js` (`SITE.name` and `SITE.slug`, the latter is the export file-name prefix). The static `<title>` and the two pre-script placeholders in `index.html` (`data-site-name`) only matter for no-JS and link previews; update them too if you care. Do **not** rename `DB_NAME` in `js/storage.js`: it is a storage key, and changing it hides every saved photo.
