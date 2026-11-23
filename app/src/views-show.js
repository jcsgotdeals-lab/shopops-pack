// Screens for one show: dashboard, sort into trays, trays, pack boxes, courier handover,
// overview and scan history.
import * as db from './db.js';
import { S, openShow, rebuild, ev, undoLast, prefs, hideRev, scanBoxHtml, bindScan, setShowId } from './ctx.js';
import {
  counts, pct, pctFloor, resolve, trayForLabel, FLAGGED, STATUS_LABEL, people, methods, timeline, problemSummary,
  PROBLEM_RESULTS, TYPE_LABEL, RESULT_LABEL, METHOD_LABEL, busyMs, perHour,
} from './state.js';
import { $, $$, esc, view, at, toast, fmtTime, fmtDay, fmtDateStr, fmtWhen, ago, dur, money, nf, modal, confirmTap, saveFile, printPdf, readFile } from './ui.js';
import { feedback } from './feedback.js';
import { trayOrderPdf, trayLabelsPdf } from './labels.js';
import { parseLabelsOnly } from './importer.js';
import { qrSvg } from './qr.js';

// ---------- shared bits ----------
export function noShow(title) {
  view().innerHTML = `<section class="panel empty"><h1>${esc(title)}</h1>
    <p class="muted">${S.owner ? 'Import a show first, or pick one.' : 'Pick the show you are packing.'}</p>
    <div class="row center wrap">${S.owner ? '<a class="btn primary" href="#import">Pack a finished show</a>' : ''}<button class="btn" id="pick-show">Pick a show</button></div></section>`;
  $('#pick-show').onclick = () => showPicker();
}
export function showPicker() {
  const list = db.shows().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 60);
  const m = modal(`<div class="modal-head"><h2>Pick a show</h2><button class="icon-btn" data-close>✕</button></div>
    <input class="grow" id="sp-q" placeholder="Search shows">
    <ul class="pick-list">${list.map(s => `<li><button data-id="${esc(s.id)}"><b>${esc(s.name)}</b><span class="muted small">${fmtDateStr(s.date)} · ${s.sum ? s.sum.trays : s.trayCount || 0} trays · ${s.sum ? s.sum.items : s.itemCount || 0} items</span></button></li>`).join('') || '<li class="muted">No shows yet.</li>'}</ul>`);
  $('#sp-q', m).oninput = e => { const q = e.target.value.toLowerCase(); $$('.pick-list li', m).forEach(li => { li.hidden = !li.textContent.toLowerCase().includes(q); }); };
  $$('[data-id]', m).forEach(b => { b.onclick = () => { setShowId(b.dataset.id); m.close(); if (/^#show\//.test(location.hash)) location.hash = '#show/' + b.dataset.id + '/' + (location.hash.split('/')[2] || 'overview'); else window.dispatchEvent(new HashChangeEvent('hashchange')); }; });
}
function banner(kind, html) { const r = $('#result'); if (r) { r.className = 'result ' + kind; r.innerHTML = html; } }
function trayTile(t, mode) {
  const done = mode === 'pack' ? t.boxDone : t.sortState === 'complete';
  const n = mode === 'pack' ? t.packed : t.inTray;
  const cls = mode === 'pack' ? (t.boxDone ? 'complete' : t.packed ? 'progress' : 'not') : t.sortState;
  return `<button class="tray-tile ${cls}" data-tray="${t.n}">
    <span class="tt-num">${t.n}</span>${done ? '<span class="tt-check">✓</span>' : ''}
    <span class="tt-buyer">${esc(at(t.buyer))}</span>
    <span class="tt-count">${n}/${t.total} ${mode === 'pack' ? 'packed' : 'scanned'}</span>
    ${hideRev() ? '' : `<span class="tt-money">${money(t.list.reduce((s, i) => s + (+i.price || 0), 0))}</span>`}
    <span class="tt-bar"><i style="width:${pct(n, t.total)}%"></i></span></button>`;
}
function itemRow(it) {
  return `<li class="item-row st-${it.status}">
    <span class="chip num">#${it.num ?? '?'}</span>
    <div class="grow"><div>${esc(it.title || 'Item')}</div>
      <div class="muted small">${it.trayAt ? 'Scanned ' + fmtTime(it.trayAt) + (it.trayBy ? ' · ' + esc(it.trayBy) : '') : 'Not scanned yet'}${it.packedAt ? ' · packed ' + fmtTime(it.packedAt) : ''}</div>
      <span class="status-pill st-${it.status}">${STATUS_LABEL[it.status]}</span></div>
    ${hideRev() ? '' : `<span class="small">${money(+it.price || 0)}</span>`}
    <div class="menu-wrap"><button class="icon-btn" data-item-menu="${esc(it.id)}" aria-label="Item options">⋯</button></div></li>`;
}
export function openTrayDrawer(n) {
  const draw = () => {
    const t = S.cur.st.trays.get(n);
    if (!t) return '';
    return `<div class="modal-head"><div><h2>Tray ${t.n}</h2><div class="muted">${esc(at(t.buyer))} · ${t.total} items${hideRev() ? '' : ' · ' + money(t.list.reduce((s, i) => s + (+i.price || 0), 0))}</div>
      <div class="row wrap gap-s"><span class="pill ${t.sortState === 'complete' ? 'ok' : ''}">${t.inTray}/${t.total} scanned</span><span class="pill ${t.boxDone ? 'ok' : ''}">${t.packed}/${t.total} packed</span>${t.handed ? '<span class="pill ok">Handed over</span>' : ''}</div></div>
      <button class="icon-btn" data-close>✕</button></div>
      <ul class="item-list">${t.list.map(itemRow).join('')}</ul>
      <div class="row wrap gap-s"><a class="btn" href="#show/${esc(S.cur.id)}/pack?t=${t.n}" data-close>Pack this box</a>${S.owner ? '<button class="btn ghost" id="tray-label">Print tray label</button>' : ''}</div>`;
  };
  const m = modal(draw(), 'drawer');
  const bind = () => {
    $$('[data-item-menu]', m).forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        $$('.item-menu', m).forEach(x => x.remove());
        const it = S.cur.st.items.get(b.dataset.itemMenu);
        const menu = document.createElement('div');
        menu.className = 'item-menu';
        const opts = [['cancelled', 'Mark as cancelled'], ['damaged', 'Mark as damaged'], ['missing', 'Mark as missing'], ['floor', 'Mark as on the floor'], ['pending', 'Back to not scanned']]
          .filter(([s]) => s !== it.status);
        menu.innerHTML = opts.map(([s, l]) => `<button data-st="${s}">${l}</button>`).join('');
        b.parentElement.appendChild(menu);
        $$('[data-st]', menu).forEach(x => { x.onclick = () => { ev({ ty: 'status', s: x.dataset.st, it: it.id, tr: it.tray, r: 'ok', m: 'tap' }); m.querySelector('.modal').innerHTML = draw(); bind(); S.refresh && S.refresh(); }; });
      };
    });
    const tl = $('#tray-label', m);
    if (tl) tl.onclick = async () => { printPdf(await trayLabelsPdf([S.cur.st.trays.get(n)], db.getShow(S.cur.id).name), `tray-${n}.pdf`); };
  };
  bind();
  return m;
}
export function phoneModal() {
  const url = location.origin + location.pathname;
  const code = db.team()?.code;
  const m = modal(`<div class="modal-head"><h2>Scan with your phone</h2><button class="icon-btn" data-close>✕</button></div>
    <p class="muted">Whose phone are you setting up?</p>
    <div class="choice-row"><button class="choice on" data-who="me"><b>My phone</b><span class="muted small">Sign in with your own login</span></button>
    <button class="choice" data-who="packer"><b>A packer's phone</b><span class="muted small">They join your team with their own login</span></button></div>
    <div class="qr-row" id="qr-box"></div>
    <p class="muted small center">Already signed in on your phone? Just open the app — this show is there.</p>`);
  const draw = who => {
    $$('.choice', m).forEach(c => c.classList.toggle('on', c.dataset.who === who));
    const link = who === 'packer' && code ? `${url}?join=${encodeURIComponent(code)}` : url;
    $('#qr-box', m).innerHTML = `<div class="qr-card">${qrSvg(link, 190)}</div>
      <ol class="steps-list"><li>Point the phone's camera at this code</li><li>Open the link${who === 'packer' ? ', type their name and tap Join' : ' and sign in'}</li>
      <li>Tap <b>Install app</b> (Android: ⋮ menu → Install app), or use the Android app</li>${who === 'packer' ? '<li>You tap <b>Approve</b> on the Team page. Done.</li>' : ''}</ol>
      ${who === 'packer' ? `<p class="muted small">Or type this team code in the app: <b class="code">${esc(code || '—')}</b></p>` : ''}
      <p class="small"><a href="https://github.com/jcsgotdeals-lab/shopops-pack/releases/latest/download/JC-Got-Trays.apk">Download the Android app (APK)</a></p>`;
  };
  $$('.choice', m).forEach(c => { c.onclick = () => draw(c.dataset.who); });
  draw('me');
}

// ---------- Dashboard (phone home) ----------
export async function viewDash() {
  const s = S.showId && db.getShow(S.showId);
  if (!s) return noShow('Dashboard');
  await openShow(s.id);
  const draw = () => {
    const st = S.cur.st, c = counts(st);
    const overall = pct(c.inTray + c.packed, c.items * 2);
    const segs = [['pending', c.pending, 'grey'], ['in_tray', c.trayOnly, 'amber'], ['packed', c.packed, 'green'], ['damaged', c.damaged, 'red'], ['missing', c.missing, 'orange'], ['floor', c.floor, 'purple']];
    const code = db.team()?.code;
    view().innerHTML = `
    <div class="dash">
      ${S.owner && code ? `<button class="pill-btn" id="invite"><span>Team code</span> <b>${esc(code)}</b> · <span class="accent">Invite</span></button>` : S.me ? `<div class="pill-btn">Packing as <b>${esc(S.me.name)}</b></div>` : ''}
      <button class="card show-card" id="switch"><span class="label">Show</span><b class="big">${esc(s.name)}</b><span class="swap">⇄</span></button>
      <a class="card handover-card" href="#show/${esc(s.id)}/handover"><span class="ico">🚚</span><div><b>Courier handover</b><div>${c.handed}/${c.trays} parcels handed over</div><div class="muted small">Scan each parcel as it goes to the courier</div></div><span>›</span></a>
      <div class="tiles three">
        <div class="tile"><span class="label">Items</span><b>${nf(c.items)}</b></div>
        <div class="tile"><span class="label">In tray</span><b class="amber">${pctFloor(c.inTray, c.items)}%</b><span class="muted">${c.inTray}/${c.items}</span></div>
        <div class="tile"><span class="label">Packed</span><b class="green">${pctFloor(c.packed, c.items)}%</b><span class="muted">${c.packed}</span></div>
      </div>
      <div class="tiles two">
        <div class="tile"><span class="label">Trays</span><b>${c.trays}</b></div>
        <div class="tile"><span class="label">Problems</span><b>${c.problems}</b></div>
      </div>
      <div class="card ring-card">
        <div class="ring" style="--p:${overall}"><div><b>${overall}%</b><span>Overall</span></div></div>
        <div class="grow"><div class="bar-line"><span>Scan to Tray</span><b class="amber">${pctFloor(c.inTray, c.items)}%</b></div><div class="bar"><i class="amber" style="width:${pct(c.inTray, c.items)}%"></i></div>
        <div class="bar-line"><span>Scan to Box</span><b class="green">${pctFloor(c.packed, c.items)}%</b></div><div class="bar"><i class="green" style="width:${pct(c.packed, c.items)}%"></i></div></div>
      </div>
      <div class="card"><h3>Item status</h3>
        <div class="stack-bar">${segs.map(([k, n, col]) => (n ? `<i class="${col}" style="flex:${n}"></i>` : '')).join('')}</div>
        <div class="status-grid">${segs.map(([k, n, col]) => `<span><i class="dot ${col}"></i>${STATUS_LABEL[k]}</span><b>${n}</b>`).join('')}${c.cancelled ? `<span><i class="dot"></i>Cancelled</span><b>${c.cancelled}</b>` : ''}</div>
      </div>
      ${S.owner ? `<div class="quick-links"><a href="#shows">All shows</a><a href="#import">Import a show</a><a href="#labels">Pre-show labels</a><a href="#analytics">Analytics</a><a href="#team">Team</a></div>` : ''}
    </div>`;
    $('#switch').onclick = () => showPicker();
    const inv = $('#invite'); if (inv) inv.onclick = () => phoneModal();
  };
  draw();
  S.refresh = () => { rebuild(); draw(); };
}

// ---------- Show page (desktop) ----------
function showHeader(s, tab) {
  const st = S.cur.st, c = counts(st);
  const sortPct = pctFloor(c.inTray, c.items);
  const packLabel = c.boxesDone >= c.trays && c.trays ? 'Done' : c.boxesDone || c.packed ? `${c.boxesDone}/${c.trays} boxes` : 'Not started';
  const steps = [
    ['overview', '▦', 'Overview', 'Summary'],
    ['sort', '1', 'Sort into trays', `${sortPct}%${c.items - c.inTray > 0 && c.inTray ? ' · ' + (c.items - c.inTray) + ' to go' : ''}`],
    ['pack', '2', 'Pack & ship', packLabel],
  ];
  const on = tab === 'labels' || tab === 'handover' ? 'pack' : tab === 'trays' ? 'sort' : tab;
  return `<div class="show-top">
    <a class="back desk" href="#shows">← All shows</a>
    <div class="steps">${steps.map(([k, n, l, sub]) => `<a class="step ${on === k ? 'on' : ''}" href="#show/${esc(s.id)}/${k}"><span class="step-n">${n}</span><span><b>${l}</b><span class="small">${sub}</span></span></a>`).join('<span class="step-line"></span>')}</div>
    <div class="row gap-s"><a class="help-link desk" href="#help">Get help with this show</a>
      <div class="menu-wrap"><button class="icon-btn" id="show-menu" aria-label="More">⋯</button></div></div>
  </div>
  <div class="row between wrap show-title">
    <div><div class="muted small">${fmtDateStr(s.date)} · ${s.platform === 'whatnot' ? 'Whatnot' : 'TikTok Shop'} · Imported ${ago(s.createdAt)}</div><h1>${esc(s.name)}</h1></div>
    ${S.owner ? `<div class="split"><button class="btn accent" id="print-main">⬇ Print Labels + Slips</button><button class="btn accent" id="print-more" aria-label="More print options">▾</button></div>` : ''}
  </div>`;
}
function bindShowHeader(s) {
  const sm = $('#show-menu');
  if (sm) sm.onclick = e => {
    e.stopPropagation();
    const old = $('.item-menu.show-m'); if (old) { old.remove(); return; }
    const menu = document.createElement('div'); menu.className = 'item-menu show-m';
    menu.innerHTML = `<a href="#show/${esc(s.id)}/scans"><b>Scan history</b><span class="small muted">Every scan on this show — who, when and what happened.</span></a>
      ${S.owner ? `<button id="m-traylabels"><b>Tray labels</b><span class="small muted">A 6×4 label per tray: big tray number, buyer and item count.</span></button>
      <button id="m-csv"><b>Export CSV</b><span class="small muted">Every item, its tray and status.</span></button>
      <button id="m-del" class="danger"><b>Delete show</b></button>` : ''}`;
    sm.parentElement.appendChild(menu);
    document.addEventListener('click', () => menu.remove(), { once: true });
    const tl = $('#m-traylabels'); if (tl) tl.onclick = async () => printPdf(await trayLabelsPdf([...S.cur.st.trays.values()], s.name), `${s.name} tray labels.pdf`);
    const cv = $('#m-csv'); if (cv) cv.onclick = () => exportCsv(s);
    const dl = $('#m-del');
    if (dl) { dl.onclick = ev2 => { ev2.stopPropagation(); confirmTap(dl, 'Tap again to delete this show for everyone', async () => { await db.deleteShow(s.id); if (S.showId === s.id) setShowId(null); toast('Show deleted', 'ok'); location.hash = '#shows'; }); dl.click(); }; }
  };
  const pm = $('#print-main'); if (pm) pm.onclick = () => printShow(s, 'both');
  const pmore = $('#print-more');
  if (pmore) pmore.onclick = e => {
    e.stopPropagation();
    const old = $('.item-menu.print-m'); if (old) { old.remove(); return; }
    const menu = document.createElement('div'); menu.className = 'item-menu print-m';
    menu.innerHTML = `<button data-p="both"><b>Labels + slips</b><span class="small muted">Label then packing slip per buyer, ordered by tray.</span></button>
      <button data-p="labels"><b>Shipping labels</b><span class="small muted">Just the address labels, ordered by tray.</span></button>
      <button data-p="slips"><b>Packing slips</b><span class="small muted">Just the packing slips, ordered by tray.</span></button>
      <button data-p="tray"><b>Tray labels</b><span class="small muted">One 6×4 label per tray: tray number, buyer and item count.</span></button>`;
    pmore.parentElement.appendChild(menu);
    document.addEventListener('click', () => menu.remove(), { once: true });
    $$('[data-p]', menu).forEach(b => { b.onclick = () => (b.dataset.p === 'tray' ? trayLabelsPdf([...S.cur.st.trays.values()], s.name).then(x => printPdf(x, `${s.name} tray labels.pdf`)) : printShow(s, b.dataset.p)); });
  };
}
async function printShow(s, mode) {
  toast('Preparing the PDF…');
  try {
    const files = await db.showFiles(s.id);
    const trays = [...S.cur.st.trays.values()].sort((a, b) => a.n - b.n);
    const ordersById = Object.fromEntries(S.cur.data.orders.map(o => [o.orderId, o]));
    const { bytes, missing } = await trayOrderPdf(trays, ordersById, files, mode, { itemCount: prefs().itemCount });
    if (!bytes) return toast(mode === 'slips' ? 'No packing slips were found for this show.' : 'No shipping labels yet. Add the labels PDF on Pack & ship → Labels.', 'error');
    saveFile(bytes, `${s.name} ${mode === 'labels' ? 'shipping labels' : mode === 'slips' ? 'packing slips' : 'labels + slips'}.pdf`);
    if (missing.length) toast(`${missing.length} tray(s) had no ${mode === 'slips' ? 'slip' : 'label'}: ${missing.slice(0, 8).map(t => t.n).join(', ')}`, 'error');
  } catch (err) { console.error(err); toast('Could not build the PDF: ' + err.message, 'error'); }
}
function exportCsv(s) {
  const st = S.cur.st;
  const rows = [['Tray', 'Buyer', 'Sticker', 'Item', 'Order ID', 'Status', 'Into tray', 'Packed', 'Box done', 'Handed over']];
  [...st.trays.values()].sort((a, b) => a.n - b.n).forEach(t => t.list.forEach(i => rows.push([t.n, t.buyer, i.num ?? '', i.title, i.orderId, STATUS_LABEL[i.status], i.trayAt ? new Date(i.trayAt).toLocaleString() : '', i.packedAt ? new Date(i.packedAt).toLocaleString() : '', t.boxDone ? 'yes' : '', t.handed ? 'yes' : ''])));
  const csv = rows.map(r => r.map(v => { const x = String(v ?? ''); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }).join(',')).join('\r\n');
  saveFile(new TextEncoder().encode('﻿' + csv), `${s.name}.csv`, 'text/csv');
}

export async function viewShow(id, tab, params) {
  const s = db.getShow(id);
  if (!s) { view().innerHTML = '<section class="panel empty"><h1>Show not found</h1><p class="muted">It may have been deleted.</p><a class="btn" href="#shows">All shows</a></section>'; return; }
  if (S.showId !== id) setShowId(id);
  view().innerHTML = '<section class="panel"><p class="muted">Loading show…</p></section>';
  await openShow(id);
  const fn = { overview: tabOverview, sort: tabSort, trays: tabTrays, pack: tabPack, labels: tabLabels, handover: tabHandover, scans: tabScans }[tab] || tabOverview;
  await fn(s, params);
}

// ---------- Overview ----------
async function tabOverview(s) {
  const draw = () => {
    const st = S.cur.st, c = counts(st);
    const left = c.items - c.inTray;
    const waiting = [...st.trays.values()].filter(t => t.sortState !== 'complete');
    const flagged = [...st.items.values()].filter(i => FLAGGED.includes(i.status));
    let next;
    if (left > 0) next = ['Sort into trays', `${left} item${left === 1 ? '' : 's'} still to scan into trays`, `${c.inTray} of ${c.items} scanned into trays`, pct(c.inTray, c.items), 'sort', 'Continue scanning'];
    else if (c.boxesDone < c.trays) next = ['Pack & ship', `${c.trays - c.boxesDone} box${c.trays - c.boxesDone === 1 ? '' : 'es'} still to pack`, `${c.boxesDone} of ${c.trays} boxes packed`, pct(c.boxesDone, c.trays), 'pack', 'Continue packing'];
    else if (c.handed < c.trays) next = ['Courier handover', `${c.trays - c.handed} parcel${c.trays - c.handed === 1 ? '' : 's'} still to hand over`, `${c.handed} of ${c.trays} handed over`, pct(c.handed, c.trays), 'handover', 'Scan parcels'];
    else next = ['All done', 'Every parcel is with the courier', `${c.trays} parcels`, 100, 'scans', 'See scan history'];
    view().innerHTML = showHeader(s, 'overview') + `
    <div class="kpis"><span><b>${nf(c.items)}</b> sales</span><span><b>${c.buyers}</b> buyers</span><span><b>${pctFloor(c.inTray, c.items)}%</b> sorted</span><span><b>${c.boxesDone}/${c.trays}</b> boxes packed</span></div>
    <div class="ov-grid">
      <div>
        <div class="next-card"><div><span class="label">${esc(next[0])}</span><h2>${esc(next[1])}</h2><div class="bar dark"><i style="width:${next[3]}%"></i></div><span class="small">${esc(next[2])}</span></div>
          <a class="btn dark" href="#show/${esc(s.id)}/${next[4]}">${esc(next[5])}</a></div>
        <h3>Needs a look</h3>
        <ul class="look-list">
          ${waiting.length && c.inTray ? `<li><i class="dot blue"></i><div class="grow"><b>${waiting.length} tray${waiting.length === 1 ? ' is' : 's are'} still waiting for items</b><div class="muted small">Scan the rest of the items, or check what is missing.</div></div><a href="#show/${esc(s.id)}/trays?f=open">Review</a></li>` : ''}
          ${flagged.length ? `<li><i class="dot red"></i><div class="grow"><b>${flagged.length} item${flagged.length === 1 ? '' : 's'} marked damaged, missing or on the floor</b><div class="muted small">${flagged.slice(0, 6).map(i => '#' + (i.num ?? '?') + ' (tray ' + i.tray + ')').join(', ')}</div></div><a href="#show/${esc(s.id)}/trays">Review</a></li>` : ''}
          ${!s.hasLabels ? `<li><i class="dot amber"></i><div class="grow"><b>No shipping labels yet</b><div class="muted small">Add the labels PDF to print them in tray order.</div></div><a href="#show/${esc(s.id)}/labels">Add</a></li>` : ''}
          ${s.noNumber ? `<li><i class="dot amber"></i><div class="grow"><b>${s.noNumber} order${s.noNumber === 1 ? '' : 's'} had no sticker number</b><div class="muted small">They're in trays as "Item without a sticker number" — tick them off by hand.</div></div><a href="#show/${esc(s.id)}/trays">Review</a></li>` : ''}
          ${!(waiting.length && c.inTray) && !flagged.length && s.hasLabels && !s.noNumber ? '<li class="muted">Nothing needs a look right now.</li>' : ''}
        </ul>
      </div>
      <div class="side-steps">
        <a class="card" href="#show/${esc(s.id)}/sort"><span class="small muted">${c.inTray >= c.items ? 'Done' : c.inTray ? 'In progress · ' + pctFloor(c.inTray, c.items) + '%' : 'Not started'}</span><b>Sort into trays</b><div class="bar"><i class="amber" style="width:${pct(c.inTray, c.items)}%"></i></div><span class="small">${c.inTray} of ${c.items} items scanned</span><span class="small muted">Open the tray grid, search a buyer, or reprint a label.</span></a>
        <a class="card" href="#show/${esc(s.id)}/pack"><span class="small muted">${c.boxesDone >= c.trays ? 'Done' : c.packed ? 'In progress' : 'Ready when you are'}</span><b>Pack & ship</b><div class="bar"><i class="green" style="width:${pct(c.packed, c.items)}%"></i></div><span class="small">${c.packed} of ${c.items} items packed</span><span class="small muted">${c.traysComplete} trays are complete and can be packed now.</span></a>
        <a class="card" href="#show/${esc(s.id)}/handover"><span class="small muted">${c.handed ? c.handed >= c.trays ? 'Done' : 'In progress' : 'Not started'}</span><b>Courier handover</b><div class="bar"><i class="blue" style="width:${pct(c.handed, c.trays)}%"></i></div><span class="small">${c.handed} of ${c.trays} parcels handed over</span><span class="small muted">Scan each parcel as it goes in the courier's sack — so nothing gets left behind.</span></a>
      </div>
    </div>
    <h2 class="section-title">Show report</h2>
    <div id="report">${showReport(s, S.cur.st)}</div>`;
    bindShowHeader(s);
  };
  draw();
  S.refresh = () => { rebuild(); draw(); };
}

// The per-show report (also used on Analytics)
export function showReport(s, st) {
  const c = counts(st);
  const evs = st.events.filter(e => !st.undone.has(e.i));
  const tl1 = timeline(evs, 'tray'), tl2 = timeline(evs, 'box');
  const ppl = people(evs);
  const probs = problemSummary(evs, st.undone);
  const meth = methods(evs);
  const methTotal = Object.values(meth).reduce((a, b) => a + b, 0);
  const trays = [...st.trays.values()];
  const buyers = new Map();
  trays.forEach(t => { const b = buyers.get(t.buyerKey) || { buyer: t.buyer, trays: [], n: 0, rev: 0 }; b.trays.push(t.n); b.n += t.total; b.rev += t.list.reduce((x, i) => x + (+i.price || 0), 0); buyers.set(t.buyerKey, b); });
  const top = [...buyers.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  const multi = [...buyers.values()].filter(b => b.n > 1).length;
  const phase = (title, tl, col) => `<div class="phase"><span><i class="dot ${col}"></i><b>${title}</b></span>${tl ? `<span class="small">${fmtWhen(tl.first)} – ${fmtWhen(tl.last)}</span><b class="big">${perHour(tl.count, tl.busy)} an hour</b><span class="small muted">items ${title === 'Sorting into trays' ? 'into trays' : 'into boxes'} · busy for ${dur(tl.busy)}</span>` : '<span class="muted small">Not started yet</span>'}</div>`;
  const bars = (tl, col) => {
    if (!tl) return '';
    const max = Math.max(...tl.bars.map(b => b.n), 1);
    return `<div class="chart"><div class="chart-head"><span><i class="dot ${col}"></i>${col === 'purple' ? 'Sorted' : 'Packed'}</span><span class="muted small">each bar = 10 min</span></div>
      <div class="bars">${tl.bars.map(b => `<i class="${col}" style="height:${Math.max(2, (b.n / max) * 100)}%" title="${fmtTime(b.t)}: ${b.n}"></i>`).join('')}</div>
      <div class="bar-axis"><span>${fmtTime(tl.bars[0].t)}</span><span>${fmtTime(tl.bars[tl.bars.length - 1].t)}</span></div></div>`;
  };
  return `<div class="tiles six">
    <div class="tile"><span class="label">Items sold</span><b>${nf(c.items)}</b></div>
    <div class="tile"><span class="label">Sales</span><b>${money(c.revenue, hideRev())}</b><span class="muted small">avg ${money(c.items ? c.revenue / c.items : 0, hideRev())}</span></div>
    <div class="tile"><span class="label">Buyers</span><b>${c.buyers}</b><span class="muted small">${c.buyers ? (c.items / c.buyers).toFixed(1) : 0} items each on average</span></div>
    <div class="tile"><span class="label">Sorted into trays</span><b>${pctFloor(c.inTray, c.items)}%</b><div class="bar"><i class="green" style="width:${pct(c.inTray, c.items)}%"></i></div><span class="muted small">${c.inTray} of ${c.items} items</span></div>
    <div class="tile"><span class="label">Packed</span><b>${pctFloor(c.boxesDone, c.trays)}%</b><span class="muted small">${c.boxesDone} of ${c.trays} boxes done</span></div>
    <div class="tile"><span class="label">Problem scans</span><b class="${c.problems ? 'red' : 'green'}">${c.problems}</b><span class="muted small">${c.problems ? 'Needs a look' : 'No problems'}</span></div>
  </div>
  <div class="card"><h3>How the show went</h3>
    <div class="phases"><div class="phase"><span><i class="dot grey"></i><b>Selling</b></span><span class="muted small">${s.platform === 'whatnot' ? 'Not tracked' : 'TikTok doesn\'t share live sales — stickers are matched after the show'}</span></div>
    ${phase('Sorting into trays', tl1, 'purple')}${phase('Packing into boxes', tl2, 'green')}</div>
    ${bars(tl1, 'purple')}${bars(tl2, 'green')}
  </div>
  ${ppl.length ? `<div class="card"><h3>Who did what</h3><p class="muted small">Each packer login, and each named phone on your own login, separately.</p>
    <table class="tbl"><thead><tr><th>Person</th><th>Into trays</th><th>Into boxes</th><th>Busy time</th><th>Problems</th><th>How they scanned</th></tr></thead><tbody>
    ${ppl.map(p => `<tr><td><span class="avatar">${esc(p.name.slice(0, 2).toUpperCase())}</span> <b>${esc(p.name)}</b><div class="muted small">${p.kind === 'packer' ? 'Packer login' : p.kind === 'phone' ? 'Named phone' : 'Your login'}</div></td>
      <td><b>${p.tray}</b><div class="muted small">${p.trayRate ? p.trayRate + ' an hour' : ''}</div></td><td><b>${p.box || '—'}</b><div class="muted small">${p.boxRate ? p.boxRate + ' an hour' : ''}</div></td>
      <td>${dur(p.busy)}</td><td>${p.problems}</td><td class="small">${Object.entries(p.methods).map(([k, v]) => `${METHOD_LABEL[k] || k} ${pct(v, Object.values(p.methods).reduce((a, b) => a + b, 0))}%`).join('<br>')}</td></tr>`).join('')}
    </tbody></table><p class="muted small">Rates count only the time someone was actually scanning: gaps over 10 minutes (breaks) are left out.</p></div>` : ''}
  <div class="two-col">
    <div class="card"><h3>Problems</h3>${Object.keys(probs).length ? `<ul class="plain">${Object.entries(probs).map(([k, n]) => `<li><b>${n}</b> ${PROBLEM_RESULTS[k]}<div class="muted small">${{ dup: 'An item that was already placed was scanned again. Harmless.', notfound: "A sticker that isn't on any order in this show.", ambiguous: 'A number that matches more than one item — scan the barcode instead of typing.', wrong: 'An item scanned into the wrong box.', mismatch: "A postage label that didn't belong to the open box.", incomplete: 'A box finished with items still missing.', skipped: 'A tray skipped while packing.' }[k] || ''}</div></li>`).join('')}</ul>` : '<p class="green small">No problem scans on this show.</p>'}</div>
    <div class="card"><h3>Top buyers</h3><p class="muted small">${multi} of ${buyers.size} buyers bought more than one item</p>
      <ol class="top-list">${top.map(b => `<li><b>${esc(String(b.buyer).replace(/^@/, ''))}</b><span class="muted small">Tray ${b.trays.join(', ')}</span><span>${b.n} items</span><span>${money(b.rev, hideRev())}</span></li>`).join('')}</ol></div>
  </div>
  <div class="card"><h3>How items are scanned</h3>${methTotal ? Object.entries(meth).map(([k, n]) => `<div class="bar-line"><span>${METHOD_LABEL[k] || k}</span><span>${n} · ${pct(n, methTotal)}%</span></div><div class="bar"><i class="${k === 'camera' ? 'orange' : k === 'scanner' ? 'blue' : 'green'}" style="width:${pct(n, methTotal)}%"></i></div>`).join('') : '<p class="muted small">No scans yet.</p>'}</div>`;
}

// ---------- Sort into trays ----------
async function tabSort(s) {
  const recent = [];
  const draw = () => {
    const st = S.cur.st, c = counts(st);
    view().innerHTML = showHeader(s, 'sort') + `
    <section class="panel scan-panel">
      <div class="row between wrap"><div><h2 id="sort-count">${nf(c.inTray)} of ${nf(c.items)} scanned</h2><div class="bar wide"><i class="amber" id="sort-bar" style="width:${pct(c.inTray, c.items)}%"></i></div><span class="muted small" id="pack-count">${c.packed}/${c.items} packed</span></div>
      ${S.owner ? '<button class="btn dark desk" id="phone-btn">📱 Scan with your phone</button>' : ''}</div>
      ${scanBoxHtml('Scan barcode or type item name…', { undoMenu: S.owner })}
      <div id="result" class="result idle"><span class="muted">Scan a sticker to see its tray.</span></div>
      <ul class="recent mob" id="recent"></ul>
    </section>
    <div class="row between wrap desk"><h2>Trays · ${c.trays}</h2><input id="tray-q" class="search" placeholder="Search by username, tray number, sticker…"></div>
    <div class="tray-grid desk" id="grid"></div>`;
    bindShowHeader(s);
    drawGrid();
    drawRecent();
    bindScan(onScan);
    const pb = $('#phone-btn'); if (pb) pb.onclick = phoneModal;
    $('#undo-btn').onclick = () => {
      const orig = undoLast();
      if (!orig) return toast('Nothing to undo yet');
      banner('warn', `<span class="label">Undone</span><span class="big-code">#${esc(S.cur.st.items.get(orig.it)?.num ?? orig.c ?? '')}</span><span class="muted">Back to not scanned</span>`);
      updateNumbers();
    };
    const um = $('#undo-more');
    if (um) um.onclick = e => {
      e.stopPropagation();
      const old = $('.item-menu.undo-m'); if (old) { old.remove(); return; }
      const menu = document.createElement('div'); menu.className = 'item-menu undo-m';
      menu.innerHTML = '<button id="reset-all" class="danger"><b>Undo all / reset trays…</b><span class="small muted">Set every scanned item back to unscanned.</span></button>';
      um.parentElement.appendChild(menu);
      const rb = $('#reset-all');
      rb.onclick = ev2 => { ev2.stopPropagation(); confirmTap(rb, 'Tap again: reset every tray in this show', () => { ev({ ty: 'reset', r: 'ok' }); menu.remove(); toast('All trays reset', 'ok'); S.refresh(); }); rb.click(); };
      document.addEventListener('click', () => menu.remove(), { once: true });
    };
    const q = $('#tray-q'); if (q) q.oninput = () => drawGrid(q.value);
  };
  const drawGrid = (q = $('#tray-q')?.value || '') => {
    const g = $('#grid'); if (!g) return;
    const ql = q.trim().toLowerCase();
    const trays = [...S.cur.st.trays.values()].sort((a, b) => a.n - b.n)
      .filter(t => !ql || String(t.n) === ql || t.buyer.toLowerCase().includes(ql.replace(/^@/, '')) || t.list.some(i => String(i.num) === ql.replace(/^#/, '')));
    g.innerHTML = trays.map(t => trayTile(t, 'sort')).join('') || '<p class="muted">No trays match.</p>';
    $$('[data-tray]', g).forEach(b => { b.onclick = () => openTrayDrawer(+b.dataset.tray); });
  };
  const drawRecent = () => { const r = $('#recent'); if (r) r.innerHTML = recent.slice(0, 12).map(x => `<li class="${x.k}"><span class="code">${esc(x.code)}</span><span>${esc(x.label)}</span><span class="muted small">${fmtTime(x.t)}</span></li>`).join(''); };
  const updateNumbers = () => {
    const c = counts(S.cur.st);
    const sc = $('#sort-count'); if (sc) sc.textContent = `${nf(c.inTray)} of ${nf(c.items)} scanned`;
    const sb = $('#sort-bar'); if (sb) sb.style.width = pct(c.inTray, c.items) + '%';
    const pc = $('#pack-count'); if (pc) pc.textContent = `${c.packed}/${c.items} packed`;
    drawGrid(); drawRecent();
  };
  const onScan = (raw, m) => {
    const st = S.cur.st;
    const cands = resolve(st, raw);
    const push = (code, label, k) => { recent.unshift({ code, label, k, t: Date.now() }); };
    if (!cands.length) {
      ev({ ty: 'tray', r: 'notfound', c: raw, m });
      banner('error', `<span class="label">Not in this show</span><span class="big-code">${esc(raw)}</span><span class="muted">This sticker isn't on any order. Check the listing name and number, or that you picked the right show.</span>`);
      feedback('error', S.settings, 'Not found'); push(raw, 'Not found', 'error'); return updateNumbers();
    }
    const open = cands.filter(i => i.status === 'pending' || FLAGGED.includes(i.status));
    if (open.length > 1) {
      ev({ ty: 'tray', r: 'ambiguous', c: raw, m });
      banner('warn', `<span class="label">More than one match</span><span class="big-code">${esc(raw)}</span><span class="muted">Could be ${[...new Set(open.map(i => i.tray))].slice(0, 6).map(n => 'tray ' + n).join(', ')}. Scan the barcode instead of typing the number.</span>`);
      feedback('warn', S.settings, 'More than one match'); push(raw, 'Ambiguous', 'warn'); return updateNumbers();
    }
    if (!open.length) {
      const it = cands[0];
      if (it.status === 'cancelled') {
        ev({ ty: 'tray', r: 'dup', c: raw, it: it.id, tr: it.tray, m });
        banner('warn', `<span class="label">Cancelled order</span><span class="big-code">#${esc(it.num)}</span><span class="muted">This item was marked as cancelled. Set it aside.</span>`);
        feedback('warn', S.settings, 'Cancelled'); push('#' + it.num, 'Cancelled', 'warn'); return updateNumbers();
      }
      ev({ ty: 'tray', r: 'dup', c: raw, it: it.id, tr: it.tray, m });
      banner('warn', `<span class="label">Already scanned · goes in</span><span class="tray-num huge">${it.tray}</span><span class="buyer-big">${esc(at(st.trays.get(it.tray)?.buyer))}</span>`);
      feedback('warn', S.settings, `Tray ${it.tray}`); push('#' + it.num, 'Repeat · tray ' + it.tray, 'warn'); return updateNumbers();
    }
    const it = open[0];
    ev({ ty: 'tray', r: 'ok', c: raw, it: it.id, tr: it.tray, m });
    const t = S.cur.st.trays.get(it.tray);
    const complete = t.sortState === 'complete';
    banner('ok', `<span class="label">#${esc(it.num ?? '')} · goes in</span><span class="tray-num huge">${it.tray}</span><span class="buyer-big">${esc(at(t.buyer))} · ${t.inTray} / ${t.total}</span>${complete ? '<span class="done-tag">Tray complete</span>' : ''}`);
    feedback(complete ? 'done' : 'ok', S.settings, `Tray ${it.tray}`);
    push('#' + (it.num ?? raw), 'Tray ' + it.tray, 'ok');
    updateNumbers();
  };
  draw();
  S.refresh = () => { rebuild(); updateNumbers(); };
}

// ---------- Trays (grid with legend; phone tab) ----------
async function tabTrays(s, params) {
  const draw = () => {
    const st = S.cur.st;
    const trays = [...st.trays.values()].sort((a, b) => a.n - b.n);
    const f = params.get('f');
    const shown = f === 'open' ? trays.filter(t => t.sortState !== 'complete') : trays;
    const n = k => trays.filter(t => t.sortState === k).length;
    view().innerHTML = showHeader(s, 'trays') + `
    <div class="legend"><span><i class="sq not"></i>Not started (${n('not')})</span><span><i class="sq progress"></i>In progress (${n('progress')})</span><span><i class="sq complete"></i>Complete (${n('complete')})</span></div>
    <input id="tray-q" class="search" placeholder="Search by username, tray number, sticker…">
    <div class="tray-grid compact" id="grid">${shown.map(t => trayTile(t, 'sort')).join('')}</div>`;
    bindShowHeader(s);
    const bindTiles = () => $$('[data-tray]').forEach(b => { b.onclick = () => openTrayDrawer(+b.dataset.tray); });
    bindTiles();
    $('#tray-q').oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      $('#grid').innerHTML = shown.filter(t => !q || String(t.n) === q || t.buyer.toLowerCase().includes(q.replace(/^@/, '')) || t.list.some(i => String(i.num) === q.replace(/^#/, ''))).map(t => trayTile(t, 'sort')).join('');
      bindTiles();
    };
  };
  draw();
  S.refresh = () => { rebuild(); if (!document.activeElement || document.activeElement.id !== 'tray-q') draw(); };
}

// ---------- Pack & ship: Labels ----------
async function tabLabels(s) {
  const draw = () => {
    view().innerHTML = showHeader(s, 'labels') + packTabs(s, 'labels') + `
    <div class="labels-card"><div class="labels-head"><span class="label">Labels</span><h2>${s.hasLabels ? 'Ready to print' : 'Add your shipping labels'}</h2>
      <p>Pages are pre-ordered by tray number with the tray number stamped on. Pick what to include and download — no finalise step needed.</p></div>
      <div class="pad"><p><b>What do you want to print?</b></p>
      <div class="choice-row three">
        <button class="choice" data-m="both"><b>Labels + slips</b><span class="small muted">Label then packing slip per buyer, ordered by tray.</span></button>
        <button class="choice on" data-m="labels"><b>Shipping labels</b><span class="small muted">Just the address labels, ordered by tray.</span></button>
        <button class="choice" data-m="slips"><b>Packing slips</b><span class="small muted">Just the packing slips, ordered by tray.</span></button>
      </div>
      ${S.owner ? '<button class="btn dark wide" id="dl">⬇ Download shipping labels PDF</button>' : '<p class="muted">Ask the owner to print labels.</p>'}
      ${S.owner ? `<details class="small add-labels"><summary>${s.hasLabels ? 'Replace or add a shipping labels PDF' : 'Use your own shipping provider? Add your labels PDF here'}</summary>
        <label class="btn ghost file-btn">Choose labels PDF<input type="file" id="labels-pdf" accept="application/pdf"></label><span class="muted small" id="lab-msg"></span></details>` : ''}
      </div></div>
    <div class="card next-up"><span class="label">Next</span><b>Pack boxes</b><span class="muted small">Scan each item into its box, then the postage label.</span><a class="btn" href="#show/${esc(s.id)}/pack">Start packing</a></div>`;
    bindShowHeader(s);
    let mode = 'labels';
    const names = { both: 'labels + slips', labels: 'shipping labels', slips: 'packing slips' };
    $$('.choice').forEach(c => { c.onclick = () => { mode = c.dataset.m; $$('.choice').forEach(x => x.classList.toggle('on', x === c)); const d = $('#dl'); if (d) d.textContent = `⬇ Download ${names[mode]} PDF`; }; });
    const dl = $('#dl'); if (dl) dl.onclick = () => printShow(s, mode);
    const lp = $('#labels-pdf');
    if (lp) lp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#lab-msg').textContent = 'Reading…';
      try {
        const file = { id: db.uid('file'), showId: s.id, name: f.name, kind: 'labels', bytes: await readFile(f), addedAt: Date.now() };
        const data = S.cur.data;
        const r = await parseLabelsOnly(file, data.orders);
        if (!r.assignments.length) { $('#lab-msg').textContent = "Couldn't match these labels to this show's orders."; return; }
        const byId = new Map(data.orders.map(o => [o.orderId, o]));
        for (const a of r.assignments) { const o = byId.get(a.order.orderId); o.labelPages = [a.ref]; o.tracking = [...new Set([...(o.tracking || []), ...a.tracking])]; }
        data.trays.forEach(t => { t.tracking = [...new Set(t.orderIds.flatMap(id => byId.get(id)?.tracking || []))]; });
        db.putFile(file);
        await db.updateShowData(s.id, data, { hasLabels: true });
        S.cur.version = db.getShow(s.id).dataVersion; rebuild();
        toast(`Matched ${r.assignments.length} labels${r.positional ? ' (by page order)' : ''}${r.leftovers.length ? ', ' + r.leftovers.length + ' pages unmatched' : ''}`, 'ok');
        s = db.getShow(s.id); draw();
      } catch (err) { console.error(err); $('#lab-msg').textContent = 'Could not read that PDF: ' + err.message; }
    };
  };
  draw();
  S.refresh = null;
}
function packTabs(s, on) {
  return `<div class="sub-tabs">${[['labels', '1', 'Labels'], ['pack', '2', 'Pack boxes'], ['handover', '3', 'Hand over']].map(([k, n, l]) => `<a class="${on === k ? 'on' : ''}" href="#show/${esc(s.id)}/${k}"><span class="step-n">${n}</span>${l}</a>`).join('')}</div>`;
}

// ---------- Pack & ship: Pack boxes ----------
async function tabPack(s, params) {
  let openN = params.get('t') ? +params.get('t') : null;
  let filter = 'todo';
  const draw = () => {
    const st = S.cur.st, c = counts(st);
    const never = [...st.items.values()].filter(i => i.status === 'pending');
    view().innerHTML = showHeader(s, 'pack') + packTabs(s, 'pack') + `
    ${never.length ? `<details class="warn-bar"><summary><b>Fix before packing:</b> ${never.length} item${never.length === 1 ? '' : 's'} never scanned into a tray <span class="right">Show</span></summary>
      <ul class="plain small">${never.slice(0, 40).map(i => `<li>#${i.num ?? '?'} · tray ${i.tray} · ${esc(at(st.trays.get(i.tray)?.buyer))}</li>`).join('')}</ul></details>` : ''}
    <section class="panel scan-panel">
      <div class="row between wrap">${scanBoxHtml('Scan or type a barcode then press Enter')}${S.owner ? '<button class="btn dark desk" id="phone-btn">📱 Scan with your phone</button>' : ''}</div>
      <p class="muted small">Scan each item into the box — or just scan the parcel's postage label and we'll tell you if anything's missing.</p>
      <div id="result" class="result idle"><span class="muted">${openN ? 'Packing tray ' + openN : 'No box open'}</span></div>
    </section>
    <div class="pack-grid"><div id="box"></div>
      <aside class="card pack-side"><b>${c.boxesDone} of ${c.trays} boxes packed</b><div class="bar"><i class="green" style="width:${pct(c.boxesDone, c.trays)}%"></i></div><span class="muted small">${c.packed} of ${c.items} items packed</span>
        <input id="pk-q" class="search" placeholder="Find a tray or buyer">
        <div class="seg"><button data-f="todo" class="${filter === 'todo' ? 'on' : ''}">To do · ${c.trays - c.boxesDone}</button><button data-f="done" class="${filter === 'done' ? 'on' : ''}">Done · ${c.boxesDone}</button></div>
        <ul class="pk-list" id="pk-list"></ul></aside></div>`;
    bindShowHeader(s);
    drawBox(); drawList();
    bindScan(onScan);
    const pb = $('#phone-btn'); if (pb) pb.onclick = phoneModal;
    $('#undo-btn').onclick = () => { const o = undoLast(); if (!o) return toast('Nothing to undo yet'); banner('warn', `<span class="label">Undone</span><span class="muted">${esc(TYPE_LABEL[o.ty] || '')} ${o.it ? '#' + (S.cur.st.items.get(o.it)?.num ?? '') : 'tray ' + (o.tr ?? '')}</span>`); drawBox(); drawList(); };
    $('#pk-q').oninput = drawList;
    $$('.seg [data-f]').forEach(b => { b.onclick = () => { filter = b.dataset.f; $$('.seg [data-f]').forEach(x => x.classList.toggle('on', x === b)); drawList(); }; });
  };
  const nextUp = () => [...S.cur.st.trays.values()].sort((a, b) => a.n - b.n).find(t => !t.boxDone && t.sortState === 'complete') || [...S.cur.st.trays.values()].sort((a, b) => a.n - b.n).find(t => !t.boxDone);
  const drawBox = () => {
    const el = $('#box'); if (!el) return;
    const t = openN != null ? S.cur.st.trays.get(openN) : null;
    if (!t) {
      const nu = nextUp();
      el.innerHTML = `<div class="card no-box"><div class="row wrap"><div class="grow"><h2>No box open</h2><p class="muted">Scan the first item of the box you're packing, or pick a tray from the list.</p></div>
        ${nu ? `<button class="next-chip" data-open="${nu.n}"><span class="label">Next up</span><b>Tray ${nu.n}</b><span>${esc(at(nu.buyer))}<br>${nu.total} items to pack</span></button>` : '<p class="green">Every box is packed.</p>'}</div>
        <div class="three-steps"><span><b>1.</b> Scan any item to open its box</span><span><b>2.</b> Scan each item as it goes in</span><span><b>3.</b> Scan the postage label to finish</span></div></div>`;
      const b = $('[data-open]', el); if (b) b.onclick = () => { openN = +b.dataset.open; drawBox(); };
      return;
    }
    const allIn = t.packed >= t.total;
    el.innerHTML = `<div class="card box-open"><div class="row between wrap"><div class="row"><span class="tray-num xl">${t.n}</span><div><h2>${esc(at(t.buyer))}</h2><p class="muted">${t.packed} of ${t.total} packed${t.boxDone ? ' · <b class="green">Box finished</b>' : ''}</p></div></div>
      <div class="row wrap gap-s">${allIn && !t.boxDone ? '<button class="btn primary" id="finish">Finish box</button>' : ''}${!allIn ? '<button class="btn ghost" id="pack-all">Mark all packed</button>' : ''}<button class="btn ghost" id="close-box">Close box</button></div></div>
      ${allIn && !t.boxDone ? `<p class="hint">${t.tracking?.length ? 'All in — scan the postage label to finish.' : 'All in — tap Finish box (no label on file to scan).'}</p>` : ''}
      <ul class="checklist">${t.list.map(i => `<li class="${i.status === 'packed' ? 'done' : ''} st-${i.status}"><span class="box-ck"></span><span class="chip num">#${i.num ?? '?'}</span><span class="grow small">${esc(i.title || '')}</span><span class="small muted">${STATUS_LABEL[i.status]}</span></li>`).join('')}</ul></div>`;
    const fin = $('#finish', el); if (fin) fin.onclick = () => { ev({ ty: 'finish', r: 'ok', tr: t.n, m: 'tap' }); feedback('done', S.settings, `Tray ${t.n} done`); banner('ok', `<span class="label">Box finished</span><span class="tray-num huge">${t.n}</span>`); openN = null; drawBox(); drawList(); };
    const pa = $('#pack-all', el); if (pa) confirmTap(pa, 'Tap again to confirm', () => { t.list.filter(i => i.status !== 'packed' && i.status !== 'cancelled').forEach(i => ev({ ty: 'box', r: 'ok', it: i.id, tr: t.n, m: 'tap' })); drawBox(); drawList(); });
    $('#close-box', el).onclick = () => { openN = null; drawBox(); };
  };
  const drawList = () => {
    const el = $('#pk-list'); if (!el) return;
    const q = ($('#pk-q')?.value || '').trim().toLowerCase().replace(/^@/, '');
    const trays = [...S.cur.st.trays.values()].sort((a, b) => a.n - b.n).filter(t => (filter === 'done' ? t.boxDone : !t.boxDone) && (!q || String(t.n) === q || t.buyer.toLowerCase().includes(q)));
    el.innerHTML = trays.map(t => `<li><button data-open="${t.n}" class="${openN === t.n ? 'on' : ''}"><b>${t.n}</b><span class="grow">${esc(at(t.buyer))}<span class="bar thin"><i class="green" style="width:${pct(t.packed, t.total)}%"></i></span></span><span class="small">${t.packed}/${t.total}</span></button></li>`).join('') || '<li class="muted small">Nothing here.</li>';
    $$('[data-open]', el).forEach(b => { b.onclick = () => { openN = +b.dataset.open; drawBox(); drawList(); }; });
  };
  const onScan = (raw, m) => {
    const st = S.cur.st;
    const lt = trayForLabel(st, raw);
    if (lt) { // a postage label
      if (openN != null && lt.n !== openN) {
        ev({ ty: 'label', r: 'mismatch', c: raw, tr: openN, m });
        banner('error', `<span class="label">Wrong label</span><span class="tray-num huge">${lt.n}</span><span class="buyer-big">This label is for tray ${lt.n} · ${esc(at(lt.buyer))}, not tray ${openN}</span>`);
        return feedback('error', S.settings, `Wrong label. Tray ${lt.n}`);
      }
      openN = lt.n;
      const missing = lt.list.filter(i => i.status !== 'packed' && i.status !== 'cancelled');
      if (missing.length) {
        ev({ ty: 'label', r: 'incomplete', c: raw, tr: lt.n, m });
        banner('error', `<span class="label">${missing.length} item${missing.length === 1 ? '' : 's'} missing from this box</span><span class="tray-num huge">${lt.n}</span><span class="muted">${missing.slice(0, 10).map(i => '#' + (i.num ?? '?')).join(', ')}</span>`);
        feedback('error', S.settings, `${missing.length} missing`);
      } else {
        ev({ ty: 'label', r: 'verified', c: raw, tr: lt.n, m });
        banner('ok', `<span class="label">Label verified · box done</span><span class="tray-num huge">${lt.n}</span><span class="buyer-big">${esc(at(lt.buyer))} · seal it</span>`);
        feedback('done', S.settings, `Tray ${lt.n} done`);
        openN = null;
      }
      drawBox(); drawList(); return;
    }
    const cands = resolve(st, raw);
    if (!cands.length) {
      ev({ ty: 'box', r: 'notfound', c: raw, m });
      banner('error', `<span class="label">Not in this show</span><span class="big-code">${esc(raw)}</span>`);
      return feedback('error', S.settings, 'Not found');
    }
    let it = cands.length === 1 ? cands[0] : (openN != null ? cands.find(i => i.tray === openN) : null) || cands.find(i => i.status !== 'packed');
    if (!it) it = cands[0];
    if (openN == null) openN = it.tray;
    if (it.tray !== openN) {
      ev({ ty: 'box', r: 'wrong', c: raw, it: it.id, tr: openN, m });
      banner('error', `<span class="label">Wrong box</span><span class="big-code">#${esc(it.num ?? raw)}</span><span class="buyer-big">Belongs in tray ${it.tray} · ${esc(at(st.trays.get(it.tray)?.buyer))}</span>`);
      return feedback('error', S.settings, `Wrong box. Tray ${it.tray}`);
    }
    if (it.status === 'packed') {
      ev({ ty: 'box', r: 'dup', c: raw, it: it.id, tr: it.tray, m });
      banner('warn', `<span class="label">Already packed</span><span class="big-code">#${esc(it.num ?? raw)}</span>`);
      feedback('warn', S.settings, 'Already packed');
    } else {
      ev({ ty: 'box', r: 'ok', c: raw, it: it.id, tr: it.tray, m });
      const t = S.cur.st.trays.get(it.tray);
      const left = t.total - t.packed;
      banner(left ? 'ok' : 'ok', left ? `<span class="label">Packed</span><span class="big-code">#${esc(it.num ?? raw)}</span><span class="muted">${left} left for ${esc(at(t.buyer))}</span>`
        : `<span class="label">Box complete</span><span class="tray-num huge">${t.n}</span><span class="buyer-big">${t.tracking?.length ? 'Scan the postage label to finish' : 'Tap Finish box'}</span>`);
      feedback(left ? 'ok' : 'done', S.settings, left ? `${left} left` : `Tray ${t.n} complete`);
    }
    drawBox(); drawList();
  };
  draw();
  S.refresh = () => { rebuild(); drawBox(); drawList(); };
}

// ---------- Pack & ship: Hand over ----------
async function tabHandover(s) {
  const draw = () => {
    const st = S.cur.st, c = counts(st);
    const left = [...st.trays.values()].filter(t => !t.handed).sort((a, b) => a.n - b.n);
    view().innerHTML = showHeader(s, 'handover') + packTabs(s, 'handover') + `
    <section class="panel scan-panel">${scanBoxHtml('Scan a parcel label…')}
      <p class="muted small">Scan each parcel as it goes in the courier's sack — so nothing gets left behind.</p>
      <div id="result" class="result idle"><span class="muted">Ready</span></div></section>
    <div class="card handover-big"><span class="truck">🚚</span><div class="grow"><span class="label">Courier handover</span><div><b class="huge-num" id="ho-n">${c.handed}</b><span class="muted big"> / ${c.trays}</span></div><span>parcels handed to the courier</span><div class="bar"><i class="blue" style="width:${pct(c.handed, c.trays)}%"></i></div></div></div>
    <details class="card"><summary>Still to hand over (${left.length})</summary><ul class="pk-list">${left.map(t => `<li><span><b>${t.n}</b> ${esc(at(t.buyer))}</span><button class="btn ghost small" data-hand="${t.n}">Mark handed over</button></li>`).join('')}</ul></details>`;
    bindShowHeader(s);
    bindScan(onScan);
    $('#undo-btn').onclick = () => { const o = undoLast(); if (!o) return toast('Nothing to undo yet'); toast('Undone'); draw(); };
    $$('[data-hand]').forEach(b => { b.onclick = () => { ev({ ty: 'handover', r: 'ok', tr: +b.dataset.hand, m: 'tap' }); draw(); }; });
  };
  const onScan = (raw, m) => {
    const st = S.cur.st;
    let t = trayForLabel(st, raw);
    if (!t && /^T?\d{1,4}$/i.test(raw.trim())) t = st.trays.get(+raw.replace(/\D/g, '')) || null;
    if (!t) { ev({ ty: 'handover', r: 'notfound', c: raw, m }); banner('error', `<span class="label">Not a parcel from this show</span><span class="big-code">${esc(raw)}</span>`); return feedback('error', S.settings, 'Not found'); }
    if (t.handed) { ev({ ty: 'handover', r: 'dup', c: raw, tr: t.n, m }); banner('warn', `<span class="label">Already handed over</span><span class="tray-num huge">${t.n}</span>`); return feedback('warn', S.settings, 'Already handed over'); }
    ev({ ty: 'handover', r: 'ok', c: raw, tr: t.n, m });
    const c = counts(S.cur.st);
    banner('ok', `<span class="label">Handed over</span><span class="tray-num huge">${t.n}</span><span class="buyer-big">${esc(at(t.buyer))} · ${c.handed}/${c.trays}</span>${t.boxDone ? '' : '<span class="muted">Heads up: this box was never finished in Pack boxes.</span>'}`);
    feedback(c.handed >= c.trays ? 'done' : 'ok', S.settings, String(c.handed));
    const n = $('#ho-n'); if (n) n.textContent = c.handed;
  };
  draw();
  S.refresh = () => { rebuild(); const c = counts(S.cur.st); const n = $('#ho-n'); if (n) n.textContent = c.handed; };
}

// ---------- Scan history ----------
async function tabScans(s) {
  let fType = 'all', fRes = 'all', fDev = null;
  const draw = () => {
    const st = S.cur.st;
    const evs = st.events;
    const scans = evs.filter(e => (e.ty === 'tray' || e.ty === 'box'));
    const ok = scans.filter(e => e.r === 'ok' && !st.undone.has(e.i));
    const devices = new Map();
    evs.forEach(e => { const k = e.dev; const d = devices.get(k) || { name: e.who || 'This login', n: 0, issues: 0, times: [], last: 0 }; if ((e.ty === 'tray' || e.ty === 'box') && e.r === 'ok') { d.n++; d.times.push(e.t); } if (PROBLEM_RESULTS[e.r]) d.issues++; d.last = Math.max(d.last, e.t); devices.set(k, d); });
    const dups = evs.filter(e => e.r === 'dup').length;
    const busy = busyMs(ok.map(e => e.t));
    const meth = methods(evs.filter(e => !st.undone.has(e.i)));
    const mt = Object.values(meth).reduce((a, b) => a + b, 0);
    const list = evs.slice().reverse().filter(e => (fType === 'all' || e.ty === fType) && (fRes === 'all' || e.r === fRes) && (!fDev || e.dev === fDev));
    view().innerHTML = showHeader(s, 'scans') + `
    <h2>Scan history</h2>
    <div class="card"><div class="kpis big"><span><b>${nf(ok.length)}</b> items scanned</span><span><b>${perHour(ok.length, busy)}</b> an hour, over ${dur(busy)} of scanning</span><span><b>${devices.size}</b> devices</span></div>
      ${dups ? `<button class="pill-btn small" id="f-dup">${dups} duplicate${dups === 1 ? '' : 's'}</button> <span class="muted small">Tap one to see those scans.</span>` : ''}</div>
    <div class="card"><h3>How items were scanned</h3>${mt ? Object.entries(meth).map(([k, n]) => `<div class="bar-line"><span>${METHOD_LABEL[k] || k}</span><span>${n} · ${pct(n, mt)}%</span></div><div class="bar"><i class="dark" style="width:${pct(n, mt)}%"></i></div>`).join('') : '<p class="muted small">No scans yet.</p>'}</div>
    <div class="card"><h3>By device</h3><div class="dev-grid">${[...devices.entries()].map(([k, d]) => `<button class="dev ${fDev === k ? 'on' : ''}" data-dev="${esc(k)}"><b>${esc(d.name)}</b><span class="small">${d.n} scanned · ${perHour(d.n, busyMs(d.times))}/hr${d.issues ? ' · <span class="red">' + d.issues + ' issue' + (d.issues === 1 ? '' : 's') + '</span>' : ''}</span><span class="muted small">Last scan ${fmtWhen(d.last)}</span></button>`).join('')}</div></div>
    <div class="card"><h3>Event log</h3><p class="muted small">Every scan, duplicate, undo, and miss for this show — newest first.</p>
      <div class="filters"><span class="label">Type</span>${['all', 'tray', 'box', 'label', 'finish', 'handover', 'status', 'undo', 'reset'].map(k => `<button class="chip-btn ${fType === k ? 'on' : ''}" data-ft="${k}">${k === 'all' ? 'All' : TYPE_LABEL[k]}</button>`).join('')}</div>
      <div class="filters"><span class="label">Result</span>${['all', 'ok', 'dup', 'notfound', 'ambiguous', 'wrong', 'verified', 'mismatch', 'incomplete'].map(k => `<button class="chip-btn ${fRes === k ? 'on' : ''}" data-fr="${k}">${k === 'all' ? 'All' : RESULT_LABEL[k]}</button>`).join('')}</div>
      <ul class="log">${list.slice(0, 400).map(e => { const it = e.it ? st.items.get(e.it) : null; return `<li class="${st.undone.has(e.i) ? 'undone' : ''}"><span class="small muted">${fmtTime(e.t)}</span><span class="res r-${e.r || 'ok'}">${RESULT_LABEL[e.r] || (e.ty === 'status' ? STATUS_LABEL[e.s] : 'Done')}</span>
        <span class="grow">${it ? `<b>#${it.num ?? '?'}</b> ${esc((it.title || '').slice(0, 40))}` : esc(e.c || '')}<div class="muted small">${TYPE_LABEL[e.ty] || e.ty} · ${METHOD_LABEL[e.m] || e.m || ''} · ${esc(e.who || 'This login')}${st.undone.has(e.i) ? ' · undone' : ''}</div></span>${e.tr != null ? `<span class="small">Tray ${e.tr}</span>` : ''}</li>`; }).join('') || '<li class="muted">No scans match.</li>'}</ul>
      ${list.length > 400 ? `<p class="muted small">Showing the newest 400 of ${list.length}.</p>` : ''}</div>`;
    bindShowHeader(s);
    $$('[data-ft]').forEach(b => { b.onclick = () => { fType = b.dataset.ft; draw(); }; });
    $$('[data-fr]').forEach(b => { b.onclick = () => { fRes = b.dataset.fr; draw(); }; });
    $$('[data-dev]').forEach(b => { b.onclick = () => { fDev = fDev === b.dataset.dev ? null : b.dataset.dev; draw(); }; });
    const fd = $('#f-dup'); if (fd) fd.onclick = () => { fRes = 'dup'; draw(); };
  };
  draw();
  S.refresh = () => { rebuild(); draw(); };
}
