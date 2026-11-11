// A Pane owns one canvas that fills its container element, keeps the backing
// store in sync with the element size and device pixel ratio, and renders a
// list of layers (bottom to top) plus an optional grid.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  class Pane {
    constructor(el, canvas, onResize) {
      this.el = el;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.width = 0; // CSS px
      this.height = 0;
      this.dpr = 1;
      this.onResize = onResize;

      this._observer = new ResizeObserver(() => this.measure());
      this._observer.observe(el);
    }

    /** Re-read the element size; resize the backing store if it changed. */
    measure() {
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (w === this.width && h === this.height && dpr === this.dpr) return;
      this.width = w;
      this.height = h;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      if (this.onResize) this.onResize();
    }

    /** Transparent offscreen canvas the size of the backing store (for blends that must not touch the mat). */
    _scratchCtx() {
      if (!this._scratch) {
        this._scratch = document.createElement('canvas');
        this._scratchCtx2d = this._scratch.getContext('2d');
      }
      const s = this._scratch;
      if (s.width !== this.canvas.width || s.height !== this.canvas.height) {
        s.width = this.canvas.width;
        s.height = this.canvas.height;
      }
      const c = this._scratchCtx2d;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, s.width, s.height);
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      return c;
    }

    /**
     * @param {{layer: Layer, alpha?: number, image?: HTMLCanvasElement, composite?: string,
     *          clip?: {x0: number, x1: number}}[]} items bottom to top; `clip` is in pane CSS px
     * @param {{grid?: boolean, grayAll?: boolean, background?: string,
     *          isolate?: boolean, divider?: number|null}} opts
     *   `isolate` draws the items on a transparent scratch canvas first (so a blend
     *   such as multiply only affects the overlap), then lays that over the mat.
     *   `divider` is an x in CSS px for a vertical curtain line (drawn before the grid).
     */
    render(items, { grid = false, grayAll = false, background = '#000', isolate = false, divider = null } = {}) {
      const { ctx, width: w, height: h, dpr } = this;
      if (w <= 0 || h <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);

      const target = isolate ? this._scratchCtx() : ctx;
      for (const { layer, alpha = 1, image = null, composite = null, clip = null } of items) {
        if (clip) {
          target.save();
          target.beginPath();
          target.rect(clip.x0, 0, clip.x1 - clip.x0, h);
          target.clip();
        }
        layer.draw(target, w, h, { alpha, grayAll, image, composite });
        if (clip) target.restore();
      }
      if (isolate) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this._scratch, 0, 0);
        ctx.restore();
      }
      if (divider !== null) drawDivider(ctx, divider, w, h, dpr);
      if (grid) drawGrid(ctx, w, h);
    }
  }

  /** Curtain line: a dark 3 px band with a light 1 px core, snapped to device pixels. */
  function drawDivider(ctx, x, w, h, dpr) {
    const odd = (n) => Math.max(1, Math.round(n)) | 1; // odd device-pixel width centres on one pixel
    const cx = Math.round(x * dpr) + 0.5; // pixel centre in device px
    const dark = odd(3 * dpr);
    const light = odd(dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(42, 37, 33, 0.55)';
    ctx.fillRect(cx - dark / 2, 0, dark, Math.round(h * dpr));
    ctx.fillStyle = '#f3eee5';
    ctx.fillRect(cx - light / 2, 0, light, Math.round(h * dpr));
    ctx.restore();
  }

  /** Thirds (stronger) plus sixths (lighter), drawn with a dark halo so the lines read on any image. */
  function drawGrid(ctx, w, h, divisions = 6) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    for (const pass of [{ color: 'rgba(0,0,0,0.55)', extra: 2 }, { color: 'rgba(255,255,255,0.85)', extra: 0 }]) {
      ctx.strokeStyle = pass.color;
      for (let i = 1; i < divisions; i++) {
        const major = (i * 3) % divisions === 0;
        ctx.lineWidth = (major ? 1.5 : 0.75) + pass.extra;
        const x = Math.round((i / divisions) * w) + 0.5;
        const y = Math.round((i / divisions) * h) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  DC.Pane = Pane;
})();
