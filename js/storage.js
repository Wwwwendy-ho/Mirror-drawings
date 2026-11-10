// Tiny promise wrapper over one IndexedDB key/value store. Everything saved here
// stays on the device; it is how images and view settings survive a reload.
// Callers must expect any method to reject (private mode, quota, no IndexedDB).

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  const DB_NAME = 'drawing-compare';
  const STORE = 'kv';

  class Storage {
    constructor() {
      this._db = null;
    }

    get available() {
      return typeof indexedDB !== 'undefined';
    }

    async _open() {
      if (this._db) return this._db;
      if (!this.available) throw new Error('IndexedDB is not available');
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
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
  }

  DC.Storage = Storage;
})();
