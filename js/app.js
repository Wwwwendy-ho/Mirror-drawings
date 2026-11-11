// Drawing Compare — app wiring. State lives here; rendering is a pure function
// of (state, layers) run on requestAnimationFrame. Images and view settings are
// persisted to the browser's own IndexedDB so a reload restores the session.

(() => {
  'use strict';
  const {
    Layer, Pane, Gestures, CameraDialog, CameraSession, Storage, Shelf, Aligner, Compare,
    decodeImage, imageFileFrom, readClipboardImage, composeExport, downloadCanvas,
  } = window.DrawingCompare;

  const SLOTS = ['drawing', 'reference'];
  const LABELS = { drawing: 'Drawing', reference: 'Reference' };
  const SETTINGS_KEYS = [
    'layout', 'linked', 'grid', 'grayAll', 'overlayTop', 'opacity', 'active',
    'compareMode', 'wipe', 'outlineDetail', 'tipFlick',
    'cameraDevices', 'cameraFacing', 'persistAsked',
  ]; // plus settings.activePhoto, written from the shelves
  const SAVE_DELAY = 500; // ms of quiet before view/settings are written
  const ALIGN_MS = 260; // duration of the alignment glide

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
    compareMode: 'tint', // overlay only: 'tint' | 'blend' | 'wipe' | 'outline'
    wipe: 0.5, // curtain position, fraction of the pane width
    outlineDetail: 0.5,
    tipFlick: false, // the one-time double-tap tip has been shown
    active: 'drawing', // the selected image: target for keyboard shortcuts and overlay-mode gestures
    showPrev: false, // show the previous photo of the drawing instead of the current one
    dotTarget: 'drawing', // which image taps place dots on when both are in one pane
    cameraDevices: {}, // remembered camera deviceId per facing ('environment' | 'user')
    cameraFacing: 'environment', // last camera used
    persistAsked: false, // navigator.storage.persist() has been requested once
  };

  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const PANE_BG = cssVar('--surround', '#7f7d79'); // neutral grey mat behind the artwork
  const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let rafId = 0;
  let saveTimer = 0;
  let restoring = true; // suppress saves until the stored session has been read
  let storageWarned = false;
  let cameraStatus = 'unknown'; // 'available' | 'none' | 'unknown'
  let pendingPasteSlot = null;
  let alignJob = 0; // id of the latest matching job; older results are dropped
  let animToken = 0;
  let undoAlign = null;
  let dotHintShown = false;
  let prevId = null; // shelf id of the photo prevLayer shows (the entry before the drawing's active one)
  let ghostToken = 0;
  let restoreDone;
  const restored = new Promise((resolve) => (restoreDone = resolve)); // adds wait for the stored session to load first
  const switchToken = { drawing: 0, reference: 0 };
  const shelfUI = { open: null, remove: false, key: '' }; // which slot's strip is open, and whether it is in remove mode

  const layers = Object.fromEntries(SLOTS.map((s) => [s, new Layer(s)]));
  const prevLayer = new Layer('previous'); // the ghost: the shelf entry before the drawing's active photo (shares its decoded canvas)
  const allLayers = [layers.drawing, layers.reference, prevLayer];
  const paneEls = Object.fromEntries(SLOTS.map((s) => [s, $(`.pane[data-slot="${s}"]`)]));
  const panes = Object.fromEntries(
    SLOTS.map((s) => [s, new Pane($('.pane-body', paneEls[s]), $('canvas', paneEls[s]), requestRender)]),
  );
  const toolsEls = {};
  const fileInputs = {};
  const dotEls = {}; // dotEls[paneSlot][layerSlot][i]
  const camera = new CameraDialog($('#camera-dialog'));
  const helpDialog = $('#help-dialog');
  const store = new Storage();
  const shelf = new Shelf(store);
  shelf.inUse = (canvas) => allLayers.some((l) => l.source === canvas);
  const shelfDialog = $('#shelf-dialog');

  const ui = {
    link: $('#btn-link'),
    grid: $('#btn-grid'),
    gray: $('#btn-gray'),
    overlayBar: $('#overlay-bar'),
    swap: $('#btn-swap'),
    swapLabel: $('#swap-label'),
    toolbar: $('.toolbar'),
    more: $('#btn-more'),
    opacity: $('#opacity'),
    opacityOut: $('#opacity-out'),
    rangeWrap: $('#range-wrap'),
    rangeLabel: $('#range-label'),
    wipeHandle: $('.wipe-handle'),
    wipeTags: { left: $('.wipe-tag.left'), right: $('.wipe-tag.right') },
    moveTarget: $('#move-target'),
    moveHint: $('#move-hint'),
    toast: $('#toast'),
    status: $('.pane[data-slot="drawing"] .pane-status'),
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

  const showingPrev = () => state.showPrev && prevLayer.hasImage;

  /** What is actually drawn for a slot: its layer (or the previous photo), or null if empty or hidden. */
  function visibleLayer(slot) {
    const layer = layers[slot];
    if (!layer.hasImage || layer.hidden) return null;
    return slot === 'drawing' && showingPrev() ? prevLayer : layer;
  }

  function render() {
    const opts = { grid: state.grid, grayAll: state.grayAll, background: PANE_BG };
    for (const slot of SLOTS) {
      const pane = panes[slot];
      if (!pane.width || !pane.height) continue;
      const stack = layersInPane(slot);
      // Hidden layers still get placed (pan/zoom keep applying to them) but are not drawn.
      for (const layer of stack) {
        layer.placeIn(pane.width, pane.height);
        if (layer === layers.drawing) prevLayer.placeIn(pane.width, pane.height);
      }
      let plan;
      if (state.layout === 'overlay') {
        const top = state.overlayTop;
        plan = Compare.plan({
          mode: state.compareMode,
          bottom: visibleLayer(other(top)),
          top: visibleLayer(top),
          drawing: visibleLayer('drawing'),
          reference: visibleLayer('reference'),
          opacity: state.opacity,
          wipe: state.wipe,
          detail: state.outlineDetail,
          paneWidth: pane.width,
        });
      } else {
        plan = { items: stack.map((l) => visibleLayer(l.id)).filter(Boolean).map((layer) => ({ layer })), isolate: false, divider: null };
      }
      pane.render(plan.items, { ...opts, isolate: plan.isolate, divider: plan.divider });
      positionDots(slot, stack);
    }
  }

  // ---------------------------------------------------------------- alignment dots

  // Each pane body holds four dot handles (two per image); only the ones whose
  // image is drawn in that pane, has dots switched on, and has that dot are shown.
  for (const paneSlot of SLOTS) {
    const body = $('.pane-body', paneEls[paneSlot]);
    dotEls[paneSlot] = {};
    for (const layerSlot of SLOTS) {
      dotEls[paneSlot][layerSlot] = [0, 1].map((i) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `dot dot-${layerSlot}`;
        el.hidden = true;
        el.dataset.n = String(i + 1); // shown by CSS as a numbered tab
        el.setAttribute('aria-label', `${LABELS[layerSlot]} dot ${i + 1}. Drag to move, double-click to remove.`);
        body.appendChild(el);

        const layer = layers[layerSlot];
        const moveTo = (e) => {
          const r = body.getBoundingClientRect();
          layer.dots[i] = layer.fromPane({ x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 });
          requestRender();
        };
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          el.setPointerCapture(e.pointerId);
          el.classList.add('dragging');
        });
        el.addEventListener('pointermove', (e) => {
          if (el.hasPointerCapture(e.pointerId)) moveTo(e);
        });
        const release = () => {
          el.classList.remove('dragging');
          syncUI();
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('dblclick', (e) => {
          e.preventDefault();
          layer.dots[i] = null;
          syncUI();
          requestRender();
        });
        return el;
      });
    }
  }

  function positionDots(paneSlot, stack) {
    const pane = panes[paneSlot];
    for (const layerSlot of SLOTS) {
      const layer = layers[layerSlot];
      const visible = stack.includes(layer) && layer.hasImage && !layer.hidden && layer.dotsOn && !(layerSlot === 'drawing' && showingPrev());
      dotEls[paneSlot][layerSlot].forEach((el, i) => {
        const dot = layer.dots[i];
        el.hidden = !(visible && dot);
        if (el.hidden) return;
        const q = layer.toPane(dot);
        el.style.transform = `translate(${pane.width / 2 + q.x}px, ${pane.height / 2 + q.y}px)`;
      });
    }
  }

  /** The image a tap in this pane should place a dot on, if any. */
  function dotLayerIn(paneSlot) {
    const candidates = layersInPane(paneSlot).filter((l) => l.hasImage && !l.hidden && l.dotsOn);
    if (candidates.length < 2) return candidates[0] || null;
    return layers[state.dotTarget];
  }

  function placeDot(paneSlot, x, y) {
    const layer = dotLayerIn(paneSlot);
    if (!layer || (layer === layers.drawing && showingPrev())) return;
    const i = layer.dots.findIndex((d) => !d);
    if (i < 0) {
      toast('Both dots are placed. Drag one to adjust it, or double-tap it to remove it.');
      return;
    }
    layer.dots[i] = layer.fromPane({ x, y });
    syncUI();
    requestRender();
  }

  // ---------------------------------------------------------------- alignment

  const placement = (l) => ({ x: l.x, y: l.y, scale: l.scale, angle: l.angle });

  /**
   * Placement for the moving image given the fixed image's placement and a match
   * m (moving -> fixed, in oriented source px: pf = m.s * R(m.theta) * pm + m.t).
   */
  function placementFromMatch(f, m) {
    const c = Math.cos(f.angle), s = Math.sin(f.angle);
    return {
      x: f.x + f.scale * (m.tx * c - m.ty * s),
      y: f.y + f.scale * (m.tx * s + m.ty * c),
      scale: f.scale * m.s,
      angle: f.angle + m.theta,
    };
  }

  /** Keep the previous photo registered to the drawing when the drawing is re-placed. */
  function carryPrevious(from, to) {
    if (!prevLayer.hasImage) return;
    const k = to.scale / from.scale;
    const d = to.angle - from.angle;
    const c = Math.cos(d), s = Math.sin(d);
    const dx = prevLayer.x - from.x, dy = prevLayer.y - from.y;
    prevLayer.x = to.x + k * (dx * c - dy * s);
    prevLayer.y = to.y + k * (dx * s + dy * c);
    prevLayer.scale *= k;
    prevLayer.angle += d;
  }

  function animateLayer(layer, target) {
    const token = ++animToken;
    const from = placement(layer);
    let done = false;
    const finish = () => {
      if (done || token !== animToken) return;
      done = true;
      Object.assign(layer, target);
      requestRender();
    };
    if (reducedMotion.matches) return finish();
    const t0 = performance.now();
    const step = (now) => {
      if (done || token !== animToken) return;
      const t = Math.min(1, (now - t0) / ALIGN_MS);
      const e = 1 - Math.pow(1 - t, 3);
      layer.x = from.x + (target.x - from.x) * e;
      layer.y = from.y + (target.y - from.y) * e;
      layer.angle = from.angle + (target.angle - from.angle) * e;
      layer.scale = from.scale * Math.pow(target.scale / from.scale, e);
      requestRender();
      if (t < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
    setTimeout(finish, ALIGN_MS + 300); // background tabs throttle rAF; never leave it half-way
  }

  /** Move the drawing to `target`, with an Undo offered in the toast. */
  function applyAlignment(target, message, { dots = null, carry = true, aligned = true } = {}) {
    const d = layers.drawing;
    const before = d.toJSON();
    const prevBefore = prevLayer.hasImage ? prevLayer.toJSON() : null;
    if (carry) carryPrevious(before, target);
    if (dots) d.dots = dots;
    d.moved = true;
    d.aligned = aligned;
    animateLayer(d, target);
    undoAlign = () => {
      animToken++;
      d.applyView(before);
      if (prevBefore) prevLayer.applyView(prevBefore);
      undoAlign = null;
      syncUI();
      requestRender();
      toast('Alignment undone.');
    };
    syncUI();
    toast(message, { label: 'Undo', run: () => undoAlign && undoAlign() });
  }

  function dotPairs() {
    const d = layers.drawing, r = layers.reference;
    return [0, 1].filter((i) => d.dots[i] && r.dots[i]);
  }

  /** Move the drawing so its dots land on the reference's dots. */
  function alignByDots() {
    const d = layers.drawing, r = layers.reference;
    const pairs = dotPairs();
    if (!d.hasImage || !r.hasImage || !pairs.length) {
      toast('Mark the same feature in both images first: switch on Dots in each pane and tap the image.');
      return;
    }
    render(); // make sure both placements are current
    const target = placement(d);
    if (pairs.length === 2) {
      const r1 = r.toPane(r.dots[0]), r2 = r.toPane(r.dots[1]);
      const d1 = d.orient(d.dots[0]), d2 = d.orient(d.dots[1]);
      const ax = d2.x - d1.x, ay = d2.y - d1.y;
      const bx = r2.x - r1.x, by = r2.y - r1.y;
      const den = ax * ax + ay * ay;
      if (den < 1 || bx * bx + by * by < 1) {
        toast('The two dots sit on top of each other. Move them apart and try again.');
        return;
      }
      // Complex ratio z = b / a: |z| is the scale, arg z the rotation.
      const zr = (bx * ax + by * ay) / den;
      const zi = (by * ax - bx * ay) / den;
      target.scale = Math.hypot(zr, zi);
      target.angle = Math.atan2(zi, zr);
      target.x = r1.x - (zr * d1.x - zi * d1.y);
      target.y = r1.y - (zi * d1.x + zr * d1.y);
      applyAlignment(target, 'Aligned on both dots: position, size and rotation.');
    } else {
      const i = pairs[0];
      const rp = r.toPane(r.dots[i]), dp = d.toPane(d.dots[i]);
      target.x += rp.x - dp.x;
      target.y += rp.y - dp.y;
      applyAlignment(target, `Centred on dot ${i + 1}. Add a second dot to match size and rotation too.`);
    }
  }

  function setBusy(text) {
    ui.status.hidden = !text;
    ui.status.textContent = text || '';
  }

  const NO_MATCH_HINT = 'A sketch and a photo can differ too much for automatic matching. Use Dots: mark the same two features in both images, then Align.';

  /** Estimate drawing -> reference and apply it only if the match is confident. */
  async function runAutoAlign(manual) {
    const d = layers.drawing, r = layers.reference;
    if (!d.hasImage || !r.hasImage) {
      if (manual) toast('Load both images first.');
      return null;
    }
    render();
    if (!r.frame) return null;
    const job = ++alignJob;
    setBusy('Aligning…');
    try {
      const res = await Aligner.estimate(Aligner.rasterize(d), Aligner.rasterize(r), (p) => {
        if (job === alignJob) setBusy(`Aligning… ${Math.round(p * 100)}%`);
      });
      if (job !== alignJob) return null;
      if (res.confident) applyAlignment(placementFromMatch(placement(r), res), 'Auto-aligned to the reference.');
      else toast(`${manual ? 'No confident match found, so nothing was moved.' : "Couldn't auto-align with confidence, so nothing was moved."} ${NO_MATCH_HINT}`);
      return res;
    } catch (err) {
      console.warn('Auto-align failed:', err);
      if (manual) toast('Auto-align failed. Use Dots and Align instead.');
      return null;
    } finally {
      if (job === alignJob) setBusy(null);
    }
  }

  /**
   * Retake: a new photo of the same drawing, already appended to the shelf as
   * `newId`. The old photo stays on the shelf one step back (it is the "Previous"
   * ghost); the new one is matched against it and inherits its placement and
   * dots. If the match is not confident the new photo simply sits where the old
   * one was.
   */
  async function retakeDrawing(newId, canvas) {
    const d = layers.drawing;
    render();
    const old = d.toJSON();
    const oldRaster = Aligner.rasterize(d);
    const oldId = shelf.active('drawing');
    const oldGhost = prevLayer.source;

    // The old photo keeps its own view on the shelf; the ghost shares its canvas (no copy).
    if (oldId) shelf.saveView(oldId, old).catch(storageFailed);
    prevLayer.setImage(d.source, null);
    prevLayer.applyView({ ...old, moved: !!old.frame });
    prevId = oldId;

    d.replaceImage(canvas, null);
    d.moved = true;
    shelf.setActive('drawing', newId);
    shelf.release(oldGhost);
    state.showPrev = false;
    setActive('drawing');
    requestRender();

    const job = ++alignJob;
    setBusy('Matching new photo…');
    try {
      const res = await Aligner.estimate(Aligner.rasterize(d), oldRaster, (p) => {
        if (job === alignJob) setBusy(`Matching new photo… ${Math.round(p * 100)}%`);
      });
      if (job !== alignJob) return null;
      if (res.confident) {
        // Old dots live in the old photo's coordinates; carry them into the new photo.
        const c = Math.cos(res.theta), s = Math.sin(res.theta);
        const dots = old.dots.map((p) => {
          if (!p) return null;
          const o = d.orient(p);
          const x = o.x - res.tx, y = o.y - res.ty;
          return d.unorient({ x: (x * c + y * s) / res.s, y: (-x * s + y * c) / res.s });
        });
        applyAlignment(placementFromMatch(old, res), 'New photo matched to the previous one. Alignment kept.', {
          dots,
          carry: false,
          aligned: old.aligned,
        });
      } else {
        toast("Couldn't match the new photo to the previous one with confidence, so it sits where the old one was. Nudge it into place, or re-place the dots and Align.");
      }
      return res;
    } catch (err) {
      console.warn('Retake matching failed:', err);
      return null;
    } finally {
      if (job === alignJob) setBusy(null);
    }
  }

  // ---------------------------------------------------------------- persistence

  function storageFailed(err) {
    console.warn('Storage unavailable:', err);
    if (storageWarned) return;
    storageWarned = true;
    toast("Can't save to this browser's storage (private mode or quota), so this session won't be restored after a reload.");
  }

  /** Debounced write of the views and the global settings. */
  function scheduleSave() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DELAY);
  }

  /** The id to store as a slot's active photo: the easel photo if it is saved, else the newest saved one. */
  function persistedActive(slot) {
    const rec = shelf.record(shelf.active(slot));
    if (rec && !rec.unsaved) return rec.id;
    const saved = shelf.list(slot).filter((r) => !r.unsaved);
    return saved.length ? saved[saved.length - 1].id : null;
  }

  /** Write settings and the views of the photos on the easels (and the ghost) now. */
  async function flushSave() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      const settings = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, state[k]]));
      settings.activePhoto = Object.fromEntries(SLOTS.map((s) => [s, persistedActive(s)]));
      await store.set('settings', settings);
      for (const slot of SLOTS) {
        const id = shelf.active(slot);
        if (id && layers[slot].hasImage) await shelf.saveView(id, layers[slot].toJSON());
      }
      if (prevId && prevLayer.hasImage) await shelf.saveView(prevId, prevLayer.toJSON());
    } catch (err) {
      storageFailed(err);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave();
  });
  window.addEventListener('pagehide', flushSave);

  /** Stored settings are untrusted (older sessions, hand edits): coerce the compare keys into range. */
  function sanitiseSettings() {
    const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
    if (!Compare.MODES.includes(state.compareMode)) state.compareMode = 'tint';
    state.wipe = num(state.wipe, Compare.WIPE_MIN, Compare.WIPE_MAX, 0.5);
    state.outlineDetail = num(state.outlineDetail, 0, 1, 0.5);
    state.opacity = num(state.opacity, 0, 1, 0.5);
    state.tipFlick = state.tipFlick === true;
    if (!SLOTS.includes(state.overlayTop)) state.overlayTop = 'drawing';
    if (!SLOTS.includes(state.active)) state.active = 'drawing';
    state.cameraFacing = state.cameraFacing === 'user' ? 'user' : 'environment';
    const devices = state.cameraDevices && typeof state.cameraDevices === 'object' && !Array.isArray(state.cameraDevices) ? state.cameraDevices : {};
    state.cameraDevices = {};
    for (const f of ['environment', 'user']) if (typeof devices[f] === 'string' && devices[f]) state.cameraDevices[f] = devices[f];
    state.persistAsked = state.persistAsked === true;
  }

  async function restoreSession() {
    try {
      if (!store.available) throw new Error('IndexedDB is not available');
      const settings = await store.get('settings');
      if (settings && typeof settings === 'object') {
        for (const k of SETTINGS_KEYS) if (k in settings) state[k] = settings[k];
        sanitiseSettings();
      }
      CameraSession.setPrefs(state.cameraDevices, state.cameraFacing);
      await shelf.load(); // migrates legacy single-image keys, sweeps orphans; decodes nothing
      const wanted = (settings && settings.activePhoto) || {};
      for (const slot of SLOTS) {
        // Decode only the photo on the easel (newest first if the remembered one is unreadable).
        const list = shelf.list(slot).map((r) => r.id).reverse();
        if (list.includes(wanted[slot])) list.unshift(wanted[slot]);
        for (const id of list) {
          try {
            const canvas = await shelf.canvasFor(id);
            const view = await shelf.getView(id);
            layers[slot].setImage(canvas, null);
            layers[slot].applyView(view);
            shelf.setActive(slot, id);
            break;
          } catch (err) {
            console.warn(`Could not restore ${slot} photo ${id}:`, err);
          }
        }
      }
    } catch (err) {
      storageFailed(err);
    } finally {
      restoring = false;
      restoreDone();
      syncUI();
      requestRender();
      syncGhost();
    }
  }

  async function clearSaved() {
    const d = shelf.count('drawing'), r = shelf.count('reference'), n = d + r;
    const message = n
      ? `Remove all ${n} saved photo${n === 1 ? '' : 's'} (${d} drawing, ${r} reference) and view settings from this browser?`
      : 'Remove all saved view settings from this browser?';
    if (!confirm(message)) return;
    alignJob++;
    switchToken.drawing++;
    switchToken.reference++;
    setBusy(null);
    closeStrip();
    const shown = allLayers.map((l) => l.source);
    allLayers.forEach((l) => l.clear());
    prevId = null;
    state.showPrev = false;
    undoAlign = null;
    try {
      await shelf.clearAll();
      toast('All saved photos cleared.', null, 'ok');
    } catch (err) {
      storageFailed(err);
    }
    shown.forEach((c) => shelf.release(c));
    syncUI();
    requestRender();
  }

  // ---------------------------------------------------------------- gestures

  /** A slot's layer plus anything that must travel with it (the previous photo). */
  const withCompanions = (slot) => (slot === 'drawing' && prevLayer.hasImage ? [layers.drawing, prevLayer] : [layers[slot]]);

  function targetLayers(slots) {
    return slots.filter((s) => layers[s].hasImage).flatMap(withCompanions);
  }

  /** Which layers a gesture that started in `slot`'s pane should move. */
  function gestureTargets(slot) {
    if (state.linked) return targetLayers(SLOTS);
    return targetLayers([state.layout === 'overlay' ? state.active : slot]);
  }

  /**
   * Fit both images. If the drawing is aligned to the reference, the pair is
   * fitted as one (reference fits, drawing follows) so the alignment survives.
   */
  function fitPair() {
    const d = layers.drawing, r = layers.reference;
    if (d.hasImage && r.hasImage && d.aligned && r.frame) {
      const frame = r.frame;
      const old = placement(r);
      r.reset();
      r.placeIn(frame.w, frame.h);
      const k = r.scale / old.scale;
      for (const l of withCompanions('drawing')) {
        l.x = r.x + k * (l.x - old.x);
        l.y = r.y + k * (l.y - old.y);
        l.scale *= k;
      }
    } else {
      for (const layer of allLayers) layer.reset();
    }
    syncUI();
    requestRender();
  }

  /** Hide or show a slot's image. In Overlay, hiding one shows the other (never an empty overlay). */
  function setHidden(slot, on) {
    const layer = layers[slot];
    if (!layer.hasImage) return;
    layer.hidden = on;
    if (on && state.layout === 'overlay') layers[other(slot)].hidden = false;
    syncUI();
    requestRender();
  }

  const toggleHidden = (slot) => setHidden(slot, !layers[slot].hidden);

  for (const slot of SLOTS) {
    new Gestures(panes[slot].canvas, {
      onPress: () => {
        if (state.layout !== 'overlay' && layers[slot].hasImage) setActive(slot);
      },
      onPan: (dx, dy) => {
        for (const l of gestureTargets(slot)) l.panBy(dx, dy);
        requestRender();
      },
      onZoom: (factor, x, y) => {
        for (const l of gestureTargets(slot)) l.zoomAt(factor, x, y);
        requestRender();
      },
      onTap: (x, y) => placeDot(slot, x, y),
      // Double-tap / double-click hides or shows the selected image (never fits).
      onDoubleTap: () => {
        if (dotLayerIn(slot)) return; // taps are placing dots here
        toggleHidden(state.layout === 'overlay' ? state.active : slot);
      },
    });
  }

  // ---------------------------------------------------------------- loading

  /** Remember the view of the photo on a slot's easel right now (not after the debounce). */
  function saveCurrentView(slot) {
    const id = shelf.active(slot);
    if (id && layers[slot].hasImage) shelf.saveView(id, layers[slot].toJSON()).catch(storageFailed);
  }

  /** Placement of `fromView` carried onto another photo of (about) the same shape, like retake does. */
  function inheritPlacement(layer, fromView, fromCanvas, toCanvas) {
    layer.applyView(fromView);
    const r = toCanvas.width / fromCanvas.width;
    layer.scale /= r;
    layer.dots = layer.dots.map((d) => (d ? { x: d.x * r, y: d.y * r } : null));
  }

  const sameShape = (a, b) => Math.abs(a.width / a.height / (b.width / b.height) - 1) <= 0.02;

  /** Append a decoded photo to a slot's shelf (asking before anything is removed), then show it. */
  async function loadInto(slot, blob) {
    if (!blob) return;
    await restored; // the stored session is read first, so a new photo is appended to it, never mistaken for it
    let canvas;
    try {
      canvas = await decodeImage(blob);
    } catch (err) {
      console.error(err);
      toast(`Couldn't read that image${blob.type ? ` (${blob.type})` : ''}.`);
      return;
    }
    saveCurrentView(slot);
    const res = await shelf.add(slot, canvas, blob, { resolve: (problem) => askShelfProblem(slot, problem) });
    if (res.error) storageFailed(res.error);
    if (slot === 'drawing' && layers.drawing.hasImage) {
      // New photo of the same drawing: keep the alignment. The swap is synchronous; matching takes a while.
      const matching = retakeDrawing(res.id, canvas);
      afterAdd(slot, res);
      await matching;
      notifyUnsaved(res); // after the match result, so the warning is not replaced by it
    } else {
      showNewPhoto(slot, res.id, canvas);
      afterAdd(slot, res);
      notifyUnsaved(res);
    }
  }

  /** Put a freshly added photo on the easel with a plain fit (first photo, or a new reference). */
  function showNewPhoto(slot, id, canvas) {
    const layer = layers[slot];
    const old = layer.source;
    layer.setImage(canvas, null);
    if (slot === 'reference' && layers.drawing.hasImage) {
      // A different reference: the old alignment no longer means anything.
      layers.drawing.reset();
      prevLayer.reset();
    }
    shelf.setActive(slot, id);
    shelf.release(old);
    setActive(slot);
    requestRender();
    if (slot === 'drawing') syncGhost();
    // First time both images are present: try to line them up automatically.
    // (loadInto is only reached from user actions; a restored session skips this.)
    if (layers[other(slot)].hasImage) {
      runAutoAlign(false);
      showFlickTip();
    }
  }

  /** After a photo was added: say if it is not saved, and ask for persistent storage once history exists. */
  function afterAdd(slot, res) {
    if (res.saved) {
      if (shelf.count(slot) >= 2 && !state.persistAsked) {
        state.persistAsked = true;
        scheduleSave();
        try {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        } catch {
          /* the result is not needed */
        }
      }
    } else if (!res.memoryOnly && res.choice === 'choose') {
      openStrip(slot, { remove: true });
    }
    showFlickTip();
    syncUI();
  }

  /** Never leave a photo unsaved without saying so (the count also shows a vermilion asterisk). */
  function notifyUnsaved(res) {
    if (res.saved || res.memoryOnly || !shelf.record(res.id) || !shelf.record(res.id).unsaved) return;
    toast(
      res.choice === 'choose'
        ? 'Remove a photo to make room; the new photo is saved as soon as there is space.'
        : 'The new photo is shown for this session only: it is not saved, and will be gone after a reload.',
    );
  }

  /** Full shelf or little storage: ask what to do. Nothing is deleted unless the answer is 'remove-oldest'. */
  function askShelfProblem(slot, problem) {
    const victimId = shelf.oldestRemovable(slot, problem);
    const victim = victimId && shelf.record(victimId);
    const make = victim
      ? `Remove the oldest ${problem === 'full' ? '' : `${LABELS[victim.slot]} photo `}(${shelf.label(victimId)}) to make room?`
      : 'Remove a photo to make room, or keep the new one for this session only.';
    $('#shelf-dialog-text').textContent =
      problem === 'full'
        ? `The ${LABELS[slot]} shelf is full (${shelf.limit} photos). ${make}`
        : `This browser has little storage left for this site, so the new photo may not be saved. ${make}`;
    $('#shelf-dialog-remove').hidden = !victim;
    return new Promise((resolve) => {
      const onClick = (e) => {
        const choice = e.target.closest('[data-choice]');
        if (choice) shelfDialog.close(choice.dataset.choice);
      };
      shelfDialog.returnValue = '';
      shelfDialog.addEventListener('click', onClick);
      shelfDialog.addEventListener(
        'close',
        () => {
          shelfDialog.removeEventListener('click', onClick);
          resolve(shelfDialog.returnValue || 'cancel'); // Escape = Cancel
        },
        { once: true },
      );
      shelfDialog.showModal();
    });
  }

  // ---------------------------------------------------------------- shelf: switching and removing

  /** Put another photo of the slot's shelf on the easel. */
  async function switchPhoto(slot, id) {
    if (!shelf.record(id) || id === shelf.active(slot)) return;
    const token = ++switchToken[slot];
    alignJob++; // an alignment still running was for the photo being left
    setBusy(null);
    saveCurrentView(slot);
    let canvas, view;
    try {
      // The ghost already holds the decoded previous photo: reuse it rather than decode again.
      const ghost = slot === 'drawing' && id === prevId && prevLayer.source ? Promise.resolve(prevLayer.source) : shelf.canvasFor(id);
      [canvas, view] = await Promise.all([ghost, shelf.getView(id)]);
    } catch (err) {
      console.warn(err);
      toast("Couldn't open that photo.");
      return;
    }
    if (token !== switchToken[slot] || !shelf.record(id)) return;
    shelf.adopt(id, canvas);
    const layer = layers[slot];
    const before = layer.hasImage ? { view: layer.toJSON(), canvas: layer.source } : null;
    layer.setImage(canvas, null);
    if (view) layer.applyView(view);
    else if (before && sameShape(before.canvas, canvas)) inheritPlacement(layer, before.view, before.canvas, canvas); // like a retake
    shelf.setActive(slot, id);
    if (before) shelf.release(before.canvas);
    if (slot === 'drawing') await syncGhost();
    syncUI();
    requestRender();
  }

  function stepPhoto(slot, direction) {
    const ids = shelf.ids[slot];
    const next = ids[ids.indexOf(shelf.active(slot)) + direction];
    if (next) switchPhoto(slot, next);
  }

  /**
   * The drawing's ghost is the shelf entry before the active photo, decoded
   * through the shelf's small canvas cache (no second copy). It shares the
   * drawing's placement, so it stays registered while both move together.
   */
  async function syncGhost() {
    const token = ++ghostToken;
    const prev = layers.drawing.hasImage ? shelf.previous('drawing') : null;
    if (!prev) {
      if (prevLayer.hasImage) {
        const old = prevLayer.source;
        prevLayer.clear();
        shelf.release(old);
      }
      prevId = null;
      state.showPrev = false;
      syncUI();
      requestRender();
      return;
    }
    if (prevId === prev.id && prevLayer.hasImage) return;
    let canvas, view;
    try {
      [canvas, view] = await Promise.all([shelf.canvasFor(prev.id, { cache: false }), shelf.getView(prev.id)]);
    } catch (err) {
      console.warn('Could not load the previous photo:', err);
      return;
    }
    if (token !== ghostToken || shelf.previous('drawing') !== prev) return;
    const old = prevLayer.source;
    prevLayer.setImage(canvas, null);
    if (view) prevLayer.applyView(view);
    else if (layers.drawing.hasImage) inheritPlacement(prevLayer, layers.drawing.toJSON(), layers.drawing.source, canvas);
    prevId = prev.id;
    shelf.release(old);
    syncUI();
    requestRender();
  }

  /** Remove the photo on the easel, after asking. */
  async function removeCurrent(slot) {
    const id = shelf.active(slot);
    if (!id || !layers[slot].hasImage) return;
    if (!confirm(`Remove this photo from the ${LABELS[slot]} shelf? This cannot be undone.`)) return;
    await removePhoto(slot, id);
  }

  async function removePhoto(slot, id) {
    const wasActive = shelf.active(slot) === id;
    const next = shelf.neighbour(id);
    try {
      await shelf.remove(id);
    } catch (err) {
      storageFailed(err);
      toast("Couldn't remove that photo.");
      return;
    }
    if (wasActive) {
      alignJob++;
      switchToken[slot]++;
      setBusy(null);
      if (next) {
        await switchPhoto(slot, next);
      } else {
        const old = layers[slot].source;
        layers[slot].clear();
        shelf.release(old);
        if (slot === 'drawing') {
          const g = prevLayer.source;
          prevLayer.clear();
          shelf.release(g);
          prevId = null;
          state.showPrev = false;
        } else {
          layers.drawing.aligned = false;
        }
      }
    } else if (slot === 'drawing') {
      await syncGhost(); // the removed photo may have been the ghost
    }
    // Room was made: store photos that were kept in memory only.
    let saved = 0;
    for (const s of SLOTS) if (shelf.unsavedIds(s).length) saved += await shelf.saveUnsaved(s);
    if (saved) toast(saved === 1 ? 'The new photo is now saved.' : `${saved} photos are now saved.`, null, 'ok');
    if (shelfUI.remove && !SLOTS.some((s) => shelf.unsavedIds(s).length)) closeStrip();
    syncUI();
    requestRender();
  }

  /** One-time tip, the first time both images are loaded; waits for any other toast (e.g. the align result) to finish. */
  function showFlickTip(tries = 0) {
    if (state.tipFlick || !SLOTS.every((s) => layers[s].hasImage)) return;
    if (ui.toast.classList.contains('show') || !ui.status.hidden) {
      if (tries < 40) setTimeout(() => showFlickTip(tries + 1), 1000);
      return;
    }
    state.tipFlick = true;
    scheduleSave();
    toast('Tip: double-tap an image to hide it, again to bring it back.');
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
    if (CameraSession.permissionState === 'denied' && !CameraSession.isOn() && IS_TOUCH) {
      // Blocked for this site: getUserMedia would fail without asking. The phone's camera app still works.
      toast("Camera is blocked for this site, using the phone's camera app instead.");
      openFilePicker(slot, true);
      return;
    }
    // On desktop a blocked camera opens the dialog in its error state (no getUserMedia call, see CameraDialog).
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
      case 'align':
        alignByDots();
        return;
      case 'auto':
        runAutoAlign(true);
        return;
      case 'hide':
        setHidden(slot, !layer.hidden);
        return; // setHidden syncs and re-renders itself
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
      case 'dots':
        if (!layer.hasImage) return;
        layer.dotsOn = !layer.dotsOn;
        if (layer.dotsOn) {
          layer.hidden = false; // dots can only be placed on a visible image
          state.dotTarget = slot;
          if (!dotHintShown) {
            dotHintShown = true;
            toast('Tap the image to place dot 1, then dot 2, on features you can find in both images. Drag a dot to adjust; double-tap it to remove.');
          }
        }
        break;
      case 'prev':
        if (!prevLayer.hasImage) return;
        state.showPrev = !state.showPrev;
        break;
      case 'reset':
        for (const l of withCompanions(slot)) l.reset();
        layers.drawing.aligned = false; // either image re-fitted on its own breaks the pairing
        break;
      case 'clear':
        removeCurrent(slot); // removes the photo on the easel (after asking); syncs and re-renders itself
        return;
      default:
        return;
    }
    syncUI();
    requestRender();
  }

  // Each pane owns its tools: cloned from the template into the pane head.
  const template = $('#tools-template');
  for (const slot of SLOTS) {
    const paneEl = paneEls[slot];
    const tools = template.content.firstElementChild.cloneNode(true);
    if (slot !== 'drawing') $$('.drawing-only', tools).forEach((el) => el.remove());
    $('.pane-tools', paneEl).appendChild(tools);
    toolsEls[slot] = tools;

    const input = $('input[type="file"]', tools);
    input.addEventListener('change', () => {
      loadInto(slot, input.files && input.files[0]);
      input.value = '';
    });
    fileInputs[slot] = input;

    // One delegated handler per pane: head tools, head "Add image", and the
    // empty-state buttons. Empty-state buttons in overlay mode fill whichever
    // slot is empty; everything else acts on this pane's own slot.
    paneEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('.tools-toggle');
      if (toggle) {
        setTrayOpen(slot, !paneEl.classList.contains('tools-open'));
        return;
      }
      const chip = e.target.closest('.hidden-chip');
      if (chip) {
        setHidden(chip.dataset.target, false);
        return;
      }
      const step = e.target.closest('[data-shelf]');
      if (step) {
        if (step.disabled) return;
        if (step.dataset.shelf === 'prev') stepPhoto(slot, -1);
        else if (step.dataset.shelf === 'next') stepPhoto(slot, 1);
        else if (shelfUI.open === slot) closeStrip(true);
        else openStrip(slot);
        return;
      }
      const item = e.target.closest('.shelf-item[data-id]');
      if (item) {
        if (shelfUI.remove) {
          const id = item.dataset.id;
          if (confirm(`Remove this photo from the ${LABELS[slot]} shelf? This cannot be undone.`)) removePhoto(slot, id);
        } else {
          switchPhoto(slot, item.dataset.id);
          closeStrip(true);
        }
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      if (btn.closest('.shelf')) closeStrip();
      const action = btn.dataset.action;
      const target = btn.closest('.dropzone') ? dropTarget(slot) : slot;
      imageAction(target, action);
      // Actions that need the image itself next: get the tray out of the way.
      if (['clear', 'dots', 'align', 'auto'].includes(action)) setTrayOpen(slot, false);
    });
  }

  function setTrayOpen(slot, open) {
    paneEls[slot].classList.toggle('tools-open', open);
    $('.tools-toggle', paneEls[slot]).setAttribute('aria-expanded', String(open));
  }

  // ---------------------------------------------------------------- shelf strip

  const stripEl = (slot) => $('.shelf', paneEls[slot]);

  function openStrip(slot, { remove = false } = {}) {
    if (shelfUI.open && shelfUI.open !== slot) closeStrip();
    if (!shelf.count(slot)) return;
    shelfUI.open = slot;
    shelfUI.remove = remove;
    shelfUI.key = '';
    const strip = stripEl(slot);
    // Under the head (its height varies when it wraps); in Overlay the Reference head sits at the bottom, so CSS opens it upward.
    strip.style.top = state.layout === 'overlay' && slot === 'reference' ? '' : `${$('.pane-head', paneEls[slot]).offsetHeight}px`;
    strip.hidden = false;
    $('.shelf-count', paneEls[slot]).setAttribute('aria-expanded', 'true');
    renderStrip(slot);
    const selected = $('.shelf-item[aria-selected="true"]', strip) || $('.shelf-item[data-id]', strip);
    if (selected) {
      strip.scrollLeft = selected.offsetLeft - (strip.clientWidth - selected.offsetWidth) / 2;
      selected.focus({ preventScroll: true });
    }
  }

  function closeStrip(restoreFocus = false) {
    const slot = shelfUI.open;
    if (!slot) return;
    shelfUI.open = null;
    shelfUI.remove = false;
    stripEl(slot).hidden = true;
    const count = $('.shelf-count', paneEls[slot]);
    count.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !count.closest('[hidden]')) count.focus({ preventScroll: true });
  }

  /** Thumbnails of the open strip; rebuilt only when the shelf, the selection or the mode changed. */
  function renderStrip(slot) {
    const key = `${shelf.version}|${shelf.active(slot)}|${shelfUI.remove}`;
    if (shelfUI.key === key) return;
    shelfUI.key = key;
    const strip = stripEl(slot);
    strip.dataset.mode = shelfUI.remove ? 'remove' : 'pick';
    const hadFocus = strip.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const list = $('.shelf-list', strip);
    list.textContent = '';
    for (const rec of shelf.list(slot)) {
      const b = document.createElement('button');
      const selected = rec.id === shelf.active(slot);
      b.type = 'button';
      b.className = `shelf-item${rec.unsaved ? ' unsaved' : ''}`;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(selected));
      b.dataset.id = rec.id;
      const label = shelf.label(rec.id) + (rec.unsaved ? ' (not saved)' : '');
      b.title = shelfUI.remove ? `Remove ${label}` : label;
      b.setAttribute('aria-label', b.title);
      const url = shelf.thumbUrl(rec.id);
      if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        b.appendChild(img);
      }
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(shelf.index(rec.id) + 1);
      b.appendChild(num);
      const trash = document.createElement('span');
      trash.className = 'trash';
      trash.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>';
      b.appendChild(trash);
      list.appendChild(b);
      if (hadFocus === rec.id) b.focus({ preventScroll: true });
    }
  }

  // Arrow keys move within the strip (and must not also nudge the image); Escape closes it.
  for (const slot of SLOTS) {
    stripEl(slot).addEventListener('keydown', (e) => {
      const items = $$('.shelf-item[data-id]', stripEl(slot));
      const i = items.indexOf(document.activeElement);
      const last = items.length - 1;
      const to = { ArrowRight: Math.min(last, i + 1), ArrowDown: Math.min(last, i + 1), ArrowLeft: Math.max(0, i - 1), ArrowUp: Math.max(0, i - 1), Home: 0, End: last }[e.key];
      if (to !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        if (items[to]) items[to].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeStrip(true);
      }
    });
  }

  // "More" popover on phones (inline buttons on desktop).
  function setMoreOpen(open) {
    ui.toolbar.classList.toggle('open', open);
    ui.more.setAttribute('aria-expanded', String(open));
  }
  ui.more.addEventListener('click', () => setMoreOpen(!ui.toolbar.classList.contains('open')));
  $('#overflow').addEventListener('click', (e) => {
    if (e.target.closest('.btn')) setMoreOpen(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (ui.toolbar.classList.contains('open') && !e.target.closest('.toolbar')) setMoreOpen(false);
    const openPane = SLOTS.find((s) => paneEls[s].classList.contains('tools-open'));
    if (openPane && !e.target.closest('.pane-head')) setTrayOpen(openPane, false);
    if (shelfUI.open && !e.target.closest('.shelf, .shelf-step')) closeStrip();
  });

  // ---------------------------------------------------------------- global controls

  function setLayout(layout) {
    state.layout = layout;
    closeStrip(); // its position depends on the layout
    // Overlay never shows nothing: if both images were hidden, bring the other one back.
    if (layout === 'overlay' && layers.drawing.hidden && layers.reference.hidden) layers[other(state.active)].hidden = false;
    syncUI();
    for (const slot of SLOTS) panes[slot].measure(); // layout changed synchronously; re-measure now
    requestRender();
  }

  function setActive(slot) {
    state.active = slot;
    syncUI();
  }

  function setOpacity(value) {
    state.opacity = Math.min(1, Math.max(0, value));
    syncUI();
    requestRender();
  }

  function setCompareMode(mode) {
    if (!Compare.MODES.includes(mode)) return;
    state.compareMode = mode;
    syncUI();
    requestRender();
  }

  function stepCompareMode(direction) {
    const modes = Compare.MODES;
    setCompareMode(modes[(modes.indexOf(state.compareMode) + direction + modes.length) % modes.length]);
  }

  function setWipe(value) {
    state.wipe = Math.min(Compare.WIPE_MAX, Math.max(Compare.WIPE_MIN, value));
    syncWipe();
    requestRender();
  }

  function setOutlineDetail(value) {
    state.outlineDetail = Math.min(1, Math.max(0, value));
    syncUI();
    requestRender();
  }

  /** The one contextual value: opacity (Blend), curtain (Wipe), detail (Outline); nothing in Tint. */
  function nudgeContextual(delta) {
    if (state.layout !== 'overlay') return;
    if (state.compareMode === 'blend') setOpacity(state.opacity + delta);
    else if (state.compareMode === 'wipe') setWipe(state.wipe + delta / 2);
    else if (state.compareMode === 'outline') setOutlineDetail(state.outlineDetail + delta);
  }

  // Wipe curtain handle: a grab target over the canvas; pointer events never reach the canvas gestures.
  {
    const handle = ui.wipeHandle;
    const body = handle.parentElement;
    const fromPointer = (e) => {
      const r = body.getBoundingClientRect();
      setWipe((e.clientX - r.left) / r.width);
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.focus({ preventScroll: true });
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer: moves still arrive */
      }
      handle.dataset.dragging = e.pointerId;
      fromPointer(e);
    });
    handle.addEventListener('pointermove', (e) => {
      if (handle.dataset.dragging === String(e.pointerId)) fromPointer(e);
    });
    const end = (e) => {
      if (handle.dataset.dragging === String(e.pointerId)) delete handle.dataset.dragging;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const next = { ArrowLeft: state.wipe - step, ArrowRight: state.wipe + step, Home: Compare.WIPE_MIN, End: Compare.WIPE_MAX }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation(); // not also a global nudge of the image
      setWipe(next);
    });
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
      background: cssVar('--paper', PANE_BG),
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    try {
      await downloadCanvas(out, `${(window.SITE && SITE.slug) || 'compare'}-${stamp}.png`);
    } catch (err) {
      console.error(err);
      toast('Export failed.');
    }
  }

  $$('input[name="layout"]').forEach((r) => r.addEventListener('change', () => setLayout(r.value)));
  $$('input[name="move"]').forEach((r) => r.addEventListener('change', () => setActive(r.value)));
  $$('input[name="compare"]').forEach((r) => r.addEventListener('change', () => setCompareMode(r.value)));

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
  $('#btn-fit').addEventListener('click', fitPair);
  $('#btn-export').addEventListener('click', exportPNG);
  $('#btn-clear-saved').addEventListener('click', clearSaved);
  ui.swap.addEventListener('click', () => {
    state.overlayTop = other(state.overlayTop);
    syncUI();
    requestRender();
  });
  ui.opacity.addEventListener('input', () => {
    const v = ui.opacity.valueAsNumber / 100;
    if (state.compareMode === 'outline') setOutlineDetail(v);
    else setOpacity(v);
  });

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
    const targets = state.linked ? targetLayers(SLOTS) : targetLayers([active]);
    const step = e.shiftKey ? 10 : 1;
    const nudge = (dx, dy) => {
      targets.forEach((l) => l.panBy(dx, dy));
      requestRender();
    };
    const zoom = (f) => {
      targets.forEach((l) => l.zoomAt(f));
      requestRender();
    };
    let handled = true;

    switch (e.key) {
      case '1': setLayout('side'); break;
      case '2': setLayout('stacked'); break;
      case '3': setLayout('overlay'); break;
      case 'l': case 'L': ui.link.click(); break;
      case 'g': case 'G': ui.grid.click(); break;
      case 'v': case 'V': ui.gray.click(); break;
      case 'f': case 'F': fitPair(); break;
      case 'e': case 'E': exportPNG(); break;
      case 'a': case 'A': setActive(other(active)); break;
      case 'm': imageAction(active, 'flipH'); break;
      case 'M': imageAction(active, 'flipV'); break;
      case 'r': imageAction(active, 'rotate'); break;
      case 'R': imageAction(active, 'rotateCCW'); break;
      case 'b': case 'B': imageAction(active, 'gray'); break;
      case 'c': case 'C': imageAction(active, 'contrast'); break;
      case 'd': case 'D': imageAction(active, 'dots'); break;
      case 'p': case 'P': imageAction('drawing', 'prev'); break;
      case 'z': case 'Z': if (undoAlign) undoAlign(); break;
      case '0': imageAction(active, 'reset'); break;
      case 'o': case 'O': if (state.layout === 'overlay' && !ui.swap.hidden) ui.swap.click(); break;
      case 'h': case 'H': imageAction(active, 'hide'); break;
      case 't': if (state.layout === 'overlay') stepCompareMode(1); break;
      case 'T': if (state.layout === 'overlay') stepCompareMode(-1); break;
      case '[': nudgeContextual(-0.1); break;
      case ']': nudgeContextual(0.1); break;
      case ',': stepPhoto(active, -1); break;
      case '.': stepPhoto(active, 1); break;
      case '?': helpDialog.showModal(); break;
      case 'Escape': setMoreOpen(false); SLOTS.forEach((s) => setTrayOpen(s, false)); closeStrip(true); break;
      case 'ArrowLeft': nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp': nudge(0, -step); break;
      case 'ArrowDown': nudge(0, step); break;
      case '+': case '=': zoom(1.1); break;
      case '-': case '_': zoom(1 / 1.1); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---------------------------------------------------------------- UI sync

  function setPressed(btn, on) {
    if (btn) btn.setAttribute('aria-pressed', String(on));
  }

  function syncUI() {
    document.body.dataset.layout = state.layout;
    $(`input[name="layout"][value="${state.layout}"]`).checked = true;
    setPressed(ui.link, state.linked);
    setPressed(ui.grid, state.grid);
    setPressed(ui.gray, state.grayAll);

    const overlay = state.layout === 'overlay';
    ui.overlayBar.hidden = !overlay;
    const mode = state.compareMode;
    document.body.dataset.compare = overlay ? mode : '';
    $(`input[name="compare"][value="${mode}"]`).checked = true;
    const top = state.overlayTop;
    ui.swapLabel.textContent =
      mode === 'wipe' ? `${LABELS[top]} left, ${LABELS[other(top)]} right` : `${LABELS[top]} over ${LABELS[other(top)]}`;
    ui.swap.hidden = !(mode === 'blend' || mode === 'wipe');
    // One contextual slider: Opacity (Blend) or Detail (Outline); Tint has none, Wipe uses the on-canvas handle.
    ui.rangeWrap.hidden = !(mode === 'blend' || mode === 'outline');
    const rangeValue = mode === 'outline' ? state.outlineDetail : state.opacity;
    ui.rangeLabel.textContent = mode === 'outline' ? 'Detail' : 'Opacity';
    ui.opacity.setAttribute('aria-label', mode === 'outline' ? 'Outline detail' : 'Top layer opacity');
    ui.opacity.value = Math.round(rangeValue * 100);
    ui.opacityOut.value = `${Math.round(rangeValue * 100)}%`;
    $(`input[name="move"][value="${state.active}"]`).checked = true;
    ui.moveHint.hidden = !state.linked;
    syncWipe();

    // Camera buttons: disabled with an explanation on devices without one
    // (phones keep them, falling back to the native camera via the file input).
    const noCamera = cameraStatus === 'none' && !IS_TOUCH;
    const camOn = CameraSession.isOn();
    for (const btn of $$('[data-action="camera"]')) {
      btn.disabled = noCamera;
      btn.classList.toggle('cam-on', camOn && !noCamera);
      btn.title = noCamera
        ? 'No camera detected on this device'
        : camOn
          ? 'Camera on standby, turns off after 2 minutes'
          : btn.closest('.pane[data-slot="drawing"].has-image')
            ? 'Retake: photograph the drawing again (keeps alignment)'
            : 'Take a photo';
    }
    syncShelf();

    const both = SLOTS.every((s) => layers[s].hasImage);
    for (const slot of SLOTS) {
      const layer = layers[slot];
      const paneEl = paneEls[slot];
      const tools = toolsEls[slot];
      const tool = (action) => $(`[data-action="${action}"]`, tools);

      // The empty state shows only when nothing is drawn in this pane's body.
      const dropzoneHidden = layersInPane(slot).some((l) => l.hasImage);
      $('.dropzone', paneEl).hidden = dropzoneHidden;
      paneEl.classList.toggle('has-image', layer.hasImage);
      // Slot empty but its body isn't showing the empty state (overlay mode):
      // offer a compact "Add image" in the head instead.
      paneEl.classList.toggle('offer-add', !layer.hasImage && (dropzoneHidden || (overlay && slot === 'reference')));
      paneEl.classList.toggle('active', state.active === slot);
      paneEl.classList.toggle('is-hidden', layer.hasImage && layer.hidden);

      // Chip: says which image is hidden. In Overlay the drawing pane's body is the only visible one.
      const chip = $('.hidden-chip', paneEl);
      const chipTarget = overlay
        ? slot === 'drawing' && SLOTS.find((s) => layers[s].hasImage && layers[s].hidden)
        : layer.hasImage && layer.hidden && slot;
      chip.hidden = !chipTarget;
      if (chipTarget) {
        chip.dataset.target = chipTarget;
        chip.textContent = `${LABELS[chipTarget]} hidden · ${IS_TOUCH ? 'double-tap' : 'double-click or H'} to show`;
      }
      paneEl.classList.toggle('placing-dots', !!dotLayerIn(slot));
      if (!layer.hasImage) setTrayOpen(slot, false);

      $$('.needs-image .tool', tools).forEach((b) => (b.disabled = !layer.hasImage));
      for (const [action, on] of [['flipH', layer.flipH], ['flipV', layer.flipV], ['gray', layer.gray], ['contrast', layer.contrast], ['dots', layer.dotsOn], ['hide', layer.hidden]]) {
        setPressed(tool(action), on);
      }
    }

    // Drawing-only alignment tools.
    const t = (action) => $(`[data-action="${action}"]`, toolsEls.drawing);
    const pairs = dotPairs().length;
    t('align').disabled = !both || pairs === 0;
    t('align').title = pairs === 2 ? 'Align on both dots: position, size and rotation' : pairs === 1 ? 'Centre on the dot (add a second for size and rotation)' : 'Place matching dots in both images first';
    t('auto').disabled = !both;
    t('prev').disabled = !prevLayer.hasImage && !shelf.previous('drawing'); // the ghost is the shelf entry before the active one
    setPressed(t('prev'), showingPrev());
    t('file').title = layers.drawing.hasImage ? 'Add a photo from a file (a retake: keeps the alignment)' : 'Add from file';
  }

  /** Stepper (n / total, chevrons) in each pane head; the open strip follows the shelf. */
  function syncShelf() {
    for (const slot of SLOTS) {
      const paneEl = paneEls[slot];
      const n = shelf.count(slot);
      const idx = shelf.ids[slot].indexOf(shelf.active(slot));
      const step = $('.shelf-step', paneEl);
      step.hidden = n < 2;
      const count = $('.shelf-count', paneEl);
      const unsaved = shelf.unsavedIds(slot).length;
      count.textContent = `${idx + 1} / ${n}`;
      count.classList.toggle('has-unsaved', unsaved > 0);
      count.title = unsaved ? `Show all photos (${unsaved} not saved)` : 'Show all photos';
      count.setAttribute('aria-label', `${LABELS[slot]} photo ${idx + 1} of ${n}. Show all photos`);
      $('[data-shelf="prev"]', paneEl).disabled = idx <= 0;
      $('[data-shelf="next"]', paneEl).disabled = idx < 0 || idx >= n - 1;
      if (shelfUI.open === slot) {
        if (!n || (n < 2 && !shelfUI.remove)) closeStrip();
        else renderStrip(slot);
      }
    }
  }

  /** Wipe handle and tags: only when both images are visible in Overlay + Wipe. */
  function syncWipe() {
    const show = state.layout === 'overlay' && state.compareMode === 'wipe' && SLOTS.every((s) => layers[s].hasImage && !layers[s].hidden);
    ui.wipeHandle.hidden = !show;
    ui.wipeTags.left.hidden = ui.wipeTags.right.hidden = !show;
    ui.wipeHandle.style.setProperty('--wipe', String(state.wipe));
    ui.wipeHandle.setAttribute('aria-valuenow', String(Math.round(state.wipe * 100)));
    ui.wipeTags.left.textContent = LABELS[state.overlayTop];
    ui.wipeTags.right.textContent = LABELS[other(state.overlayTop)];
  }

  // ---------------------------------------------------------------- misc

  let toastTimer = 0;
  /** @param {{label: string, run: () => void}} [action] optional button shown in the toast */
  function toast(message, action, kind) { // kind 'ok' swaps the lead mark for a checkmark
    ui.toast.textContent = '';
    const text = document.createElement('span');
    text.textContent = message;
    ui.toast.appendChild(text);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => action.run());
      ui.toast.appendChild(btn);
    }
    ui.toast.classList.toggle('has-action', !!action);
    ui.toast.classList.toggle('ok', kind === 'ok');
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), action ? 8000 : Math.max(4000, message.length * 60));
  }

  // Browser zoom changes DPR without necessarily resizing the panes.
  window.addEventListener('resize', () => SLOTS.forEach((s) => panes[s].measure()));

  // Small surface for debugging and tests from the console.
  window.DrawingCompare.app = {
    state, layers, prevLayer, panes, shelf, store, camera, loadInto, runAutoAlign, alignByDots, fitPair, render, setHidden, setCompareMode,
    switchPhoto, stepPhoto, removePhoto, flushSave, restored, syncGhost,
  };

  // ---------------------------------------------------------------- start

  // Camera: remembered device/facing are saved with the settings; the Camera buttons show the standby dot.
  CameraSession.onPrefs = (prefs) => {
    state.cameraDevices = { ...prefs.devices };
    state.cameraFacing = prefs.facing;
    scheduleSave();
  };
  CameraSession.subscribe((type) => {
    if (type === 'state' || type === 'permission') syncUI();
  });

  for (const slot of SLOTS) panes[slot].measure();
  syncUI();
  requestRender();
  restoreSession();
  CameraDialog.detect().then((status) => {
    cameraStatus = status;
    syncUI();
  });
  CameraSession.watchPermission(); // reading the permission never prompts
})();
