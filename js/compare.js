// Overlay compare modes. This module turns "two visible layers + a mode" into a
// render plan for Pane.render, and owns the derived bitmaps (tinted copies, the
// reference's edge map) with their caches. Derived bitmaps stay in SOURCE space,
// so they travel through each layer's normal transform (mirror, flip, rotate,
// free rotation) with no extra code. No DOM access beyond offscreen canvases.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const MODES = ['tint', 'blend', 'wipe', 'outline'];
  const WIPE_MIN = 0.04;
  const WIPE_MAX = 0.96;
  // Exact RGB complements, so where both agree the product is near-black.
  const COLORS = { drawing: '#29bad5', reference: '#d6452a' };
  const CONTRAST_BOOST = 1.4;
  const EDGE_WORK_EDGE = 1024; // long side of the edge-map work canvas
  // If a slow device stalls on the first Tint, cap tinted bitmaps here (long side, px).
  const TINT_MAX_EDGE = Infinity;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hexRGB = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  // ---------------------------------------------------------------- tint

  const tintCache = new WeakMap(); // source canvas -> Map<key, canvas>

  /** Luminance mapped onto a ramp from the tint colour (black) to white; alpha unchanged. */
  function tinted(layer, hex) {
    const src = layer.source;
    if (!src) return null;
    const key = `${hex}|${layer.contrast}`;
    let perSource = tintCache.get(src);
    if (!perSource) tintCache.set(src, (perSource = new Map()));
    const hit = perSource.get(key);
    if (hit) return hit;

    const k = Math.min(1, TINT_MAX_EDGE / Math.max(src.width, src.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(src.width * k));
    canvas.height = Math.max(1, Math.round(src.height * k));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const [tr, tg, tb] = hexRGB(hex);
    const dr = 255 - tr, dg = 255 - tg, db = 255 - tb;
    const contrast = layer.contrast;
    for (let i = 0; i < d.length; i += 4) {
      let l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (contrast) l = clamp((l - 128) * CONTRAST_BOOST + 128, 0, 255);
      const f = l / 255;
      d[i] = tr + dr * f;
      d[i + 1] = tg + dg * f;
      d[i + 2] = tb + db * f;
    }
    ctx.putImageData(img, 0, 0);
    perSource.set(key, canvas);
    return canvas;
  }

  // ---------------------------------------------------------------- outline

  const edgeCache = new WeakMap(); // source canvas -> { w, h, mag, canvas, builtFor }

  /** Edge magnitude map (0..255) of a source canvas: downscale, blur, Sobel, percentile-normalise. */
  function edgeMap(src) {
    const hit = edgeCache.get(src);
    if (hit) return hit;

    const s = Math.min(1, EDGE_WORK_EDGE / Math.max(src.width, src.height));
    const w = Math.max(3, Math.round(src.width * s));
    const h = Math.max(3, Math.round(src.height * s));
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const wctx = work.getContext('2d');
    wctx.fillStyle = '#fff'; // transparent areas count as paper, not as a black frame
    wctx.fillRect(0, 0, w, h);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(src, 0, 0, w, h);
    const px = wctx.getImageData(0, 0, w, h).data;

    let lum = new Float32Array(w * h);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
      lum[i] = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
    }

    // Separable [1 2 1] / 4 blur, clamped at the borders.
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const a = lum[row + (x > 0 ? x - 1 : 0)];
        const c = lum[row + (x < w - 1 ? x + 1 : x)];
        tmp[row + x] = (a + 2 * lum[row + x] + c) / 4;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : 0) * w;
      const dn = (y < h - 1 ? y + 1 : y) * w;
      const row = y * w;
      for (let x = 0; x < w; x++) lum[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) / 4;
    }

    // Sobel; the 1 px border stays 0 so no frame appears around the image.
    const m = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const tl = lum[i - w - 1], t = lum[i - w], tr = lum[i - w + 1];
        const l = lum[i - 1], r = lum[i + 1];
        const bl = lum[i + w - 1], b = lum[i + w], br = lum[i + w + 1];
        const gx = tr + 2 * r + br - tl - 2 * l - bl;
        const gy = bl + 2 * b + br - tl - 2 * t - tr;
        const v = Math.hypot(gx, gy) / 4;
        m[i] = v;
        hist[Math.min(255, v | 0)]++;
        count++;
      }
    }
    let p = 255;
    for (let acc = 0, bin = 0; bin < 256; bin++) {
      acc += hist[bin];
      if (acc >= count * 0.98) {
        p = bin;
        break;
      }
    }
    const scale = 255 / Math.max(p, 8);
    const mag = new Uint8ClampedArray(w * h);
    for (let i = 0; i < mag.length; i++) mag[i] = m[i] * scale;

    const entry = { w, h, mag, canvas: null, builtFor: '' };
    edgeCache.set(src, entry);
    return entry;
  }

  const smoothstep = (lo, hi, v) => {
    const t = clamp((v - lo) / (hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /** The reference's contours as a coloured, alpha-keyed bitmap in source space (rebuilt only when detail changes). */
  function outline(layer, detail, hex) {
    const src = layer.source;
    if (!src) return null;
    const e = edgeMap(src);
    const d = Math.round(clamp(Number.isFinite(detail) ? detail : 0.5, 0, 1) / 0.02) * 0.02;
    const key = `${d.toFixed(2)}|${hex}`;
    if (e.canvas && e.builtFor === key) return e.canvas;

    if (!e.canvas) {
      e.canvas = document.createElement('canvas');
      e.canvas.width = e.w;
      e.canvas.height = e.h;
    }
    const ctx = e.canvas.getContext('2d');
    const img = ctx.createImageData(e.w, e.h);
    const out = img.data;
    const [r, g, b] = hexRGB(hex);
    const lo = 255 * (0.55 - 0.45 * d);
    const hi = lo + 40;
    // 256-entry lookup: alpha for each magnitude.
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = smoothstep(lo, hi, v) * 255;
    for (let i = 0, j = 0; i < e.mag.length; i++, j += 4) {
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      out[j + 3] = lut[e.mag[i]];
    }
    ctx.putImageData(img, 0, 0);
    e.builtFor = key;
    return e.canvas;
  }

  /** Drop every derived bitmap for a source canvas (call when it leaves memory). */
  function forget(canvas) {
    tintCache.delete(canvas);
    edgeCache.delete(canvas);
  }

  // ---------------------------------------------------------------- planner

  /**
   * Decide what to draw. `top`/`bottom` are the layers to composite (null when
   * empty or hidden); `drawing`/`reference` say which of them plays which role
   * (so Swap never changes colours). Returns what Pane.render needs.
   *
   * @returns {{items: object[], isolate: boolean, divider: number|null}}
   */
  function plan({ mode, bottom, top, drawing, reference, opacity = 0.5, wipe = 0.5, detail = 0.5, paneWidth = 0 }) {
    const plain = (layer) => ({ items: [{ layer }], isolate: false, divider: null });
    const present = [bottom, top].filter(Boolean);
    if (!present.length) return { items: [], isolate: false, divider: null };
    if (present.length === 1) return plain(present[0]);

    switch (mode) {
      case 'blend':
        return { items: [{ layer: bottom }, { layer: top, alpha: opacity }], isolate: false, divider: null };
      case 'wipe': {
        const x = clamp(wipe, WIPE_MIN, WIPE_MAX) * paneWidth;
        return {
          items: [
            { layer: bottom, clip: { x0: x, x1: paneWidth } },
            { layer: top, clip: { x0: 0, x1: x } },
          ],
          isolate: false,
          divider: x,
        };
      }
      case 'outline': {
        if (!drawing || !reference) return plain(top);
        return {
          items: [{ layer: drawing }, { layer: reference, image: outline(reference, detail, COLORS.reference) }],
          isolate: false,
          divider: null,
        };
      }
      case 'tint':
      default: {
        const colour = (layer) => (layer === reference ? COLORS.reference : COLORS.drawing);
        return {
          items: [
            { layer: bottom, image: tinted(bottom, colour(bottom)) },
            { layer: top, image: tinted(top, colour(top)), composite: 'multiply' },
          ],
          isolate: true,
          divider: null,
        };
      }
    }
  }

  DC.Compare = { MODES, COLORS, WIPE_MIN, WIPE_MAX, tinted, outline, forget, plan };
})();
