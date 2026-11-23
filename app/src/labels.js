// PDF generation with pdf-lib (global PDFLib from vendor/pdf-lib.min.js)
import { encode, totalModules } from './code128.js';

const MM = 72 / 25.4;
const lib = () => window.PDFLib;

export function stickerCode(batch, n) {
  return `${batch.prefix}${String(n).padStart(batch.pad || 4, '0')}`;
}

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

export async function stickerBatchPdf(batch, settings) {
  const { PDFDocument, StandardFonts, rgb } = lib();
  const doc = await PDFDocument.create();
  doc.setTitle(`${batch.name} stickers ${batch.start}-${batch.start + batch.count - 1}`);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const W = settings.labelWidthMm * MM, H = settings.labelHeightMm * MM;
  const pad = 2.5 * MM;
  for (let n = batch.start; n < batch.start + batch.count; n++) {
    const code = stickerCode(batch, n);
    const page = doc.addPage([W, H]);
    const nameSize = fitText(reg, safe(batch.name), W - 2 * pad, 6.5);
    page.drawText(safe(batch.name), { x: pad, y: H - pad - nameSize * 0.8, size: nameSize, font: reg, color: rgb(0, 0, 0) });
    const numText = '#' + n;
    const numSize = 7;
    page.drawText(numText, { x: W - pad - bold.widthOfTextAtSize(numText, numSize), y: H - pad - numSize * 0.8, size: numSize, font: bold });
    const codeSize = fitText(bold, code, W - 2 * pad, 13);
    const barTop = H - pad - 9;
    const barBottom = pad + codeSize + 1.5;
    drawBarcode(page, code, pad + 1.5 * MM, barBottom, W - 2 * pad - 3 * MM, barTop - barBottom);
    page.drawText(code, { x: (W - bold.widthOfTextAtSize(code, codeSize)) / 2, y: pad, size: codeSize, font: bold });
  }
  return doc.save();
}

// One label per tray: big tray number, buyer, item count
export async function trayLabelsPdf(trays, settings, showName) {
  const { PDFDocument, StandardFonts } = lib();
  const doc = await PDFDocument.create();
  doc.setTitle(`${showName} tray labels`);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const W = settings.labelWidthMm * MM, H = settings.labelHeightMm * MM, pad = 2.5 * MM;
  for (const t of trays) {
    const page = doc.addPage([W, H]);
    const num = String(t.number);
    const numSize = fitText(bold, num, W * 0.45, H * 0.62);
    page.drawText(num, { x: pad, y: (H - numSize * 0.72) / 2, size: numSize, font: bold });
    const rx = pad + bold.widthOfTextAtSize(num, numSize) + 2 * MM, rw = W - rx - pad;
    page.drawText('TRAY', { x: rx, y: H - pad - 6, size: 6, font: reg });
    const buyer = safe(t.buyer);
    const bs = fitText(bold, buyer, rw, 10);
    page.drawText(buyer, { x: rx, y: H / 2 - 2, size: bs, font: bold });
    const meta = `${t.itemCount || 0} item${t.itemCount === 1 ? '' : 's'}`;
    page.drawText(meta, { x: rx, y: pad, size: fitText(reg, meta, rw, 7), font: reg });
  }
  return doc.save();
}

// Build a shipping-label PDF in tray order from imported source PDFs.
// labelRefs: [{fileId, pageIndex}] per order; trays sorted by number.
export async function reorderedLabelsPdf(trays, ordersById, filesById) {
  const { PDFDocument } = lib();
  const out = await PDFDocument.create();
  out.setTitle('Shipping labels in tray order');
  const loaded = {};
  const missing = [];
  for (const t of trays) {
    let any = false;
    for (const oid of t.orderIds) {
      const o = ordersById[oid];
      for (const ref of (o && o.labelPages) || []) {
        if (!filesById[ref.fileId]) continue;
        if (!loaded[ref.fileId]) loaded[ref.fileId] = await PDFDocument.load(filesById[ref.fileId].bytes, { ignoreEncryption: true });
        const [p] = await out.copyPages(loaded[ref.fileId], [ref.pageIndex]);
        out.addPage(p);
        any = true;
      }
    }
    if (!any) missing.push(t);
  }
  return { bytes: out.getPageCount() ? await out.save() : null, missing };
}

// Packing slips in tray order (for sellers who ship with their own labels)
export async function reorderedSlipsPdf(trays, ordersById, filesById) {
  const { PDFDocument } = lib();
  const out = await PDFDocument.create();
  const loaded = {};
  for (const t of trays) for (const oid of t.orderIds) {
    const o = ordersById[oid];
    for (const ref of (o && o.slipPages) || []) {
      if (!filesById[ref.fileId]) continue;
      if (!loaded[ref.fileId]) loaded[ref.fileId] = await PDFDocument.load(filesById[ref.fileId].bytes, { ignoreEncryption: true });
      const [p] = await out.copyPages(loaded[ref.fileId], [ref.pageIndex]);
      out.addPage(p);
    }
  }
  return out.getPageCount() ? out.save() : null;
}
