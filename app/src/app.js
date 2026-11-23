import * as db from './db.js';
import { stickerBatchPdf, trayLabelsPdf, reorderedLabelsPdf, reorderedSlipsPdf, stickerCode } from './labels.js';
import { parsePdfs, parseLabelsOnly, ordersFromCsv, planTrays, buyerKey } from './importer.js';
import { drawToCanvas } from './code128.js';
import { feedback } from './feedback.js';
import { CameraScanner } from './camera.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

const state = {
  settings: null,
  showId: null,
  pendingImport: null,
  camera: null,
  packTray: null,
};

// ---------- helpers ----------
function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const native = () => window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
async function saveNative(bytes, filename, mime) {
  // Android app: write to cache, then open the share sheet (Print, Drive, Files, email...)
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  const res = await Filesystem.writeFile({ path: filename, data: btoa(s), directory: 'CACHE' });
  await Share.share({ title: filename, url: res.uri, dialogTitle: 'Save or print ' + filename });
}
function saveFile(bytes, filename, mime = 'application/pdf') {
  if (native()) { saveNative(bytes, filename, mime).catch(err => toast('Could not save the file: ' + err.message, 'error')); return; }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function openPdf(bytes) {
  if (native()) return saveFile(bytes, 'stickers.pdf');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const w = window.open(url, '_blank');
  if (!w) saveFile(bytes, 'labels.pdf');
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show'; }
function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}
function readText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(file); });
}
function setShow(id) {
  state.showId = id;
  try { localStorage.setItem('currentShow', id || ''); } catch (e) { /* ignore */ }
}
async function currentShow() {
  if (!state.showId) return null;
  return db.get('shows', state.showId);
}
async function showData(showId) {
  const [trays, items, orders, batches, scans] = await Promise.all([
    db.byIndex('trays', 'showId', showId), db.byIndex('items', 'showId', showId),
    db.byIndex('orders', 'showId', showId), db.byIndex('batches', 'showId', showId),
    db.byIndex('scans', 'showId', showId),
  ]);
  trays.sort((a, b) => a.number - b.number);
  batches.sort((a, b) => a.createdAt - b.createdAt);
  return { trays, items, orders, batches, scans };
}
function needShow(title) {
  view().innerHTML = `<section class="panel empty"><h1>${esc(title)}</h1><p>Pick or create a show first.</p><a class="btn primary" href="#shows">Go to shows</a></section>`;
}
async function refreshTrayStatus(showId, trayNumber) {
  const trays = await db.byIndex('trays', 'showId', showId);
  const t = trays.find(t => t.number === trayNumber);
  if (!t) return null;
  const items = (await db.byIndex('items', 'showId', showId)).filter(i => i.trayNumber === trayNumber);
  t.itemCount = items.length;
  t.inTray = items.filter(i => i.status !== 'sold').length;
  t.packedCount = items.filter(i => i.status === 'packed').length;
  if (t.status !== 'shipped') t.status = items.length && t.packedCount === items.length ? 'packed' : 'open';
  await db.put('trays', t);
  return t;
}
async function logScan(showId, code, mode, result, trayNumber) {
  await db.put('scans', { id: db.uid('s'), showId, code, mode, result, trayNumber: trayNumber ?? null, at: Date.now() });
}
async function updateShowLabel() {
  const s = await currentShow();
  $('#current-show').textContent = s ? s.name : 'No show selected';
}

// ---------- Shows ----------
async function viewShows() {
  const shows = (await db.all('shows')).sort((a, b) => b.createdAt - a.createdAt);
  const stats = await Promise.all(shows.map(async s => {
    const { trays, items } = await showData(s.id);
    return { trays: trays.length, items: items.length, inTray: items.filter(i => i.status !== 'sold').length, packed: items.filter(i => i.status === 'packed').length };
  }));
  const d0 = new Date(); const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  view().innerHTML = `
  <section class="panel">
    <h1>Shows</h1>
    <form id="new-show" class="row wrap">
      <label class="grow">Show name<input id="show-name" required placeholder="Friday night toys LIVE" maxlength="80"></label>
      <label>Date<input id="show-date" type="date" value="${today}"></label>
      <button class="btn primary" type="submit">New show</button>
    </form>
  </section>
  <section class="list">
    ${shows.length ? shows.map((s, i) => `
      <article class="show-card ${s.id === state.showId ? 'current' : ''}">
        <div class="grow">
          <h2>${esc(s.name)}</h2>
          <p class="muted">${esc(s.date || '')}${s.id === state.showId ? ' · current show' : ''}</p>
          <div class="stats">
            <span><b>${stats[i].trays}</b> trays</span>
            <span><b>${stats[i].items}</b> items</span>
            <span><b>${stats[i].inTray}</b> in trays</span>
            <span><b>${stats[i].packed}</b> packed</span>
          </div>
          ${stats[i].items ? `<div class="bar"><i style="width:${Math.round(stats[i].packed / stats[i].items * 100)}%"></i></div>` : ''}
        </div>
        <div class="col">
          ${s.id === state.showId ? '' : `<button class="btn" data-act="select" data-id="${s.id}">Open</button>`}
          <button class="btn ghost danger" data-act="delete" data-id="${s.id}">Delete</button>
        </div>
      </article>`).join('') : `<p class="muted pad">No shows yet. Create one above, then print sticker batches for it.</p>`}
  </section>`;
  $('#new-show').onsubmit = async e => {
    e.preventDefault();
    const s = { id: db.uid('show'), name: $('#show-name').value.trim(), date: $('#show-date').value, createdAt: Date.now() };
    await db.put('shows', s);
    setShow(s.id);
    await updateShowLabel();
    toast('Show created');
    location.hash = '#stickers';
  };
  view().onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'select') { setShow(b.dataset.id); await updateShowLabel(); viewShows(); }
    if (b.dataset.act === 'delete') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to delete'; return; }
      const id = b.dataset.id;
      for (const st of ['batches', 'orders', 'trays', 'items', 'scans', 'files']) await db.delWhere(st, 'showId', id);
      await db.del('shows', id);
      if (state.showId === id) setShow(null);
      await updateShowLabel();
      toast('Show deleted');
      viewShows();
    }
  };
}

// ---------- Stickers ----------
async function viewStickers() {
  const show = await currentShow();
  if (!show) return needShow('Stickers');
  const { batches, items } = await showData(show.id);
  const allBatches = batches; // sticker numbers only need to be unique within a show
  view().innerHTML = `
  <section class="panel">
    <h1>Sticker batches</h1>
    <p class="muted">Print numbered stickers before you go live. Stick the next one on each item as it sells. Name a TikTok listing after the batch (for example "${esc(batches[0]?.name || 'Toys')}") so the sticker number shows on the packing slip.</p>
    <form id="batch-form" class="grid-form">
      <label>Batch name<input id="b-name" required maxlength="40" placeholder="Toys"></label>
      <label>Code prefix<input id="b-prefix" required maxlength="4" pattern="[A-Za-z0-9]{1,4}" placeholder="TOY" style="text-transform:uppercase"></label>
      <label>First number<input id="b-start" type="number" min="1" max="99999" value="1" required></label>
      <label>How many (max 1000)<input id="b-count" type="number" min="1" max="1000" value="100" required></label>
      <div class="preview-wrap"><span class="muted small">Preview</span><canvas id="b-preview" width="400" height="200"></canvas></div>
      <button class="btn primary" type="submit">Create batch and download PDF</button>
    </form>
  </section>
  <section class="list">
    ${batches.map(b => {
      const used = items.filter(i => i.code.startsWith(b.prefix)).length;
      return `<article class="show-card">
        <div class="grow"><h2>${esc(b.name)} <span class="code">${esc(stickerCode(b, b.start))} – ${esc(stickerCode(b, b.start + b.count - 1))}</span></h2>
        <p class="muted">${b.count} stickers · ${used} matched to orders · created ${fmtDate(b.createdAt)}</p></div>
        <div class="col">
          <button class="btn" data-act="dl" data-id="${b.id}">Download PDF</button>
          <button class="btn ghost" data-act="open" data-id="${b.id}">Open to print</button>
          <button class="btn ghost danger" data-act="del" data-id="${b.id}">Delete</button>
        </div></article>`;
    }).join('') || '<p class="muted pad">No batches for this show yet.</p>'}
  </section>`;
  const nameEl = $('#b-name'), prefixEl = $('#b-prefix'), startEl = $('#b-start');
  const draw = () => {
    const c = $('#b-preview'), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    const b = { prefix: (prefixEl.value || 'TOY').toUpperCase(), pad: 4 };
    const code = stickerCode(b, +startEl.value || 1);
    g.font = '18px sans-serif'; g.fillText(nameEl.value || 'Toys', 14, 28);
    g.font = 'bold 18px sans-serif'; g.textAlign = 'right'; g.fillText('#' + (+startEl.value || 1), 386, 28); g.textAlign = 'left';
    try { drawToCanvas(g, code, 24, 40, 352, 100); } catch (e) { /* invalid */ }
    g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.fillText(code, 200, 184); g.textAlign = 'left';
  };
  const suggestStart = () => {
    const p = prefixEl.value.toUpperCase();
    const same = allBatches.filter(b => b.prefix === p);
    const next = same.reduce((m, b) => Math.max(m, b.start + b.count), 1);
    startEl.value = next;
  };
  nameEl.oninput = () => {
    if (!prefixEl.dataset.touched) { prefixEl.value = nameEl.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(); suggestStart(); }
    draw();
  };
  prefixEl.oninput = () => { prefixEl.dataset.touched = '1'; suggestStart(); draw(); };
  startEl.oninput = draw;
  draw();
  $('#batch-form').onsubmit = async e => {
    e.preventDefault();
    const b = {
      id: db.uid('batch'), showId: show.id, name: nameEl.value.trim(), prefix: prefixEl.value.toUpperCase().trim(),
      start: +startEl.value, count: Math.min(1000, +$('#b-count').value), pad: 4, createdAt: Date.now(),
    };
    const clash = allBatches.find(x => x.prefix === b.prefix && b.start < x.start + x.count && x.start < b.start + b.count);
    if (clash) { toast(`Numbers overlap batch "${clash.name}" (${stickerCode(clash, clash.start)}–${stickerCode(clash, clash.start + clash.count - 1)}). Change the first number or prefix.`, 'error'); return; }
    await db.put('batches', b);
    toast('Building sticker PDF…');
    const bytes = await stickerBatchPdf(b, state.settings);
    saveFile(bytes, `${slug(b.name)}-stickers-${b.start}-${b.start + b.count - 1}.pdf`);
    viewStickers();
  };
  view().onclick = async e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const b = await db.get('batches', btn.dataset.id);
    if (btn.dataset.act === 'dl' || btn.dataset.act === 'open') {
      const bytes = await stickerBatchPdf(b, state.settings);
      if (btn.dataset.act === 'dl') saveFile(bytes, `${slug(b.name)}-stickers-${b.start}-${b.start + b.count - 1}.pdf`); else openPdf(bytes);
    }
    if (btn.dataset.act === 'del') {
      if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to delete'; return; }
      await db.del('batches', b.id); viewStickers();
    }
  };
}

// ---------- Import ----------
async function viewImport() {
  const show = await currentShow();
  if (!show) return needShow('Import orders');
  const { batches, orders } = await showData(show.id);
  const p = state.pendingImport && state.pendingImport.showId === show.id ? state.pendingImport : null;
  view().innerHTML = `
  <section class="panel">
    <h1>Import orders</h1>
    <p class="muted">After the live, download TikTok Shop's shipping labels with packing slips as one PDF and add it here. Several PDFs from the same show are combined. You can also import an order CSV export.</p>
    ${batches.length ? '' : '<p class="notice">This show has no sticker batches yet. Orders can still be imported, but sticker numbers can only be matched once a batch exists.</p>'}
    <div class="drop" id="drop">
      <input id="pdf-input" type="file" accept="application/pdf,.pdf,.csv,text/csv" multiple>
      <p><b>Choose PDF or CSV files</b><br><span class="muted">or drop them here</span></p>
    </div>
    <p id="progress" class="muted small"></p>
  </section>
  ${p ? renderPreview(p) : ''}
  ${orders.length ? `
  <section class="panel">
    <h2>Add shipping labels later</h2>
    <p class="muted">Imported packing slips only? Add the labels PDF here. Pages are matched by order ID, or by order of appearance when the counts match.</p>
    <input id="labels-input" type="file" accept="application/pdf,.pdf">
  </section>` : ''}`;
  const handle = async files => {
    if (!files.length) return;
    const prog = $('#progress');
    try {
      const pdfs = [], csvs = [];
      for (const f of files) (/\.csv$/i.test(f.name) || f.type.includes('csv') ? csvs : pdfs).push(f);
      const stored = [];
      for (const f of pdfs) stored.push({ id: db.uid('file'), showId: show.id, name: f.name, kind: 'tiktok-pdf', bytes: await readFile(f), addedAt: Date.now() });
      let parsed = { orders: [], unmatchedLabels: [], pageCount: 0 };
      if (stored.length) parsed = await parsePdfs(stored, batches, state.settings, m => { prog.textContent = 'Reading ' + m; });
      for (const f of csvs) {
        const r = ordersFromCsv(await readText(f), batches, state.settings);
        parsed.orders.push(...r.orders);
      }
      prog.textContent = '';
      if (!parsed.orders.length) { toast('No packing slips or orders were found in these files.', 'error'); return; }
      state.pendingImport = { showId: show.id, files: stored, parsed, names: files.map(f => f.name) };
      viewImport();
    } catch (err) {
      console.error(err); prog.textContent = '';
      toast('Could not read the file: ' + err.message, 'error');
    }
  };
  $('#pdf-input').onchange = e => handle([...e.target.files]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); };
  const li = $('#labels-input');
  if (li) li.onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const file = { id: db.uid('file'), showId: show.id, name: f.name, kind: 'labels-pdf', bytes: await readFile(f), addedAt: Date.now() };
    const r = await parseLabelsOnly(file, orders);
    if (!r.assignments.length) { toast(`No label pages could be matched (${r.pageCount} pages, ${orders.length} orders).`, 'error'); return; }
    await db.put('files', file);
    for (const a of r.assignments) { a.order.labelPages = [a.ref]; await db.put('orders', a.order); }
    toast(`${r.assignments.length} labels matched${r.positional ? ' by page order' : ''}${r.leftovers.length ? `, ${r.leftovers.length} pages unmatched` : ''}.`, r.leftovers.length ? 'warn' : 'ok');
    viewImport();
  };
  bindPreview(show);
}

function renderPreview(p) {
  const plan = planTrays(p.parsed.orders, [], []); // order-only preview grouping
  const noCodes = p.parsed.orders.filter(o => !o.codes.length);
  const noLabel = p.files.length ? p.parsed.orders.filter(o => !o.labelPages.length) : [];
  const qtyGap = p.parsed.orders.filter(o => o.qty && o.codes.length && o.qty !== o.codes.length);
  return `<section class="panel">
    <h2>Check before creating trays</h2>
    <div class="stats big">
      <span><b>${p.parsed.orders.length}</b> orders</span>
      <span><b>${plan.length}</b> buyers</span>
      <span><b>${p.parsed.orders.reduce((n, o) => n + o.codes.length, 0)}</b> stickers found</span>
      ${p.files.length ? `<span><b>${p.parsed.orders.length - noLabel.length}</b> labels matched</span>` : ''}
    </div>
    ${noCodes.length ? `<p class="notice">${noCodes.length} order${noCodes.length > 1 ? 's have' : ' has'} no sticker number. Type the numbers below (for example <span class="code">12, 15</span>) or leave blank to pack those by hand.</p>` : ''}
    ${noLabel.length ? `<p class="notice">${noLabel.length} order${noLabel.length > 1 ? 's have' : ' has'} no shipping label page in the PDF.</p>` : ''}
    ${p.parsed.unmatchedLabels.length ? `<p class="notice">${p.parsed.unmatchedLabels.length} label page${p.parsed.unmatchedLabels.length > 1 ? 's' : ''} could not be linked to an order.</p>` : ''}
    ${qtyGap.length ? `<p class="notice">${qtyGap.length} order${qtyGap.length > 1 ? 's list' : ' lists'} a quantity that differs from the stickers found.</p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Buyer</th><th>Stickers</th><th>Qty</th><th>Label</th></tr></thead>
      <tbody>${p.parsed.orders.map((o, i) => `<tr class="${o.codes.length ? '' : 'flag'}">
        <td class="code small">${esc(o.orderId.startsWith('slip-') ? '—' : o.orderId)}</td>
        <td><input class="inline" data-buyer="${i}" value="${esc(o.buyer)}" placeholder="Buyer name"></td>
        <td>${o.codes.length ? o.codes.map(c => `<span class="chip">${esc(c)}</span>`).join(' ') : `<input class="inline" data-codes="${i}" placeholder="Sticker numbers">`}</td>
        <td>${o.qty ?? ''}</td>
        <td>${o.labelPages.length ? 'Yes' : (p.files.length ? '<span class="warn-text">Missing</span>' : '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="row">
      <button class="btn primary" id="commit-import">Create trays</button>
      <button class="btn ghost" id="cancel-import">Discard</button>
    </div>
  </section>`;
}

function bindPreview(show) {
  const p = state.pendingImport;
  if (!p || p.showId !== show.id) return;
  view().querySelectorAll('[data-buyer]').forEach(inp => inp.onchange = () => {
    const o = p.parsed.orders[+inp.dataset.buyer]; o.buyer = inp.value.trim(); o.buyerKey = buyerKey(o.buyer) || 'order' + o.orderId;
  });
  $('#cancel-import').onclick = () => { state.pendingImport = null; viewImport(); };
  $('#commit-import').onclick = async () => {
    const { batches, trays: existingTrays, orders: existingOrders, items: existingItems } = await showData(show.id);
    // manual sticker numbers
    view().querySelectorAll('[data-codes]').forEach(inp => {
      const o = p.parsed.orders[+inp.dataset.codes];
      inp.value.split(/[\s,;]+/).filter(Boolean).forEach(tok => {
        const up = tok.toUpperCase();
        let b = batches.find(b => up.startsWith(b.prefix));
        let n = parseInt(b ? up.slice(b.prefix.length) : up.replace(/\D/g, ''), 10);
        if (!b) b = batches.find(b => n >= b.start && n < b.start + b.count);
        if (b && n >= b.start && n < b.start + b.count) { const c = stickerCode(b, n); if (!o.codes.includes(c)) o.codes.push(c); }
      });
    });
    // merge with orders already imported for this show (re-import or part 2)
    const known = new Map(existingOrders.map(o => [o.orderId, o]));
    const merged = p.parsed.orders.map(o => {
      const k = known.get(o.orderId);
      return k ? { ...k, codes: [...new Set([...k.codes, ...o.codes])], labelPages: o.labelPages.length ? o.labelPages : k.labelPages, slipPages: o.slipPages.length ? o.slipPages : k.slipPages, buyer: o.buyer || k.buyer, buyerKey: o.buyerKey } : o;
    });
    const plan = planTrays(merged, batches, existingTrays);
    const codeOwner = new Map(existingItems.map(i => [i.code, i]));
    const conflicts = [];
    await db.putMany('files', p.files);
    const orderRows = [];
    for (const g of plan) {
      const tray = existingTrays.find(t => t.number === g.number) || { id: db.uid('tray'), showId: show.id, number: g.number, buyerKey: g.buyerKey, status: 'open', createdAt: Date.now(), orderIds: [] };
      tray.buyer = g.buyer;
      for (const o of g.orders) {
        const row = { ...o, id: known.get(o.orderId)?.id || db.uid('ord'), showId: show.id, trayNumber: g.number };
        orderRows.push(row);
        if (!tray.orderIds.includes(row.id)) tray.orderIds.push(row.id);
        for (const c of o.codes) {
          const prev = codeOwner.get(c);
          if (prev && prev.trayNumber !== g.number) { conflicts.push(c); continue; }
          if (!prev) {
            const it = { id: show.id + ':' + c, showId: show.id, code: c, trayNumber: g.number, buyer: g.buyer, orderId: o.orderId, status: 'sold', createdAt: Date.now() };
            codeOwner.set(c, it);
            await db.put('items', it);
          }
        }
      }
      await db.put('trays', tray);
      await refreshTrayStatus(show.id, g.number);
    }
    await db.putMany('orders', orderRows);
    state.pendingImport = null;
    toast(`${plan.length} trays ready${conflicts.length ? `. ${conflicts.length} sticker numbers appear on two buyers' slips: ${conflicts.slice(0, 5).join(', ')}` : ''}.`, conflicts.length ? 'warn' : 'ok');
    location.hash = '#trays';
  };
}

// ---------- Trays ----------
async function viewTrays(params) {
  const show = await currentShow();
  if (!show) return needShow('Trays');
  const { trays, items, orders } = await showData(show.id);
  const filter = params.get('f') || 'all';
  const sel = params.get('t') ? +params.get('t') : null;
  const list = trays.filter(t => filter === 'all' || (filter === 'open' ? t.status === 'open' : t.status === filter));
  const tray = sel ? trays.find(t => t.number === sel) : null;
  const trayItems = tray ? items.filter(i => i.trayNumber === tray.number).sort((a, b) => a.code.localeCompare(b.code)) : [];
  const trayOrders = tray ? orders.filter(o => tray.orderIds.includes(o.id)) : [];
  const counts = { all: trays.length, open: trays.filter(t => t.status === 'open').length, packed: trays.filter(t => t.status === 'packed').length, shipped: trays.filter(t => t.status === 'shipped').length };
  view().innerHTML = `
  <section class="panel">
    <div class="row wrap between">
      <h1>Trays</h1>
      <div class="row wrap">
        <button class="btn" id="dl-labels" ${trays.length ? '' : 'disabled'}>Shipping labels in tray order</button>
        <button class="btn ghost" id="dl-slips" ${trays.length ? '' : 'disabled'}>Packing slips in tray order</button>
        <button class="btn ghost" id="dl-traylabels" ${trays.length ? '' : 'disabled'}>Tray labels</button>
      </div>
    </div>
    <div class="tabs">${['all', 'open', 'packed', 'shipped'].map(f => `<a href="#trays?f=${f}" class="${f === filter ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)} <span>${counts[f]}</span></a>`).join('')}</div>
  </section>
  ${tray ? `
  <section class="panel tray-detail">
    <div class="row between wrap">
      <div><span class="tray-num xl">${tray.number}</span></div>
      <div class="grow"><h2>${esc(tray.buyer)}</h2><p class="muted">${trayItems.length} items · ${tray.packedCount || 0} packed · ${trayOrders.length} order${trayOrders.length === 1 ? '' : 's'} · <span class="status ${tray.status}">${tray.status}</span></p></div>
      <div class="col">
        <a class="btn primary" href="#pack?t=${tray.number}">Pack this tray</a>
        ${tray.status !== 'shipped' ? `<button class="btn ghost" data-act="ship">Mark shipped</button>` : `<button class="btn ghost" data-act="reopen">Reopen</button>`}
        <a class="btn ghost" href="#trays?f=${filter}">Close</a>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Sticker</th><th>Order</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
      ${trayItems.map(i => `<tr><td class="code">${esc(i.code)}</td><td class="code small">${esc(i.orderId)}</td><td><span class="status ${i.status}">${i.status.replace('_', ' ')}</span></td><td class="small muted">${fmtDate(i.packedAt || i.scannedAt || i.createdAt)}</td>
      <td><button class="btn tiny ghost danger" data-act="rm" data-id="${esc(i.id)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No stickers matched to this tray. Add one below.</td></tr>'}
    </tbody></table></div>
    <form id="add-item" class="row wrap"><label class="grow">Add sticker to this tray<input id="add-code" placeholder="TOY0042" autocomplete="off"></label><button class="btn" type="submit">Add</button></form>
  </section>` : ''}
  <section class="tray-grid">
    ${list.map(t => `<a class="tray-tile ${t.status} ${sel === t.number ? 'sel' : ''}" href="#trays?f=${filter}&t=${t.number}">
      <span class="tray-num">${t.number}</span>
      <span class="buyer">${esc(t.buyer)}</span>
      <span class="small muted">${t.packedCount || 0}/${t.itemCount || 0} packed</span>
      <span class="mini-bar"><i style="width:${t.itemCount ? Math.round((t.packedCount || 0) / t.itemCount * 100) : 0}%"></i></span>
    </a>`).join('') || `<p class="muted pad">${trays.length ? 'No trays in this filter.' : 'No trays yet. Import the TikTok labels PDF after your show.'}</p>`}
  </section>`;
  const ordersById = Object.fromEntries(orders.map(o => [o.id, o]));
  const filesById = async () => Object.fromEntries((await db.byIndex('files', 'showId', show.id)).map(f => [f.id, f]));
  $('#dl-labels').onclick = async () => {
    const { bytes, missing } = await reorderedLabelsPdf(trays, ordersById, await filesById());
    if (!bytes) return toast('No shipping label pages were found in the imported PDFs.', 'error');
    saveFile(bytes, `${slug(show.name)}-labels-tray-order.pdf`);
    if (missing.length) toast(`No label for tray${missing.length > 1 ? 's' : ''} ${missing.slice(0, 12).map(t => t.number).join(', ')}${missing.length > 12 ? '…' : ''}`, 'warn');
  };
  $('#dl-slips').onclick = async () => {
    const bytes = await reorderedSlipsPdf(trays, ordersById, await filesById());
    if (!bytes) return toast('No packing slip pages were imported.', 'error');
    saveFile(bytes, `${slug(show.name)}-slips-tray-order.pdf`);
  };
  $('#dl-traylabels').onclick = async () => saveFile(await trayLabelsPdf(trays, state.settings, show.name), `${slug(show.name)}-tray-labels.pdf`);
  view().onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b || !tray) return;
    if (b.dataset.act === 'ship') { tray.status = 'shipped'; tray.shippedAt = Date.now(); await db.put('trays', tray); }
    if (b.dataset.act === 'reopen') { tray.status = 'open'; await db.put('trays', tray); await refreshTrayStatus(show.id, tray.number); }
    if (b.dataset.act === 'rm') { await db.del('items', b.dataset.id); await refreshTrayStatus(show.id, tray.number); }
    viewTrays(params);
  };
  const add = $('#add-item');
  if (add) add.onsubmit = async e => {
    e.preventDefault();
    const code = $('#add-code').value.trim().toUpperCase(); if (!code) return;
    const exist = items.find(i => i.code === code);
    if (exist) return toast(`${code} is already in tray ${exist.trayNumber}.`, 'error');
    await db.put('items', { id: show.id + ':' + code, showId: show.id, code, trayNumber: tray.number, buyer: tray.buyer, orderId: trayOrders[0]?.orderId || '', status: 'sold', createdAt: Date.now() });
    await refreshTrayStatus(show.id, tray.number);
    viewTrays(params);
  };
}

// ---------- Scanning (shared) ----------
function scanBox(placeholder) {
  return `<form class="scan-form" id="scan-form" autocomplete="off">
    <input id="scan-input" class="scan-input" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text">
    <button class="btn" type="submit">Enter</button>
    <button class="btn ghost" type="button" id="cam-btn">Camera</button>
  </form>
  <div class="cam-wrap" id="cam-wrap" hidden><video id="cam-video" muted playsinline></video><div class="cam-line"></div></div>`;
}
function bindScanBox(onCode) {
  const input = $('#scan-input');
  const focus = () => { if (document.activeElement?.tagName !== 'INPUT' || document.activeElement === input) input.focus({ preventScroll: true }); };
  focus();
  $('#scan-form').onsubmit = e => { e.preventDefault(); const v = input.value.trim(); input.value = ''; if (v) onCode(v); };
  $('#cam-btn').onclick = async () => {
    if (state.camera) { stopCamera(); return; }
    $('#cam-wrap').hidden = false;
    state.camera = new CameraScanner($('#cam-video'), onCode);
    try { await state.camera.start(); $('#cam-btn').textContent = 'Stop camera'; }
    catch (err) { stopCamera(); toast(err.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings.' : err.message, 'error'); }
  };
  view().onclick = e => { if (!e.target.closest('button,a,input,label,video')) focus(); };
}
function stopCamera() {
  if (state.camera) state.camera.stop();
  state.camera = null;
  const w = $('#cam-wrap'); if (w) w.hidden = true;
  const b = $('#cam-btn'); if (b) b.textContent = 'Camera';
}
function normalizeCode(raw) { return String(raw).trim().toUpperCase().replace(/\s+/g, ''); }

// ---------- Scan to Tray ----------
async function viewScan() {
  const show = await currentShow();
  if (!show) return needShow('Scan to tray');
  const recent = (await db.byIndex('scans', 'showId', show.id)).filter(s => s.mode === 'tray').sort((a, b) => b.at - a.at).slice(0, 12);
  view().innerHTML = `
  <section class="panel scan-panel">
    <h1>Scan to tray</h1>
    <p class="muted">Scan each sticker. The tray number shows here and is read out loud.</p>
    ${scanBox('Scan or type a sticker code')}
    <div id="result" class="result idle"><span class="muted">Waiting for a scan</span></div>
  </section>
  <section class="panel"><h2>Recent scans</h2><ul class="recent" id="recent">${recent.map(recentRow).join('') || '<li class="muted">None yet</li>'}</ul></section>`;
  bindScanBox(async raw => {
    const code = normalizeCode(raw);
    const items = await db.byIndex('items', 'code', code);
    const it = items.find(i => i.showId === show.id);
    const res = $('#result');
    let result, tray = null;
    if (!it) {
      result = 'unknown';
      res.className = 'result error';
      res.innerHTML = `<span class="label">Not in this show</span><span class="big-code">${esc(code)}</span><span class="muted">This sticker isn't on any imported order. Check the import page, or add it to a tray by hand.</span>`;
      feedback('error', state.settings, 'Not found');
    } else {
      tray = await refreshTrayStatus(show.id, it.trayNumber);
      const already = it.status !== 'sold';
      if (!already) { it.status = 'in_tray'; it.scannedAt = Date.now(); await db.put('items', it); tray = await refreshTrayStatus(show.id, it.trayNumber); }
      result = already ? 'repeat' : 'ok';
      res.className = 'result ' + (already ? 'warn' : 'ok');
      res.innerHTML = `<span class="label">${already ? 'Already scanned · ' : ''}Tray</span><span class="tray-num huge">${it.trayNumber}</span>
        <span class="buyer-big">${esc(it.buyer)}</span><span class="muted">${esc(code)} · ${tray.inTray} of ${tray.itemCount} items in tray</span>`;
      feedback(already ? 'warn' : 'ok', state.settings, `Tray ${it.trayNumber}`);
    }
    await logScan(show.id, code, 'tray', result, it?.trayNumber);
    const ul = $('#recent');
    if (ul) { if (ul.querySelector('.muted')) ul.innerHTML = ''; ul.insertAdjacentHTML('afterbegin', recentRow({ code, result, trayNumber: it?.trayNumber, at: Date.now() })); }
  });
}
function recentRow(s) {
  const label = { ok: 'Tray ' + s.trayNumber, repeat: 'Repeat · tray ' + s.trayNumber, unknown: 'Not found', wrong: 'Wrong tray', packed: 'Packed · tray ' + s.trayNumber }[s.result] || s.result;
  return `<li class="${s.result}"><span class="code">${esc(s.code)}</span><span>${esc(label)}</span><span class="muted small">${fmtDate(s.at)}</span></li>`;
}

// ---------- Scan to Box (pack) ----------
async function viewPack(params) {
  const show = await currentShow();
  if (!show) return needShow('Pack');
  const { trays, items } = await showData(show.id);
  let trayNum = params.get('t') ? +params.get('t') : state.packTray;
  let tray = trays.find(t => t.number === trayNum) || null;
  state.packTray = tray ? tray.number : null;
  const trayItems = tray ? items.filter(i => i.trayNumber === tray.number).sort((a, b) => a.code.localeCompare(b.code)) : [];
  const nextOpen = trays.find(t => t.status === 'open' && (!tray || t.number > tray.number)) || trays.find(t => t.status === 'open' && (!tray || t.number !== tray.number));
  view().innerHTML = `
  <section class="panel scan-panel">
    <h1>Pack</h1>
    <p class="muted">${tray ? 'Scan each item as it goes in the box. Items from another buyer are flagged.' : 'Scan any item from a tray, or type a tray number, to start packing it.'}</p>
    ${scanBox(tray ? 'Scan an item going into the box' : 'Scan an item or type a tray number')}
    <div id="result" class="result idle"><span class="muted">${tray ? 'Packing tray ' + tray.number : 'No tray open'}</span></div>
  </section>
  ${tray ? `<section class="panel">
    <div class="row between wrap">
      <div class="row"><span class="tray-num xl">${tray.number}</span><div><h2>${esc(tray.buyer)}</h2><p class="muted" id="pack-count">${trayItems.filter(i => i.status === 'packed').length} of ${trayItems.length} packed</p></div></div>
      <div class="row wrap">
        <button class="btn ghost" id="pack-all">Mark all packed</button>
        ${nextOpen ? `<a class="btn" href="#pack?t=${nextOpen.number}">Next tray (${nextOpen.number})</a>` : ''}
      </div>
    </div>
    <ul class="checklist">${trayItems.map(i => `<li class="${i.status === 'packed' ? 'done' : ''}" data-code="${esc(i.code)}"><span class="box"></span><span class="code">${esc(i.code)}</span><span class="muted small">${esc(i.orderId)}</span></li>`).join('') || '<li class="muted">No stickers matched to this tray.</li>'}</ul>
  </section>` : ''}`;
  const openTray = n => { location.hash = '#pack?t=' + n; };
  bindScanBox(async raw => {
    const code = normalizeCode(raw);
    const res = $('#result');
    if (/^\d{1,4}$/.test(code) && trays.some(t => t.number === +code)) { openTray(+code); return; }
    const it = (await db.byIndex('items', 'code', code)).find(i => i.showId === show.id);
    if (!it) {
      res.className = 'result error';
      res.innerHTML = `<span class="label">Not in this show</span><span class="big-code">${esc(code)}</span>`;
      feedback('error', state.settings, 'Not found');
      await logScan(show.id, code, 'pack', 'unknown');
      return;
    }
    if (!tray) { openTray(it.trayNumber); return; }
    if (it.trayNumber !== tray.number) {
      res.className = 'result error';
      res.innerHTML = `<span class="label">Wrong buyer</span><span class="big-code">${esc(code)}</span><span class="buyer-big">Belongs in tray ${it.trayNumber} · ${esc(it.buyer)}</span>`;
      feedback('error', state.settings, `Wrong buyer. Tray ${it.trayNumber}`);
      await logScan(show.id, code, 'pack', 'wrong', it.trayNumber);
      return;
    }
    const was = it.status === 'packed';
    it.status = 'packed'; it.packedAt = it.packedAt || Date.now(); it.scannedAt = it.scannedAt || Date.now();
    await db.put('items', it);
    const t = await refreshTrayStatus(show.id, tray.number);
    await logScan(show.id, code, 'pack', was ? 'repeat' : 'packed', tray.number);
    const li = view().querySelector(`li[data-code="${CSS.escape(code)}"]`); if (li) li.classList.add('done');
    $('#pack-count').textContent = `${t.packedCount} of ${t.itemCount} packed`;
    if (t.packedCount === t.itemCount) {
      res.className = 'result ok';
      res.innerHTML = `<span class="label">Tray complete</span><span class="tray-num huge">${tray.number}</span><span class="buyer-big">${esc(tray.buyer)} · seal the box</span>`;
      feedback('done', state.settings, `Tray ${tray.number} complete`);
    } else {
      res.className = 'result ' + (was ? 'warn' : 'ok');
      res.innerHTML = `<span class="label">${was ? 'Already packed' : 'Packed'}</span><span class="big-code">${esc(code)}</span><span class="muted">${t.itemCount - t.packedCount} left for ${esc(tray.buyer)}</span>`;
      feedback(was ? 'warn' : 'ok', state.settings, was ? 'Already packed' : String(t.itemCount - t.packedCount) + ' left');
    }
  });
  const pa = $('#pack-all');
  if (pa) pa.onclick = async () => {
    if (pa.dataset.confirm !== '1') { pa.dataset.confirm = '1'; pa.textContent = 'Tap again to confirm'; return; }
    for (const i of trayItems) if (i.status !== 'packed') { i.status = 'packed'; i.packedAt = Date.now(); await db.put('items', i); }
    await refreshTrayStatus(show.id, tray.number);
    feedback('done', state.settings, `Tray ${tray.number} complete`);
    viewPack(params);
  };
}

// ---------- History ----------
async function viewHistory(params) {
  const q = (params.get('q') || '').trim();
  const shows = await db.all('shows');
  const showName = Object.fromEntries(shows.map(s => [s.id, s.name]));
  let results = [];
  if (q) {
    const ql = q.toLowerCase(), qk = buyerKey(q);
    const [items, trays] = await Promise.all([db.all('items'), db.all('trays')]);
    const trayBy = new Map(trays.map(t => [t.showId + ':' + t.number, t]));
    results = items.filter(i => i.code.toLowerCase().includes(ql) || String(i.orderId).includes(q) || (qk && buyerKey(i.buyer).includes(qk)))
      .map(i => ({ ...i, tray: trayBy.get(i.showId + ':' + i.trayNumber) }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 300);
  }
  view().innerHTML = `
  <section class="panel">
    <h1>History</h1>
    <form id="hist-form" class="row"><input id="hist-q" class="grow" value="${esc(q)}" placeholder="Search buyer, order ID or sticker code"><button class="btn primary">Search</button></form>
  </section>
  ${q ? `<section class="panel"><p class="muted">${results.length} result${results.length === 1 ? '' : 's'}${results.length === 300 ? ' (first 300)' : ''}</p>
  <div class="table-wrap"><table><thead><tr><th>Sticker</th><th>Buyer</th><th>Show</th><th>Tray</th><th>Order</th><th>Status</th><th>Packed</th></tr></thead><tbody>
  ${results.map(r => `<tr><td class="code">${esc(r.code)}</td><td>${esc(r.buyer)}</td><td>${esc(showName[r.showId] || '')}</td><td>${r.trayNumber}</td><td class="code small">${esc(r.orderId)}</td>
    <td><span class="status ${r.tray?.status === 'shipped' ? 'shipped' : r.status}">${r.tray?.status === 'shipped' ? 'shipped' : r.status.replace('_', ' ')}</span></td><td class="small muted">${fmtDate(r.packedAt)}</td></tr>`).join('')}
  </tbody></table></div></section>` : ''}`;
  $('#hist-form').onsubmit = e => { e.preventDefault(); location.hash = '#history?q=' + encodeURIComponent($('#hist-q').value.trim()); };
}

// ---------- Settings / data ----------
async function viewSettings() {
  const s = state.settings;
  const show = await currentShow();
  view().innerHTML = `
  <section class="panel">
    <h1>Settings</h1>
    <form id="set-form" class="grid-form">
      <label>Label width (mm)<input id="s-w" type="number" min="25" max="150" value="${s.labelWidthMm}"></label>
      <label>Label height (mm)<input id="s-h" type="number" min="15" max="150" value="${s.labelHeightMm}"></label>
      <label class="check"><input id="s-voice" type="checkbox" ${s.voice ? 'checked' : ''}> Read tray numbers out loud</label>
      <label class="check"><input id="s-sounds" type="checkbox" ${s.sounds ? 'checked' : ''}> Beeps</label>
      <label class="check"><input id="s-vib" type="checkbox" ${s.vibrate ? 'checked' : ''}> Vibrate (phones)</label>
      <label class="wide">Extra sticker pattern (advanced, optional)<input id="s-re" value="${esc(s.stickerRegex)}" placeholder="e.g. Lot\\s*(\\d+)"><span class="muted small">A regular expression whose first group is the sticker number, for listings named another way.</span></label>
      <button class="btn primary" type="submit">Save settings</button>
    </form>
  </section>
  <section class="panel">
    <h2>Data</h2>
    <p class="muted">Everything is stored on this device only. Back up regularly, and restore the backup on another device to move your data.</p>
    <div class="row wrap">
      ${show ? `<button class="btn" id="csv">Export "${esc(show.name)}" as CSV</button>` : ''}
      <button class="btn" id="backup">Download backup</button>
      <label class="btn ghost file-btn">Restore backup<input id="restore" type="file" accept=".json,application/json"></label>
    </div>
  </section>
  <section class="panel">
    <h2>Install</h2>
    <p class="muted">On Android, open the menu in Chrome and choose <b>Install app</b> or <b>Add to Home screen</b>. On a computer, use the install icon at the right of Chrome's or Edge's address bar.</p>
    <button class="btn" id="install-btn" ${window.__installPrompt ? '' : 'hidden'}>Install ShopOps Pack</button>
  </section>`;
  $('#set-form').onsubmit = async e => {
    e.preventDefault();
    const re = $('#s-re').value.trim();
    if (re) { try { new RegExp(re); } catch (err) { return toast('The sticker pattern is not a valid regular expression.', 'error'); } }
    state.settings = { ...s, labelWidthMm: +$('#s-w').value || 50, labelHeightMm: +$('#s-h').value || 25, voice: $('#s-voice').checked, sounds: $('#s-sounds').checked, vibrate: $('#s-vib').checked, stickerRegex: re };
    await db.saveSettings(state.settings);
    toast('Settings saved', 'ok');
  };
  const csvBtn = $('#csv');
  if (csvBtn) csvBtn.onclick = async () => {
    const { items, trays } = await showData(show.id);
    const tb = new Map(trays.map(t => [t.number, t]));
    const rows = [['Tray', 'Buyer', 'Sticker', 'Order ID', 'Item status', 'Tray status', 'Scanned', 'Packed']];
    items.sort((a, b) => a.trayNumber - b.trayNumber || a.code.localeCompare(b.code)).forEach(i => rows.push([i.trayNumber, i.buyer, i.code, i.orderId, i.status, tb.get(i.trayNumber)?.status || '', i.scannedAt ? new Date(i.scannedAt).toISOString() : '', i.packedAt ? new Date(i.packedAt).toISOString() : '']));
    const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    saveFile(new TextEncoder().encode('﻿' + csv), `${slug(show.name)}.csv`, 'text/csv');
  };
  $('#backup').onclick = async () => {
    const data = await db.exportBackup();
    saveFile(new TextEncoder().encode(JSON.stringify(data)), `shopops-pack-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  };
  $('#restore').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      await db.importBackup(JSON.parse(await readText(f)));
      state.settings = await db.getSettings();
      setShow(null); await updateShowLabel();
      toast('Backup restored', 'ok'); location.hash = '#shows';
    } catch (err) { toast(err.message, 'error'); }
  };
  const ib = $('#install-btn');
  if (ib) ib.onclick = async () => { const p = window.__installPrompt; if (!p) return; p.prompt(); await p.userChoice; window.__installPrompt = null; ib.hidden = true; };
}

// ---------- Router ----------
const routes = { shows: viewShows, stickers: viewStickers, import: viewImport, trays: viewTrays, scan: viewScan, pack: viewPack, history: viewHistory, settings: viewSettings };
async function route() {
  stopCamera();
  view().onclick = null;
  const [name, qs] = (location.hash.slice(1) || (state.showId ? 'trays' : 'shows')).split('?');
  const fn = routes[name] || viewShows;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + name));
  try { await fn(new URLSearchParams(qs || '')); }
  catch (err) { console.error(err); view().innerHTML = `<section class="panel"><h1>Something went wrong</h1><p>${esc(err.message)}</p></section>`; }
  window.scrollTo(0, 0);
}

async function boot() {
  state.settings = await db.getSettings();
  let saved = null; try { saved = localStorage.getItem('currentShow'); } catch (e) { /* ignore */ }
  if (saved && await db.get('shows', saved)) state.showId = saved;
  await updateShowLabel();
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; });
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}
boot();
