// Drawing Compare — app wiring. State lives here; rendering is a pure function
// of (state, layers) run on requestAnimationFrame. Images and view settings are
// persisted to the browser's own IndexedDB so a reload restores the session.

(() => {
  'use strict';
  const {
    Layer, Pane, Gestures, CameraDialog, Storage,
    decodeImage, imageFileFrom, readClipboardImage, composeExport, downloadCanvas,
  } = window.DrawingCompare;

  const SLOTS = ['drawing', 'reference'];
  const LABELS = { drawing: 'Drawing', reference: 'Reference' };
  const SETTINGS_KEYS = ['layout', 'linked', 'grid', 'grayAll', 'overlayTop', 'opacity', 'active'];
  const SAVE_DELAY = 500; // ms of quiet before view/settings are written

  const other = (slot) => (slot === 'drawing' ? 'reference' : 'drawing');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    layout: matchMedia('(max-width: 640px)').matches ? 'stacked' : 'side',
    linked: true,
    grid: false,
    grayAll: false,
    overlayTop: 'drawing',
    opacity: 0.5,
    active: 'drawing', // target for keyboard shortcuts and overlay-mode gestures
  };

  const PANE_BG = getComputedStyle(document.documentElement).getPropertyValue('--pane-bg').trim() || '#000';
  const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

  let rafId = 0;
  let saveTimer = 0;
  let restoring = true; // suppress saves until the stored session has been read
  let storageWarned = false;
  let cameraStatus = 'unknown'; // 'available' | 'none' | 'unknown'
  let pendingPasteSlot = null;

  const layers = Object.fromEntries(SLOTS.map((s) => [s, new Layer(s)]));
  const paneEls = Object.fromEntries(SLOTS.map((s) => [s, $(`.pane[data-slot="${s}"]`)]));
  const panes = Object.fromEntries(
    SLOTS.map((s) => [s, new Pane(paneEls[s], $('canvas', paneEls[s]), requestRender)]),
  );
  const strips = {};
  const fileInputs = {};
  const camera = new CameraDialog($('#camera-dialog'));
  const helpDialog = $('#help-dialog');
  const store = new Storage();

  const ui = {
    link: $('#btn-link'),
    grid: $('#btn-grid'),
    gray: $('#btn-gray'),
    overlayBar: $('#overlay-bar'),
    swap: $('#btn-swap'),
    opacity: $('#opacity'),
    opacityOut: $('#opacity-out'),
    moveTarget: $('#move-target'),
    moveHint: $('#move-hint'),
    toast: $('#toast'),
  };

  // ---------------------------------------------------------------- rendering

  function requestRender() {
    scheduleSave();
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  /** Layers drawn in a given pane, bottom to top, for the current layout. */
  function layersInPane(slot) {
    if (state.layout === 'overlay') {
      return slot === 'drawing' ? [layers[other(state.overlayTop)], layers[state.overlayTop]] : [];
    }
    return [layers[slot]];
  }

  function render() {
    const opts = { grid: state.grid, grayAll: state.grayAll, background: PANE_BG };
    for (const slot of SLOTS) {
      const pane = panes[slot];
      if (!pane.width || !pane.height) continue;
      const stack = layersInPane(slot);
      const bothLoaded = stack.length === 2 && stack.every((l) => l.hasImage);
      const items = stack.map((layer, i) => {
        layer.placeIn(pane.width, pane.height);
        return { layer, alpha: bothLoaded && i === 1 ? state.opacity : 1 };
      });
      pane.render(items, opts);
    }
  }

  // ---------------------------------------------------------------- persistence

  function storageFailed(err) {
    console.warn('Storage unavailable:', err);
    if (storageWarned) return;
    storageWarned = true;
    toast("Can't save to this browser's storage (private mode or quota), so this session won't be restored after a reload.");
  }

  /** Debounced write of both views and the global settings. */
  function scheduleSave() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const settings = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, state[k]]));
        await store.set('settings', settings);
        for (const slot of SLOTS) {
          if (layers[slot].hasImage) await store.set(`view:${slot}`, layers[slot].toJSON());
        }
      } catch (err) {
        storageFailed(err);
      }
    }, SAVE_DELAY);
  }

  async function saveImage(slot, blob) {
    if (restoring) return;
    try {
      if (blob) await store.set(`image:${slot}`, blob);
      else await Promise.all([store.delete(`image:${slot}`), store.delete(`view:${slot}`)]);
    } catch (err) {
      storageFailed(err);
    }
  }

  async function restoreSession() {
    try {
      if (!store.available) throw new Error('IndexedDB is not available');
      const settings = await store.get('settings');
      if (settings && typeof settings === 'object') {
        for (const k of SETTINGS_KEYS) if (k in settings) state[k] = settings[k];
      }
      for (const slot of SLOTS) {
        const blob = await store.get(`image:${slot}`);
        if (!blob) continue;
        try {
          layers[slot].setImage(await decodeImage(blob), blob);
          layers[slot].applyView(await store.get(`view:${slot}`));
        } catch (err) {
          console.warn(`Could not restore ${slot}:`, err);
        }
      }
    } catch (err) {
      storageFailed(err);
    } finally {
      restoring = false;
      syncUI();
      requestRender();
    }
  }

  async function clearSaved() {
    if (!confirm('Remove both images and all saved view settings from this browser?')) return;
    for (const slot of SLOTS) layers[slot].clear();
    try {
      await store.clear();
      toast('Saved images cleared.');
    } catch (err) {
      storageFailed(err);
    }
    syncUI();
    requestRender();
  }

  // ---------------------------------------------------------------- gestures

  /** Which layers a gesture that started in `slot`'s pane should move. */
  function gestureTargets(slot) {
    const loaded = SLOTS.filter((s) => layers[s].hasImage);
    if (state.linked) return loaded;
    const target = state.layout === 'overlay' ? state.active : slot;
    return loaded.includes(target) ? [target] : [];
  }

  for (const slot of SLOTS) {
    new Gestures(panes[slot].canvas, {
      onPress: () => {
        if (state.layout !== 'overlay' && layers[slot].hasImage) setActive(slot);
      },
      onPan: (dx, dy) => {
        for (const t of gestureTargets(slot)) layers[t].panBy(dx, dy);
        requestRender();
      },
      onZoom: (factor, x, y) => {
        for (const t of gestureTargets(slot)) layers[t].zoomAt(factor, x, y);
        requestRender();
      },
      onDoubleTap: () => {
        for (const t of gestureTargets(slot)) layers[t].reset();
        requestRender();
      },
    });
  }

  // ---------------------------------------------------------------- loading

  async function loadInto(slot, blob) {
    if (!blob) return;
    try {
      const canvas = await decodeImage(blob);
      layers[slot].setImage(canvas, blob);
      saveImage(slot, blob);
      setActive(slot);
      requestRender();
    } catch (err) {
      console.error(err);
      toast(`Couldn't read that image${blob.type ? ` (${blob.type})` : ''}.`);
    }
  }

  /** Slot for a paste or an untargeted drop: first empty slot, else the active one. */
  function fallbackSlot() {
    return SLOTS.find((s) => !layers[s].hasImage) || state.active;
  }

  function dropTarget(paneSlot) {
    return state.layout === 'overlay' ? fallbackSlot() : paneSlot;
  }

  async function pasteInto(slot) {
    try {
      const blob = await readClipboardImage();
      if (blob) loadInto(slot, blob);
      else toast('No image on the clipboard.');
    } catch {
      // Clipboard API blocked or unsupported: fall back to a keyboard paste.
      pendingPasteSlot = slot;
      toast(`Press Ctrl+V (⌘V on Mac) to paste into ${LABELS[slot]}.`);
    }
  }

  document.addEventListener('paste', (e) => {
    if (isEditable(e.target)) return;
    const file = imageFileFrom(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    const slot = pendingPasteSlot || fallbackSlot();
    pendingPasteSlot = null;
    loadInto(slot, file);
  });

  // Drag and drop onto panes; swallow drops elsewhere so the browser doesn't navigate.
  for (const slot of SLOTS) {
    const el = paneEls[slot];
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      const file = imageFileFrom(e.dataTransfer);
      if (file) loadInto(dropTarget(slot), file);
      else toast('That drop had no image file in it.');
    });
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function openFilePicker(slot, useCapture) {
    const input = fileInputs[slot];
    if (useCapture) input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.click();
  }

  function openCamera(slot) {
    if (cameraStatus === 'none') {
      // No live camera: on phones the file input can still open the camera app.
      if (IS_TOUCH) openFilePicker(slot, true);
      else toast('No camera detected on this device. Use File or Paste instead.');
      return;
    }
    camera.open().then((blob) => loadInto(slot, blob));
  }

  // ---------------------------------------------------------------- per-image actions

  function imageAction(slot, action) {
    const layer = layers[slot];
    switch (action) {
      case 'file':
        openFilePicker(slot, false);
        return;
      case 'camera':
        openCamera(slot);
        return;
      case 'paste':
        pasteInto(slot);
        return;
      case 'flipH':
        layer.flipH = !layer.flipH;
        break;
      case 'flipV':
        layer.flipV = !layer.flipV;
        break;
      case 'rotate':
        layer.rotate(1);
        break;
      case 'rotateCCW':
        layer.rotate(-1);
        break;
      case 'gray':
        layer.gray = !layer.gray;
        break;
      case 'contrast':
        layer.contrast = !layer.contrast;
        break;
      case 'reset':
        layer.reset();
        break;
      case 'clear':
        layer.clear();
        saveImage(slot, null);
        break;
      default:
        return;
    }
    syncUI();
    requestRender();
  }

  // Build the two control strips from the template.
  const dock = $('#dock');
  const template = $('#strip-template');
  for (const slot of SLOTS) {
    const strip = template.content.firstElementChild.cloneNode(true);
    strip.dataset.slot = slot;
    strip.setAttribute('aria-label', `${LABELS[slot]} controls`);
    $('.strip-label', strip).textContent = LABELS[slot];
    const input = $('input[type="file"]', strip);
    input.addEventListener('change', () => {
      loadInto(slot, input.files && input.files[0]);
      input.value = '';
    });
    strip.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) imageAction(slot, btn.dataset.action);
    });
    dock.appendChild(strip);
    strips[slot] = strip;
    fileInputs[slot] = input;

    // Buttons inside the pane's empty-state message.
    paneEls[slot].addEventListener('click', (e) => {
      const btn = e.target.closest('.dropzone [data-action]');
      if (btn) imageAction(dropTarget(slot), btn.dataset.action);
    });
  }

  // ---------------------------------------------------------------- global controls

  function setLayout(layout) {
    state.layout = layout;
    syncUI();
    for (const slot of SLOTS) panes[slot].measure(); // layout changed synchronously; re-measure now
    requestRender();
  }

  function setActive(slot) {
    state.active = slot;
    syncUI();
  }

  function fitAll() {
    for (const slot of SLOTS) layers[slot].reset();
    requestRender();
  }

  function setOpacity(value) {
    state.opacity = Math.min(1, Math.max(0, value));
    syncUI();
    requestRender();
  }

  async function exportPNG() {
    if (!SLOTS.some((s) => layers[s].hasImage)) {
      toast('Load an image first.');
      return;
    }
    render(); // make sure the canvases reflect the latest state
    const canvases = state.layout === 'overlay' ? [panes.drawing.canvas] : SLOTS.map((s) => panes[s].canvas);
    const out = composeExport({
      layout: state.layout,
      canvases,
      gap: Math.round(12 * (window.devicePixelRatio || 1)),
      background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || PANE_BG,
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    try {
      await downloadCanvas(out, `drawing-compare-${stamp}.png`);
    } catch (err) {
      console.error(err);
      toast('Export failed.');
    }
  }

  $$('input[name="layout"]').forEach((r) => r.addEventListener('change', () => setLayout(r.value)));
  $$('input[name="move"]').forEach((r) => r.addEventListener('change', () => setActive(r.value)));

  ui.link.addEventListener('click', () => {
    state.linked = !state.linked;
    syncUI();
    scheduleSave();
  });
  ui.grid.addEventListener('click', () => {
    state.grid = !state.grid;
    syncUI();
    requestRender();
  });
  ui.gray.addEventListener('click', () => {
    state.grayAll = !state.grayAll;
    syncUI();
    requestRender();
  });
  $('#btn-fit').addEventListener('click', fitAll);
  $('#btn-export').addEventListener('click', exportPNG);
  $('#btn-clear-saved').addEventListener('click', clearSaved);
  ui.swap.addEventListener('click', () => {
    state.overlayTop = other(state.overlayTop);
    syncUI();
    requestRender();
  });
  ui.opacity.addEventListener('input', () => setOpacity(ui.opacity.valueAsNumber / 100));

  $('#btn-help').addEventListener('click', () => helpDialog.showModal());
  $('[data-close]', helpDialog).addEventListener('click', () => helpDialog.close());

  // ---------------------------------------------------------------- keyboard

  function isEditable(el) {
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target) || document.querySelector('dialog[open]')) return;

    const active = state.active;
    const targets = state.linked ? SLOTS.filter((s) => layers[s].hasImage) : [active];
    const step = e.shiftKey ? 10 : 1;
    let handled = true;

    switch (e.key) {
      case '1': setLayout('side'); break;
      case '2': setLayout('stacked'); break;
      case '3': setLayout('overlay'); break;
      case 'l': case 'L': ui.link.click(); break;
      case 'g': case 'G': ui.grid.click(); break;
      case 'v': case 'V': ui.gray.click(); break;
      case 'f': case 'F': fitAll(); break;
      case 'e': case 'E': exportPNG(); break;
      case 'a': case 'A': setActive(other(active)); break;
      case 'm': imageAction(active, 'flipH'); break;
      case 'M': imageAction(active, 'flipV'); break;
      case 'r': imageAction(active, 'rotate'); break;
      case 'R': imageAction(active, 'rotateCCW'); break;
      case 'b': case 'B': imageAction(active, 'gray'); break;
      case 'c': case 'C': imageAction(active, 'contrast'); break;
      case '0': imageAction(active, 'reset'); break;
      case 'o': case 'O': if (state.layout === 'overlay') ui.swap.click(); break;
      case '[': setOpacity(state.opacity - 0.1); break;
      case ']': setOpacity(state.opacity + 0.1); break;
      case '?': helpDialog.showModal(); break;
      case 'ArrowLeft': targets.forEach((s) => layers[s].panBy(-step, 0)); requestRender(); break;
      case 'ArrowRight': targets.forEach((s) => layers[s].panBy(step, 0)); requestRender(); break;
      case 'ArrowUp': targets.forEach((s) => layers[s].panBy(0, -step)); requestRender(); break;
      case 'ArrowDown': targets.forEach((s) => layers[s].panBy(0, step)); requestRender(); break;
      case '+': case '=': targets.forEach((s) => layers[s].zoomAt(1.1)); requestRender(); break;
      case '-': case '_': targets.forEach((s) => layers[s].zoomAt(1 / 1.1)); requestRender(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---------------------------------------------------------------- UI sync

  function setPressed(btn, on) {
    btn.setAttribute('aria-pressed', String(on));
  }

  function syncUI() {
    document.body.dataset.layout = state.layout;
    $(`input[name="layout"][value="${state.layout}"]`).checked = true;
    setPressed(ui.link, state.linked);
    setPressed(ui.grid, state.grid);
    setPressed(ui.gray, state.grayAll);

    const overlay = state.layout === 'overlay';
    ui.overlayBar.hidden = !overlay;
    ui.swap.textContent = `Top: ${LABELS[state.overlayTop]}`;
    ui.opacity.value = Math.round(state.opacity * 100);
    ui.opacityOut.value = `${Math.round(state.opacity * 100)}%`;
    $(`input[name="move"][value="${state.active}"]`).checked = true;
    ui.moveTarget.disabled = state.linked;
    ui.moveHint.hidden = !state.linked;

    // Camera buttons: disabled with an explanation on devices without one
    // (phones keep them, falling back to the native camera via the file input).
    const noCamera = cameraStatus === 'none' && !IS_TOUCH;
    for (const btn of $$('[data-action="camera"]')) {
      btn.disabled = noCamera;
      btn.title = noCamera ? 'No camera detected on this device' : 'Take a photo';
    }

    for (const slot of SLOTS) {
      const layer = layers[slot];
      const paneEl = paneEls[slot];
      const strip = strips[slot];

      const inPane = layersInPane(slot);
      $('.dropzone', paneEl).hidden = inPane.some((l) => l.hasImage);
      $('.pane-label', paneEl).textContent = overlay
        ? `Overlay · ${LABELS[state.overlayTop]} over ${LABELS[other(state.overlayTop)]}`
        : LABELS[slot];
      paneEl.classList.toggle('active', !overlay && state.active === slot);

      strip.classList.toggle('active', state.active === slot);
      $$('.needs-image .btn', strip).forEach((b) => (b.disabled = !layer.hasImage));
      for (const [action, on] of [['flipH', layer.flipH], ['flipV', layer.flipV], ['gray', layer.gray], ['contrast', layer.contrast]]) {
        setPressed($(`[data-action="${action}"]`, strip), on);
      }
    }
  }

  // ---------------------------------------------------------------- misc

  let toastTimer = 0;
  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 4000);
  }

  // Browser zoom changes DPR without necessarily resizing the panes.
  window.addEventListener('resize', () => SLOTS.forEach((s) => panes[s].measure()));

  // ---------------------------------------------------------------- start

  for (const slot of SLOTS) panes[slot].measure();
  syncUI();
  requestRender();
  restoreSession();
  CameraDialog.detect().then((status) => {
    cameraStatus = status;
    syncUI();
  });
})();
