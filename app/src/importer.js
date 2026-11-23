// Reads TikTok Shop PDFs (shipping labels + packing slips) and order CSVs.
import { stickerCode, nameKey } from './state.js';

let pdfjsP;
async function pdfjs() {
  if (!pdfjsP) pdfjsP = import('../vendor/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
  return pdfjsP;
}

// Returns [{pageIndex, text, lines:[...]}]
export async function extractPages(bytes) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ').replace(/\s+/g, ' ').trim());
    pages.push({ pageIndex: i - 1, lines, text: lines.join('\n') });
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

const ORDER_LABELED = /order\s*(?:id|no\.?|number|#)\s*[:#]?\s*(\d{15,20})/ig;
const LONG_ID = /(?<![\d])(\d{16,19})(?![\d])/g;

export function findOrderIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(ORDER_LABELED)) ids.add(m[1]);
  if (!ids.size) for (const m of text.matchAll(LONG_ID)) ids.add(m[1]);
  return [...ids];
}

export function classifyPage(text) {
  const t = text.toLowerCase();
  let slip = 0, label = 0;
  if (/packing\s*(slip|list)/.test(t)) slip += 3;
  if (/\b(qty|quantity)\b/.test(t)) slip += 2;
  if (/seller\s*sku|\bsku\b|product\s*name|item\s*name/.test(t)) slip += 2;
  if (/order\s*(id|no|number)/.test(t)) slip += 1;
  if (/\b(usps|ups|fedex|dhl|ontrac|tracking|postage|priority mail|ground advantage|first[- ]class)\b/.test(t)) label += 3;
  if (/\b(9[2-5]\d{18,20}|1z[0-9a-z]{16})\b/.test(t.replace(/\s/g, ''))) label += 3;
  if (/(ship\s*from|return\s*address)/.test(t)) label += 1;
  if (slip === 0 && label === 0) return t.length < 40 ? 'label' : 'unknown';
  return slip >= label ? 'slip' : 'label';
}

export function findBuyer(lines) {
  const patterns = [
    /(?:buyer\s*(?:username|name|nickname)?|username|nickname)\s*[:\-]\s*(.+)/i,
    /(?:ship\s*to|deliver\s*to|recipient(?:\s*name)?|customer(?:\s*name)?|sold\s*to)\s*[:\-]?\s*(.*)/i,
  ];
  for (const re of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        let v = (m[1] || '').trim();
        if (!v && lines[i + 1]) v = lines[i + 1].trim();
        v = v.replace(/\s{2,}.*/, '').replace(/order\s*id.*$/i, '').trim();
        if (v && v.length <= 60) return v;
      }
    }
  }
  const at = lines.join(' ').match(/@([A-Za-z0-9._]{2,30})/);
  return at ? '@' + at[1] : '';
}

export function buyerKey(name) {
  return String(name || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '');
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- items on a packing slip ----
// TikTok item titles end in the sticker number, e.g. "(F) SQUISHIES(Non-Branded) Buy 1 Rest Ship FREE! #67".
// Titles can wrap onto a second line, so a short piece before "#67" takes the line above as well.
const NOT_ITEM = /\b(order|tracking|invoice|page|package|po box|apt|suite|unit|ste)\b\s*$/i;
const HEADER = /(product\s*name|item\s*name|\bsku\b|\bqty\b|quantity|order\s*id|buyer|ship\s*to|packing\s*(slip|list)|:)/i;
export function findItems(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, li) => {
    for (const m of line.matchAll(/#\s?(\d{1,5})(?![\d])/g)) {
      let before = line.slice(0, m.index).replace(/^.*#\s?\d{1,5}\s*/, '').trim();
      if (NOT_ITEM.test(before)) continue;
      if (before.length < 15 && li > 0 && !/#\s?\d/.test(lines[li - 1]) && !HEADER.test(lines[li - 1])) before = (lines[li - 1].trim() + ' ' + before).trim();
      before = before.replace(/^(?:\d+[.)]?\s+)+/, '').replace(/^(?:product\s*name|item\s*name)\s*/i, '').trim();
      if (before.length > 120) before = before.slice(-120);
      const num = +m[1];
      const after = (line.slice(m.index + m[0].length) + ' ' + (lines[li + 1] || '')).slice(0, 80);
      const q = after.match(/\b(?:qty|quantity|x)\s*[:x]?\s*(\d{1,3})\b/i);
      const price = after.match(/\$\s?(\d{1,5}(?:\.\d{2})?)/);
      out.push({ title: (before + ' #' + num).trim(), name: before, num, qty: q ? +q[1] : 1, price: price ? +price[1] : 0 });
    }
  });
  const seen = new Set();
  return out.filter(i => { const k = nameKey(i.name) + '#' + i.num; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Tracking numbers on a shipping label (USPS 9xxx…, UPS 1Z…, FedEx 12/15/20 digits)
export function findTracking(text) {
  const out = new Set();
  const squashed = text.replace(/(\d)\s+(?=\d)/g, '$1');
  for (const m of squashed.matchAll(/\b(9[1-5]\d{18,24})\b/g)) out.add(m[1]);
  for (const m of squashed.matchAll(/\b(1Z[0-9A-Z]{16})\b/gi)) out.add(m[1].toUpperCase());
  if (!out.size) for (const m of squashed.matchAll(/(?:tracking|trk)\s*(?:#|no\.?|number)?\s*[:#]?\s*([0-9A-Z]{10,34})/gi)) out.add(m[1].toUpperCase());
  return [...out];
}

// Parse one or more PDFs (combined labels + packing slips, or slips only). files: [{id, name, bytes}]
export async function parsePdfs(files, onProgress) {
  const orders = new Map();
  const labels = [];
  const seq = [];
  for (const f of files) {
    const pages = await extractPages(f.bytes);
    for (const p of pages) {
      onProgress && onProgress(`${f.name}: page ${p.pageIndex + 1} of ${pages.length}`);
      const kind = classifyPage(p.text);
      const ids = findOrderIds(p.text);
      const entry = { fileId: f.id, pageIndex: p.pageIndex, kind, ids, tracking: kind === 'slip' ? [] : findTracking(p.text) };
      seq.push(entry);
      if (kind === 'slip') {
        const oid = ids[0] || `slip-${f.id}-${p.pageIndex}`;
        let o = orders.get(oid);
        if (!o) { o = { orderId: oid, extraOrderIds: ids.slice(1), buyer: '', items: [], slipPages: [], labelPages: [], tracking: [], firstSeq: seq.length }; orders.set(oid, o); }
        o.buyer = o.buyer || findBuyer(p.lines);
        for (const it of findItems(p.text)) if (!o.items.some(x => x.num === it.num && nameKey(x.name) === nameKey(it.name))) o.items.push(it);
        o.slipPages.push({ fileId: f.id, pageIndex: p.pageIndex });
        entry.order = o;
      } else labels.push(entry);
    }
  }
  const byAnyId = new Map();
  for (const o of orders.values()) { byAnyId.set(o.orderId, o); o.extraOrderIds.forEach(id => byAnyId.set(id, o)); }
  const attach = (o, l) => { o.labelPages.push({ fileId: l.fileId, pageIndex: l.pageIndex }); l.tracking.forEach(t => { if (!o.tracking.includes(t)) o.tracking.push(t); }); l.done = true; };
  for (const l of labels) { const o = l.ids.map(id => byAnyId.get(id)).find(Boolean); if (o) attach(o, l); }
  for (const dir of [1, -1]) {
    for (let i = 0; i < seq.length; i++) {
      const l = seq[i];
      if (l.kind === 'slip' || l.done) continue;
      const n = seq[i + dir];
      if (n && n.kind === 'slip' && n.fileId === l.fileId && n.order && !n.order.labelPages.length) attach(n.order, l);
    }
  }
  const unmatched = labels.filter(l => !l.done).map(l => ({ fileId: l.fileId, pageIndex: l.pageIndex }));
  const list = [...orders.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  list.forEach(o => { o.buyerKey = buyerKey(o.buyer) || 'order' + o.orderId; });
  return { orders: list, unmatchedLabels: unmatched, pageCount: seq.length, labelPages: labels.length };
}

// A shipping-labels PDF added after a slips-only import: match by order ID, else by position.
export async function parseLabelsOnly(file, orders) {
  const pages = await extractPages(file.bytes);
  const byId = new Map();
  orders.forEach(o => { byId.set(o.orderId, o); (o.extraOrderIds || []).forEach(id => byId.set(id, o)); });
  const assignments = []; const leftovers = [];
  for (const p of pages) {
    const o = findOrderIds(p.text).map(id => byId.get(id)).find(Boolean);
    if (o) assignments.push({ order: o, ref: { fileId: file.id, pageIndex: p.pageIndex }, tracking: findTracking(p.text) });
    else leftovers.push(p.pageIndex);
  }
  let positional = false;
  if (!assignments.length && pages.length === orders.length) {
    positional = true;
    const sorted = orders.slice().sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
    pages.forEach((p, i) => assignments.push({ order: sorted[i], ref: { fileId: file.id, pageIndex: p.pageIndex }, tracking: findTracking(p.text) }));
    leftovers.length = 0;
  }
  return { assignments, leftovers, positional, pageCount: pages.length };
}

// ---- CSV ----
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

export function ordersFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV has no order rows.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...res) => { for (const re of res) { const i = head.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  const cOrder = col(/^order\s*id$/, /order\s*(id|no|number)/);
  const cBuyer = col(/buyer\s*username/, /buyer\s*nickname/, /^buyer/, /recipient/, /customer/, /ship.*name/);
  const cQty = col(/^quantity$/, /qty|quantity/);
  const cTitle = col(/product\s*name/, /item\s*name/, /title/, /listing/);
  const cTrack = col(/tracking/);
  if (cOrder < 0) throw new Error('Could not find an "Order ID" column in the CSV.');
  const orders = new Map();
  rows.slice(1).forEach((r, idx) => {
    if (!/\d{6,}/.test(r[cOrder] || '')) return;
    const oid = (r[cOrder] || '').trim();
    let o = orders.get(oid);
    if (!o) { o = { orderId: oid, extraOrderIds: [], buyer: cBuyer >= 0 ? (r[cBuyer] || '').trim() : '', items: [], slipPages: [], labelPages: [], tracking: [], firstSeq: idx }; orders.set(oid, o); }
    const found = findItems(cTitle >= 0 ? r[cTitle] || '' : r.join(' | '));
    found.forEach(it => { it.qty = cQty >= 0 ? (parseInt(r[cQty], 10) || 1) : 1; o.items.push(it); });
    if (cTrack >= 0 && r[cTrack]) o.tracking.push(r[cTrack].trim());
  });
  const list = [...orders.values()];
  list.forEach(o => { o.buyerKey = buyerKey(o.buyer) || 'order' + o.orderId; });
  return { orders: list, unmatchedLabels: [], pageCount: 0, labelPages: 0 };
}

// Build trays the Scan2Tray "post-show" way: the buyer with the most items gets Tray 1, and so on.
// A tray holds at most `perTray` items; bigger buyers get extra trays, placed by their size.
export function planShow(orders, perTray = 24) {
  const groups = new Map();
  for (const o of orders) {
    let g = groups.get(o.buyerKey);
    if (!g) { g = { buyerKey: o.buyerKey, buyer: o.buyer || 'Unknown buyer', orders: [], items: [], seq: o.firstSeq ?? 0 }; groups.set(o.buyerKey, g); }
    g.orders.push(o);
    for (const it of o.items) for (let q = 0; q < Math.max(1, it.qty || 1); q++) g.items.push({ ...it, orderId: o.orderId });
    if (!o.items.length) g.items.push({ title: 'Item without a sticker number', name: '', num: null, qty: 1, price: 0, orderId: o.orderId, noNum: true });
  }
  const chunks = [];
  for (const g of groups.values()) {
    g.items.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9));
    for (let i = 0; i < g.items.length; i += perTray) chunks.push({ g, items: g.items.slice(i, i + perTray), part: i / perTray });
  }
  chunks.sort((a, b) => b.items.length - a.items.length || a.g.seq - b.g.seq || a.part - b.part);
  const trays = [], items = [];
  chunks.forEach((c, i) => {
    const n = i + 1;
    const orderIds = [...new Set(c.items.map(x => x.orderId))];
    const tracking = [...new Set(c.g.orders.filter(o => orderIds.includes(o.orderId)).flatMap(o => o.tracking || []))];
    const t = { n, buyer: c.g.buyer, buyerKey: c.g.buyerKey, orderIds, items: [], tracking, part: c.part };
    c.items.forEach((x, j) => {
      const id = `${n}-${j}`;
      items.push({ id, num: x.num, name: x.name, code: x.num != null ? stickerCode(x.name, x.num) : '', title: x.title, price: x.price || 0, tray: n, orderId: x.orderId, noNum: !!x.noNum });
      t.items.push(id);
    });
    trays.push(t);
  });
  const slim = orders.map(o => ({ orderId: o.orderId, extraOrderIds: o.extraOrderIds, buyer: o.buyer, buyerKey: o.buyerKey, slipPages: o.slipPages, labelPages: o.labelPages, tracking: o.tracking, firstSeq: o.firstSeq }));
  return { trays, items, orders: slim };
}
