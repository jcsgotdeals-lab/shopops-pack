// PDF generation with pdf-lib (global PDFLib from vendor/pdf-lib.min.js)
import { encode, totalModules } from './code128.js';
import { stickerCode } from './state.js';

const MM = 72 / 25.4;
const lib = () => window.PDFLib;

function drawBarcode(page, text, x, y, w, h) {
  const { rgb } = lib();
  const widths = encode(text);
  const m = w / totalModules(widths);
  let cx = x;
  widths.forEach((wd, i) => {
    if (i % 2 === 0) page.drawRectangle({ x: cx, y, width: wd * m, height: h, color: rgb(0, 0, 0) });
    cx += wd * m;
  });
}

function fitText(font, text, maxW, size) {
  let s = size;
  while (s > 4 && font.widthOfTextAtSize(text, s) > maxW) s -= 0.5;
  return s;
}

// ASCII-safe text for the standard PDF fonts
export function safe(text) {
  return String(text ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').trim() || '?';
}

// Pre-show stickers: one 50x25 mm label per number, barcode + "Name #n".
// rows: [{name, from, to}]
export async function preShowPdf(rows, settings, testOnly = false) {
  const { PDFDocument, StandardFonts } = lib();
  const doc = await PDFDocument.create();
  doc.setTitle('Pre-show labels');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = settings.labelWidthMm * MM, H = settings.labelHeightMm * MM, pad = 2 * MM;
  for (const r of rows) {
    const last = testOnly ? r.from : r.to;
    for (let n = r.from; n <= last; n++) {
      const page = doc.addPage([W, H]);
      const text = `${safe(r.name)} #${n}`;
      const ts = fitText(bold, text, W - 2 * pad, 11);
      page.drawText(text, { x: (W - bold.widthOfTextAtSize(text, ts)) / 2, y: pad, size: ts, font: bold });
      const barBottom = pad + ts + 1.5 * MM;
      drawBarcode(page, stickerCode(r.name, n), pad + 2 * MM, barBottom, W - 2 * pad - 4 * MM, H - pad - barBottom);
    }
    if (testOnly) break;
  }
  return doc.save();
}

// Tray labels: one 6x4 in label per tray with a big tray number, buyer, item count (and address if known).
export async function trayLabelsPdf(trays, showName) {
  const { PDFDocument, StandardFonts, rgb } = lib();
  const doc = await PDFDocument.create();
  doc.setTitle(`${showName} tray labels`);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const W = 6 * 72, H = 4 * 72, pad = 18;
  for (const t of trays) {
    const page = doc.addPage([W, H]);
    page.drawText('TRAY', { x: pad, y: H - pad - 14, size: 14, font: bold, color: rgb(0.3, 0.3, 0.3) });
    const num = String(t.n);
    const ns = fitText(bold, num, W * 0.55, 150);
    page.drawText(num, { x: pad, y: H / 2 - ns * 0.36, size: ns, font: bold });
    const rx = W * 0.58, rw = W - rx - pad;
    const buyer = safe('@' + String(t.buyer || '').replace(/^@/, ''));
    page.drawText(buyer, { x: rx, y: H - pad - 40, size: fitText(bold, buyer, rw, 20), font: bold });
    const cnt = `${t.total} item${t.total === 1 ? '' : 's'}`;
    page.drawText(cnt, { x: rx, y: H - pad - 70, size: 18, font: reg });
    let y = H - pad - 100;
    for (const line of (t.address || []).slice(0, 5)) { page.drawText(safe(line), { x: rx, y, size: fitText(reg, safe(line), rw, 11), font: reg }); y -= 15; }
    const show = safe(showName);
    page.drawText(show, { x: pad, y: pad, size: fitText(reg, show, W - 2 * pad, 10), font: reg, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}

// Shipping labels and/or packing slips, reordered by tray, each page stamped with its tray number.
// mode: 'both' (label then slip per buyer) | 'labels' | 'slips'
export async function trayOrderPdf(trays, ordersById, filesById, mode, opts = {}) {
  const { PDFDocument, StandardFonts, rgb } = lib();
  const out = await PDFDocument.create();
  out.setTitle(mode === 'slips' ? 'Packing slips in tray order' : mode === 'labels' ? 'Shipping labels in tray order' : 'Labels and slips in tray order');
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const reg = await out.embedFont(StandardFonts.Helvetica);
  const loaded = {};
  const missing = [];
  const done = new Set(); // a buyer split over two trays shares one label: print it once
  const add = async (ref, t) => {
    const key = ref.fileId + ':' + ref.pageIndex;
    if (done.has(key)) return true;
    if (!filesById[ref.fileId]) return false;
    done.add(key);
    if (!loaded[ref.fileId]) loaded[ref.fileId] = await PDFDocument.load(filesById[ref.fileId].bytes, { ignoreEncryption: true });
    const [p] = await out.copyPages(loaded[ref.fileId], [ref.pageIndex]);
    out.addPage(p);
    // stamp: white box with the tray number in the top-right corner
    const { width, height } = p.getSize();
    const label = String(t.n);
    const size = Math.min(34, width / 8);
    const bw = Math.max(bold.widthOfTextAtSize(label, size) + 14, size * 1.6);
    const bh = size + (opts.itemCount ? 16 : 8);
    const x = width - bw - 6, y = height - bh - 6;
    p.drawRectangle({ x, y, width: bw, height: bh, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0), borderWidth: 2 });
    p.drawText(label, { x: x + (bw - bold.widthOfTextAtSize(label, size)) / 2, y: y + (opts.itemCount ? 13 : 6), size, font: bold });
    if (opts.itemCount) {
      const c = `${t.total} item${t.total === 1 ? '' : 's'}`;
      p.drawText(c, { x: x + (bw - reg.widthOfTextAtSize(c, 8)) / 2, y: y + 4, size: 8, font: reg });
    }
    return true;
  };
  for (const t of trays) {
    let any = false;
    for (const oid of t.orderIds) {
      const o = ordersById[oid];
      if (!o) continue;
      if (mode !== 'slips') for (const ref of o.labelPages || []) any = (await add(ref, t)) || any;
      if (mode !== 'labels') for (const ref of o.slipPages || []) any = (await add(ref, t)) || any;
    }
    if (!any) missing.push(t);
  }
  return { bytes: out.getPageCount() ? await out.save() : null, missing };
}
