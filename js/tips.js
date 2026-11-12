/* Info bubbles: one shared tooltip for buttons, driven by data-tip / data-key.
   Hover (400 ms), keyboard focus, and touch long-press (450 ms, the click that follows is swallowed).
   Native title attributes are adopted into data-tip so nothing shows twice. No dependency on app.js. */
(function () {
  'use strict';
  var SEL = 'button, label.btn, .segmented label, .layer-tab';
  var EXC = '.dot, .hidden-chip, .toast-action, [data-close], [data-camera="cancel"], [data-choice="cancel"], [data-no-tip]';
  var BOX = '.tools, .tool-group, .shelf-step, .head-add, .layer-ctl, .dot-coach, .actions, .dialog-actions';
  var OFF = [
    ['[data-action="camera"]', null],
    ['[data-action="auto"], [data-action="lineup"]', 'Needs both a drawing and a reference'],
    ['[data-action="prev"]', 'No earlier photo of this drawing yet'],
    ['.needs-image .tool', 'Add a photo to this pane first'],
    ['[data-shelf="prev"]', 'This is the oldest photo'],
    ['[data-shelf="next"]', 'This is the newest photo'],
    ['[data-camera="capture"]', 'The camera is still starting']
  ];
  var fine = window.matchMedia ? matchMedia('(pointer: fine)') : { matches: true };
  var tip = document.createElement('div');
  tip.id = 'tip';
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  tip.innerHTML = '<span class="tip-name"></span><span class="tip-keys"></span><span class="tip-desc" id="tip-desc"></span>';
  var nameEl = tip.firstChild, keysEl = nameEl.nextSibling, descEl = keysEl.nextSibling;
  var cur = null, hov = null, mode = 'mouse', timer = 0, hideTimer = 0, lastHide = 0;
  var suppress = null, swallow = null, lastType = 'mouse', down = null, raf = 0, mv = null;

  function trigger(t) {
    var el = t && t.closest ? t.closest(SEL) : null;
    return el && !el.matches(EXC) ? el : null;
  }
  // Disabled buttons get no pointer events (tips.css), so find them by position inside their container.
  function triggerAt(e) {
    var t = e.target;
    if (!t || !t.closest || t.tagName === 'CANVAS') return null;
    var el = trigger(t);
    if (el) return el;
    var box = t.closest(BOX);
    if (!box) return null;
    var list = box.querySelectorAll(':disabled');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.matches(SEL) || b.matches(EXC)) continue;
      var r = b.getBoundingClientRect();
      if (r.width && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return b;
    }
    return null;
  }
  function anchor(el) { return el; }
  function describedBy(el) {
    if (el.tagName === 'LABEL' && el.htmlFor) return document.getElementById(el.htmlFor) || el;
    return el;
  }

  function adopt(el) {
    var v = el.getAttribute('title');
    if (v === null) return;
    v = v.trim();
    if (v) {
      var m = /\s*\(((?:Shift\+)?[A-Z0-9?,.\[\]])\)$/.exec(v);
      if (m && !el.dataset.key) { el.dataset.key = m[1]; v = v.slice(0, m.index); }
      el.dataset.tip = v;
    }
    el.removeAttribute('title');
    if (cur === el) render(el);
  }
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('title')) adopt(root);
    var i, l = root.querySelectorAll('[title],[data-key]');
    for (i = 0; i < l.length; i++) {
      if (l[i].hasAttribute('title')) adopt(l[i]);
      if (l[i].dataset.key && !l[i].hasAttribute('aria-keyshortcuts')) l[i].setAttribute('aria-keyshortcuts', l[i].dataset.key);
    }
  }

  function reason(el) {
    for (var i = 0; i < OFF.length; i++) if (el.matches(OFF[i][0])) return el.dataset.tipOff || OFF[i][1] || el.dataset.tip || '';
    return el.dataset.tipOff || '';
  }

  function render(el) {
    var off = el.disabled;
    var name = (el.getAttribute('aria-label') || el.textContent).replace(/\s+/g, ' ').trim();
    var desc = off ? reason(el) : el.dataset.tip || '';
    var key = !off && el.dataset.key;
    if (!name && !desc) return false;
    if (!desc && !key && !(el.querySelector('.sr-only') || off)) return false;
    if (desc.toLowerCase() === name.toLowerCase()) desc = '';
    nameEl.textContent = name || desc;
    if (!name) desc = '';
    descEl.textContent = desc;
    tip.classList.toggle('is-off', !!off);
    keysEl.textContent = '';
    if (key && (mode === 'kbd' || (mode === 'mouse' && fine.matches))) {
      key.split('+').forEach(function (k) {
        var kb = document.createElement('kbd');
        kb.textContent = k;
        keysEl.appendChild(kb);
      });
    }
    return true;
  }

  function place(el) {
    tip.style.left = tip.style.top = '0px'; // measure at the origin so the width does not depend on the old position
    var vv = window.visualViewport;
    var vx = vv ? vv.offsetLeft : 0, vy = vv ? vv.offsetTop : 0;
    var vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
    var L = vx + 6, T = vy + 6, R = vx + vw - 6, B = vy + vh - 6;
    var r = anchor(el).getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight, gap = mode === 'touch' ? 12 : 8;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
    var fits = {
      above: r.top - gap - h >= T, below: r.bottom + gap + h <= B,
      left: r.left - gap - w >= L, right: r.right + gap + w <= R
    };
    var order = mode === 'touch' ? ['above', 'left', 'right', 'below'] : cy < vy + vh * 0.45 ? ['below', 'above'] : ['above', 'below'];
    var side = null;
    for (var i = 0; i < order.length && !side; i++) if (fits[order[i]]) side = order[i];
    if (!side) side = order[0] === 'below' ? 'below' : 'above';
    var x, y;
    if (side === 'above' || side === 'below') {
      x = clamp(cx - w / 2, L, Math.max(L, R - w));
      y = side === 'above' ? r.top - gap - h : r.bottom + gap;
      tip.style.setProperty('--ax', clamp(cx - x, 10, w - 10) + 'px');
    } else {
      y = clamp(cy - h / 2, T, Math.max(T, B - h));
      x = side === 'left' ? r.left - gap - w : r.right + gap;
      tip.style.setProperty('--ay', clamp(cy - y, 10, h - 10) + 'px');
    }
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
    tip.className = tip.className.replace(/ ?is-(above|below|left|right)/g, '') + ' is-' + side;
  }

  function show(el, m) {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    mode = m || 'mouse';
    var host = el.closest('dialog[open]') || document.body;
    if (tip.parentNode !== host) host.appendChild(tip);
    if (!render(el)) { hide(); return false; }
    var was = !!cur;
    if (cur && cur !== el) cur.removeAttribute('aria-describedby');
    cur = el;
    tip.style.visibility = 'hidden';
    tip.hidden = false;
    tip.classList.remove('show');
    place(el);
    tip.style.visibility = '';
    if (was) tip.style.transition = 'none';
    void tip.offsetWidth;
    tip.style.transition = '';
    tip.classList.add('show');
    var d = describedBy(el);
    if (descEl.textContent) d.setAttribute('aria-describedby', 'tip-desc');
    el.dataset.tipOn = '';
    return true;
  }
  function hide() {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    if (!cur) return;
    describedBy(cur).removeAttribute('aria-describedby');
    cur.removeAttribute('data-tip-on');
    cur = null;
    tip.classList.remove('show');
    tip.hidden = true;
    lastHide = Date.now();
  }
  function later(el, m, ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { show(el, m); }, ms);
  }

  // ---- mouse / pen hover
  function over(e) {
    if (e.pointerType === 'touch') { lastType = 'touch'; return; }
    lastType = 'mouse';
    var t = triggerAt(e);
    if (t === hov) return;
    hov = t;
    clearTimeout(timer);
    if (suppress && suppress !== t) suppress = null;
    if (!t) { if (cur && mode !== 'kbd') hide(); return; }
    if (t === suppress) return;
    if (cur === t) return;
    later(t, 'mouse', cur || Date.now() - lastHide < 300 ? 0 : 400);
  }
  document.addEventListener('pointerover', over, { passive: true, capture: true });
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') { touchMove(e); return; }
    var t = e.target;
    if (!t || t.tagName === 'CANVAS' || raf || t.closest(SEL) || !t.closest || !t.closest(BOX)) return;
    mv = e;
    raf = requestAnimationFrame(function () { raf = 0; over(mv); });
  }, { passive: true, capture: true });
  document.addEventListener('pointerout', function (e) {
    if (!e.relatedTarget && e.pointerType !== 'touch') { hov = null; clearTimeout(timer); if (mode !== 'kbd') hide(); }
  }, { passive: true, capture: true });

  // ---- touch long-press
  function touchMove(e) {
    if (!down) return;
    if (Math.abs(e.clientX - down.x) > 10 || Math.abs(e.clientY - down.y) > 10) {
      clearTimeout(timer);
      if (down.shown) { hide(); swallow = null; }
      down = null;
    }
  }
  document.addEventListener('pointerdown', function (e) {
    lastType = e.pointerType;
    swallow = null;
    down = null;
    var t = null;
    if (e.pointerType !== 'touch') {
      hide();
      t = trigger(e.target);
      suppress = t;
      return;
    }
    hide();
    t = triggerAt(e);
    if (!t) return;
    down = { x: e.clientX, y: e.clientY, el: t, shown: false };
    var d = down;
    timer = setTimeout(function () {
      if (down !== d) return;
      if (show(t, 'touch')) { d.shown = true; swallow = { el: t, until: 0 }; }
    }, 450);
  }, { passive: true, capture: true });
  function up(e) {
    if (e.pointerType !== 'touch' || !down) return;
    clearTimeout(timer);
    if (down.shown) {
      if (e.type === 'pointerup' && swallow) swallow.until = performance.now() + 700;
      else swallow = null;
      hideTimer = setTimeout(hide, 900);
    }
    down = null;
  }
  document.addEventListener('pointerup', up, { passive: true, capture: true });
  document.addEventListener('pointercancel', up, { passive: true, capture: true });
  document.addEventListener('click', function (e) {
    if (swallow && swallow.until && performance.now() < swallow.until && (swallow.el.contains(e.target) || describedBy(swallow.el) === e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallow = null;
      return;
    }
    if (e.isTrusted && lastType !== 'touch') { clearTimeout(timer); hide(); }
  }, true);
  document.addEventListener('contextmenu', function (e) {
    if (lastType === 'touch' && trigger(e.target)) e.preventDefault();
  }, true);

  // ---- keyboard focus
  document.addEventListener('focusin', function (e) {
    var t = e.target, el = null;
    if (!t.matches || !t.matches(':focus-visible')) return;
    if (t.matches('.segmented input') && t.nextElementSibling && t.nextElementSibling.tagName === 'LABEL') el = t.nextElementSibling;
    else el = trigger(t);
    if (el) later(el, 'kbd', 150);
  });
  document.addEventListener('focusout', function () { clearTimeout(timer); if (mode === 'kbd') hide(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && cur) { hide(); e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- anything that moves the page
  ['scroll', 'wheel'].forEach(function (n) { document.addEventListener(n, function () { if (cur) hide(); }, { passive: true, capture: true }); });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);

  // ---- titles written later by app.js become data-tip
  scan(document.body);
  document.body.appendChild(tip);
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'attributes') adopt(m.target);
      else for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  window.DrawingCompare = window.DrawingCompare || {};
  window.DrawingCompare.tips = { show: show, hide: hide };
})();
