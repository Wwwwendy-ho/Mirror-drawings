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
    'compareMode', 'wipe', 'outlineDetail', 'tipFlick', 'tipUnlink', 'tipDots',
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
    tipUnlink: false, // the one-time "Link is off" tip (Overlay) has been shown
    active: 'drawing', // the selected image: target for keyboard shortcuts and overlay-mode gestures
    showPrev: false, // show the previous photo of the drawing instead of the current one
    tipDots: false, // the first-use "match the same two spots" picture has been shown
    dotFlow: null, // the Line up flow while it is open: { step, oneDot, snapshot, crops, ... } (runtime only, never saved)
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
  let alignKind = null; // 'fit' while a Fit all match is pending: any manual move, layout or photo switch drops it
  const matchCache = new Map(); // matchKey() -> Aligner result, so a repeated Fit all on the same photos is instant
  let animToken = 0;
  let undoAlign = null;
  let dotLock = 0; // performance.now() until which taps and double-clicks next to a just-placed dot are ignored
  let touchTipDone = false;
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
  // Per-image controls, found once. In Overlay the Reference's ctl / tools / strip are docked into the
  // Drawing pane (dockReference), so they are always reached through these refs and `data-owner`, never through a pane.
  const els = Object.fromEntries(
    SLOTS.map((s) => {
      const pane = paneEls[s];
      const ctl = $(`.layer-ctl[data-owner="${s}"]`, pane);
      return [s, {
        pane, ctl,
        tab: $('.layer-tab', ctl),
        eye: $('.eye', ctl),
        step: $('.shelf-step', ctl),
        count: $('.shelf-count', ctl),
        prev: $('[data-shelf="prev"]', ctl),
        next: $('[data-shelf="next"]', ctl),
        headAdd: $('.head-add', ctl),
        toggle: $('.tools-toggle', pane),
        tools: $(`.pane-tools[data-owner="${s}"]`, pane),
        strip: $(`.shelf[data-owner="${s}"]`, pane),
      }];
    }),
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
    toast: $('#toast'),
    status: $('.pane-status'), // lives in the Drawing head; docked into the canvas in Overlay
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

  /**
   * When the pane changes size (layout switch, window resize, a session restored into another window) an aligned
   * pair must keep its relationship: the reference is re-placed by its own rules (re-fitted, or scaled when the
   * user moved it), and the drawing and its ghost follow with the SAME similarity (scale k, rotation, offset
   * about the reference), so drawing.scale / reference.scale, the relative offset and the angle never change.
   */
  function placePair() {
    const d = layers.drawing, r = layers.reference;
    if (!(d.hasImage && r.hasImage && d.aligned && r.frame && d.frame)) return;
    const pd = panes.drawing;
    const pr = state.layout === 'overlay' ? panes.drawing : panes.reference;
    const w = pr.width, h = pr.height;
    if (w <= 0 || h <= 0 || pd.width !== w || pd.height !== h) return; // panes disagree (mid-resize): per-layer rules apply
    if (r.frame.w === w && r.frame.h === h && d.frame.w === w && d.frame.h === h) return;
    const from = placement(r);
    r.placeIn(w, h);
    const to = placement(r);
    const k = to.scale / from.scale, dA = to.angle - from.angle;
    const c = Math.cos(dA), s = Math.sin(dA);
    for (const l of prevLayer.hasImage ? [d, prevLayer] : [d]) {
      const dx = l.x - from.x, dy = l.y - from.y;
      l.x = to.x + k * (dx * c - dy * s);
      l.y = to.y + k * (dx * s + dy * c);
      l.scale *= k;
      l.angle += dA;
      l.frame = { w, h };
    }
  }

  function render() {
    placePair();
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
      const solo = soloSlot();
      if (solo) {
        // Line up, Overlay: each step shows only the image it is about, at full strength
        const only = visibleLayer(solo) || layers[solo];
        plan = { items: only.hasImage ? [{ layer: only }] : [], isolate: false, divider: null };
      } else if (state.layout === 'overlay') {
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
    if (state.dotFlow) positionCoach();
  }

  // ---------------------------------------------------------------- Line up with dots (guided flow)

  // Dots exist only while the flow is open. Pairs are matched by colour AND shape (pair 1 = vermilion circle,
  // pair 2 = blue square); the reference's dots are dashed with an "R" tab, the drawing's solid.
  // Steps: intro (first use) -> R1 -> R2 -> D1 -> D2 -> automatic align -> review. See the design spec, section 3.

  const SVGNS = 'http://www.w3.org/2000/svg';
  const PAIR = [
    { name: 'vermilion circle', hex: '#c2492a' },
    { name: 'blue square', hex: '#1f6f8b' },
  ];
  const ORDER = ['R1', 'R2', 'D1', 'D2'];
  const stepSlot = (s) => (s === 'R1' || s === 'R2' ? 'reference' : s === 'D1' || s === 'D2' ? 'drawing' : null);
  const stepIdx = (s) => (s === 'R2' || s === 'D2' ? 1 : 0);
  const inSteps = () => !!(state.dotFlow && stepSlot(state.dotFlow.step));
  const soloSlot = () => (state.layout === 'overlay' && inSteps() ? stepSlot(state.dotFlow.step) : null);
  const TAP = () => (IS_TOUCH ? 'Tap' : 'Click');
  const coachEl = $('#dot-coach');
  const coachQ = (sel) => $(sel, coachEl);
  const links = {}; // links[paneSlot] = { intra: {drawing, reference}, cross: [line, line] }
  const loupe = document.createElement('canvas');
  loupe.className = 'dot-loupe';
  loupe.width = loupe.height = 224;
  loupe.hidden = true;
  loupe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(loupe);

  // Each pane body holds four dot handles (two per image); which are shown depends on the flow (positionDots).
  for (const paneSlot of SLOTS) {
    const body = $('.pane-body', paneEls[paneSlot]);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'dot-links');
    svg.setAttribute('aria-hidden', 'true');
    const line = (cls) => {
      const l = document.createElementNS(SVGNS, 'line');
      l.setAttribute('class', cls);
      l.style.display = 'none';
      svg.appendChild(l);
      return l;
    };
    links[paneSlot] = { intra: { reference: line('link-in'), drawing: line('link-in') }, cross: [line('link-x'), line('link-x')] };
    body.appendChild(svg);
    dotEls[paneSlot] = {};
    for (const layerSlot of ['reference', 'drawing']) {
      dotEls[paneSlot][layerSlot] = [0, 1].map((i) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `dot dot-${layerSlot}`;
        el.hidden = true;
        el.dataset.n = String(i + 1);
        const ring = document.createElement('i');
        ring.className = 'ring';
        ring.dataset.tag = `${layerSlot === 'reference' ? 'R' : ''}${i + 1}`;
        el.appendChild(ring);
        el.setAttribute('aria-label', `${LABELS[layerSlot]} dot ${i + 1} of 2, ${PAIR[i].name}. Arrow keys move it, Delete removes it.`);
        body.appendChild(el);

        const layer = layers[layerSlot];
        let moved = false;
        const moveTo = (e) => {
          const r = body.getBoundingClientRect();
          layer.dots[i] = layer.fromPane({ x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 });
          moved = true;
          if (e.pointerType !== 'mouse') drawLoupe(paneSlot, layerSlot, i, e);
          requestRender();
        };
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          moved = false;
          try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
          el.classList.add('dragging');
          el.focus({ preventScroll: true });
        });
        el.addEventListener('pointermove', (e) => {
          if (el.classList.contains('dragging')) moveTo(e);
        });
        const release = () => {
          if (!el.classList.contains('dragging')) return;
          el.classList.remove('dragging');
          loupe.hidden = true;
          if (moved) flowAdvance();
          else syncUI();
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('dblclick', (e) => {
          e.preventDefault();
          if (performance.now() < dotLock) return; // the second click of a double-click that placed this dot
          removeDot(layerSlot, i);
        });
        el.addEventListener('keydown', (e) => {
          const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (move) {
            e.preventDefault();
            e.stopPropagation(); // not also a nudge of the image
            const k = e.shiftKey ? 10 : 1;
            const q = layer.toPane(layer.dots[i]);
            layer.dots[i] = layer.fromPane({ x: q.x + move[0] * k, y: q.y + move[1] * k });
            requestRender();
            clearTimeout(el._t);
            el._t = setTimeout(flowAdvance, 300); // in review: re-align once the arrows rest
          } else if (e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            removeDot(layerSlot, i);
          }
        });
        return el;
      });
    }
  }

  function setLine(l, a, b) {
    if (!a || !b) { l.style.display = 'none'; return; }
    l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
    l.style.display = '';
  }

  function positionDots(paneSlot, stack) {
    const pane = panes[paneSlot];
    const f = state.dotFlow;
    const solo = soloSlot();
    const pt = { drawing: [null, null], reference: [null, null] };
    for (const layerSlot of SLOTS) {
      const layer = layers[layerSlot];
      const visible = !!f && stack.includes(layer) && layer.hasImage && !layer.hidden && !(layerSlot === 'drawing' && showingPrev()) && (!solo || solo === layerSlot);
      dotEls[paneSlot][layerSlot].forEach((el, i) => {
        const dot = layer.dots[i];
        el.hidden = !(visible && dot);
        if (el.hidden) return;
        const q = layer.toPane(dot);
        const p = { x: pane.width / 2 + q.x, y: pane.height / 2 + q.y };
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
        el.classList.toggle('paired', !!(layers.drawing.dots[i] && layers.reference.dots[i]));
        pt[layerSlot][i] = p;
      });
    }
    const lk = links[paneSlot];
    for (const layerSlot of SLOTS) setLine(lk.intra[layerSlot], pt[layerSlot][0], pt[layerSlot][1]);
    const review = !!f && f.step === 'review' && state.layout === 'overlay';
    [0, 1].forEach((i) => {
      const a = pt.reference[i], b = pt.drawing[i];
      const far = a && b && Math.hypot(a.x - b.x, a.y - b.y) > 1.5;
      lk.cross[i].style.stroke = i ? 'var(--dot-2)' : 'var(--accent)';
      setLine(lk.cross[i], review && far ? a : null, b);
    });
  }

  // ---- loupe: a magnifier above the finger while a dot is dragged with touch or pen
  function drawLoupe(paneSlot, layerSlot, i, e) {
    const pane = panes[paneSlot];
    const q = layers[layerSlot].toPane(layers[layerSlot].dots[i]);
    const cx = pane.width / 2 + q.x, cy = pane.height / 2 + q.y, k = pane.dpr, S = 44.8;
    const ctx = loupe.getContext('2d');
    ctx.fillStyle = PANE_BG;
    ctx.fillRect(0, 0, 224, 224);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(pane.canvas, (cx - S / 2) * k, (cy - S / 2) * k, S * k, S * k, 0, 0, 224, 224);
    ctx.lineCap = 'round';
    for (const [w, c] of [[5, 'rgba(255,255,255,.85)'], [2.4, PAIR[i].hex]]) {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.moveTo(112, 40); ctx.lineTo(112, 98); ctx.moveTo(112, 126); ctx.lineTo(112, 184);
      ctx.moveTo(40, 112); ctx.lineTo(98, 112); ctx.moveTo(126, 112); ctx.lineTo(184, 112);
      ctx.stroke();
    }
    const vv = window.visualViewport;
    const vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
    const x = Math.min(vw - 62, Math.max(62, e.clientX));
    let y = e.clientY < 130 ? e.clientY + 80 : e.clientY - 80;
    y = Math.min(vh - 62, Math.max(62, y));
    loupe.style.left = `${x - 56}px`;
    loupe.style.top = `${y - 56}px`;
    loupe.hidden = false;
  }

  // ---- reference-spot thumbnail, captured from the pane canvas right after a reference dot is placed
  function captureCrop(i) {
    const slot = state.layout === 'overlay' ? 'drawing' : 'reference';
    const pane = panes[slot];
    const q = layers.reference.toPane(layers.reference.dots[i]);
    const cx = pane.width / 2 + q.x, cy = pane.height / 2 + q.y, k = pane.dpr, S = 96;
    const c = document.createElement('canvas');
    c.width = c.height = 144;
    const ctx = c.getContext('2d');
    ctx.fillStyle = PANE_BG;
    ctx.fillRect(0, 0, 144, 144);
    try { ctx.drawImage(pane.canvas, (cx - S / 2) * k, (cy - S / 2) * k, S * k, S * k, 0, 0, 144, 144); } catch { /* nothing to show */ }
    ctx.lineWidth = 3;
    for (const [w, col] of [[5, 'rgba(255,255,255,.9)'], [3, PAIR[i].hex]]) {
      ctx.lineWidth = w;
      ctx.strokeStyle = col;
      ctx.beginPath();
      if (i === 0) ctx.arc(72, 72, 15, 0, Math.PI * 2);
      else ctx.rect(57, 57, 30, 30);
      ctx.stroke();
    }
    return c;
  }

  // ---- state machine
  const dotsFar = (layer) => {
    const a = layer.dots[0], b = layer.dots[1];
    if (!a || !b) return true;
    return Math.hypot(a.x - b.x, a.y - b.y) >= 0.12 * Math.hypot(layer.source.width, layer.source.height);
  };

  /** The first thing still to do, in the order R1, R2, D1, D2 ('review' when nothing is missing). */
  function nextStep() {
    const f = state.dotFlow, r = layers.reference, d = layers.drawing, one = f.oneDot;
    if (!r.dots[0]) return 'R1';
    if (!one && (!r.dots[1] || (!f.accepted.R2 && !dotsFar(r)))) return 'R2';
    if (!d.dots[0]) return 'D1';
    if (!one && (!d.dots[1] || (!f.accepted.D2 && !dotsFar(d)))) return 'D2';
    return 'review';
  }

  const bothLoaded = () => SLOTS.every((s) => layers[s].hasImage);

  function openFlow() {
    if (state.dotFlow) return;
    if (!bothLoaded()) { toast('Needs both a drawing and a reference'); return; }
    cancelMatch();
    closeStrip();
    setMoreOpen(false);
    SLOTS.forEach((s) => setTrayOpen(s, false));
    for (const s of SLOTS) layers[s].hidden = false;
    state.showPrev = false;
    const d = layers.drawing, r = layers.reference;
    const f = {
      step: 'R1',
      oneDot: !!(r.dots[0] && d.dots[0] && !r.dots[1] && !d.dots[1]),
      snapshot: snapshotViews(),
      crops: [null, null],
      accepted: { R2: !!r.dots[1], D2: !!d.dots[1] }, // dots that were already there are not second-guessed
      notice: '', warn: '', undone: false, firstRun: false, returnStep: null, noticeTimer: 0,
    };
    state.dotFlow = f;
    if (!state.tipDots) {
      state.tipDots = true;
      scheduleSave();
      f.firstRun = true;
      f.step = 'intro';
      f.returnStep = nextStep();
    } else {
      f.step = nextStep();
    }
    if (f.step === 'review' && d.aligned && d.alignSource === 'dots') f.warn = '';
    flowRefresh();
  }

  /** Close the flow. `quiet`: no toast. Everything (dots and placement) goes back to how it was when the flow opened. */
  function cancelFlow(quiet = false) {
    const f = state.dotFlow;
    if (!f) return;
    animToken++;
    clearTimeout(f.noticeTimer);
    const S = f.snapshot;
    layers.drawing.applyView(S.d);
    layers.reference.applyView(S.r);
    if (S.p && prevLayer.hasImage) prevLayer.applyView(S.p);
    closeFlow();
    if (!quiet) toast('Line-up cancelled. Nothing was changed.');
  }

  function closeFlow() {
    const f = state.dotFlow;
    if (!f) return;
    clearTimeout(f.noticeTimer);
    const hadFocus = coachEl.contains(document.activeElement) || document.activeElement.classList.contains('dot');
    state.dotFlow = null;
    loupe.hidden = true;
    syncUI();
    requestRender();
    if (hadFocus) {
      const t = $('[data-action="lineup"]', toolsEls[state.active]);
      if (t && t.offsetParent) t.focus({ preventScroll: true });
    }
  }

  function toggleFlow() {
    if (state.dotFlow) cancelFlow();
    else openFlow();
  }

  /** Re-evaluate what is missing; align when all is there; update targeting, the coach and the canvas. */
  function flowAdvance() {
    const f = state.dotFlow;
    if (!f || f.step === 'intro') return;
    clearTimeout(f.noticeTimer);
    f.notice = '';
    const next = nextStep();
    if (next !== f.step) f.flipped = false; // a new step lets the coach pick its edge again
    f.step = next;
    if (next === 'review') alignFlow();
    flowRefresh();
  }

  function flowRefresh() {
    const f = state.dotFlow;
    const slot = f && stepSlot(f.step);
    if (slot && state.active !== slot) state.active = slot; // the target image becomes the selected one by itself
    if (f && f.step === 'R2' && IS_TOUCH && !touchTipDone) f.touchTip = true;
    syncUI();
    requestRender();
  }

  /** Move the drawing so its dots land on the reference's. Review state afterwards (or back to a step on error). */
  function alignFlow() {
    const f = state.dotFlow;
    const res = dotsTarget();
    f.undone = false;
    if (res.error) {
      f.step = res.pairs && res.pairs.length === 2 ? 'D2' : 'D1';
      f.accepted.D2 = false;
      f.notice = 'The two dots sit on the same spot. Move one away.';
      return;
    }
    f.warn = res.pairs.length === 2 ? suspiciousMessage(res.target) : '';
    applyAlignment(res.target, '', { source: 'dots', quiet: true });
  }

  /** A warning when the match moved the drawing a lot (probably one dot on a different spot). */
  function suspiciousMessage(t) {
    const d = layers.drawing, r = layers.reference;
    let ang = (t.angle - r.angle) % (2 * Math.PI);
    if (ang > Math.PI) ang -= 2 * Math.PI;
    if (ang < -Math.PI) ang += 2 * Math.PI;
    const deg = Math.abs(ang) * 180 / Math.PI;
    const fit = (l) => {
      const b = l.bounds, fr = l.frame || { w: panes.drawing.width, h: panes.drawing.height };
      return Math.min((fr.w - 24) / b.w, (fr.h - 24) / b.h);
    };
    const ratio = (t.scale / r.scale) / (fit(d) / fit(r));
    const parts = [];
    if (deg > 45) parts.push(`turned ${Math.round(deg)} degrees`);
    if (ratio > 3 || ratio < 1 / 3) parts.push(ratio > 1 ? `${ratio.toFixed(1)}x larger` : `${(1 / ratio).toFixed(1)}x smaller`);
    return parts.length ? `That moved the drawing a lot (${parts.join(', ')}).` : '';
  }

  function removeDot(layerSlot, i) {
    const f = state.dotFlow;
    if (!f || !layers[layerSlot].dots[i]) return;
    layers[layerSlot].dots[i] = null;
    const step = `${layerSlot === 'reference' ? 'R' : 'D'}${i + 1}`;
    f.accepted[step] = false;
    if (layerSlot === 'reference') f.crops[i] = null;
    if (step === 'R1' || step === 'R2') f.oneDot = false;
    if (f.step === 'intro') return syncUI();
    flowAdvance();
  }

  function flowBack() {
    const f = state.dotFlow;
    if (!f || f.step === 'intro') return;
    for (let k = ORDER.length - 1; k >= 0; k--) {
      const s = ORDER[k], slot = stepSlot(s), i = stepIdx(s);
      if (layers[slot].dots[i]) { removeDot(slot, i); return; }
    }
  }

  function flowStartOver() {
    const f = state.dotFlow;
    for (const s of SLOTS) layers[s].dots = [null, null];
    f.crops = [null, null];
    f.accepted = { R2: false, D2: false };
    f.oneDot = false;
    f.warn = '';
    flowAdvance();
  }

  function flowStart() {
    const f = state.dotFlow;
    if (!f || f.step !== 'intro') return;
    f.step = nextStep();
    if (f.step === 'review') alignFlow();
    flowRefresh();
  }

  function flowHelp() {
    const f = state.dotFlow;
    if (!f || f.step === 'intro') return;
    f.returnStep = f.step;
    f.step = 'intro';
    flowRefresh();
  }

  function flowDone() {
    const f = state.dotFlow;
    if (!f || f.step !== 'review') return;
    const d = layers.drawing;
    const lined = d.aligned && d.alignSource === 'dots' && !f.undone;
    const pairs = dotPairs().length;
    const S = f.snapshot;
    closeFlow();
    if (lined) toast(pairs === 2 ? 'Lined up on both dots: position, size and rotation.' : 'Centred on one dot.', setUndo(S, 'Alignment undone.'));
  }

  /** Undo inside the flow: the placement goes back to how it was when the flow opened; the dots stay. */
  function flowUndo() {
    const f = state.dotFlow;
    if (!f || f.step !== 'review') return;
    animToken++;
    const S = f.snapshot;
    layers.drawing.applyView({ ...S.d, dots: layers.drawing.dots });
    layers.reference.applyView({ ...S.r, dots: layers.reference.dots });
    if (S.p && prevLayer.hasImage) prevLayer.applyView(S.p);
    f.undone = true;
    f.warn = '';
    flowRefresh();
  }

  function flowNotice(text, shake = false) {
    const f = state.dotFlow;
    clearTimeout(f.noticeTimer);
    f.notice = text;
    f.noticeTimer = setTimeout(() => { if (state.dotFlow === f) { f.notice = ''; renderCoach(); positionCoach(); } }, 5000);
    renderCoach();
    positionCoach();
    if (shake) {
      coachEl.classList.remove('shake');
      void coachEl.offsetWidth;
      coachEl.classList.add('shake');
    }
  }

  /** A tap (or Enter at the centre) at pane-centred (x, y) in `paneSlot`'s pane. */
  function flowTap(paneSlot, x, y, keyboard = false) {
    const f = state.dotFlow;
    const step = f && f.step;
    const target = stepSlot(step);
    if (!target) return; // intro and review: taps place nothing
    if (!keyboard) {
      if (performance.now() < dotLock) return;
      const cr = coachEl.getBoundingClientRect(), pr = panes[paneSlot].canvas.getBoundingClientRect();
      const cx = pr.left + pr.width / 2 + x, cy = pr.top + pr.height / 2 + y;
      if (!coachEl.hidden && cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom) { // a tap on the coach never places a dot: it moves the box out of the way
        f.flipped = !f.flipped;
        positionCoach();
        return;
      }
    }
    if (state.layout !== 'overlay' && paneSlot !== target) {
      flowNotice(target === 'reference'
        ? `That's the drawing. ${TAP()} the reference (the other image).`
        : `That's the reference. ${TAP()} your drawing (the other image).`, true);
      return;
    }
    const layer = layers[target];
    if (!layer.hasImage) return;
    const p = layer.fromPane({ x, y });
    if (Math.abs(p.x) > layer.source.width / 2 || Math.abs(p.y) > layer.source.height / 2) {
      flowNotice(`${TAP()} on the image itself.`);
      return;
    }
    const i = stepIdx(step);
    layer.dots[i] = p;
    dotLock = performance.now() + 500;
    if (step === 'R2') touchTipDone = true;
    if (target === 'reference') {
      render();
      f.crops[i] = captureCrop(i);
    }
    flowAdvance();
    if (keyboard) {
      render();
      const el = dotEls[state.layout === 'overlay' ? 'drawing' : target][target][i];
      if (!el.hidden) el.focus({ preventScroll: true });
    }
  }

  // ---- the coach
  const bold = (text) => {
    const frag = document.createDocumentFragment();
    String(text).split('**').forEach((part, k) => {
      if (!part) return;
      if (k % 2) { const b = document.createElement('strong'); b.textContent = part; frag.appendChild(b); }
      else frag.appendChild(document.createTextNode(part));
    });
    return frag;
  };

  function coachContent() {
    const f = state.dotFlow, step = f.step, tap = TAP().toLowerCase(), Tap = TAP();
    const total = f.oneDot ? 2 : 4;
    const stepNo = { R1: 1, R2: 2, D1: f.oneDot ? 2 : 3, D2: 4 }[step];
    const solo = state.layout === 'overlay' ? (stepSlot(step) === 'reference' ? ' Now showing only the reference.' : ' Now showing only your drawing.') : '';
    const c = { l1: '', l2: '', tip: '', actions: [], warn: false, art: false, solo: stepSlot(step) ? solo : '' };
    const d = layers.drawing;
    const pairs = dotPairs().length;
    switch (step) {
      case 'intro':
        Object.assign(c, { l1: 'Line up with dots', l2: 'Mark the same two spots on both images. The app then moves, resizes and turns your drawing to match.', art: true, actions: ['start'] });
        return c;
      case 'R1':
        c.l1 = `Step 1 of ${total}`;
        c.l2 = `${Tap} a clear spot on the **REFERENCE**, such as the corner of an eye.`;
        if (f.firstRun) c.tip = 'Good spots are sharp and easy to find in both images: corners of eyes, the tip of the nose, where two lines cross. Pick two that are far apart.';
        break;
      case 'R2':
        c.l1 = `Step 2 of ${total}`;
        c.l2 = `${Tap} a second spot on the **REFERENCE**, far from the first.${f.touchTip && IS_TOUCH ? ' Drag the dot to adjust it. Pinch to zoom in for precision.' : ''}`;
        c.actions = ['one'];
        break;
      case 'D1':
        c.l1 = `Step ${stepNo} of ${total}`;
        c.l2 = f.oneDot ? `Now ${tap} the **same spot** on **YOUR DRAWING**.` : `Now ${tap} the **same spot as dot 1** on **YOUR DRAWING**.`;
        break;
      case 'D2':
        c.l1 = `Step 4 of ${total}`;
        c.l2 = `Last one: ${tap} the **same spot as dot 2** on **YOUR DRAWING**.`;
        break;
      case 'review':
        if (f.undone) { c.l1 = 'Put back where it was'; c.l2 = 'Nothing is lined up now. Drag a dot to line up again, or start over.'; }
        else if (pairs === 2) { c.l1 = 'Lined up on both dots'; c.l2 = 'Check the fit. Drag a dot to fine-tune; it re-aligns when you let go.'; }
        else { c.l1 = 'Centred on one dot'; c.l2 = 'Position matched; size and rotation unchanged.'; }
        if (f.warn && !f.undone) { c.l1 = f.warn; c.l2 = 'If it looks wrong, one dot is probably on a different spot. Drag it, or start over.'; c.warn = true; }
        c.actions = pairs === 2 || f.undone ? ['done', 'undo', 'again'] : ['done', 'second', 'undo'];
        return c;
    }
    if ((step === 'R2' || step === 'D2') && layers[stepSlot(step)].dots[1]) { // placed too close to dot 1
      c.l2 = 'Those two dots are very close. Spots far apart give a steadier match.';
      c.actions = ['move', 'keep'];
      c.warn = true;
    }
    if (f.notice) { c.l2 = f.notice; c.warn = false; }
    return c;
  }

  let coachKey = '';
  function renderCoach() {
    const f = state.dotFlow;
    coachEl.hidden = !f;
    if (!f) { coachKey = ''; return; }
    const c = coachContent();
    const r = layers.reference, d = layers.drawing;
    const present = [r.dots[0], r.dots[1], d.dots[0], d.dots[1]].map((v) => (v ? 1 : 0)).join('');
    const key = [f.step, f.oneDot, c.l1, c.l2, c.tip, c.actions.join(), present, c.warn, state.layout === 'overlay', !!f.crops[stepIdx(f.step)]].join('|');
    if (key === coachKey) return;
    coachKey = key;
    coachQ('.coach-step').textContent = c.l1;
    coachQ('.coach-step').classList.toggle('warn', c.warn);
    const text = coachQ('.coach-text');
    text.textContent = '';
    text.appendChild(bold(c.l2));
    if (c.solo) { const s = document.createElement('span'); s.className = 'sr-only'; s.textContent = c.solo; text.appendChild(s); }
    const tip = coachQ('.coach-tip');
    tip.hidden = !c.tip;
    tip.textContent = c.tip;
    coachQ('.coach-art').style.display = c.art ? '' : 'none';
    coachEl.classList.toggle('is-intro', c.art);
    coachQ('#coach-live').textContent = `${c.l1}. ${text.textContent}`;
    // pips: reference pair first (dashed), then the drawing pair (solid); filled when placed, the current one pulses
    $$('.pip', coachEl).forEach((p, k) => {
      const step = ORDER[k];
      p.classList.toggle('on', present[k] === '1');
      p.classList.toggle('now', f.step === step);
      p.hidden = f.oneDot && k % 2 === 1;
    });
    // thumbnail of the reference spot, on the drawing steps
    const thumb = coachQ('.coach-thumb');
    const crop = (f.step === 'D1' || f.step === 'D2') && f.crops[stepIdx(f.step)];
    thumb.hidden = !crop;
    thumb.textContent = '';
    if (crop) {
      thumb.appendChild(crop);
      const cap = document.createElement('figcaption');
      cap.textContent = `Reference dot ${stepIdx(f.step) + 1}`;
      thumb.appendChild(cap);
    }
    const any = present.includes('1');
    const show = { back: f.step !== 'intro' && any, help: f.step !== 'intro', cancel: true, flip: true };
    for (const b of $$('[data-coach]', coachEl)) {
      const k = b.dataset.coach;
      b.hidden = k in show ? !show[k] : !c.actions.includes(k);
    }
    coachQ('.coach-actions').hidden = !c.actions.some((k) => k !== 'one'); // "Use one spot" lives in the top row (wide) or beside the text (phones)
  }

  /** Over the top edge of the target image's pane body (the bottom edge when the dots being worked on are up there). */
  function positionCoach() {
    const f = state.dotFlow;
    if (!f) return;
    const overlay = state.layout === 'overlay';
    const slot = overlay ? 'drawing' : stepSlot(f.step) || 'drawing';
    const body = $('.pane-body', paneEls[slot]).getBoundingClientRect();
    const ws = $('.workspace').getBoundingClientRect();
    let span = body;
    if (!overlay && state.layout === 'side' && body.width < 420) span = $('.panes').getBoundingClientRect(); // narrow phones: span both panes
    const width = Math.min(460, span.width - 16);
    coachEl.style.width = `${width}px`;
    const h = coachEl.offsetHeight;
    const left = Math.min(ws.right - 4 - width, Math.max(ws.left + 4, span.left + span.width / 2 - width / 2));
    const topY = body.top + 8, botY = body.bottom - 8 - h;
    const hits = (y0) => SLOTS.some((s) => dotEls[slot][s].some((el) => {
      if (el.hidden) return false;
      const r = el.getBoundingClientRect(), cy = r.top + r.height / 2, cx = r.left + r.width / 2;
      return cx > left - 20 && cx < left + width + 20 && cy > y0 - 24 && cy < y0 + h + 24;
    }));
    // On the drawing steps the spot is probably where the reference dot sits, relative to its image: keep the coach off it.
    let hintY = null;
    if (stepSlot(f.step) === 'drawing') {
      const rd = layers.reference.dots[stepIdx(f.step)], d = layers.drawing, r = layers.reference;
      if (rd && d.hasImage && r.hasImage) {
        const q = d.toPane({ x: (rd.x / r.source.width) * d.source.width, y: (rd.y / r.source.height) * d.source.height });
        hintY = body.top + panes[slot].height / 2 + q.y;
      }
    }
    const hintHits = (y0) => hintY !== null && hintY > y0 - 24 && hintY < y0 + h + 24;
    // how much of the shown image(s) each edge would cover: the coach takes the freer edge, or the opposite one when flipped
    const pane = panes[slot];
    const shown = (overlay ? soloSlot() ? [soloSlot()] : SLOTS : [slot]).map((s) => layers[s]).filter((l) => l.hasImage && !l.hidden);
    const covered = (y0) => {
      let area = 0;
      for (const l of shown) {
        const b = l.bounds, c = Math.cos(l.angle), s = Math.sin(l.angle);
        const hw = (b.w * l.scale) / 2, hh = (b.h * l.scale) / 2;
        const ys = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => body.top + pane.height / 2 + l.y + px * s + py * c);
        const y1 = Math.max(y0, Math.min(...ys)), y2 = Math.min(y0 + h, Math.max(...ys));
        area += Math.max(0, y2 - y1);
      }
      return area + (hits(y0) ? 200 : 0) + (hintHits(y0) ? 800 : 0);
    };
    let top = covered(botY) < covered(topY) ? botY : topY;
    if (f.flipped) top = top === topY ? botY : topY;
    coachEl.style.left = `${left - ws.left}px`;
    coachEl.style.top = `${top - ws.top}px`;
  }

  coachEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-coach]');
    const f = state.dotFlow;
    if (!b || !f) return;
    switch (b.dataset.coach) {
      case 'back': flowBack(); break;
      case 'help': flowHelp(); break;
      case 'flip': f.flipped = !f.flipped; positionCoach(); break;
      case 'cancel': cancelFlow(); break;
      case 'start': flowStart(); break;
      case 'one': f.oneDot = true; flowAdvance(); break;
      case 'second': f.oneDot = false; flowAdvance(); break;
      case 'done': flowDone(); break;
      case 'undo': flowUndo(); break;
      case 'again': flowStartOver(); break;
      case 'move': layers[stepSlot(f.step)].dots[1] = null; flowAdvance(); break;
      case 'keep': f.accepted[f.step] = true; flowAdvance(); break;
      default:
    }
  });
  coachEl.addEventListener('animationend', () => coachEl.classList.remove('shake'));

  /** Keep the page's controls in step with the flow (called from syncUI). */
  function syncFlow() {
    const f = state.dotFlow;
    const steps = inSteps();
    document.body.dataset.dotflow = !f ? '' : steps ? 'step' : f.step === 'intro' ? 'intro' : 'review';
    ui.overlayBar.inert = steps;
    for (const slot of SLOTS) {
      const target = steps && state.layout !== 'overlay' && stepSlot(f.step) === slot;
      paneEls[slot].classList.toggle('dot-target', target);
      paneEls[slot].classList.toggle('placing-dots', steps && (state.layout === 'overlay' ? slot === 'drawing' : stepSlot(f.step) === slot));
      if (steps) els[slot].tab.setAttribute('aria-disabled', 'true');
      else els[slot].tab.removeAttribute('aria-disabled');
    }
    renderCoach();
    positionCoach();
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

  /** Views of all three layers, so Fit all / Z can put everything back exactly. */
  function snapshotViews() {
    return {
      d: layers.drawing.toJSON(),
      r: layers.reference.toJSON(),
      p: prevLayer.hasImage ? prevLayer.toJSON() : null,
    };
  }

  /** Restore a snapshot; `message` is the toast ('' for none). */
  function restoreViews(S, message = 'Alignment undone.') {
    animToken++;
    alignJob++; // a match still running was for the state being undone
    setBusy(null);
    layers.drawing.applyView(S.d);
    layers.reference.applyView(S.r);
    if (S.p && prevLayer.hasImage) prevLayer.applyView(S.p);
    undoAlign = null;
    syncUI();
    requestRender();
    if (message) toast(message);
  }

  /** Make Z (and the toast's Undo button) put `S` back; returns the toast action. */
  function setUndo(S, message) {
    undoAlign = () => restoreViews(S, message);
    return { label: 'Undo', run: () => undoAlign && undoAlign() };
  }

  /**
   * Move the drawing to `target`, with an Undo offered in the toast. `snapshot` (all three layers) is
   * what Undo restores when given. `source` is how the alignment was found ('dots' | 'auto'); a fresh
   * alignment is never "tuned" (adjusted by hand afterwards).
   */
  function applyAlignment(target, message, { dots = null, carry = true, aligned = true, source = null, tuned = false, snapshot = null, quiet = false } = {}) {
    const d = layers.drawing;
    const S = snapshot || snapshotViews();
    const before = d.toJSON();
    if (carry) carryPrevious(before, target);
    if (dots) d.dots = dots;
    d.moved = true;
    d.aligned = aligned;
    d.alignSource = aligned ? source : null;
    d.tuned = aligned && tuned;
    animateLayer(d, target);
    if (quiet) return; // the Line up flow reports once, when it is done
    const action = setUndo(S, 'Alignment undone.');
    syncUI();
    toast(message, action);
  }

  /** Called when the user moves things by hand: an alignment found earlier is no longer pending, and a solo move is "tuning". */
  function noteManualMove(targets) {
    if (alignKind === 'fit' && alignJob) cancelMatch();
    const d = layers.drawing;
    if (d.aligned && d.hasImage && layers.reference.hasImage && !(targets.includes(d) && targets.includes(layers.reference))) d.tuned = true;
  }

  function cancelMatch() {
    alignJob++;
    alignKind = null;
    setBusy(null);
  }

  function dotPairs() {
    const d = layers.drawing, r = layers.reference;
    return [0, 1].filter((i) => d.dots[i] && r.dots[i]);
  }

  /**
   * The drawing's placement that lands its dots on the reference's dots (one pair: position only; two:
   * position, size and rotation), from the placements as they are now. { error } if the dots coincide.
   */
  function dotsTarget() {
    const d = layers.drawing, r = layers.reference;
    const pairs = dotPairs();
    render(); // make sure both placements are current
    const target = placement(d);
    if (pairs.length === 2) {
      const r1 = r.toPane(r.dots[0]), r2 = r.toPane(r.dots[1]);
      const d1 = d.orient(d.dots[0]), d2 = d.orient(d.dots[1]);
      const ax = d2.x - d1.x, ay = d2.y - d1.y;
      const bx = r2.x - r1.x, by = r2.y - r1.y;
      const den = ax * ax + ay * ay;
      if (den < 1 || bx * bx + by * by < 1) return { error: 'The two dots sit on the same spot. Move one away.', pairs };
      // Complex ratio z = b / a: |z| is the scale, arg z the rotation.
      const zr = (bx * ax + by * ay) / den;
      const zi = (by * ax - bx * ay) / den;
      target.scale = Math.hypot(zr, zi);
      target.angle = Math.atan2(zi, zr);
      target.x = r1.x - (zr * d1.x - zi * d1.y);
      target.y = r1.y - (zi * d1.x + zr * d1.y);
      return { target, pairs, message: 'Aligned on both dots: position, size and rotation.' };
    }
    const i = pairs[0];
    const rp = r.toPane(r.dots[i]), dp = d.toPane(d.dots[i]);
    target.x += rp.x - dp.x;
    target.y += rp.y - dp.y;
    return { target, pairs, message: `Centred on dot ${i + 1}. Add a second dot to match size and rotation too.` };
  }

  /** Toast action that opens the guided Line up flow. */
  const lineUpAction = () => ({ label: 'Line up with dots', run: openFlow });

  /** Move the drawing so its dots land on the reference's dots (used by the tests and the console; the flow aligns by itself). */
  function alignByDots() {
    if (!bothLoaded() || !dotPairs().length) return;
    const res = dotsTarget();
    if (res.error) toast(res.error);
    else applyAlignment(res.target, res.message, { source: 'dots' });
  }

  function setBusy(text) {
    ui.status.hidden = !text;
    ui.status.textContent = text || '';
  }

  /** Cache key for the current pair of photos and their orientations (the match is independent of placement). */
  function matchKey() {
    const a = shelf.active('drawing'), b = shelf.active('reference');
    if (!a || !b) return null;
    const o = (l) => `${l.rotation}${l.flipH ? 1 : 0}${l.flipV ? 1 : 0}`;
    return `${a}|${b}|${o(layers.drawing)}|${o(layers.reference)}`;
  }

  /** Aligner.estimate for the current pair, from the cache when this exact pair was matched before. */
  async function matchPair(job) {
    const key = matchKey();
    if (key && matchCache.has(key)) return matchCache.get(key);
    setBusy('Aligning…');
    const res = await Aligner.estimate(Aligner.rasterize(layers.drawing), Aligner.rasterize(layers.reference), (p) => {
      if (job === alignJob) setBusy(`Aligning… ${Math.round(p * 100)}%`);
    });
    if (key) {
      matchCache.set(key, res);
      if (matchCache.size > 24) matchCache.delete(matchCache.keys().next().value);
    }
    return res;
  }

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
    alignKind = null;
    try {
      const res = await matchPair(job);
      if (job !== alignJob) return null;
      if (res.confident) applyAlignment(placementFromMatch(placement(r), res), 'Auto-aligned to the reference.', { source: 'auto' });
      else toast("Couldn't line them up automatically, so nothing was moved.", lineUpAction());
      return res;
    } catch (err) {
      console.warn('Auto-align failed:', err);
      if (manual) toast("Couldn't line them up automatically, so nothing was moved.", lineUpAction());
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
    alignKind = null;
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
          source: old.alignSource,
          tuned: old.tuned,
        });
      } else {
        toast("Couldn't match the new photo to the previous one, so it sits where the old one was.", lineUpAction());
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
    state.tipUnlink = state.tipUnlink === true;
    state.tipDots = state.tipDots === true;
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
    state.dotFlow = null;
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
   * Fit one image to its pane and carry the other one (and the drawing's ghost) with it, so their
   * relative placement is unchanged: the pair fit. Returns false when there is nothing to carry.
   */
  function pairFit(anchor) {
    const A = layers[anchor], B = layers[other(anchor)];
    const frame = A.frame;
    if (!A.hasImage || !B.hasImage || !frame) return false;
    const from = placement(A);
    const keep = anchor === 'drawing' ? { moved: A.moved, aligned: A.aligned, alignSource: A.alignSource, tuned: A.tuned } : null;
    A.reset();
    A.placeIn(frame.w, frame.h);
    if (keep) Object.assign(A, keep); // the drawing stays aligned; only its placement changed
    const to = placement(A);
    const k = to.scale / from.scale;
    const dA = to.angle - from.angle;
    const c = Math.cos(dA), s = Math.sin(dA);
    const movers = anchor === 'reference' ? withCompanions('drawing') : [B, ...(prevLayer.hasImage ? [prevLayer] : [])];
    for (const l of movers) {
      const dx = l.x - from.x, dy = l.y - from.y;
      l.x = to.x + k * (dx * c - dy * s);
      l.y = to.y + k * (dx * s + dy * c);
      l.scale *= k;
      l.angle += dA;
    }
    return true;
  }

  /**
   * Fit all (F): fit the pair, then line up. A hand-tuned alignment is kept; otherwise existing dots
   * win; otherwise a confident-only automatic match (never when it is not sure). Undo and Z restore
   * everything. See section 2 of the overlay design spec.
   */
  async function fitAll() {
    const d = layers.drawing, r = layers.reference;
    cancelFlow(true); // Fit all re-places everything: an open Line up flow is closed first
    cancelMatch();
    if (!(d.hasImage && r.hasImage)) {
      for (const layer of allLayers) layer.reset(); // 0 or 1 image: a plain fit of what is there
      syncUI();
      requestRender();
      return;
    }
    render(); // placements and frames are current
    const S = snapshotViews();
    const wasAligned = d.aligned && pairFit('reference');
    if (!wasAligned) for (const layer of allLayers) layer.reset(); // not paired: each fits on its own
    render(); // place the layers that were reset
    const undo = () => setUndo(S, 'Fit undone.');

    if (wasAligned && d.tuned) {
      syncUI();
      requestRender();
      toast('Fitted. Your hand-placed alignment was kept.', undo());
      return;
    }
    if (dotPairs().length) {
      const res = dotsTarget();
      if (res.target) applyAlignment(res.target, 'Fitted and lined up on your dots.', { source: 'dots', snapshot: S });
      else {
        syncUI();
        requestRender();
        toast(`Fitted. ${res.error}`, undo());
      }
      return;
    }
    syncUI();
    requestRender();
    const job = ++alignJob;
    alignKind = 'fit';
    let res = null;
    try {
      res = await matchPair(job);
    } catch (err) {
      console.warn('Fit all matching failed:', err);
    }
    if (job !== alignJob) return; // the user moved something meanwhile: no result, no toast
    alignKind = null;
    setBusy(null);
    if (res && res.confident) {
      applyAlignment(placementFromMatch(placement(r), res), 'Fitted and lined up with the reference.', { source: 'auto', snapshot: S });
    } else if (wasAligned) {
      toast("Fitted. Couldn't find a better match, so your alignment was kept.", undo());
    } else {
      undo(); // Z still undoes; the toast button opens the guided flow
      toast("Fitted both. Couldn't line them up automatically.", lineUpAction());
    }
  }

  /** Shift+F: every image fitted on its own; any alignment is cleared. */
  function plainFit() {
    cancelFlow(true);
    cancelMatch();
    const S = snapshotViews();
    for (const layer of allLayers) layer.reset();
    syncUI();
    requestRender();
    toast('Each image fitted on its own. Alignment cleared.', setUndo(S, 'Fit undone.'));
  }

  /** The per-image Fit tool (and 0): never matches. With Link on and an alignment, the other image follows. */
  function fitOne(slot) {
    const d = layers.drawing;
    cancelMatch();
    render();
    if (state.linked && d.aligned && d.hasImage && layers.reference.hasImage && pairFit(slot)) {
      syncUI();
      requestRender();
      return;
    }
    const S = snapshotViews();
    const dropped = d.aligned && d.hasImage && layers.reference.hasImage;
    for (const l of withCompanions(slot)) l.reset();
    d.aligned = false; // either image re-fitted on its own breaks the pairing
    d.alignSource = null;
    d.tuned = false;
    syncUI();
    requestRender();
    if (dropped) {
      toast(
        slot === 'drawing' ? 'Drawing fitted on its own. It is no longer lined up with the reference.' : 'Reference fitted on its own. The drawing is no longer lined up with it.',
        setUndo(S, 'Fit undone.'),
      );
    }
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
        if (state.layout !== 'overlay' && layers[slot].hasImage && !inSteps()) setActive(slot); // while placing, the target stays selected
      },
      onPan: (dx, dy) => {
        const t = gestureTargets(slot);
        noteManualMove(t);
        for (const l of t) l.panBy(dx, dy);
        requestRender();
      },
      onZoom: (factor, x, y) => {
        const t = gestureTargets(slot);
        noteManualMove(t);
        for (const l of t) l.zoomAt(factor, x, y);
        requestRender();
      },
      onTap: (x, y) => { if (state.dotFlow) flowTap(slot, x, y); },
      // Double-tap / double-click hides or shows the selected image (never fits).
      onDoubleTap: () => {
        if (state.dotFlow) return; // taps are placing dots: never hide anything while the Line up flow is open
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
    cancelFlow(true); // a new photo closes the Line up flow
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
    cancelFlow(true);
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
    cancelFlow(true);
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
      case 'lineup':
        toggleFlow();
        return;
      case 'auto':
        cancelFlow(true);
        runAutoAlign(true);
        return;
      case 'hide':
        if (inSteps()) return; // the target image stays visible while placing dots
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
      case 'prev':
        if (!prevLayer.hasImage || state.dotFlow) return;
        state.showPrev = !state.showPrev;
        break;
      case 'reset':
        fitOne(slot); // syncs and re-renders itself
        return;
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
    els[slot].tools.appendChild(tools);
    toolsEls[slot] = tools;

    const input = $('input[type="file"]', tools);
    input.addEventListener('change', () => {
      loadInto(slot, input.files && input.files[0]);
      input.value = '';
    });
    fileInputs[slot] = input;

    // One delegated handler per pane: head tools, head "Add image", and the
    // empty-state buttons. Empty-state buttons in overlay mode fill whichever
    // slot is empty; everything else acts on the slot that owns the control
    // (`data-owner`: in Overlay the Reference's controls live in the Drawing pane).
    paneEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('.tools-toggle');
      if (toggle) {
        if (state.dotFlow && state.dotFlow.step !== 'review') return; // the tray stays shut while the coach is asking for dots
        setTrayOpen(slot, !paneEl.classList.contains('tools-open'));
        return;
      }
      const chip = e.target.closest('.hidden-chip');
      if (chip) {
        setHidden(chip.dataset.target, false);
        return;
      }
      const owner = e.target.closest('[data-owner]');
      const own = owner ? owner.dataset.owner : slot;
      const tab = e.target.closest('.layer-tab');
      if (tab) {
        if (inSteps()) return; // the step decides which image is selected
        selectTab(own);
        return;
      }
      const step = e.target.closest('[data-shelf]');
      if (step) {
        if (step.disabled) return;
        if (step.dataset.shelf === 'prev') stepPhoto(own, -1);
        else if (step.dataset.shelf === 'next') stepPhoto(own, 1);
        else if (shelfUI.open === own) closeStrip(true);
        else openStrip(own);
        return;
      }
      const item = e.target.closest('.shelf-item[data-id]');
      if (item) {
        if (shelfUI.remove) {
          const id = item.dataset.id;
          if (confirm(`Remove this photo from the ${LABELS[own]} shelf? This cannot be undone.`)) removePhoto(own, id);
        } else {
          switchPhoto(own, item.dataset.id);
          closeStrip(true);
        }
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      if (btn.closest('.shelf')) closeStrip();
      const action = btn.dataset.action;
      const target = btn.closest('.dropzone') ? dropTarget(slot) : own;
      imageAction(target, action);
      // Actions that need the image itself next: get the tray out of the way.
      if (['clear', 'lineup', 'auto'].includes(action)) setTrayOpen(slot, false);
    });
  }

  /** A layer tab was pressed: it becomes the selected image. In Overlay an empty layer can be selected too (to add a photo). */
  function selectTab(slot) {
    const overlay = state.layout === 'overlay';
    if (!overlay && !layers[slot].hasImage) return;
    setActive(slot);
    if (overlay && !layers[slot].hasImage && COMPACT.matches) setTrayOpen('drawing', true); // File / Camera / Paste are in the tray
  }

  /** Layout in which Overlay's tools live in a tray (phones, landscape phones) rather than in the head. */
  const COMPACT = matchMedia('(max-width: 720px), (min-width: 721px) and (max-height: 599px)');

  function setTrayOpen(slot, open) {
    paneEls[slot].classList.toggle('tools-open', open);
    els[slot].toggle.setAttribute('aria-expanded', String(open));
  }

  // ---------------------------------------------------------------- Overlay: one sheet

  /**
   * In Overlay the Reference pane is not shown: its head controls (tab, eye, stepper), its tool row and
   * its thumbnail strip are moved into the Drawing pane's head, so one head carries both layer tabs and
   * only the selected layer's tools. Leaving Overlay puts every element back where the markup had it.
   * Idempotent; driven from syncUI.
   */
  let docked = false;
  const hostPane = (slot) => (docked ? paneEls.drawing : paneEls[slot]); // the pane element that holds a slot's head controls
  function dockReference(on) {
    if (docked === on) return;
    docked = on;
    const d = els.drawing, r = els.reference;
    const refHead = $('.pane-head', r.pane);
    if (on) {
      d.ctl.after(r.ctl);
      d.tools.after(r.tools);
      d.strip.after(r.strip);
      $('.pane-body', d.pane).appendChild(ui.status); // "Aligning…" is a chip on the canvas, so the head never wraps
    } else {
      refHead.prepend(r.ctl);
      refHead.append(r.tools);
      r.pane.insertBefore(r.strip, $('.pane-body', r.pane));
      d.ctl.insertBefore(ui.status, d.headAdd);
    }
  }

  // ---------------------------------------------------------------- shelf strip

  const stripEl = (slot) => els[slot].strip;

  function openStrip(slot, { remove = false } = {}) {
    if (shelfUI.open && shelfUI.open !== slot) closeStrip();
    if (!shelf.count(slot)) return;
    shelfUI.open = slot;
    shelfUI.remove = remove;
    shelfUI.key = '';
    const strip = stripEl(slot);
    // Under the head (its height varies when it wraps); in Overlay both strips open under the single Drawing head.
    strip.style.top = `${$('.pane-head', hostPane(slot)).offsetHeight}px`;
    strip.hidden = false;
    els[slot].count.setAttribute('aria-expanded', 'true');
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
    const count = els[slot].count;
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
    if (alignKind === 'fit') cancelMatch(); // a pending Fit all match belongs to the layout it was started in
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
  $$('input[name="compare"]').forEach((r) => r.addEventListener('change', () => setCompareMode(r.value)));

  ui.link.addEventListener('click', () => {
    state.linked = !state.linked;
    syncUI();
    scheduleSave();
    if (!state.linked && state.layout === 'overlay' && !state.tipUnlink) {
      state.tipUnlink = true;
      toast(`Link is off: drags now move only the selected image (${LABELS[state.active]}). Tap a name above the image to pick the other.`);
    }
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

    const flow = state.dotFlow;
    if (flow && (e.key === 'Enter' || e.key === ' ')) {
      // Enter / Space without a focused button: Start (intro), Done (review), or drop the step's dot at the centre of the image
      const t = e.target;
      const onButton = t instanceof HTMLElement && t.closest('button, select, [role="slider"]') && !t.matches('.dot');
      if (!onButton) {
        e.preventDefault();
        if (e.key === 'Enter' && flow.step === 'intro') flowStart();
        else if (e.key === 'Enter' && flow.step === 'review') flowDone();
        else if (inSteps() && !e.repeat) flowTap(state.layout === 'overlay' ? 'drawing' : stepSlot(flow.step), 0, 0, true);
        return;
      }
    }

    const active = state.active;
    const targets = state.linked ? targetLayers(SLOTS) : targetLayers([active]);
    const step = e.shiftKey ? 10 : 1;
    const nudge = (dx, dy) => {
      noteManualMove(targets);
      targets.forEach((l) => l.panBy(dx, dy));
      requestRender();
    };
    const zoom = (f) => {
      noteManualMove(targets);
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
      case 'f': case 'F': if (e.shiftKey) plainFit(); else fitAll(); break;
      case 'e': case 'E': exportPNG(); break;
      case 'a': case 'A': if (!inSteps()) setActive(other(active)); break;
      case 'm': imageAction(active, 'flipH'); break;
      case 'M': imageAction(active, 'flipV'); break;
      case 'r': imageAction(active, 'rotate'); break;
      case 'R': imageAction(active, 'rotateCCW'); break;
      case 'b': case 'B': imageAction(active, 'gray'); break;
      case 'c': case 'C': imageAction(active, 'contrast'); break;
      case 'd': case 'D': toggleFlow(); break;
      case 'Backspace': if (flow && flow.step !== 'intro') flowBack(); else handled = false; break;
      case 'p': case 'P': imageAction('drawing', 'prev'); break;
      case 'z': case 'Z': if (flow) flowUndo(); else if (undoAlign) undoAlign(); break;
      case '0': imageAction(active, 'reset'); break;
      case 'o': case 'O': if (state.layout === 'overlay' && !ui.swap.hidden) ui.swap.click(); break;
      case 'h': case 'H': if (!inSteps()) imageAction(active, 'hide'); break;
      case 't': if (state.layout === 'overlay') stepCompareMode(1); break;
      case 'T': if (state.layout === 'overlay') stepCompareMode(-1); break;
      case '[': nudgeContextual(-0.1); break;
      case ']': nudgeContextual(0.1); break;
      case ',': stepPhoto(active, -1); break;
      case '.': stepPhoto(active, 1); break;
      case '?': helpDialog.showModal(); break;
      case 'Escape': cancelFlow(); setMoreOpen(false); SLOTS.forEach((s) => setTrayOpen(s, false)); closeStrip(true); break;
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

  /** The slot a control belongs to: its `data-owner`, else the pane it sits in. */
  function ownerSlot(el) {
    const o = el.closest('[data-owner]');
    return o ? o.dataset.owner : el.closest('.pane').dataset.slot;
  }

  function setPressed(btn, on) {
    if (btn) btn.setAttribute('aria-pressed', String(on));
  }

  function syncUI() {
    if (state.dotFlow && !bothLoaded()) {
      state.dotFlow = null;
      loupe.hidden = true;
      toast('Line-up closed: it needs both a drawing and a reference.');
    }
    document.body.dataset.layout = state.layout;
    $(`input[name="layout"][value="${state.layout}"]`).checked = true;
    setPressed(ui.link, state.linked);
    setPressed(ui.grid, state.grid);
    setPressed(ui.gray, state.grayAll);

    const overlay = state.layout === 'overlay';
    dockReference(overlay);
    ui.overlayBar.hidden = !overlay;
    const mode = state.compareMode;
    document.body.dataset.compare = overlay ? mode : '';
    $(`input[name="compare"][value="${mode}"]`).checked = true;
    const top = state.overlayTop;
    ui.swapLabel.textContent = mode === 'wipe' ? `${LABELS[top]} on the left` : `${LABELS[top]} on top`;
    ui.swap.dataset.tip = mode === 'wipe' ? 'Swap which image is on the left of the curtain' : 'Swap which image is on top';
    ui.swap.hidden = !(mode === 'blend' || mode === 'wipe');
    // One contextual slider: Opacity (Blend) or Detail (Outline); Tint has none, Wipe uses the on-canvas handle.
    ui.rangeWrap.hidden = !(mode === 'blend' || mode === 'outline');
    const rangeValue = mode === 'outline' ? state.outlineDetail : state.opacity;
    ui.rangeLabel.textContent = mode === 'outline' ? 'Detail' : 'Opacity';
    ui.opacity.setAttribute('aria-label', mode === 'outline' ? 'Outline detail' : 'Top layer opacity');
    ui.opacity.value = Math.round(rangeValue * 100);
    ui.opacityOut.value = `${Math.round(rangeValue * 100)}%`;
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
          : ownerSlot(btn) === 'drawing' && layers.drawing.hasImage
            ? 'Retake: photograph the drawing again (keeps alignment)'
            : 'Take a photo';
    }
    syncShelf();

    const both = SLOTS.every((s) => layers[s].hasImage);
    const anyImage = SLOTS.some((s) => layers[s].hasImage);
    els.drawing.toggle.setAttribute('aria-controls', overlay ? `tools-${state.active}` : 'tools-drawing');
    for (const slot of SLOTS) {
      const layer = layers[slot];
      const paneEl = paneEls[slot];
      const e = els[slot];
      const tools = toolsEls[slot];
      const tool = (action) => $(`[data-action="${action}"]`, tools);

      // Per-image controls carry their own state classes: in Overlay they are not inside "their" pane.
      const current = state.active === slot;
      for (const el of [e.ctl, e.tools, e.strip]) {
        el.classList.toggle('has-image', layer.hasImage);
        el.classList.toggle('is-current', current);
        el.classList.toggle('is-hidden', layer.hasImage && layer.hidden);
      }
      e.tab.setAttribute('aria-pressed', String(current));
      const emptyTab = overlay && !layer.hasImage;
      $('span', e.tab).textContent = emptyTab ? `${LABELS[slot]} +` : LABELS[slot];
      e.tab.dataset.tip = emptyTab
        ? `No ${LABELS[slot].toLowerCase()} yet. Select it, then add a photo`
        : `Select the ${LABELS[slot].toLowerCase()}: it is the image that moves when Link is off, and the one double-tap hides`;
      e.eye.hidden = !layer.hasImage;
      setPressed(e.eye, layer.hidden);
      paneEl.classList.toggle('has-any', anyImage);

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
      // The tray belongs to the pane that holds it: in Overlay that is the Drawing pane, whichever layer is selected.
      if (overlay ? slot === 'reference' || !anyImage : !layer.hasImage) setTrayOpen(slot, false);

      $$('.needs-image .tool', tools).forEach((b) => (b.disabled = !layer.hasImage));
      for (const [action, on] of [['flipH', layer.flipH], ['flipV', layer.flipV], ['gray', layer.gray], ['contrast', layer.contrast], ['lineup', !!state.dotFlow], ['hide', layer.hidden]]) {
        setPressed(tool(action), on);
      }
      // Line up: needs both images; a small vermilion corner dot says the pair already has dots
      const lu = tool('lineup');
      lu.disabled = !both;
      lu.classList.toggle('has-dots', both && dotPairs().length > 0);
      lu.dataset.tip = both && dotPairs().length ? 'Adjust the dots that line the drawing up' : 'Line the drawing up with the reference by marking the same two spots on both';
    }

    // Drawing-only alignment tools.
    const t = (action) => $(`[data-action="${action}"]`, toolsEls.drawing);
    t('auto').disabled = !both;
    t('prev').disabled = !prevLayer.hasImage && !shelf.previous('drawing'); // the ghost is the shelf entry before the active one
    setPressed(t('prev'), showingPrev());
    t('file').title = layers.drawing.hasImage ? 'Add a photo from a file (a retake: keeps the alignment)' : 'Add from file';
    syncFlow();
  }

  /** Stepper (n / total, chevrons) in each pane head; the open strip follows the shelf. */
  function syncShelf() {
    for (const slot of SLOTS) {
      const n = shelf.count(slot);
      const idx = shelf.ids[slot].indexOf(shelf.active(slot));
      const step = els[slot].step;
      step.hidden = n < 2;
      const count = els[slot].count;
      const unsaved = shelf.unsavedIds(slot).length;
      count.textContent = `${idx + 1} / ${n}`;
      count.classList.toggle('has-unsaved', unsaved > 0);
      count.title = unsaved ? `Show all photos (${unsaved} not saved)` : 'Show all photos';
      count.setAttribute('aria-label', `${LABELS[slot]} photo ${idx + 1} of ${n}. Show all photos`);
      els[slot].prev.disabled = idx <= 0;
      els[slot].next.disabled = idx < 0 || idx >= n - 1;
      if (shelfUI.open === slot) {
        if (!n || (n < 2 && !shelfUI.remove)) closeStrip();
        else renderStrip(slot);
      }
    }
  }

  /** Wipe handle and tags: only when both images are visible in Overlay + Wipe. */
  function syncWipe() {
    const show = state.layout === 'overlay' && state.compareMode === 'wipe' && !soloSlot() && SLOTS.every((s) => layers[s].hasImage && !layers[s].hidden);
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
    state, layers, prevLayer, panes, shelf, store, camera, loadInto, runAutoAlign, alignByDots, fitAll, plainFit, fitOne, render, setHidden, setCompareMode,
    openFlow, cancelFlow, dotPairs, switchPhoto, stepPhoto, removePhoto, flushSave, restored, syncGhost,
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
