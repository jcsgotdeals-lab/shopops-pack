// Shared app state: who is signed in, the open show, and the scan box.
import * as db from './db.js';
import { buildState, counts, people, methods } from './state.js';
import { $ } from './ui.js';
import { CameraScanner } from './camera.js';

export const S = {
  user: null, owner: false, me: null,
  settings: db.localSettings(),
  showId: null,
  cur: null, // {id, data, st}
  scanHandler: null,
  camera: null,
  refresh: null, // set by the open screen to redraw itself when data changes
  undo: new Map(), // showId -> [eventId] made on this device
};

export function setShowId(id) {
  S.showId = id;
  try { localStorage.setItem('currentShow', id || ''); } catch (e) { /* ignore */ }
}
export const prefs = () => ({ perTray: 24, itemCount: true, hideRevenue: false, ...db.teamPrefs() });
export const hideRev = () => prefs().hideRevenue;

// Load a show's data and scans and work out the current state.
export async function openShow(id) {
  if (S.cur && S.cur.id === id && S.cur.version === db.getShow(id)?.dataVersion) { rebuild(); return S.cur; }
  const data = await db.showData(id);
  await db.showEvents(id);
  S.cur = { id, data, version: db.getShow(id)?.dataVersion };
  rebuild();
  return S.cur;
}
export function rebuild() {
  if (!S.cur) return null;
  S.cur.st = buildState(S.cur.data, db.eventsNow(S.cur.id));
  queueSummary();
  return S.cur.st;
}
// Record a scan on the open show
export function ev(e) {
  const x = db.addEvent(S.cur.id, e);
  if (['tray', 'box', 'label', 'finish', 'handover'].includes(e.ty) && (e.r === 'ok' || e.r === 'verified')) {
    const list = S.undo.get(S.cur.id) || []; list.push(x.i); S.undo.set(S.cur.id, list);
  }
  rebuild();
  return x;
}
export function undoLast() {
  const list = S.undo.get(S.cur.id) || [];
  const id = list.pop();
  if (!id) return null;
  const orig = db.eventsNow(S.cur.id).find(e => e.i === id);
  db.addEvent(S.cur.id, { ty: 'undo', u: id, r: 'ok', it: orig?.it, tr: orig?.tr });
  rebuild();
  return orig;
}

// Each device keeps the show's summary (progress, who scanned) up to date on the show itself,
// so the shows list and Analytics don't need to read every scan.
let sumTimer = null, sumLast = 0;
function queueSummary() {
  if (!S.cur) return;
  clearTimeout(sumTimer);
  const wait = Math.max(0, 20000 - (Date.now() - sumLast));
  sumTimer = setTimeout(writeSummary, wait);
}
export function writeSummary() {
  if (!S.cur || !S.cur.st || !db.getShow(S.cur.id)) return;
  const st = S.cur.st, c = counts(st);
  const evs = st.events.filter(e => !st.undone.has(e.i));
  const scans = evs.filter(e => e.ty === 'tray' || e.ty === 'box');
  const sum = {
    items: c.items, inTray: c.inTray, packed: c.packed, boxes: c.boxesDone, handed: c.handed, trays: c.trays, buyers: c.buyers,
    problems: c.problems, revenue: c.revenue,
    scans: scans.filter(e => e.r === 'ok').length,
    first: scans.length ? scans[0].t : null, last: scans.length ? scans[scans.length - 1].t : null,
    people: people(evs).map(p => ({ key: p.key, name: p.name, kind: p.kind, tray: p.tray, box: p.box, busy: p.busy, trayRate: p.trayRate, boxRate: p.boxRate })),
    methods: methods(evs),
  };
  const old = db.getShow(S.cur.id).sum;
  if (JSON.stringify(old) === JSON.stringify(sum)) return;
  sumLast = Date.now();
  db.updateShow(S.cur.id, { sum });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeSummary(); });

// ---------------- the scan box ----------------
// Works with: USB/Bluetooth scanners and Android scanner phones (they type the code + Enter),
// the phone camera, and typing by hand.
export function scanBoxHtml(placeholder, opts = {}) {
  const sm = S.settings.scannerMode;
  return `<div class="scanrow">
    <span class="scan-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M7 9v6M10 9v6M13 9v6M16 9v6"/></svg></span>
    <input id="scan" class="scan-input" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" inputmode="${sm ? 'none' : 'text'}" placeholder="${placeholder}">
    ${sm ? '' : '<button class="btn cam-btn" id="cam-btn" type="button" title="Scan with the camera">Camera</button>'}
    ${opts.undo === false ? '' : `<div class="undo-group"><button class="btn ghost" id="undo-btn" type="button">Undo</button>${opts.undoMenu ? '<button class="btn ghost" id="undo-more" type="button" aria-label="More undo options">▾</button>' : ''}</div>`}
  </div>
  <div id="cam-wrap" class="cam-wrap" hidden><video id="cam" playsinline muted></video><div class="cam-frame"></div><button class="btn ghost small" id="cam-stop" type="button">Stop camera</button></div>`;
}
export function bindScan(handler) {
  S.scanHandler = handler;
  const inp = $('#scan');
  if (!inp) return;
  let times = [];
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const v = inp.value.trim(); inp.value = '';
      const fast = times.length >= 4 && (times[times.length - 1] - times[0]) / (times.length - 1) < 45;
      times = [];
      if (v) handler(v, fast || S.settings.scannerMode ? 'scanner' : 'typed');
    } else if (e.key.length === 1) times.push(performance.now());
  });
  const cb = $('#cam-btn');
  if (cb) cb.onclick = () => (S.camera ? stopCamera() : startCamera(code => handler(code, 'camera')));
  const cs = $('#cam-stop'); if (cs) cs.onclick = stopCamera;
  if (!document.activeElement || !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) inp.focus({ preventScroll: true });
}
export async function startCamera(onCode) {
  const wrap = $('#cam-wrap'); if (!wrap) return;
  wrap.hidden = false;
  try {
    S.camera = new CameraScanner($('#cam'), onCode);
    await S.camera.start();
    $('#cam-btn') && ($('#cam-btn').textContent = 'Stop');
  } catch (err) {
    wrap.hidden = true; S.camera = null;
    const { toast } = await import('./ui.js');
    toast(err.message || 'Could not open the camera', 'error');
  }
}
export function stopCamera() {
  if (S.camera) { S.camera.stop(); S.camera = null; }
  const w = $('#cam-wrap'); if (w) w.hidden = true;
  const b = $('#cam-btn'); if (b) b.textContent = 'Camera';
}

// Scanner phones and USB scanners "type" very fast. Catch scans even if the scan box lost focus.
let buf = '', bufTimes = [], flushTimer = null;
function flush(viaEnter) {
  const v = buf.trim(), t = bufTimes;
  buf = ''; bufTimes = [];
  if (!v || !S.scanHandler) return;
  const fast = t.length >= 4 && (t[t.length - 1] - t[0]) / (t.length - 1) < 45;
  if (fast || (viaEnter && S.settings.scannerMode)) S.scanHandler(v, 'scanner');
}
document.addEventListener('keydown', e => {
  if (!S.scanHandler) return;
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  if (document.querySelector('.modal-back')) return;
  if (e.key === 'Enter' || e.key === 'Tab') { if (buf) { e.preventDefault(); flush(true); } return; }
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  buf += e.key; bufTimes.push(performance.now());
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(false), 150);
});
// Dedicated scanner mode: keep the scan box ready so the trigger always lands in it.
setInterval(() => {
  if (!S.settings.scannerMode || !S.scanHandler) return;
  const inp = $('#scan');
  const a = document.activeElement;
  if (!inp || document.querySelector('.modal-back')) return;
  if (a && a !== inp && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  if (a !== inp) inp.focus({ preventScroll: true });
}, 700);
