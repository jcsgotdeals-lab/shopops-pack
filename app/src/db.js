// Team database (Firebase). Every phone and computer on the team reads and writes the same
// data and sees changes live. Each device also keeps an offline copy, so scanning keeps
// working without internet and catches up when the connection is back.
//
// Data layout (kept small so the free Firebase limits hold up at ~1,000 items per show):
//   shows/{id}                 one document per show (name, date, counts)
//   showData/{id}~{n}          the imported trays, items and orders, as JSON in a few big pieces
//   events/{show}~{device}~{t} scans, in 10-minute pieces per device (one write per scan)
//   files/{id} + fileChunks    the imported PDFs
//   team/main, members/{uid}   team code and packer logins
//   prefs/team                 team-wide preferences
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, Bytes, arrayUnion,
} from '../vendor/firebase/firebase-firestore.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, signInAnonymously, signOut as fbSignOut,
} from '../vendor/firebase/firebase-auth.js';
import { firebaseConfig, OWNER_EMAIL } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
let fs = null;
const CHUNK = 900000;

export const uid = (prefix = '') => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const enc = id => encodeURIComponent(String(id));

// ---------------- errors and change notifications ----------------
const changeCbs = new Set();
const errCbs = new Set();
let changeTimer = null;
let pending = new Set();
export function onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); }
export function onError(cb) { errCbs.add(cb); }
function emit(what) {
  pending.add(what);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const p = pending; pending = new Set();
    changeCbs.forEach(cb => { try { cb(p); } catch (e) { console.error(e); } });
  }, 150);
}
function fail(err) { console.error(err); errCbs.forEach(cb => { try { cb(err); } catch (e) { /* ignore */ } }); }

// ---------------- sign in ----------------
export const currentUser = () => auth.currentUser;
export function waitForUser() {
  return new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
}
export async function signInOwner(email, password) { return (await signInWithEmailAndPassword(auth, email.trim(), password)).user; }
export async function signInPacker() { return (await signInAnonymously(auth)).user; }
export async function signOut() {
  await fbSignOut(auth);
  try { localStorage.removeItem('currentShow'); } catch (e) { /* ignore */ }
  location.hash = ''; location.reload();
}
export const isOwnerUser = u => !!u && !u.isAnonymous && (u.email || '').toLowerCase() === OWNER_EMAIL;

// ---------------- start ----------------
const live = { shows: new Map(), prefs: {}, team: null, members: new Map(), me: null };
export const shows = () => [...live.shows.values()];
export const getShow = id => live.shows.get(id);
export const teamPrefs = () => live.prefs;
export const team = () => live.team;
export const members = () => [...live.members.values()];
export const myMember = () => live.me;

export function start() {
  if (fs) return;
  fs = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    ignoreUndefinedProperties: true,
    experimentalAutoDetectLongPolling: true,
  });
}
function listenDoc(ref, onData) {
  return new Promise(res => {
    let first = true;
    onSnapshot(ref, d => { onData(d); if (first) { first = false; res(); } }, e => { fail(e); if (first) { first = false; res(); } });
  });
}
// Owner and active packers: listen to shows and team preferences (owner also: team + members).
export function startTeamData(isOwner) {
  const ready = [];
  ready.push(new Promise(res => {
    let first = true;
    onSnapshot(collection(fs, 'shows'), snap => {
      snap.docChanges().forEach(ch => { if (ch.type === 'removed') live.shows.delete(ch.doc.data().id); else live.shows.set(ch.doc.data().id, ch.doc.data()); });
      if (first) { first = false; res(); } else emit('shows');
    }, e => { fail(e); if (first) { first = false; res(); } });
  }));
  let firstPrefs = true;
  ready.push(listenDoc(doc(fs, 'prefs', 'team'), d => { live.prefs = d.exists() ? d.data() : {}; if (!firstPrefs) emit('prefs'); firstPrefs = false; }));
  if (isOwner) {
    let firstTeam = true;
    ready.push(listenDoc(doc(fs, 'team', 'main'), d => { live.team = d.exists() ? d.data() : null; if (!firstTeam) emit('team'); firstTeam = false; }));
    onSnapshot(collection(fs, 'members'), snap => {
      snap.docChanges().forEach(ch => { if (ch.type === 'removed') live.members.delete(ch.doc.id); else live.members.set(ch.doc.id, ch.doc.data()); });
      emit('members');
    }, fail);
  }
  return Promise.all(ready);
}

// ---------------- team and packers ----------------
export function makeCode(name = 'TEAM') {
  const base = String(name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'TEAM';
  return base + '-' + String(Math.floor(1000 + Math.random() * 9000));
}
export async function ensureTeam(ownerName) {
  if (live.team && live.team.code) return live.team;
  const t = { code: makeCode(ownerName), createdAt: Date.now() };
  live.team = t;
  await setDoc(doc(fs, 'team', 'main'), t);
  return t;
}
export async function changeTeamCode(ownerName) {
  const t = { ...(live.team || {}), code: makeCode(ownerName), changedAt: Date.now() };
  live.team = t;
  await setDoc(doc(fs, 'team', 'main'), t);
}
// A packer's phone asks to join. Only works with the right team code (the database rules check it).
export async function requestJoin(code, name) {
  const u = auth.currentUser;
  await setDoc(doc(fs, 'members', u.uid), {
    uid: u.uid, name: name.trim(), code: code.trim().toUpperCase(), status: 'pending', kind: 'packer', createdAt: Date.now(),
  });
}
export function watchMe(cb) {
  const u = auth.currentUser;
  return onSnapshot(doc(fs, 'members', u.uid), d => { live.me = d.exists() ? d.data() : null; cb(live.me); }, e => cb(null, e));
}
export async function setMember(id, patch) { await updateDoc(doc(fs, 'members', id), patch); }
export async function removeMember(id) { await deleteDoc(doc(fs, 'members', id)); }
export async function savePrefs(patch) { live.prefs = { ...live.prefs, ...patch }; await setDoc(doc(fs, 'prefs', 'team'), live.prefs); }

// ---------------- shows ----------------
const dataCache = new Map();
function writeData(b, showId, data, oldParts = 0) {
  const json = JSON.stringify(data);
  const parts = Math.ceil(json.length / CHUNK) || 1;
  for (let i = 0; i < parts; i++) b.set(doc(fs, 'showData', enc(showId + '~' + i)), { showId, idx: i, json: json.slice(i * CHUNK, (i + 1) * CHUNK) });
  for (let i = parts; i < oldParts; i++) b.delete(doc(fs, 'showData', enc(showId + '~' + i)));
  return parts;
}
// Import: one show document, the trays/items/orders as JSON pieces, and the PDFs.
export async function createShow(show, data, files) {
  const b = writeBatch(fs);
  const parts = writeData(b, show.id, data);
  const s = { ...show, dataParts: parts, dataVersion: Date.now() };
  b.set(doc(fs, 'shows', enc(show.id)), s);
  live.shows.set(show.id, s);
  dataCache.set(show.id, { data, version: s.dataVersion });
  b.commit().catch(fail);
  for (const f of files || []) putFile(f);
  return s;
}
// Replace a show's data (for example when a shipping-labels PDF is added afterwards).
export async function updateShowData(showId, data, patch = {}) {
  const old = live.shows.get(showId) || {};
  const b = writeBatch(fs);
  const parts = writeData(b, showId, data, old.dataParts || 0);
  const s = { ...old, ...patch, dataParts: parts, dataVersion: Date.now() };
  b.set(doc(fs, 'shows', enc(showId)), s);
  live.shows.set(showId, s);
  dataCache.set(showId, { data, version: s.dataVersion });
  b.commit().catch(fail);
}
export function updateShow(showId, patch) {
  const s = { ...live.shows.get(showId), ...patch };
  live.shows.set(showId, s);
  setDoc(doc(fs, 'shows', enc(showId)), s).catch(fail);
}
export async function deleteShow(showId) {
  const s = live.shows.get(showId);
  live.shows.delete(showId);
  deleteDoc(doc(fs, 'shows', enc(showId))).catch(fail);
  for (let i = 0; i < (s?.dataParts || 1); i++) deleteDoc(doc(fs, 'showData', enc(showId + '~' + i))).catch(fail);
  getDocs(query(collection(fs, 'events'), where('showId', '==', showId))).then(q => q.docs.forEach(d => deleteDoc(d.ref).catch(fail))).catch(fail);
  getDocs(query(collection(fs, 'files'), where('showId', '==', showId))).then(q => q.docs.forEach(d => deleteFile(d.data().id))).catch(fail);
}
export async function showData(showId) {
  const s = live.shows.get(showId);
  const c = dataCache.get(showId);
  if (c && (!s || c.version === s.dataVersion)) return c.data;
  const snap = await getDocs(query(collection(fs, 'showData'), where('showId', '==', showId)));
  const parts = snap.docs.map(d => d.data()).sort((a, b) => a.idx - b.idx);
  const data = parts.length ? JSON.parse(parts.map(p => p.json).join('')) : { trays: [], items: [], orders: [] };
  dataCache.set(showId, { data, version: s?.dataVersion });
  return data;
}

// ---------------- scan events ----------------
const evSubs = new Map();
export function showEvents(showId) {
  let sub = evSubs.get(showId);
  if (!sub) {
    sub = { events: new Map() };
    sub.ready = new Promise(res => {
      let first = true;
      onSnapshot(query(collection(fs, 'events'), where('showId', '==', showId)), snap => {
        let changed = false;
        snap.docChanges().forEach(ch => {
          const d = ch.doc.data();
          for (const e of d.list || []) {
            if (!sub.events.has(e.i)) { sub.events.set(e.i, { ...e, dev: d.device, who: d.who, wk: d.whoKind }); changed = true; }
          }
        });
        if (first) { first = false; res(); } else if (changed) emit('events:' + showId);
      }, e => { fail(e); if (first) { first = false; res(); } });
    });
    evSubs.set(showId, sub);
  }
  return sub.ready.then(() => [...sub.events.values()]);
}
export const eventsNow = showId => (evSubs.get(showId) ? [...evSubs.get(showId).events.values()] : []);

let device = { id: 'unknown', who: '', whoKind: 'owner' };
export function setDevice(d) { device = d; }
export const thisDevice = () => device;
// Record one scan (or undo / status change). Saved on this device at once, synced when online.
export function addEvent(showId, e) {
  const ev = { i: uid('e'), t: Date.now(), ...e };
  const bucket = Math.floor(ev.t / 600000);
  const sub = evSubs.get(showId);
  if (sub) sub.events.set(ev.i, { ...ev, dev: device.id, who: device.who, wk: device.whoKind });
  setDoc(doc(fs, 'events', enc(`${showId}~${device.id}~${bucket}`)), {
    showId, device: device.id, who: device.who, whoKind: device.whoKind, bucket, list: arrayUnion(ev),
  }, { merge: true }).catch(fail);
  return ev;
}
// Events from every show since a date (Analytics). Read on demand.
export async function eventsSince(ms) {
  const snap = await getDocs(query(collection(fs, 'events'), where('bucket', '>=', Math.floor(ms / 600000))));
  const out = [];
  snap.docs.forEach(d => { const x = d.data(); (x.list || []).forEach(e => out.push({ ...e, showId: x.showId, dev: x.device, who: x.who, wk: x.whoKind })); });
  return out;
}

// ---------------- PDFs ----------------
const fileCache = new Map();
export function putFile(f) {
  const u8 = new Uint8Array(f.bytes || new ArrayBuffer(0));
  const meta = { id: f.id, showId: f.showId, name: f.name, kind: f.kind, size: u8.length, addedAt: f.addedAt || Date.now() };
  fileCache.set(f.id, { ...meta, bytes: u8.buffer });
  const ops = [];
  for (let i = 0, n = 0; i < u8.length; i += CHUNK, n++) ops.push([doc(fs, 'fileChunks', enc(f.id + '~' + n)), { fileId: f.id, showId: f.showId, idx: n, data: Bytes.fromUint8Array(u8.subarray(i, i + CHUNK)) }]);
  ops.push([doc(fs, 'files', enc(f.id)), meta]);
  for (let i = 0; i < ops.length; i += 8) {
    const b = writeBatch(fs);
    ops.slice(i, i + 8).forEach(([r, d]) => b.set(r, d));
    b.commit().catch(fail);
  }
}
export async function showFiles(showId) {
  const snap = await getDocs(query(collection(fs, 'files'), where('showId', '==', showId)));
  const out = {};
  for (const d of snap.docs) {
    const m = d.data();
    if (fileCache.has(m.id)) { out[m.id] = fileCache.get(m.id); continue; }
    const cs = await getDocs(query(collection(fs, 'fileChunks'), where('fileId', '==', m.id)));
    const parts = cs.docs.map(x => x.data()).sort((a, b) => a.idx - b.idx).map(p => p.data.toUint8Array());
    const u8 = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; parts.forEach(p => { u8.set(p, o); o += p.length; });
    const f = { ...m, bytes: u8.buffer };
    fileCache.set(m.id, f); out[m.id] = f;
  }
  return out;
}
function deleteFile(id) {
  fileCache.delete(id);
  deleteDoc(doc(fs, 'files', enc(id))).catch(fail);
  getDocs(query(collection(fs, 'fileChunks'), where('fileId', '==', id))).then(s => s.docs.forEach(d => deleteDoc(d.ref).catch(fail))).catch(fail);
}

// ---------------- this device's own settings ----------------
export const DEFAULTS = {
  labelWidthMm: 50, labelHeightMm: 25, voice: true, sounds: true, vibrate: true,
  scannerMode: false, deviceName: '',
};
export function localSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('settings') || '{}'); } catch (e) { /* ignore */ }
  return { ...DEFAULTS, ...s };
}
export function saveLocalSettings(s) { try { localStorage.setItem('settings', JSON.stringify(s)); } catch (e) { /* ignore */ } }
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem('deviceId'); } catch (e) { /* ignore */ }
  if (!id) { id = uid('d'); try { localStorage.setItem('deviceId', id); } catch (e) { /* ignore */ } }
  return id;
}
