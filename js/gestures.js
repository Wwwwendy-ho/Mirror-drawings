// Pointer-event gesture recogniser: one pointer pans (after a small slop), two
// pointers pinch-zoom and pan, wheel zooms about the cursor. Quick, still presses
// are taps (onTap); two taps in quick succession are a double-tap (onDoubleTap).
// Touch, pen and mouse all go through the same pointer events, so they behave alike.
// All coordinates handed to callbacks are relative to the element centre, in CSS px.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const WHEEL_SENSITIVITY = 0.002;

  // Tuning constants, per pointer kind (touch also covers pen).
  const TOUCH = {
    tapSlop: 10, // max travel (from the down point) during a press that still counts as a tap
    doubleDist: 30, // max distance between the two down points of a double-tap
  };
  const MOUSE = { tapSlop: 4, doubleDist: 6 };
  const TAP_MAX_MS = 300; // down to up
  const DOUBLE_GAP_MS = 300; // first up to second down
  const MULTI_GUARD_MS = 350; // no taps shortly after a two-pointer gesture (touch)

  const kind = (e) => (e.pointerType === 'mouse' ? MOUSE : TOUCH);

  class Gestures {
    /**
     * @param {HTMLElement} el
     * @param {{
     *   onPress?: () => void,
     *   onPan?: (dx: number, dy: number) => void,
     *   onZoom?: (factor: number, x: number, y: number) => void,
     *   onDoubleTap?: (x: number, y: number) => void,
     *   onTap?: (x: number, y: number) => void,
     * }} handlers
     */
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers;
      this.pointers = new Map(); // pointerId -> { x, y } (client coords)
      this.prev = null; // previous summary of the active pointers
      this.press = null; // the current single-pointer press, while it can still be a tap
      this.panning = false; // a drag past the slop (or a multi-pointer gesture) is under way
      this.lastTap = null; // previous qualifying tap, for double-tap detection
      this.multiAt = -Infinity; // last time two or more pointers were down

      el.addEventListener('pointerdown', (e) => this._down(e));
      el.addEventListener('pointermove', (e) => this._move(e));
      el.addEventListener('pointerup', (e) => this._up(e));
      el.addEventListener('pointercancel', (e) => this._up(e));
      el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      // No context menu on touch long-press mid-gesture.
      el.addEventListener('contextmenu', (e) => {
        if (this.pointers.size) e.preventDefault();
      });
    }

    _down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault(); // no text selection / native drag; this also suppresses focus, so:
      if (this.el.focus) this.el.focus({ preventScroll: true }); // keyboard shortcuts work after a click
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone (or synthetic): events still reach us */
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.prev = this._summary();
      if (this.pointers.size >= 2) {
        this.multiAt = e.timeStamp;
        this.panning = true; // pinch and two-finger pan start immediately
        this.press = null;
      } else {
        this.panning = false;
        const guarded = e.pointerType !== 'mouse' && e.timeStamp - this.multiAt < MULTI_GUARD_MS;
        this.press = guarded ? null : { x: e.clientX, y: e.clientY, t: e.timeStamp, type: e.pointerType, id: e.pointerId };
      }
      if (this.h.onPress) this.h.onPress();
    }

    _move(e) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cur = this._summary();

      // Travel is measured from the down point over the whole press: once past the
      // slop it is a drag, never a tap.
      const slop = kind(e).tapSlop;
      const travelled = this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > slop;
      if (travelled) this.press = null;

      if (!this.panning) {
        if (cur.count === 1 && !travelled) return; // still inside the slop: nothing moves
        if (cur.count === 1) {
          this.panning = true; // start panning from here; the slop distance is discarded
          this.prev = cur;
          return;
        }
      }

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
      if (!this.pointers.has(e.pointerId)) return;
      if (this.pointers.size >= 2) this.multiAt = e.timeStamp;
      const press = this.press;
      this.press = null;
      if (press && press.id === e.pointerId && e.type === 'pointerup' && e.timeStamp - press.t <= TAP_MAX_MS) {
        this._tap(e, press);
      }
      this.pointers.delete(e.pointerId);
      this.prev = this.pointers.size ? this._summary() : null;
      if (!this.pointers.size) this.panning = false;
    }

    /** A qualifying tap: always report it, and pair it with the previous one into a double-tap. */
    _tap(e, press) {
      const p = this._local(e.clientX, e.clientY);
      if (this.h.onTap) this.h.onTap(p.x, p.y);

      const last = this.lastTap;
      const near =
        last &&
        last.type === press.type &&
        press.t - last.upAt <= DOUBLE_GAP_MS &&
        Math.hypot(press.x - last.x, press.y - last.y) <= kind(e).doubleDist;
      if (near) {
        this.lastTap = null; // a triple tap fires once
        if (this.h.onDoubleTap) this.h.onDoubleTap(p.x, p.y);
      } else {
        this.lastTap = { x: press.x, y: press.y, type: press.type, upAt: e.timeStamp };
      }
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
