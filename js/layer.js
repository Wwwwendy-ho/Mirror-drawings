// A Layer is one image plus its view state: orientation (mirror/flip/90-degree
// turns), value filters (grayscale/contrast), a pane-relative similarity
// transform (x, y, scale, angle) and up to two alignment dots.
//
// Coordinates: (x, y) is the offset of the image centre from the pane centre, in
// CSS pixels; `scale` is CSS pixels per image pixel; `angle` is a free rotation in
// radians (set by alignment). A point p in the image (source pixels, relative to
// the image centre) appears in the pane at
//     (x, y) + R(angle) * scale * orient(p)
// where orient() applies the 90-degree turns and flips. The layer remembers the
// pane size it was last laid out in (`frame`) so it can re-fit or re-scale itself
// when the pane changes size (or a saved view is restored into another window).

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const CONTRAST_BOOST = 1.4;
  const FIT_MARGIN = 12;
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 64;
  const VIEW_KEYS = [
    'flipH', 'flipV', 'rotation', 'gray', 'contrast',
    'x', 'y', 'scale', 'angle', 'moved', 'frame', 'aligned', 'alignSource', 'tuned', 'dots',
  ]; // (older saved views also carry `dotsOn`; dots are only shown while the Line up flow is open, so it is ignored)

  // Canvas 2D `filter` is missing in some browsers (older Safari); fall back to
  // filtering pixels ourselves when it is not available.
  const FILTER_SUPPORTED = (() => {
    try {
      return typeof document.createElement('canvas').getContext('2d').filter === 'string';
    } catch {
      return false;
    }
  })();

  class Layer {
    constructor(id) {
      this.id = id;
      this.source = null; // HTMLCanvasElement holding the (downscaled) image
      this.blob = null; // original file/blob, kept so it can be persisted
      this.flipH = false;
      this.flipV = false;
      this.rotation = 0; // degrees, multiple of 90
      this.gray = false;
      this.contrast = false;
      this.x = 0;
      this.y = 0;
      this.scale = 1;
      this.angle = 0; // radians; non-zero only after an alignment
      this.moved = false; // user has panned/zoomed away from the auto fit
      this.aligned = false; // placed relative to the other image (dots / auto / retake)
      this.alignSource = null; // how it was aligned: null | 'dots' | 'auto'
      this.tuned = false; // aligned, then moved by hand on its own: Fit all keeps such a placement
      this.frame = null; // { w, h } pane size the transform is relative to
      this.dots = [null, null]; // alignment dots, {x, y} in centred source pixels
      this.hidden = false; // skipped when rendering (runtime only, never persisted)
      this._filtered = null;
      this._filteredKey = '';
    }

    get hasImage() {
      return this.source !== null;
    }

    /** Size of the image's bounding box after 90-degree turns, at scale 1. */
    get bounds() {
      if (!this.source) return { w: 0, h: 0 };
      const { width: w, height: h } = this.source;
      return this.rotation % 180 ? { w: h, h: w } : { w, h };
    }

    setImage(canvas, blob = null) {
      this.source = canvas;
      this.blob = blob;
      this._filtered = null;
      this.hidden = false;
      this.flipH = false;
      this.flipV = false;
      this.rotation = 0;
      this.dots = [null, null];
      this.reset();
    }

    /**
     * Swap in a new photo of the same subject, keeping orientation, filters and
     * placement: the new image is shown at the same on-screen width as the old
     * one, and the dots keep their relative positions.
     */
    replaceImage(canvas, blob = null) {
      const oldW = this.source ? this.source.width : canvas.width;
      this.source = canvas;
      this.blob = blob;
      this._filtered = null;
      this.hidden = false;
      const r = canvas.width / oldW;
      this.scale /= r;
      this.dots = this.dots.map((d) => (d ? { x: d.x * r, y: d.y * r } : null));
    }

    clear() {
      this.source = null;
      this.blob = null;
      this._filtered = null;
      this.dots = [null, null];
      this.hidden = false;
      this.reset();
    }

    /** Forget manual placement and alignment; the next layout pass re-fits the image. */
    reset() {
      this.moved = false;
      this.aligned = false;
      this.alignSource = null;
      this.tuned = false;
      this.angle = 0;
      this.frame = null;
    }

    /** Plain-object snapshot of the view state (for persistence and undo). */
    toJSON() {
      const out = {};
      for (const k of VIEW_KEYS) out[k] = this[k];
      out.dots = this.dots.map((d) => (d ? { x: d.x, y: d.y } : null));
      out.frame = this.frame ? { w: this.frame.w, h: this.frame.h } : null;
      return out;
    }

    applyView(view) {
      if (!view || typeof view !== 'object') return;
      for (const k of VIEW_KEYS) if (k in view) this[k] = view[k];
      // Views saved before these existed (or hand-edited ones) load as "not aligned by anything".
      if (!('alignSource' in view)) this.alignSource = null;
      if (!('tuned' in view)) this.tuned = false;
      if (this.alignSource !== 'dots' && this.alignSource !== 'auto') this.alignSource = null;
      this.tuned = this.tuned === true && this.aligned === true;
      this.rotation = ((Math.round(this.rotation / 90) * 90) % 360 + 360) % 360;
      this.angle = Number.isFinite(this.angle) ? this.angle : 0;
      const dots = Array.isArray(view.dots) ? view.dots : [];
      this.dots = [0, 1].map((i) => {
        const d = dots[i];
        return d && Number.isFinite(d.x) && Number.isFinite(d.y) ? { x: d.x, y: d.y } : null;
      });
      this.frame = this.frame && this.frame.w > 0 && this.frame.h > 0 ? { w: this.frame.w, h: this.frame.h } : null;
      if (!Number.isFinite(this.scale) || this.scale <= 0 || !Number.isFinite(this.x) || !Number.isFinite(this.y)) this.reset();
    }

    /**
     * Make the transform valid for a pane of the given size. An untouched layer is
     * fitted and centred; a layer the user has moved is scaled proportionally so
     * that two aligned layers stay aligned when the pane is resized.
     */
    placeIn(w, h) {
      if (!this.source || w <= 0 || h <= 0) return;
      if (this.frame && this.frame.w === w && this.frame.h === h) return;
      if (!this.moved || !this.frame) {
        const b = this.bounds;
        this.scale = Math.min((w - 2 * FIT_MARGIN) / b.w, (h - 2 * FIT_MARGIN) / b.h);
        this.x = 0;
        this.y = 0;
        this.angle = 0;
      } else {
        // Ratio of the panes' short sides: the same for every layer (alignment is
        // kept) and reversible, so switching layouts back and forth never drifts.
        const r = Math.min(w, h) / Math.min(this.frame.w, this.frame.h);
        this.x *= r;
        this.y *= r;
        this.scale *= r;
      }
      this.frame = { w, h };
    }

    panBy(dx, dy) {
      this.x += dx;
      this.y += dy;
      this.moved = true;
    }

    /** Zoom by `factor` around the pane-relative point (px, py). */
    zoomAt(factor, px = 0, py = 0) {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
      const k = next / this.scale;
      this.x = px + (this.x - px) * k;
      this.y = py + (this.y - py) * k;
      this.scale = next;
      this.moved = true;
    }

    rotate(direction = 1) {
      this.rotation = (this.rotation + 90 * direction + 360) % 360;
      if (!this.moved) this.frame = null; // re-fit for the new bounding box
    }

    // ---- point mapping ----

    /** Image point (centred source px) -> displayed orientation (turns, then flips). */
    orient(p) {
      let { x, y } = p;
      for (let i = 0; i < this.rotation / 90; i++) [x, y] = [-y, x];
      return { x: this.flipH ? -x : x, y: this.flipV ? -y : y };
    }

    unorient(p) {
      let x = this.flipH ? -p.x : p.x;
      let y = this.flipV ? -p.y : p.y;
      for (let i = 0; i < this.rotation / 90; i++) [x, y] = [y, -x];
      return { x, y };
    }

    /** Image point -> pane-centred CSS px. */
    toPane(p) {
      const o = this.orient(p);
      const c = Math.cos(this.angle), s = Math.sin(this.angle);
      return {
        x: this.x + this.scale * (o.x * c - o.y * s),
        y: this.y + this.scale * (o.x * s + o.y * c),
      };
    }

    /** Pane-centred CSS px -> image point. */
    fromPane(q) {
      const dx = (q.x - this.x) / this.scale;
      const dy = (q.y - this.y) / this.scale;
      const c = Math.cos(this.angle), s = Math.sin(this.angle);
      return this.unorient({ x: dx * c + dy * s, y: -dx * s + dy * c });
    }

    /**
     * Draw through this layer's transform. `image` substitutes a derived bitmap
     * (tinted copy, outline map) stretched over the source rectangle, with no
     * gray/contrast filter; `composite` sets the blend operation for this draw.
     */
    draw(ctx, paneW, paneH, { alpha = 1, grayAll = false, image: custom = null, composite = null } = {}) {
      if (!this.source) return;
      const gray = !custom && (this.gray || grayAll);
      const contrast = !custom && this.contrast;
      const { width: w, height: h } = this.source;

      ctx.save();
      ctx.globalAlpha = alpha;
      if (composite) ctx.globalCompositeOperation = composite;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(paneW / 2 + this.x, paneH / 2 + this.y);
      ctx.rotate(this.angle);
      ctx.scale(this.scale, this.scale);
      ctx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1); // mirror in screen space
      ctx.rotate((this.rotation * Math.PI) / 180);

      if (custom) {
        ctx.drawImage(custom, -w / 2, -h / 2, w, h);
        ctx.restore();
        return;
      }

      let image = this.source;
      if (gray || contrast) {
        if (FILTER_SUPPORTED) {
          ctx.filter = `${gray ? 'grayscale(1) ' : ''}${contrast ? `contrast(${CONTRAST_BOOST})` : ''}`.trim();
        } else {
          image = this._filteredImage(gray, contrast);
        }
      }
      ctx.drawImage(image, -w / 2, -h / 2);
      ctx.restore();
    }

    _filteredImage(gray, contrast) {
      const key = `${gray}|${contrast}`;
      if (this._filtered && this._filteredKey === key) return this._filtered;

      const src = this.source;
      const canvas = document.createElement('canvas');
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(src, 0, 0);

      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      const k = contrast ? CONTRAST_BOOST : 1;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i];
        let g = d[i + 1];
        let b = d[i + 2];
        if (gray) r = g = b = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (contrast) {
          r = (r - 128) * k + 128;
          g = (g - 128) * k + 128;
          b = (b - 128) * k + 128;
        }
        d[i] = r; // Uint8ClampedArray rounds and clamps
        d[i + 1] = g;
        d[i + 2] = b;
      }
      ctx.putImageData(img, 0, 0);

      this._filtered = canvas;
      this._filteredKey = key;
      return canvas;
    }
  }

  DC.Layer = Layer;
})();
