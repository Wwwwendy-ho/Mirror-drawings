// Pointer-event gesture recogniser: one pointer pans, two pointers pinch-zoom and
// pan, wheel zooms about the cursor, double-click/tap fires a callback.
// All coordinates handed to callbacks are relative to the element centre, in CSS px.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const WHEEL_SENSITIVITY = 0.002;

  class Gestures {
    /**
     * @param {HTMLElement} el
     * @param {{
     *   onPress?: () => void,
     *   onPan?: (dx: number, dy: number) => void,
     *   onZoom?: (factor: number, x: number, y: number) => void,
     *   onDoubleTap?: () => void,
     * }} handlers
     */
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers;
      this.pointers = new Map(); // pointerId -> { x, y } (client coords)
      this.prev = null; // previous summary of the active pointers

      el.addEventListener('pointerdown', (e) => this._down(e));
      el.addEventListener('pointermove', (e) => this._move(e));
      el.addEventListener('pointerup', (e) => this._up(e));
      el.addEventListener('pointercancel', (e) => this._up(e));
      el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (this.h.onDoubleTap) this.h.onDoubleTap();
      });
      // No context menu on touch long-press mid-gesture.
      el.addEventListener('contextmenu', (e) => {
        if (this.pointers.size) e.preventDefault();
      });
    }

    _down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault(); // no text selection / native drag; this also suppresses focus, so:
      if (this.el.focus) this.el.focus({ preventScroll: true }); // keyboard shortcuts work after a click
      this.el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.prev = this._summary();
      if (this.h.onPress) this.h.onPress();
    }

    _move(e) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cur = this._summary();
      const prev = this.prev;
      if (prev && prev.count === cur.count) {
        if (cur.count >= 2 && prev.dist > 0 && this.h.onZoom) {
          const anchor = this._local(prev.cx, prev.cy);
          this.h.onZoom(cur.dist / prev.dist, anchor.x, anchor.y);
        }
        if (this.h.onPan) this.h.onPan(cur.cx - prev.cx, cur.cy - prev.cy);
      }
      this.prev = cur;
    }

    _up(e) {
      this.pointers.delete(e.pointerId);
      this.prev = this.pointers.size ? this._summary() : null;
    }

    _wheel(e) {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // lines
      else if (e.deltaMode === 2) dy *= 120; // pages
      const factor = Math.exp(-dy * WHEEL_SENSITIVITY);
      const p = this._local(e.clientX, e.clientY);
      if (this.h.onZoom) this.h.onZoom(factor, p.x, p.y);
    }

    /** Centre and spread of the first two active pointers. */
    _summary() {
      const pts = [...this.pointers.values()];
      const count = pts.length;
      if (count === 0) return { count: 0, cx: 0, cy: 0, dist: 0 };
      if (count === 1) return { count, cx: pts[0].x, cy: pts[0].y, dist: 0 };
      const [a, b] = pts;
      return { count, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(b.x - a.x, b.y - a.y) };
    }

    _local(clientX, clientY) {
      const r = this.el.getBoundingClientRect();
      return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
    }
  }

  DC.Gestures = Gestures;
})();
