// Reads TikTok Shop PDFs (shipping labels + packing slips) and order CSVs.
import { stickerCode } from './labels.js';

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

// Find sticker codes referenced in text, given the show's batches.
export function findStickerCodes(text, batches, settings = {}) {
  const codes = [];
  const add = c => { if (!codes.includes(c)) codes.push(c); };
  for (const b of batches) {
    const inRange = n => n >= b.start && n < b.start + b.count;
    for (const m of text.matchAll(new RegExp(`\\b${esc(b.prefix)}\\s*-?\\s*(\\d{1,6})\\b`, 'gi'))) {
      const n = +m[1]; if (inRange(n)) add(stickerCode(b, n));
    }
    if (b.name) {
      for (const m of text.matchAll(new RegExp(`${esc(b.name)}\\s*(?:#|no\\.?|number|num|lot|-|:|x)?\\s*#?(\\d{1,6})\\b`, 'gi'))) {
        const n = +m[1]; if (inRange(n)) add(stickerCode(b, n));
      }
    }
  }
  if (settings.stickerRegex && batches.length) {
    try {
      for (const m of text.matchAll(new RegExp(settings.stickerRegex, 'gi'))) {
        const n = +(m[1] || m[0]).replace(/\D/g, '');
        const b = batches.find(b => n >= b.start && n < b.start + b.count);
        if (b) add(stickerCode(b, n));
      }
    } catch (e) { /* invalid user regex is reported in settings */ }
  }
  return codes;
}

function findQty(lines) {
  let total = 0;
  for (const l of lines) {
    const m = l.match(/\b(?:qty|quantity)\s*[:x]?\s*(\d{1,3})\b/i);
    if (m) total += +m[1];
  }
  return total || null;
}

// Parse one or more PDFs. files: [{id, name, bytes}]
export async function parsePdfs(files, batches, settings, onProgress) {
  const orders = new Map();
  const labels = []; // {fileId, pageIndex, orderIds, seq}
  const seq = []; // overall page sequence for adjacency pairing
  for (const f of files) {
    const pages = await extractPages(f.bytes);
    for (const p of pages) {
      onProgress && onProgress(`${f.name}: page ${p.pageIndex + 1} of ${pages.length}`);
      const kind = classifyPage(p.text);
      const ids = findOrderIds(p.text);
      const entry = { fileId: f.id, pageIndex: p.pageIndex, kind, ids, text: p.text };
      seq.push(entry);
      if (kind === 'slip') {
        const oid = ids[0] || `slip-${f.id}-${p.pageIndex}`;
        let o = orders.get(oid);
        if (!o) {
          o = { orderId: oid, extraOrderIds: ids.slice(1), buyer: '', codes: [], qty: null, slipPages: [], labelPages: [], text: '', firstSeq: seq.length };
          orders.set(oid, o);
        }
        o.buyer = o.buyer || findBuyer(p.lines);
        o.text += '\n' + p.text;
        findStickerCodes(p.text, batches, settings).forEach(c => { if (!o.codes.includes(c)) o.codes.push(c); });
        const q = findQty(p.lines); if (q) o.qty = (o.qty || 0) + q;
        o.slipPages.push({ fileId: f.id, pageIndex: p.pageIndex });
        entry.order = o;
      } else {
        labels.push(entry);
      }
    }
  }
  // Pair labels to orders: 1) by order ID in label text
  const unmatched = [];
  const byAnyId = new Map();
  for (const o of orders.values()) { byAnyId.set(o.orderId, o); o.extraOrderIds.forEach(id => byAnyId.set(id, o)); }
  for (const l of labels) {
    const o = l.ids.map(id => byAnyId.get(id)).find(Boolean);
    if (o) { o.labelPages.push({ fileId: l.fileId, pageIndex: l.pageIndex }); l.done = true; }
  }
  // 2) by position: label directly before its slip, then directly after
  for (const dir of [1, -1]) {
    for (let i = 0; i < seq.length; i++) {
      const l = seq[i];
      if (l.kind === 'slip' || l.done) continue;
      const n = seq[i + dir];
      if (n && n.kind === 'slip' && n.fileId === l.fileId && n.order && !n.order.labelPages.length) {
        n.order.labelPages.push({ fileId: l.fileId, pageIndex: l.pageIndex });
        l.done = true;
      }
    }
  }
  for (const l of labels) if (!l.done) unmatched.push({ fileId: l.fileId, pageIndex: l.pageIndex, kind: l.kind });
  const list = [...orders.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  list.forEach(o => { o.buyerKey = buyerKey(o.buyer) || 'order' + o.orderId; delete o.text; });
  return { orders: list, unmatchedLabels: unmatched, pageCount: seq.length };
}

// Labels-only PDF uploaded after slips were imported: match by order ID, else by order of appearance.
export async function parseLabelsOnly(file, existingOrders) {
  const pages = await extractPages(file.bytes);
  const byId = new Map();
  existingOrders.forEach(o => { byId.set(o.orderId, o); (o.extraOrderIds || []).forEach(id => byId.set(id, o)); });
  const assignments = []; const leftovers = [];
  for (const p of pages) {
    const o = findOrderIds(p.text).map(id => byId.get(id)).find(Boolean);
    if (o) assignments.push({ order: o, ref: { fileId: file.id, pageIndex: p.pageIndex } });
    else leftovers.push(p.pageIndex);
  }
  let positional = false;
  if (!assignments.length && pages.length === existingOrders.length) {
    positional = true;
    const sorted = existingOrders.slice().sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
    pages.forEach((p, i) => assignments.push({ order: sorted[i], ref: { fileId: file.id, pageIndex: p.pageIndex } }));
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

export function ordersFromCsv(text, batches, settings) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV has no order rows.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...res) => { for (const re of res) { const i = head.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  const cOrder = col(/^order\s*id$/, /order\s*(id|no|number)/);
  const cBuyer = col(/buyer\s*username/, /buyer\s*nickname/, /^buyer/, /recipient/, /customer/, /ship.*name/);
  const cQty = col(/^quantity$/, /qty|quantity/);
  if (cOrder < 0) throw new Error('Could not find an "Order ID" column in the CSV.');
  const orders = new Map();
  rows.slice(1).forEach((r, idx) => {
    // skip TikTok's description row under the header
    if (!/\d{6,}/.test(r[cOrder] || '')) return;
    const oid = (r[cOrder] || '').trim();
    const buyer = cBuyer >= 0 ? (r[cBuyer] || '').trim() : '';
    let o = orders.get(oid);
    if (!o) { o = { orderId: oid, extraOrderIds: [], buyer, codes: [], qty: 0, slipPages: [], labelPages: [], firstSeq: idx }; orders.set(oid, o); }
    o.buyer = o.buyer || buyer;
    findStickerCodes(r.join(' | '), batches, settings).forEach(c => { if (!o.codes.includes(c)) o.codes.push(c); });
    o.qty += cQty >= 0 ? (parseInt(r[cQty], 10) || 1) : 1;
  });
  const list = [...orders.values()];
  list.forEach(o => { o.buyerKey = buyerKey(o.buyer) || 'order' + o.orderId; });
  return { orders: list, unmatchedLabels: [], pageCount: 0 };
}

// Group parsed orders into trays. Earliest sticker number = earliest win = lowest tray number.
export function planTrays(parsedOrders, batches, existingTrays = []) {
  const batchRank = new Map(batches.map((b, i) => [b.prefix, i]));
  const codeRank = code => {
    const b = batches.find(b => code.startsWith(b.prefix));
    const n = b ? parseInt(code.slice(b.prefix.length), 10) : 1e9;
    return (b ? batchRank.get(b.prefix) : 999) * 1e7 + n;
  };
  const groups = new Map();
  for (const o of parsedOrders) {
    let g = groups.get(o.buyerKey);
    if (!g) { g = { buyerKey: o.buyerKey, buyer: o.buyer || 'Unknown buyer', orders: [], codes: [], rank: Infinity, seq: Infinity }; groups.set(o.buyerKey, g); }
    g.orders.push(o);
    o.codes.forEach(c => { if (!g.codes.includes(c)) g.codes.push(c); });
    g.rank = Math.min(g.rank, ...o.codes.map(codeRank));
    g.seq = Math.min(g.seq, o.firstSeq ?? 0);
  }
  const existingByKey = new Map(existingTrays.map(t => [t.buyerKey, t]));
  let next = existingTrays.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  const sorted = [...groups.values()].sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  sorted.forEach(g => {
    g.codes.sort((a, b) => codeRank(a) - codeRank(b));
    const ex = existingByKey.get(g.buyerKey);
    g.number = ex ? ex.number : next++;
    g.existing = !!ex;
  });
  return sorted.sort((a, b) => a.number - b.number);
}
