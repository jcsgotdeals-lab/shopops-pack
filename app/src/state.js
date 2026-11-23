// Turns a show's imported data plus its scan events into the current picture:
// where every item is, how far each tray and box has got, and the numbers for reports.

export const STATUS_LABEL = {
  pending: 'Pending', in_tray: 'In tray', packed: 'Packed', damaged: 'Damaged', missing: 'Missing', floor: 'On floor', cancelled: 'Cancelled',
};
export const FLAGGED = ['damaged', 'missing', 'floor'];
export const PROBLEM_RESULTS = {
  dup: 'Scanned twice', notfound: 'Not found', ambiguous: 'Ambiguous', wrong: 'Wrong box', skipped: 'Skipped tray', mismatch: 'Label mismatch', incomplete: 'Box not complete',
};
export const TYPE_LABEL = { tray: 'Into tray', box: 'Into box', label: 'Label verify', boxcheck: 'Box check', handover: 'Courier handover', undo: 'Undo', reset: 'Reset trays', status: 'Item status', finish: 'Box finished' };
export const RESULT_LABEL = { ok: 'Scanned', dup: 'Duplicate', notfound: 'Not found', ambiguous: 'Ambiguous', wrong: 'Wrong box', skipped: 'Skipped tray', verified: 'Label verified', mismatch: 'Label mismatch', incomplete: 'Box not complete' };
export const METHOD_LABEL = { camera: 'Phone camera', scanner: 'Barcode scanner', typed: 'Typed by hand', tap: 'Tapped on screen' };

export function normCode(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }
export function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
// Short code for a listing name, printed in the sticker barcode (e.g. "K3F9-67").
export function nameHash(name) {
  const k = nameKey(name);
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 1679616).toString(36).toUpperCase().padStart(4, '0');
}
export const stickerCode = (name, n) => `${nameHash(name)}-${n}`;

export function buildState(data, events) {
  const items = new Map((data.items || []).map(it => [it.id, { ...it, status: 'pending' }]));
  const trays = new Map((data.trays || []).map(t => [t.n, { ...t, boxDone: false, labelOk: false, handed: false }]));
  const evs = events.slice().sort((a, b) => a.t - b.t);
  const undone = new Set(evs.filter(e => e.ty === 'undo' && e.u).map(e => e.u));
  for (const e of evs) {
    if (e.ty === 'undo' || undone.has(e.i)) continue;
    if (e.ty === 'reset') {
      items.forEach(it => { if (it.status === 'in_tray' || it.status === 'packed') { it.status = 'pending'; it.trayAt = it.packedAt = null; } });
      trays.forEach(t => { t.boxDone = false; t.labelOk = false; });
      continue;
    }
    const it = e.it ? items.get(e.it) : null;
    const tr = e.tr != null ? trays.get(e.tr) : null;
    if (e.ty === 'status' && it) { it.status = e.s; if (e.s === 'pending') it.trayAt = it.packedAt = null; continue; }
    if (e.r !== 'ok' && e.r !== 'verified') continue;
    if (e.ty === 'tray' && it) { if (it.status === 'pending' || FLAGGED.includes(it.status)) it.status = 'in_tray'; it.trayAt = it.trayAt || e.t; it.trayBy = it.trayBy || e.who; }
    else if (e.ty === 'box' && it) { it.status = 'packed'; it.packedAt = e.t; it.trayAt = it.trayAt || e.t; }
    else if ((e.ty === 'label' || e.ty === 'finish') && tr) { tr.boxDone = true; tr.labelOk = e.ty === 'label'; tr.doneAt = e.t; }
    else if (e.ty === 'handover' && tr) { tr.handed = true; tr.handedAt = e.t; }
  }
  // per-tray numbers
  for (const t of trays.values()) {
    t.list = (t.items || []).map(id => items.get(id)).filter(Boolean);
    const live = t.list.filter(i => i.status !== 'cancelled');
    t.total = live.length;
    t.inTray = live.filter(i => i.status === 'in_tray' || i.status === 'packed').length;
    t.packed = live.filter(i => i.status === 'packed').length;
    t.sortState = t.total && t.inTray >= t.total ? 'complete' : t.inTray > 0 ? 'progress' : 'not';
    t.packState = t.boxDone ? 'done' : t.packed > 0 ? 'progress' : 'todo';
  }
  // lookups for scanning
  const byCode = new Map(), byNum = new Map();
  for (const it of items.values()) {
    if (it.code) { const k = normCode(it.code); (byCode.get(k) || byCode.set(k, []).get(k)).push(it); }
    if (it.num != null) (byNum.get(String(it.num)) || byNum.set(String(it.num), []).get(String(it.num))).push(it);
  }
  const byTracking = new Map();
  for (const t of trays.values()) for (const tn of t.tracking || []) byTracking.set(normCode(tn), t);
  return { items, trays, byCode, byNum, byTracking, events: evs, undone };
}

// Which item(s) does a scanned or typed value mean?
export function resolve(st, raw) {
  const code = normCode(raw);
  if (!code) return [];
  if (st.byCode.has(code)) return st.byCode.get(code);
  // our sticker format NAME-123, Scan2Tray-style "Name #123", or just "123"
  const m = code.match(/(?:^|[^0-9])#?(\d{1,6})$/) || code.match(/^(\d{1,6})$/);
  if (m) {
    const n = String(+m[1]);
    const cands = st.byNum.get(n) || [];
    if (cands.length) {
      const h = code.match(/^([0-9A-Z]{4})-\d+$/);
      if (h) { const same = cands.filter(c => c.code && normCode(c.code).startsWith(h[1] + '-')); if (same.length) return same; }
      return cands;
    }
  }
  // typed item name
  const q = raw.trim().toLowerCase();
  if (q.length >= 3) {
    const hits = [...st.items.values()].filter(i => (i.title || '').toLowerCase().includes(q));
    if (hits.length) return hits;
  }
  return [];
}
// A shipping label (tracking barcode) -> tray. USPS label barcodes carry "420"+ZIP before the tracking number.
export function trayForLabel(st, raw) {
  const code = normCode(raw).replace(/[^0-9A-Z]/g, '');
  if (code.length < 10) return null;
  if (st.byTracking.has(code)) return st.byTracking.get(code);
  for (const [tn, t] of st.byTracking) if (tn.length >= 10 && (code.endsWith(tn) || tn.endsWith(code))) return t;
  return null;
}

// ---------- numbers for dashboards and reports ----------
export function counts(st) {
  const all = [...st.items.values()];
  const live = all.filter(i => i.status !== 'cancelled');
  const by = s => all.filter(i => i.status === s).length;
  const trays = [...st.trays.values()];
  const problems = st.events.filter(e => !st.undone.has(e.i) && PROBLEM_RESULTS[e.r] && e.r !== 'dup').length + FLAGGED.reduce((n, s) => n + by(s), 0);
  return {
    items: live.length,
    inTray: live.filter(i => i.status === 'in_tray' || i.status === 'packed').length,
    packed: by('packed'),
    pending: by('pending'), damaged: by('damaged'), missing: by('missing'), floor: by('floor'), cancelled: by('cancelled'), trayOnly: by('in_tray'),
    trays: trays.length,
    traysComplete: trays.filter(t => t.sortState === 'complete').length,
    traysProgress: trays.filter(t => t.sortState === 'progress').length,
    boxesDone: trays.filter(t => t.boxDone).length,
    handed: trays.filter(t => t.handed).length,
    buyers: new Set(trays.map(t => t.buyerKey)).size,
    revenue: live.reduce((n, i) => n + (+i.price || 0), 0),
    problems,
  };
}
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
// percentage that never shows 100% until truly finished
export const pctFloor = (a, b) => (b ? Math.floor((a / b) * 100) : 0);

const GAP = 10 * 60000;
// Busy time: add up the time between scans, leaving out gaps over 10 minutes (breaks).
export function busyMs(times) {
  const t = times.slice().sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; if (d <= GAP) ms += d; }
  return ms + (t.length ? 30000 : 0);
}
export const perHour = (n, ms) => (ms > 0 ? Math.round(n / (ms / 3600000)) : 0);

export function personKey(e) { return (e.wk || 'owner') + ':' + (e.who || e.dev || '?'); }
// Who did what, from a list of events.
export function people(events) {
  const map = new Map();
  for (const e of events) {
    if (e.ty !== 'tray' && e.ty !== 'box') continue;
    const k = personKey(e);
    let p = map.get(k);
    if (!p) { p = { key: k, name: e.who || 'This login', kind: e.wk || 'owner', tray: 0, box: 0, times: [], trayTimes: [], boxTimes: [], problems: 0, methods: {} }; map.set(k, p); }
    p.times.push(e.t);
    if (e.r === 'ok') { if (e.ty === 'tray') { p.tray++; p.trayTimes.push(e.t); } else { p.box++; p.boxTimes.push(e.t); } }
    else if (PROBLEM_RESULTS[e.r] && e.r !== 'dup') p.problems++;
    const m = e.m || 'typed'; p.methods[m] = (p.methods[m] || 0) + 1;
  }
  for (const p of map.values()) {
    p.busy = busyMs(p.times);
    p.trayRate = perHour(p.tray, busyMs(p.trayTimes));
    p.boxRate = perHour(p.box, busyMs(p.boxTimes));
  }
  return [...map.values()].sort((a, b) => (b.tray + b.box) - (a.tray + a.box));
}
export function methods(events) {
  const m = {};
  events.filter(e => (e.ty === 'tray' || e.ty === 'box') && e.r === 'ok').forEach(e => { const k = e.m || 'typed'; m[k] = (m[k] || 0) + 1; });
  return m;
}
// 10-minute bars for a timeline chart
export function timeline(events, ty) {
  const ts = events.filter(e => e.ty === ty && e.r === 'ok').map(e => e.t).sort((a, b) => a - b);
  if (!ts.length) return null;
  const start = Math.floor(ts[0] / 600000) * 600000;
  const end = Math.floor(ts[ts.length - 1] / 600000) * 600000;
  const bars = [];
  for (let b = start; b <= end; b += 600000) bars.push({ t: b, n: 0 });
  ts.forEach(t => { bars[Math.floor((t - start) / 600000)].n++; });
  return { first: ts[0], last: ts[ts.length - 1], count: ts.length, busy: busyMs(ts), bars };
}
export function problemSummary(events, undone = new Set()) {
  const out = {};
  events.filter(e => !undone.has(e.i) && PROBLEM_RESULTS[e.r]).forEach(e => { out[e.r] = (out[e.r] || 0) + 1; });
  return out;
}
