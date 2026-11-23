// Team database. Every phone and computer signed in to the team account reads and
// writes the same data in Firebase (Firestore) and gets changes live, like Scan2Tray.
// Each device also keeps an offline copy, so scanning keeps working without internet
// and catches up when the connection is back.
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, query, where, writeBatch, Bytes,
} from '../vendor/firebase/firebase-firestore.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut as fbSignOut,
} from '../vendor/firebase/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

export const STORES = ['shows', 'batches', 'orders', 'trays', 'items', 'scans', 'files'];
const PER_SHOW = ['batches', 'orders', 'trays', 'items', 'scans', 'files'];
const CHUNK = 900000; // bytes per stored piece of a PDF (Firestore documents max out at 1 MB)

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
let fs = null;

// ---------- sign in ----------
export function currentUser() { return auth.currentUser; }
export function waitForUser() {
  return new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
}
export async function signIn(email, password) { return (await signInWithEmailAndPassword(auth, email.trim(), password)).user; }
export async function createTeam(email, password) { return (await createUserWithEmailAndPassword(auth, email.trim(), password)).user; }
export async function signOut() { await fbSignOut(auth); try { localStorage.removeItem('currentShow'); } catch (e) { /* ignore */ } location.reload(); }

// ---------- live copy of the team data ----------
const mem = Object.fromEntries(STORES.map(s => [s, new Map()]));
const subs = new Map(); // key -> Promise (resolved after first snapshot)
const listeners = new Set();
const errListeners = new Set();
let changeTimer = null;
export function onRemoteChange(cb) { listeners.add(cb); }
export function onError(cb) { errListeners.add(cb); }
function emitChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => listeners.forEach(cb => { try { cb(); } catch (e) { console.error(e); } }), 300);
}
function reportError(err) {
  console.error(err);
  errListeners.forEach(cb => { try { cb(err); } catch (e) { /* ignore */ } });
}

const encId = id => encodeURIComponent(String(id));
const col = store => collection(fs, store);

function subscribe(key, store, q) {
  if (subs.has(key)) return subs.get(key);
  const p = new Promise(resolve => {
    let first = true;
    onSnapshot(q, snap => {
      const changes = snap.docChanges();
      for (const ch of changes) {
        const v = ch.doc.data();
        if (ch.type === 'removed') mem[store].delete(v.id);
        else {
          const old = mem[store].get(v.id);
          if (store === 'files' && old && old.bytes && old.size === v.size) v.bytes = old.bytes; // keep downloaded PDF
          mem[store].set(v.id, v);
        }
      }
      if (first) { first = false; resolve(); }
      else if (changes.length && !snap.metadata.hasPendingWrites) emitChange();
    }, err => { reportError(err); if (first) { first = false; resolve(); } });
  });
  subs.set(key, p);
  return p;
}

export async function start() {
  if (fs) return;
  fs = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    ignoreUndefinedProperties: true,
    experimentalAutoDetectLongPolling: true,
  });
  await subscribe('shows', 'shows', col('shows'));
}
function ensureShow(showId) {
  return Promise.all(PER_SHOW.map(s => subscribe(s + ':' + showId, s, query(col(s), where('showId', '==', showId)))));
}
function ensureAll(store) {
  if (store === 'shows') return subs.get('shows');
  return subscribe(store + ':*', store, col(store));
}

// ---------- reads ----------
export async function get(store, key) {
  if (store === 'shows') await subs.get('shows');
  if (mem[store].has(key)) return withBytes(store, mem[store].get(key));
  try {
    const d = await getDoc(doc(fs, store, encId(key)));
    if (!d.exists()) return undefined;
    const v = d.data(); mem[store].set(v.id, v);
    if (v.showId) ensureShow(v.showId);
    return withBytes(store, v);
  } catch (e) { reportError(e); return undefined; }
}
export async function all(store) {
  await ensureAll(store);
  const rows = [...mem[store].values()];
  return store === 'files' ? Promise.all(rows.map(r => withBytes(store, r))) : rows.map(clone);
}
export async function byIndex(store, index, value) {
  if (index === 'showId') await ensureShow(value);
  const rows = [...mem[store].values()].filter(r => r[index] === value);
  return store === 'files' ? Promise.all(rows.map(r => withBytes(store, r))) : rows.map(clone);
}
const clone = v => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// PDFs are stored in pieces in "fileChunks" and downloaded the first time they're needed.
async function withBytes(store, f) {
  if (store !== 'files' || !f) return clone(f);
  if (!f.bytes) {
    const snap = await getDocs(query(col('fileChunks'), where('fileId', '==', f.id)));
    const parts = snap.docs.map(d => d.data()).sort((a, b) => a.idx - b.idx);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.data.toUint8Array().length, 0));
    let o = 0; for (const p of parts) { const u = p.data.toUint8Array(); out.set(u, o); o += u.length; }
    f.bytes = out.buffer;
  }
  const { bytes, ...meta } = f;
  return { ...clone(meta), bytes };
}

// ---------- writes (saved on this device right away, sent to the team as soon as online) ----------
function writeOps(store, value) {
  const v = { ...value };
  const ops = [];
  if (store === 'files') {
    const u8 = new Uint8Array(v.bytes || new ArrayBuffer(0));
    delete v.bytes; v.size = u8.length;
    for (let i = 0, n = 0; i < u8.length; i += CHUNK, n++) {
      ops.push([doc(fs, 'fileChunks', encId(v.id + '~' + n)), { fileId: v.id, idx: n, data: Bytes.fromUint8Array(u8.subarray(i, i + CHUNK)) }]);
    }
    mem.files.set(v.id, { ...clone(v), bytes: u8.buffer });
  } else mem[store].set(v.id, clone(v));
  ops.push([doc(fs, store, encId(v.id)), clone(v)]);
  return ops;
}
export async function put(store, value) {
  for (const [ref, data] of writeOps(store, value)) setDoc(ref, data).catch(reportError);
  return value;
}
export async function putMany(store, values) {
  const ops = values.flatMap(v => writeOps(store, v));
  for (let i = 0; i < ops.length; i += 20) {
    const b = writeBatch(fs);
    ops.slice(i, i + 20).forEach(([ref, data]) => b.set(ref, data));
    b.commit().catch(reportError);
  }
  return values;
}
export async function del(store, key) {
  mem[store].delete(key);
  deleteDoc(doc(fs, store, encId(key))).catch(reportError);
  if (store === 'files') {
    getDocs(query(col('fileChunks'), where('fileId', '==', key)))
      .then(s => s.docs.forEach(d => deleteDoc(d.ref).catch(reportError))).catch(reportError);
  }
}
export async function delWhere(store, index, value) {
  if (index === 'showId') await ensureShow(value);
  const rows = [...mem[store].values()].filter(r => r[index] === value);
  for (const r of rows) await del(store, r.id);
  return rows.length;
}

// ---------- settings (sounds, voice, label size) stay on each device ----------
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
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('settings') || '{}'); } catch (e) { /* ignore */ }
  return { ...DEFAULT_SETTINGS, ...saved };
}
export async function saveSettings(value) {
  try { localStorage.setItem('settings', JSON.stringify(value)); } catch (e) { /* ignore */ }
  return value;
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- backup (whole team) ----------
export async function exportBackup() {
  const out = { app: 'shopops-pack', version: 2, exportedAt: new Date().toISOString(), data: {} };
  for (const s of STORES) {
    const rows = await all(s);
    out.data[s] = s === 'files' ? rows.map(r => ({ ...r, bytes: undefined, b64: bufToB64(r.bytes) })) : rows;
  }
  return out;
}
// Restoring adds the backup's records to the team data; it never wipes what's already there.
export async function importBackup(obj) {
  if (!obj || obj.app !== 'shopops-pack') throw new Error('This file is not a ShopOps Pack backup.');
  for (const s of STORES) {
    const rows = (obj.data[s] || []).map(r => (s === 'files' ? { ...r, bytes: b64ToBuf(r.b64), b64: undefined } : r));
    if (rows.length) await putMany(s, rows);
  }
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64 || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
