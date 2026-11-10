// A Layer is one image plus its view state: orientation (mirror/flip/rotate),
// value filters (grayscale/contrast) and a pane-relative transform (x, y, scale).
//
// Coordinates: (x, y) is the offset of the image centre from the pane centre, in
// CSS pixels; `scale` is CSS pixels per image pixel. The layer remembers the pane
// size it was last laid out in (`frame`) so it can re-fit or re-scale itself when
// the pane changes size (or when a saved view is restored into a different window).

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const CONTRAST_BOOST = 1.4;
  const FIT_MARGIN = 12;
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 64;
  const VIEW_KEYS = ['flipH', 'flipV', 'rotation', 'gray', 'contrast', 'x', 'y', 'scale', 'moved', 'frame'];

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
      this.moved = false; // user has panned/zoomed away from the auto fit
      this.frame = null; // { w, h } pane size the transform is relative to
      this._filtered = null;
      this._filteredKey = '';
    }

    get hasImage() {
      return this.source !== null;
    }

    /** Size of the image's bounding box after rotation, at scale 1. */
    get bounds() {
      if (!this.source) return { w: 0, h: 0 };
      const { width: w, height: h } = this.source;
      return this.rotation % 180 ? { w: h, h: w } : { w, h };
    }

    setImage(canvas, blob = null) {
      this.source = canvas;
      this.blob = blob;
      this._filtered = null;
      this.flipH = false;
      this.flipV = false;
      this.rotation = 0;
      this.reset();
    }

    clear() {
      this.source = null;
      this.blob = null;
      this._filtered = null;
      this.reset();
    }

    /** Forget manual pan/zoom; the next layout pass re-fits the image. */
    reset() {
      this.moved = false;
      this.frame = null;
    }

    /** Plain-object snapshot of the view state (for persistence). */
    toJSON() {
      const out = {};
      for (const k of VIEW_KEYS) out[k] = this[k];
      return out;
    }

    applyView(view) {
      if (!view || typeof view !== 'object') return;
      for (const k of VIEW_KEYS) if (k in view) this[k] = view[k];
      this.rotation = ((Math.round(this.rotation / 90) * 90) % 360 + 360) % 360;
      if (!Number.isFinite(this.scale) || this.scale <= 0) this.reset();
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
      } else {
        const r = Math.min(w / this.frame.w, h / this.frame.h);
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

    draw(ctx, paneW, paneH, { alpha = 1, grayAll = false } = {}) {
      if (!this.source) return;
      const gray = this.gray || grayAll;
      const contrast = this.contrast;
      const { width: w, height: h } = this.source;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(paneW / 2 + this.x, paneH / 2 + this.y);
      ctx.scale(this.scale, this.scale);
      ctx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1); // mirror in screen space
      ctx.rotate((this.rotation * Math.PI) / 180);

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
