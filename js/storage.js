// Tiny promise wrapper over one IndexedDB key/value store. Everything saved here
// stays on the device; it is how images and view settings survive a reload.
// Callers must expect any method to reject (private mode, quota, no IndexedDB).

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const DB_NAME = 'drawing-compare';
  const STORE = 'kv';

  class Storage {
    constructor(name = DB_NAME) {
      this._name = name; // a different name gives tests a scratch database
      this._db = null;
    }

    get available() {
      return typeof indexedDB !== 'undefined';
    }

    async _open() {
      if (this._db) return this._db;
      if (!this.available) throw new Error('IndexedDB is not available');
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this._name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
        req.onblocked = () => reject(new Error('IndexedDB open was blocked'));
      });
      this._db.onversionchange = () => {
        this._db.close();
        this._db = null;
      };
      return this._db;
    }

    async _run(mode, fn) {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    }

    get(key) {
      return this._run('readonly', (s) => s.get(key));
    }

    set(key, value) {
      return this._run('readwrite', (s) => s.put(value, key));
    }

    delete(key) {
      return this._run('readwrite', (s) => s.delete(key));
    }

    clear() {
      return this._run('readwrite', (s) => s.clear());
    }

    /** Every key in the store (strings). */
    async keys() {
      return this._run('readonly', (s) => s.getAllKeys());
    }

    /**
     * Apply several writes in ONE readwrite transaction: all of them or none.
     * ops: [{ put: [key, value] } | { delete: key }]. Resolves when the
     * transaction has committed; rejects (and commits nothing) on any failure,
     * including a value that cannot be cloned.
     */
    async batch(ops) {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(STORE, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
          tx.onerror = () => {}; // the abort handler reports it
          const s = tx.objectStore(STORE);
          for (const op of ops) {
            if ('put' in op) s.put(op.put[1], op.put[0]);
            else s.delete(op.delete);
          }
        } catch (err) {
          // e.g. DataCloneError thrown synchronously by put(): undo what was queued.
          try {
            if (tx) tx.abort();
          } catch {
            /* already finished */
          }
          reject(err);
        }
      });
    }
  }

  DC.Storage = Storage;
})();
