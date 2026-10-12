// IndexedDB storage: inks, pens, fills, images (blobs), meta (settings / sync state)
const DB_NAME = 'ink-catalog';
const DB_VERSION = 1;
const STORES = ['inks', 'pens', 'fills', 'images', 'meta'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  all: store => tx(store, 'readonly', s => reqP(s.getAll())),
  get: (store, id) => tx(store, 'readonly', s => reqP(s.get(id))),
  put: (store, obj) => tx(store, 'readwrite', s => { s.put(obj); }),
  putMany: (store, arr) => tx(store, 'readwrite', s => { for (const o of arr) s.put(o); }),
  del: (store, id) => tx(store, 'readwrite', s => { s.delete(id); }),
  clear: store => tx(store, 'readwrite', s => { s.clear(); }),
  async meta(key, fallback = null) { const r = await this.get('meta', key); return r ? r.value : fallback; },
  setMeta(key, value) { return this.put('meta', { id: key, value }); },
};
