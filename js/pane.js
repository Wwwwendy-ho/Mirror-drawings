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

    /**
     * @param {{layer: Layer, alpha?: number}[]} items bottom to top
     */
    render(items, { grid = false, grayAll = false, background = '#000' } = {}) {
      const { ctx, width: w, height: h, dpr } = this;
      if (w <= 0 || h <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
      for (const { layer, alpha = 1 } of items) layer.draw(ctx, w, h, { alpha, grayAll });
      if (grid) drawGrid(ctx, w, h);
    }
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
