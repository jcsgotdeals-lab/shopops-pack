// Small IndexedDB wrapper. All data stays on this device.
const DB_NAME = 'shopops-pack';
const DB_VERSION = 1;
export const STORES = ['shows', 'batches', 'orders', 'trays', 'items', 'scans', 'files', 'settings'];

let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, opts, indexes = []) => {
        const s = db.createObjectStore(name, opts);
        indexes.forEach(([n, k, o]) => s.createIndex(n, k, o || {}));
      };
      mk('shows', { keyPath: 'id' });
      mk('batches', { keyPath: 'id' }, [['showId', 'showId']]);
      mk('orders', { keyPath: 'id' }, [['showId', 'showId']]);
      mk('trays', { keyPath: 'id' }, [['showId', 'showId']]);
      mk('items', { keyPath: 'id' }, [['showId', 'showId'], ['code', 'code']]);
      mk('scans', { keyPath: 'id' }, [['showId', 'showId']]);
      mk('files', { keyPath: 'id' }, [['showId', 'showId']]);
      mk('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function get(store, key) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key));
}
export async function all(store) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll());
}
export async function byIndex(store, index, value) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(value));
}
export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((res, rej) => { tx.oncomplete = () => res(value); tx.onerror = () => rej(tx.error); });
}
export async function putMany(store, values) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  values.forEach(v => s.put(v));
  return new Promise((res, rej) => { tx.oncomplete = () => res(values); tx.onerror = () => rej(tx.error); });
}
export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function delWhere(store, index, value) {
  const rows = await byIndex(store, index, value);
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  rows.forEach(r => s.delete(r.id));
  return new Promise((res, rej) => { tx.oncomplete = () => res(rows.length); tx.onerror = () => rej(tx.error); });
}
export async function clear(store) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

// Settings with defaults
export const DEFAULT_SETTINGS = {
  labelWidthMm: 50,
  labelHeightMm: 25,
  voice: true,
  sounds: true,
  vibrate: true,
  stickerRegex: '',
  businessName: 'ShopOps',
};
export async function getSettings() {
  const row = await get('settings', 'app');
  return { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
}
export async function saveSettings(value) {
  return put('settings', { key: 'app', value });
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Full backup (files stored as base64)
export async function exportBackup() {
  const out = { app: 'shopops-pack', version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const s of STORES) {
    const rows = await all(s);
    if (s === 'files') {
      out.data[s] = await Promise.all(rows.map(async r => ({ ...r, bytes: undefined, b64: bufToB64(r.bytes) })));
    } else out.data[s] = rows;
  }
  return out;
}
export async function importBackup(obj) {
  if (!obj || obj.app !== 'shopops-pack') throw new Error('This file is not a ShopOps Pack backup.');
  for (const s of STORES) {
    await clear(s);
    const rows = (obj.data[s] || []).map(r => s === 'files' ? { ...r, bytes: b64ToBuf(r.b64), b64: undefined } : r);
    if (rows.length) await putMany(s, rows);
  }
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
