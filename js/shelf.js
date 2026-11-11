// Photo shelves. Each slot (drawing, reference) owns a chronological list of
// photos, oldest first, of which exactly one is "on the easel" (shown by the
// slot's Layer). The rest of the app works on two Layers and does not know
// shelves exist; this module owns what is stored and what is decoded.
//
// IndexedDB keys (same database and `kv` store as everything else):
//   shelf:<slot>   string[] of photo ids, oldest first (saved photos only)
//   photo:<id>     { id, slot, created, w, h, bytes, type, thumb: Blob }
//   blob:<id>      the stored image Blob (normalised, see normalise())
//   view:<id>      Layer.toJSON() for that photo
// Only Storage.batch writes or deletes photo keys, so a crash can never leave a
// half-written photo behind; load() sweeps any strays it finds.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const SLOTS = ['drawing', 'reference'];
  const MAX_PER_SHELF = 12;
  // Decoded canvases kept per slot (the active photo plus the previously active
  // one). If a device struggles, set this to 1.
  const CACHE_PER_SLOT = 2;
  const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;
  const KEEP_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const REENCODE_QUALITY = 0.9;
  const THUMB_EDGE = 128;
  const THUMB_QUALITY = 0.7;
  const LOW_SPACE_BYTES = 20 * 1024 * 1024;

  const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  const isQuotaError = (err) => !!err && (err.name === 'QuotaExceededError' || err.code === 22 || /quota/i.test(err.message || ''));
  const otherSlot = (slot) => (slot === 'drawing' ? 'reference' : 'drawing');

  /** A copy of `canvas` on white, scaled so its long side is at most `edge` (or kept as is). */
  function flatten(canvas, edge = Infinity) {
    const k = Math.min(1, edge / Math.max(canvas.width, canvas.height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(canvas.width * k));
    out.height = Math.max(1, Math.round(canvas.height * k));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  class Shelf {
    constructor(store) {
      this.store = store;
      this.limit = MAX_PER_SHELF; // photos per slot; tests may lower it
      this.cacheSize = CACHE_PER_SLOT;
      this.persistent = true; // false once storage is known to be unusable: shelves then live in memory only
      this.inUse = () => false; // app: is this canvas still shown by a layer?
      this.ids = { drawing: [], reference: [] }; // every photo, oldest first (including unsaved ones)
      this.records = new Map(); // id -> record (+ runtime `unsaved` flag)
      this.activeId = { drawing: null, reference: null };
      this.version = 0; // bumped on every change the UI should redraw for
      this._cache = { drawing: [], reference: [] }; // [{ id, canvas }], most recent first
      this._decoding = new Map(); // id -> in-flight decode promise
      this._views = new Map(); // id -> latest view (memory copy)
      this._memBlobs = new Map(); // id -> blob, for photos that are not (or cannot be) stored
      this._thumbUrls = new Map(); // id -> object URL, created once per record
      this._chain = Promise.resolve();
    }

    // ------------------------------------------------------------ reading

    list(slot) {
      return this.ids[slot].map((id) => this.records.get(id));
    }

    count(slot) {
      return this.ids[slot].length;
    }

    total() {
      return SLOTS.reduce((n, s) => n + this.count(s), 0);
    }

    record(id) {
      return this.records.get(id) || null;
    }

    active(slot) {
      return this.activeId[slot];
    }

    index(id) {
      const rec = this.records.get(id);
      return rec ? this.ids[rec.slot].indexOf(id) : -1;
    }

    /** The shelf entry just before the active one (the "previous photo" ghost), or null. */
    previous(slot) {
      const i = this.ids[slot].indexOf(this.activeId[slot]);
      return i > 0 ? this.records.get(this.ids[slot][i - 1]) : null;
    }

    /** Where the easel goes if `id` is removed: the older neighbour, else the newer one. */
    neighbour(id) {
      const rec = this.records.get(id);
      if (!rec) return null;
      const ids = this.ids[rec.slot];
      const i = ids.indexOf(id);
      return ids[i - 1] || ids[i + 1] || null;
    }

    setActive(slot, id) {
      this.activeId[slot] = this.records.has(id) ? id : null;
      this.version++;
    }

    savedCount(slot) {
      return this.ids[slot].filter((id) => !this.records.get(id).unsaved).length;
    }

    unsavedIds(slot) {
      return this.ids[slot].filter((id) => this.records.get(id).unsaved);
    }

    /** "#3 · 10 Nov 14:32": position on the shelf plus capture time. */
    label(id) {
      const rec = this.records.get(id);
      if (!rec) return '';
      const d = new Date(rec.created);
      const pad = (n) => String(n).padStart(2, '0');
      return `#${this.index(id) + 1} · ${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** Object URL of the thumbnail, created once per record and revoked on removal. */
    thumbUrl(id) {
      const rec = this.records.get(id);
      if (!rec || !rec.thumb) return '';
      let url = this._thumbUrls.get(id);
      if (!url) this._thumbUrls.set(id, (url = URL.createObjectURL(rec.thumb)));
      return url;
    }

    /** Serialise mutations so overlapping adds and removes write consistent shelf arrays. */
    _serial(fn) {
      const run = this._chain.then(fn, fn);
      this._chain = run.catch(() => {});
      return run;
    }

    // ------------------------------------------------------------ startup

    /**
     * Read shelves and photo records, migrating the old one-image-per-slot keys
     * and sweeping orphans. Does not decode any image. Rejects if storage is
     * unusable (the shelf then works in memory for this session).
     */
    async load() {
      if (!this.store.available) {
        this.persistent = false;
        throw new Error('IndexedDB is not available');
      }
      try {
        const keys = new Set(await this.store.keys());
        for (const slot of SLOTS) {
          if (!keys.has(`shelf:${slot}`) && keys.has(`image:${slot}`)) await this._migrate(slot);
        }
        let repaired = [];
        for (const slot of SLOTS) {
          const stored = await this.store.get(`shelf:${slot}`);
          const wanted = Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
          const kept = [];
          for (const id of wanted) {
            const rec = await this.store.get(`photo:${id}`);
            if (rec && rec.id === id) {
              this.records.set(id, rec);
              kept.push(id);
            }
          }
          this.ids[slot] = kept;
          if (kept.length !== wanted.length) repaired.push(slot);
        }
        for (const slot of repaired) await this.store.set(`shelf:${slot}`, this.ids[slot]);
        await this._sweep();
        this.version++;
      } catch (err) {
        this.persistent = false;
        throw err;
      }
    }

    /** Turn legacy image:/view: keys (and the old "previous" photo, as an older entry) into a shelf. */
    async _migrate(slot) {
      const items = [];
      if (slot === 'drawing' && (await this.store.get('image:previous'))) items.push({ blob: 'image:previous', view: 'view:previous' });
      items.push({ blob: `image:${slot}`, view: `view:${slot}` });

      const ops = [];
      const ids = [];
      const legacy = [];
      const base = Date.now() - items.length * 1000; // keep the old order
      for (const [i, item] of items.entries()) {
        const blob = await this.store.get(item.blob);
        if (!(blob instanceof Blob)) continue;
        let canvas;
        try {
          canvas = await DC.decodeImage(blob);
        } catch (err) {
          console.warn(`Could not migrate ${item.blob}:`, err);
          continue;
        }
        const { record, blob: stored } = await this.prepare(slot, canvas, blob, { created: base + i * 1000 });
        const view = await this.store.get(item.view);
        ops.push({ put: [`blob:${record.id}`, stored] }, { put: [`photo:${record.id}`, this._plain(record)] });
        if (view) ops.push({ put: [`view:${record.id}`, view] });
        ids.push(record.id);
        legacy.push(item.blob, item.view);
      }
      if (!ids.length) return; // nothing readable: leave the legacy keys alone
      ops.push({ put: [`shelf:${slot}`, ids] });
      for (const key of legacy) ops.push({ delete: key });
      await this.store.batch(ops);
    }

    /** Delete photo/blob/view keys no shelf refers to, and legacy keys of slots that have a shelf. */
    async _sweep() {
      const live = new Set(this.ids.drawing.concat(this.ids.reference));
      const keys = await this.store.keys();
      const hasShelf = new Set(keys.filter((k) => /^shelf:/.test(k)).map((k) => k.slice(6)));
      const doomed = keys.filter((k) => {
        const m = /^(photo|blob|view):(.+)$/.exec(k);
        if (m) return !live.has(m[2]);
        const legacy = /^image:(.+)$/.exec(k);
        return !!legacy && hasShelf.has(legacy[1] === 'previous' ? 'drawing' : legacy[1]);
      });
      if (doomed.length) await this.store.batch(doomed.map((key) => ({ delete: key })));
    }

    // ------------------------------------------------------------ encoding

    /**
     * The blob to store. PNG/JPEG/WebP up to 1.5 MB are kept as they are;
     * anything else is re-encoded from the decoded canvas (long side at most
     * 2048 px) as JPEG 0.9 on white. Known loss: big transparent PNGs lose alpha.
     */
    async normalise(canvas, blob) {
      if (blob && KEEP_TYPES.includes(blob.type) && blob.size <= KEEP_AS_IS_BYTES) {
        return new Blob([blob], { type: blob.type }); // a plain Blob, without a File's name
      }
      const out = await toBlob(flatten(canvas), 'image/jpeg', REENCODE_QUALITY);
      return out || blob;
    }

    /** 128 px JPEG thumbnail. */
    async thumb(canvas) {
      return toBlob(flatten(canvas, THUMB_EDGE), 'image/jpeg', THUMB_QUALITY);
    }

    /** Encode everything a new photo needs (not yet stored or listed). */
    async prepare(slot, canvas, blob, { created = Date.now() } = {}) {
      const stored = await this.normalise(canvas, blob);
      const thumb = await this.thumb(canvas);
      const record = { id: newId(), slot, created, w: canvas.width, h: canvas.height, bytes: stored.size, type: stored.type, thumb, unsaved: false };
      return { record, blob: stored };
    }

    _plain(r) {
      return { id: r.id, slot: r.slot, created: r.created, w: r.w, h: r.h, bytes: r.bytes, type: r.type, thumb: r.thumb };
    }

    // ------------------------------------------------------------ adding

    /** 'full' when the slot has its maximum of saved photos, 'low' when the browser reports little free space. */
    async _problem(slot, bytes) {
      if (this.savedCount(slot) >= this.limit) return 'full';
      try {
        const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
        if (e && Number.isFinite(e.quota) && Number.isFinite(e.usage) && e.quota - e.usage < Math.max(LOW_SPACE_BYTES, bytes)) return 'low';
      } catch {
        /* no estimate: carry on and rely on QuotaExceededError */
      }
      return null;
    }

    /**
     * Append a photo and put it on the easel; nothing is ever overwritten.
     * When the shelf is full or storage is short, `resolve(problem)` is asked
     * what to do and returns 'remove-oldest', 'choose' or 'cancel'; nothing is
     * deleted unless it answers 'remove-oldest'. Otherwise (cancel, choose, or a
     * storage error) the photo is kept in memory, marked `unsaved`.
     * @returns {Promise<{id: string, saved: boolean, memoryOnly?: boolean, problem?: string, choice?: string, error?: Error}>}
     */
    async add(slot, canvas, blob, { view = null, resolve = null } = {}) {
      const { record, blob: stored } = await this.prepare(slot, canvas, blob);
      for (;;) {
        let problem = this.persistent ? await this._problem(slot, record.bytes) : null;
        if (!problem) {
          try {
            await this._commit(slot, record, stored, view);
            return { id: record.id, saved: this.persistent, memoryOnly: !this.persistent };
          } catch (err) {
            if (!isQuotaError(err)) {
              this._insertUnsaved(slot, record, stored, view);
              return { id: record.id, saved: false, error: err };
            }
            problem = 'quota';
          }
        }
        const choice = resolve ? await resolve(problem, this) : 'cancel';
        if (choice === 'remove-oldest') {
          const victim = this.oldestRemovable(slot, problem);
          if (victim) {
            await this.remove(victim);
            continue;
          }
        }
        this._insertUnsaved(slot, record, stored, view);
        return { id: record.id, saved: false, problem, choice };
      }
    }

    /** Oldest saved photo that is not on an easel (within the slot; for storage shortage also the other slot). */
    oldestRemovable(slot, problem) {
      const pick = (s) => this.ids[s].find((id) => id !== this.activeId[s] && !this.records.get(id).unsaved);
      return pick(slot) || (problem === 'full' ? null : pick(otherSlot(slot))) || null;
    }

    _commit(slot, record, stored, view) {
      return this._serial(async () => {
        const id = record.id;
        if (this.persistent) {
          const next = this.ids[slot].filter((x) => !this.records.get(x).unsaved).concat(id);
          const ops = [{ put: [`blob:${id}`, stored] }, { put: [`photo:${id}`, this._plain(record)] }, { put: [`shelf:${slot}`, next] }];
          if (view) ops.push({ put: [`view:${id}`, view] });
          await this.store.batch(ops); // throws, and writes nothing, on failure
        } else {
          this._memBlobs.set(id, stored);
        }
        record.unsaved = false;
        this._insert(slot, record, view);
      });
    }

    _insertUnsaved(slot, record, stored, view) {
      record.unsaved = true;
      this._memBlobs.set(record.id, stored);
      this._insert(slot, record, view);
    }

    _insert(slot, record, view) {
      this.records.set(record.id, record);
      this.ids[slot].push(record.id);
      if (view) this._views.set(record.id, view);
      this.version++; // the caller puts it on the easel (setActive) in the same step as swapping the layer
    }

    /**
     * Try to store photos that were kept in memory only (after the user made
     * room). No prompts; stops at the first problem. Returns how many were saved.
     */
    saveUnsaved(slot) {
      return this._serial(async () => {
        let saved = 0;
        for (const id of this.unsavedIds(slot)) {
          const record = this.records.get(id);
          if (this.savedCount(slot) >= this.limit || (await this._problem(slot, record.bytes))) break;
          const next = this.ids[slot].filter((x) => x === id || !this.records.get(x).unsaved);
          const ops = [{ put: [`blob:${id}`, this._memBlobs.get(id)] }, { put: [`photo:${id}`, this._plain(record)] }, { put: [`shelf:${slot}`, next] }];
          const view = this._views.get(id);
          if (view) ops.push({ put: [`view:${id}`, view] });
          try {
            await this.store.batch(ops);
          } catch {
            break;
          }
          record.unsaved = false;
          this._memBlobs.delete(id);
          saved++;
        }
        if (saved) this.version++;
        return saved;
      });
    }

    // ------------------------------------------------------------ removing

    /** Remove a photo from its shelf and storage (one atomic batch). The caller chooses the next easel photo. */
    remove(id) {
      return this._serial(async () => {
        const rec = this.records.get(id);
        if (!rec) return;
        const slot = rec.slot;
        if (this.persistent && !rec.unsaved) {
          const next = this.ids[slot].filter((x) => x !== id && !this.records.get(x).unsaved);
          await this.store.batch([
            { delete: `blob:${id}` },
            { delete: `photo:${id}` },
            { delete: `view:${id}` },
            { put: [`shelf:${slot}`, next] },
          ]);
        }
        this.ids[slot] = this.ids[slot].filter((x) => x !== id);
        this.records.delete(id);
        this._views.delete(id);
        this._memBlobs.delete(id);
        const url = this._thumbUrls.get(id);
        if (url) URL.revokeObjectURL(url);
        this._thumbUrls.delete(id);
        const cached = this._cache[slot].find((e) => e.id === id);
        this._cache[slot] = this._cache[slot].filter((e) => e.id !== id);
        if (cached) this.release(cached.canvas);
        if (this.activeId[slot] === id) this.activeId[slot] = null;
        this.version++;
      });
    }

    /** Clear storage, then forget everything in memory (also when storage fails: the app has already emptied the easel). */
    clearAll() {
      return this._serial(async () => {
        try {
          if (this.persistent) await this.store.clear();
        } finally {
          this.reset();
        }
      });
    }

    /** Forget everything in memory. */
    reset() {
      for (const url of this._thumbUrls.values()) URL.revokeObjectURL(url);
      this._thumbUrls.clear();
      const canvases = SLOTS.flatMap((s) => this._cache[s].map((e) => e.canvas));
      this.ids = { drawing: [], reference: [] };
      this.records.clear();
      this.activeId = { drawing: null, reference: null };
      this._cache = { drawing: [], reference: [] };
      this._decoding.clear();
      this._views.clear();
      this._memBlobs.clear();
      this.version++;
      canvases.forEach((c) => this.release(c));
    }

    // ------------------------------------------------------------ decoding and views

    /**
     * Decoded canvas for a photo: from the small per-slot cache, else decoded from
     * its stored blob. With `cache: false` a fresh decode is not remembered (the
     * ghost uses this, so looking at the previous photo never evicts the photo that
     * was just on the easel).
     */
    async canvasFor(id, { cache: remember = true } = {}) {
      const rec = this.records.get(id);
      if (!rec) throw new Error('Unknown photo');
      const cache = this._cache[rec.slot];
      const hit = cache.find((e) => e.id === id);
      if (hit) {
        cache.splice(cache.indexOf(hit), 1);
        cache.unshift(hit);
        return hit.canvas;
      }
      let job = this._decoding.get(id);
      if (!job) {
        job = (async () => {
          const blob = this._memBlobs.get(id) || (await this.store.get(`blob:${id}`));
          if (!(blob instanceof Blob)) throw new Error('The stored photo is missing');
          const canvas = await DC.decodeImage(blob);
          if (remember && this.records.has(id)) this._remember(rec.slot, id, canvas);
          return canvas;
        })().finally(() => this._decoding.delete(id));
        this._decoding.set(id, job);
      }
      return job;
    }

    /** Put an already decoded canvas (e.g. the ghost's) into the cache for `id`. */
    adopt(id, canvas) {
      const rec = this.records.get(id);
      if (rec && canvas) this._remember(rec.slot, id, canvas);
    }

    _remember(slot, id, canvas) {
      const cache = this._cache[slot];
      const i = cache.findIndex((e) => e.id === id);
      if (i >= 0) cache.splice(i, 1);
      cache.unshift({ id, canvas });
      while (cache.length > this.cacheSize) this.release(cache.pop().canvas);
    }

    /** A canvas left the cache or its layer: drop its derived (tint/outline) bitmaps unless something still shows it. */
    release(canvas) {
      if (!canvas || this.inUse(canvas) || SLOTS.some((s) => this._cache[s].some((e) => e.canvas === canvas))) return;
      if (DC.Compare && DC.Compare.forget) DC.Compare.forget(canvas);
    }

    /** Saved view of a photo (null if none yet). */
    async getView(id) {
      if (this._views.has(id)) return this._views.get(id);
      const rec = this.records.get(id);
      if (!rec || rec.unsaved || !this.persistent) return null;
      let view = null;
      try {
        view = (await this.store.get(`view:${id}`)) || null;
      } catch {
        view = null;
      }
      this._views.set(id, view);
      return view;
    }

    /** Remember a photo's view; written to storage at once if the photo is saved. */
    async saveView(id, view) {
      const rec = this.records.get(id);
      if (!rec) return;
      this._views.set(id, view);
      if (rec.unsaved || !this.persistent) return;
      await this._serial(async () => {
        if (this.records.has(id) && !this.records.get(id).unsaved) await this.store.set(`view:${id}`, view);
      });
    }
  }

  Shelf.MAX_PER_SHELF = MAX_PER_SHELF;
  Shelf.isQuotaError = isQuotaError;
  DC.Shelf = Shelf;
})();
