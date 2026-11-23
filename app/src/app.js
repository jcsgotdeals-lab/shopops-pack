// JC Got Trays: start-up, sign-in, menus, and the screens that aren't about one show
// (Shows, Import, Pre-show labels, Analytics, Team, Settings, Help).
import * as db from './db.js';
import { S, setShowId, prefs, hideRev, stopCamera, openShow } from './ctx.js';
import { counts, pct, pctFloor, buildState, METHOD_LABEL, nameKey } from './state.js';
import { $, $$, esc, view, at, toast, fmtDateStr, fmtWhen, ago, dur, money, nf, modal, confirmTap, saveFile, printPdf, readFile, readText, isPhone } from './ui.js';
import { parsePdfs, ordersFromCsv, planShow } from './importer.js';
import { preShowPdf } from './labels.js';
import { qrSvg } from './qr.js';
import { viewDash, viewShow, noShow, showReport, phoneModal } from './views-show.js';

const APP_VERSION = '1.3.0';
const appUrl = () => location.origin + location.pathname;
const OWNER_NAME = 'JULIAN';

// ================= start-up =================
async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; });
  db.start();
  let lastErr = 0;
  db.onError(err => {
    if (Date.now() - lastErr < 10000) return; lastErr = Date.now();
    if (err && err.code === 'permission-denied') toast(S.owner ? 'The team database refused a change. Sign out and in again.' : 'This phone no longer has access to the team. Ask the owner to reactivate you.', 'error');
    else toast('Sync problem: ' + (err.message || err), 'error');
  });
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  const user = await db.waitForUser();
  if (!user) return signInScreen(joinCode ? 'join' : 'owner', joinCode);
  S.user = user;
  if (db.isOwnerUser(user)) {
    S.owner = true;
    await db.startTeamData(true);
    db.ensureTeam(OWNER_NAME).catch(() => {});
    const name = S.settings.deviceName.trim();
    db.setDevice({ id: db.deviceId(), who: name || 'You', whoKind: name ? 'phone' : 'owner' });
    startApp();
  } else if (user.isAnonymous) {
    let started = false;
    db.watchMe((me, err) => {
      if (err) { console.error(err); return joinScreen(joinCode, "Couldn't reach your team. Check the internet and try again."); }
      S.me = me;
      if (!me) return started ? location.reload() : joinScreen(joinCode);
      if (me.status === 'pending') return waitingScreen(me);
      if (me.status === 'deactivated') return blockedScreen(me);
      if (me.status === 'active' && !started) {
        started = true;
        db.setDevice({ id: db.deviceId(), who: me.name, whoKind: 'packer' });
        db.startTeamData(false).then(startApp);
      }
    });
  } else {
    signInScreen('owner', null, `${esc(user.email)} isn't the owner login for this team. Packers join with the team code instead.`);
    db.signOut().catch(() => {});
  }
}

function startApp() {
  document.body.classList.remove('signed-out');
  document.body.classList.toggle('packer', !S.owner);
  buildShell();
  let saved = null; try { saved = localStorage.getItem('currentShow'); } catch (e) { /* ignore */ }
  if (saved && db.getShow(saved)) S.showId = saved;
  else { const latest = db.shows().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]; if (latest) S.showId = latest.id; }
  if (location.search.includes('join=')) history.replaceState(null, '', location.pathname + location.hash);
  db.onChange(onData);
  window.addEventListener('hashchange', route);
  route();
}

// Something changed on another phone or computer
async function onData(keys) {
  if (S.showId && !db.getShow(S.showId)) { setShowId(null); if (S.cur) S.cur = null; return route(); }
  const name = location.hash.slice(1).split('?')[0] || '';
  if (keys.has('shows') && S.cur && db.getShow(S.cur.id) && db.getShow(S.cur.id).dataVersion !== S.cur.version) {
    await openShow(S.cur.id); return route();
  }
  if (S.cur && keys.has('events:' + S.cur.id) && S.refresh) S.refresh();
  if ((keys.has('shows') || keys.has('prefs')) && ['', 'shows', 'analytics'].includes(name)) route();
  if ((keys.has('members') || keys.has('team')) && name === 'team') route();
  if (keys.has('prefs') && S.refresh) S.refresh();
}

// ================= menus =================
const OWNER_NAV = [['shows', 'Shows'], ['labels', 'Pre-Show Labels'], ['analytics', 'Analytics'], ['team', 'Team'], ['settings', 'Settings'], ['help', 'Help']];
const PACKER_NAV = [['dash', 'Dashboard'], ['tray-scan', 'Scan to Tray'], ['trays', 'Trays'], ['box-scan', 'Scan to Box'], ['settings', 'Settings'], ['help', 'Help']];
const ICON = {
  dash: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  'tray-scan': '<path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M7 9v6M10 9v6M13 9v6M16 9v6"/>',
  trays: '<path d="M3 4h7v7H3zM14 4h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  'box-scan': '<path d="M3 8l9-4 9 4v9l-9 4-9-4zM3 8l9 4 9-4M12 12v9"/>',
  settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
function buildShell() {
  const nav = S.owner ? OWNER_NAV : PACKER_NAV;
  $('#top-nav').innerHTML = nav.map(([k, l]) => `<a href="#${k}" data-nav="${k}">${l}</a>`).join('');
  $('#tabbar').innerHTML = ['dash', 'tray-scan', 'trays', 'box-scan', 'settings'].map(k => `<a href="#${k}" data-nav="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg><span>${{ dash: 'Dashboard', 'tray-scan': 'Scan to Tray', trays: 'Trays', 'box-scan': 'Scan to Box', settings: 'Settings' }[k]}</span></a>`).join('');
  $('#who').textContent = S.owner ? (S.settings.deviceName || 'Owner') : S.me?.name || '';
}
function markNav(name) {
  const map = { show: 'shows', import: 'shows', '': isPhone() ? 'dash' : S.owner ? 'shows' : 'dash' };
  const n = map[name] ?? name;
  $$('[data-nav]').forEach(a => {
    let on = a.dataset.nav === n;
    if (name === 'show') { const tab = location.hash.split('/')[2] || ''; if (a.closest('#tabbar')) on = { sort: 'tray-scan', trays: 'trays', pack: 'box-scan', labels: 'box-scan', handover: 'dash', overview: 'dash', scans: 'dash' }[tab.split('?')[0]] === a.dataset.nav; }
    a.classList.toggle('on', on);
  });
}

// ================= routing =================
const PACKER_OK = new Set(['dash', 'tray-scan', 'trays', 'box-scan', 'settings', 'help', 'show']);
async function route() {
  stopCamera();
  S.scanHandler = null; S.refresh = null;
  $$('.modal-back').forEach(m => m.remove());
  const [path, qs] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  const parts = (path || '').split('/');
  let name = parts[0];
  if (!name) name = isPhone() || !S.owner ? 'dash' : 'shows';
  markNav(parts[0] ? name : '');
  if (!S.owner && !PACKER_OK.has(name)) name = 'dash';
  try {
    if (name === 'show') {
      const tab = parts[2] || 'overview';
      if (!S.owner && !['sort', 'trays', 'pack', 'handover', 'scans', 'overview'].includes(tab)) return viewShow(parts[1], 'sort', params);
      await viewShow(decodeURIComponent(parts[1] || ''), tab, params);
    } else if (name === 'tray-scan' || name === 'trays' || name === 'box-scan') {
      const tab = { 'tray-scan': 'sort', trays: 'trays', 'box-scan': 'pack' }[name];
      if (!S.showId || !db.getShow(S.showId)) return noShow({ sort: 'Scan to Tray', trays: 'Trays', pack: 'Scan to Box' }[tab]);
      await viewShow(S.showId, tab, params);
    } else {
      const fn = { dash: viewDash, shows: viewShows, import: viewImport, labels: viewLabels, analytics: viewAnalytics, team: viewTeam, settings: viewSettings, help: viewHelp }[name] || viewShows;
      await fn(params);
    }
  } catch (err) {
    console.error(err);
    view().innerHTML = `<section class="panel"><h1>Something went wrong</h1><p>${esc(err.message)}</p><a class="btn" href="#">Back to start</a></section>`;
  }
  if (!params.get('keep')) window.scrollTo(0, 0);
}

// ================= sign in / join =================
function signInScreen(mode, joinCode, note) {
  document.body.classList.add('signed-out');
  const draw = m => {
    view().innerHTML = `<section class="panel signin">
      <div class="brand-big"><img src="icons/icon-192.png" alt="" width="56" height="56"><h1>JC Got <b>Trays</b></h1></div>
      <div class="seg wide"><button data-m="owner" class="${m === 'owner' ? 'on' : ''}">Owner login</button><button data-m="join" class="${m === 'join' ? 'on' : ''}">Join your team</button></div>
      ${note ? `<p class="notice">${note}</p>` : ''}
      ${m === 'owner' ? `
      <form id="si-form" class="stack">
        <label>Email<input id="si-email" type="email" autocomplete="username" required></label>
        <label>Password<input id="si-pass" type="password" autocomplete="current-password" required minlength="6"></label>
        <button class="btn primary">Sign in</button>
      </form>
      <p class="muted small">The business owner's login. Every phone and computer signed in sees the same shows, trays and scans, live.</p>` : `
      <form id="join-form" class="stack">
        <label>Team code<input id="j-code" autocapitalize="characters" autocomplete="off" placeholder="e.g. JULIAN-7262" value="${esc(joinCode || '')}" required></label>
        <label>Your name<input id="j-name" autocomplete="name" placeholder="So the team knows who scanned what" required maxlength="40"></label>
        <button class="btn primary">Join</button>
      </form>
      <p class="muted small">No password needed. The owner gets your request and taps Approve. Packers can scan and pack — nothing else.</p>`}
      <p class="small" id="si-msg"></p>
    </section>`;
    $$('.seg [data-m]').forEach(b => { b.onclick = () => draw(b.dataset.m); });
    const msg = t => { $('#si-msg').textContent = t; };
    const f = $('#si-form');
    if (f) f.onsubmit = async e => {
      e.preventDefault(); msg('Signing in…');
      try { await db.signInOwner($('#si-email').value, $('#si-pass').value); location.reload(); }
      catch (err) { msg({ 'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'Wrong email or password.', 'auth/network-request-failed': 'No internet connection. Connect and try again.', 'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.' }[err.code] || err.message); }
    };
    const j = $('#join-form');
    if (j) j.onsubmit = e => { e.preventDefault(); doJoin($('#j-code').value, $('#j-name').value, msg); };
  };
  draw(mode);
}
async function doJoin(code, name, msg) {
  msg('Sending your request…');
  try {
    if (!db.currentUser()) await db.signInPacker();
    await db.requestJoin(code, name);
    location.reload();
  } catch (err) {
    console.error(err);
    msg(err.code === 'permission-denied' ? "That team code isn't right. Check it with the owner (it may have been changed)." : err.code === 'auth/operation-not-allowed' || err.code === 'auth/admin-restricted-operation' ? 'Joining is switched off for this team right now. Tell the owner.' : 'Could not join: ' + err.message);
  }
}
function joinScreen(code, note) {
  signInScreen('join', code, note);
}
function waitingScreen(me) {
  document.body.classList.add('signed-out');
  view().innerHTML = `<section class="panel signin center">
    <div class="spinner"></div><h1>Waiting for approval</h1>
    <p>Hi <b>${esc(me.name)}</b>. Your request to join is with the owner. This screen opens by itself as soon as they tap <b>Approve</b>.</p>
    <button class="btn ghost" id="cancel-join">Cancel and start over</button></section>`;
  $('#cancel-join').onclick = async () => { await db.removeMember(me.uid).catch(() => {}); db.signOut(); };
}
function blockedScreen(me) {
  document.body.classList.add('signed-out');
  view().innerHTML = `<section class="panel signin center"><h1>Access paused</h1><p>The owner has deactivated <b>${esc(me.name)}</b> on this team. Ask them to reactivate you on the Team page.</p>
    <button class="btn ghost" id="so">Sign out</button></section>`;
  $('#so').onclick = () => db.signOut();
}

// ================= Shows (home) =================
let showsLimit = 20;
function showStatus(s) {
  const m = s.sum;
  if (!m || !m.items) return ['Not started', 'grey'];
  if (m.handed >= m.trays && m.trays) return ['Shipped', 'green'];
  if (m.boxes >= m.trays && m.trays) return ['Packed', 'green'];
  if (m.packed) return ['Packing', 'blue'];
  if (m.inTray >= m.items) return ['Sorted', 'blue'];
  if (m.inTray) return ['Sorting', 'amber'];
  return ['Not started', 'grey'];
}
function viewShows(params) {
  const q = (params.get('q') || '').toLowerCase();
  const all = db.shows().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const list = all.filter(s => !q || s.name.toLowerCase().includes(q));
  const tot = all.reduce((t, s) => { const m = s.sum || {}; t.items += m.items ?? s.itemCount ?? 0; t.buyers += m.buyers ?? 0; t.rev += m.revenue ?? 0; t.scans += m.scans ?? 0; return t; }, { items: 0, buyers: 0, rev: 0, scans: 0 });
  const cur = S.showId && db.getShow(S.showId);
  view().innerHTML = `
  <div class="home-head"><div><h1>Shows</h1><p class="muted">Import a finished show to sort it into trays and pack it — or print numbered stickers before you go live.</p></div></div>
  <div class="home-cards">
    <a class="card big-link" href="#import"><span class="ico">📦</span><div><b>Pack a finished show</b><span class="muted small">Add the labels + packing slips PDF. Trays are made for you: biggest buyer gets Tray 1.</span></div><span>›</span></a>
    <a class="card big-link" href="#labels"><span class="ico">🏷️</span><div><b>Pre-show labels</b><span class="muted small">Print numbered stickers to put on items as they sell during the live.</span></div><span>›</span></a>
    ${cur ? `<a class="card big-link accent" href="#show/${esc(cur.id)}/overview"><span class="ico">▶</span><div><b>Continue: ${esc(cur.name)}</b><span class="muted small">${cur.sum ? `${pctFloor(cur.sum.inTray, cur.sum.items)}% sorted · ${cur.sum.boxes}/${cur.sum.trays} boxes packed` : 'Not started'}</span></div><span>›</span></a>` : ''}
  </div>
  ${all.length ? `<div class="kpis"><span><b>${all.length}</b> shows</span><span><b>${nf(tot.items)}</b> items</span><span><b>${nf(tot.buyers)}</b> buyers</span>${hideRev() ? '' : `<span><b>${money(tot.rev)}</b> sales</span>`}<span><b>${nf(tot.scans)}</b> scans</span></div>` : ''}
  <section class="panel">
    <div class="row between wrap"><h2>Recent shows</h2><input class="search" id="sh-q" placeholder="Search shows" value="${esc(q)}"></div>
    ${list.length ? `<div class="table-wrap"><table class="tbl click">
      <thead><tr><th>Show</th><th>Date</th><th>Platform</th><th>Items</th><th>Buyers</th><th>Sorted</th><th>Boxes</th><th>Status</th></tr></thead>
      <tbody>${list.slice(0, showsLimit).map(s => { const m = s.sum || {}; const [st, col] = showStatus(s); return `<tr data-go="${esc(s.id)}">
        <td><b>${esc(s.name)}</b>${s.sample ? ' <span class="pill">Practice</span>' : ''}</td><td>${fmtDateStr(s.date)}</td><td>${s.platform === 'whatnot' ? 'Whatnot' : 'TikTok Shop'}</td>
        <td>${m.items ?? s.itemCount ?? 0}</td><td>${m.buyers ?? '—'}</td><td>${m.items ? pctFloor(m.inTray, m.items) + '%' : '0%'}</td><td>${m.trays ? m.boxes + '/' + m.trays : (s.trayCount || 0) ? '0/' + s.trayCount : '—'}</td>
        <td><span class="status-pill ${col}">${st}</span></td></tr>`; }).join('')}</tbody></table></div>
      ${list.length > showsLimit ? '<button class="btn ghost" id="more">Load more</button>' : ''}` : `<div class="empty"><p class="muted">${q ? 'No shows match.' : 'No shows yet.'}</p>${q ? '' : '<button class="btn" id="sample">Practise on a sample show</button>'}</div>`}
  </section>`;
  $$('[data-go]').forEach(tr => { tr.onclick = () => { setShowId(tr.dataset.go); location.hash = '#show/' + tr.dataset.go + '/overview'; }; });
  const sq = $('#sh-q');
  sq.oninput = () => { clearTimeout(sq._t); sq._t = setTimeout(() => { location.hash = '#shows' + (sq.value ? '?keep=1&q=' + encodeURIComponent(sq.value) : ''); setTimeout(() => { const n = $('#sh-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 50); }, 300); };
  const mb = $('#more'); if (mb) mb.onclick = () => { showsLimit += 20; viewShows(params); };
  const sb = $('#sample'); if (sb) sb.onclick = makeSample;
}

// ================= Import =================
let pending = null; // parsed import waiting for "Create show"
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function viewImport() {
  const plat = pending?.platform || localStorage.getItem('platform') || 'tiktok';
  view().innerHTML = `
  <a class="back" href="#shows">← All shows</a>
  <h1>Pack a finished show</h1>
  <section class="panel">
    <h3>1. Where did you sell?</h3>
    <div class="choice-row"><button class="choice ${plat === 'tiktok' ? 'on' : ''}" data-p="tiktok"><b>TikTok Shop</b><span class="small muted">Shipping labels + packing slips PDF from Seller Center</span></button>
      <button class="choice ${plat === 'whatnot' ? 'on' : ''}" data-p="whatnot"><b>Whatnot</b><span class="small muted">Labels + packing slips PDF from the seller hub</span></button></div>
    <h3>2. Add the PDF</h3>
    <p class="muted small">${plat === 'whatnot' ? 'In Whatnot: Shipments → select the show → Print labels (with packing slips).' : 'In Seller Center: Orders → select the LIVE\'s orders → Print → <b>Shipping label and packing list</b>.'} Got several PDFs from the same show? Add them all — they're stitched together. Only have packing slips? That works too; add the labels later on the show's Labels step.</p>
    <label class="drop" id="drop"><input id="files" type="file" accept="application/pdf,.pdf,.csv,text/csv" multiple><b>Choose PDF files</b><span class="muted">or drop them here · an order CSV also works</span></label>
    <p class="muted small" id="prog"></p>
    <p class="small">New to this? <button class="link" id="sample">Practise on a sample show</button> — fake orders, nothing real is touched.</p>
  </section>
  <div id="preview"></div>`;
  $$('[data-p]').forEach(b => { b.onclick = () => { localStorage.setItem('platform', b.dataset.p); if (pending) pending.platform = b.dataset.p; viewImport(); }; });
  $('#sample').onclick = makeSample;
  const handle = async files => {
    if (!files.length) return;
    const prog = $('#prog');
    try {
      const pdfs = [], csvs = [];
      files.forEach(f => (/\.csv$/i.test(f.name) || /csv/.test(f.type) ? csvs : pdfs).push(f));
      const stored = [];
      for (const f of pdfs) stored.push({ id: db.uid('file'), name: f.name, kind: 'import', bytes: await readFile(f), addedAt: Date.now() });
      let parsed = { orders: [], unmatchedLabels: [], pageCount: 0, labelPages: 0 };
      if (stored.length) parsed = await parsePdfs(stored, m => { prog.textContent = 'Reading ' + m; });
      for (const f of csvs) parsed.orders.push(...ordersFromCsv(await readText(f)).orders);
      prog.textContent = '';
      if (!parsed.orders.length) return toast("No packing slips were found in these files. Make sure the PDF includes packing slips (TikTok: 'Shipping label and packing list').", 'error');
      const first = files[0].name.replace(/\.(pdf|csv)$/i, '');
      pending = { files: stored, parsed, platform: plat, name: /^\d|label|slip|print|order/i.test(first) ? `Show ${fmtDateStr(today())}` : first, date: today() };
      drawPreview();
    } catch (err) { console.error(err); prog.textContent = ''; toast('Could not read the file: ' + err.message, 'error'); }
  };
  $('#files').onchange = e => handle([...e.target.files]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); };
  if (pending) drawPreview();
}
function drawPreview() {
  const p = pending;
  const plan = planShow(p.parsed.orders);
  const noNum = p.parsed.orders.filter(o => !o.items.length);
  const withLabel = p.parsed.orders.filter(o => o.labelPages.length).length;
  const buyers = new Set(plan.trays.map(t => t.buyerKey)).size;
  $('#preview').innerHTML = `<section class="panel">
    <h2>Check before creating trays</h2>
    <div class="kpis"><span><b>${p.parsed.orders.length}</b> orders</span><span><b>${plan.items.length}</b> items</span><span><b>${buyers}</b> buyers</span><span><b>${plan.trays.length}</b> trays</span><span><b>${withLabel}</b> labels matched</span></div>
    ${noNum.length ? `<p class="notice">${noNum.length} order${noNum.length === 1 ? '' : 's'} had no sticker number (#…) on the slip. They still get a tray; tick them off by hand.</p>` : ''}
    ${withLabel < p.parsed.orders.length && p.parsed.labelPages ? `<p class="notice">${p.parsed.orders.length - withLabel} order${p.parsed.orders.length - withLabel === 1 ? '' : 's'} had no shipping label in the PDF.</p>` : ''}
    ${!p.parsed.labelPages && p.files.length ? '<p class="notice">Packing slips only — add the shipping labels later on the show\'s Labels step.</p>' : ''}
    ${plan.trays.length > buyers ? `<p class="muted small">${plan.trays.length - buyers} buyer${plan.trays.length - buyers === 1 ? ' has' : 's have'} more than one package, so they get one tray per package (each package has its own label).</p>` : ''}
    <div class="grid2"><label>Show name<input id="pv-name" value="${esc(p.name)}"></label><label>Show date<input id="pv-date" type="date" value="${esc(p.date)}"></label></div>
    <details><summary>See the trays (${plan.trays.length})</summary><div class="table-wrap"><table class="tbl"><thead><tr><th>Tray</th><th>Buyer</th><th>Items</th><th>Stickers</th></tr></thead><tbody>
      ${plan.trays.map(t => `<tr><td><b>${t.n}</b></td><td>${esc(at(t.buyer))}${t.part ? ' <span class="muted small">(part ' + (t.part + 1) + ')</span>' : ''}</td><td>${t.items.length}</td><td class="small">${t.items.map(id => plan.items.find(i => i.id === id)).map(i => (i.num != null ? '#' + i.num : '—')).join(', ')}</td></tr>`).join('')}
    </tbody></table></div></details>
    <div class="row"><button class="btn primary" id="create">Create show</button><button class="btn ghost" id="discard">Discard</button></div>
  </section>`;
  $('#pv-name').oninput = e => { p.name = e.target.value; };
  $('#pv-date').oninput = e => { p.date = e.target.value; };
  $('#discard').onclick = () => { pending = null; viewImport(); };
  $('#create').onclick = async () => {
    const id = db.uid('show');
    const show = {
      id, name: (p.name || '').trim() || 'Show', date: p.date || today(), platform: p.platform, createdAt: Date.now(),
      trayCount: plan.trays.length, itemCount: plan.items.length, hasLabels: plan.orders.some(o => o.labelPages.length), noNumber: noNum.length,
    };
    await db.createShow(show, plan, p.files.map(f => ({ ...f, showId: id })));
    pending = null; setShowId(id);
    toast(`${plan.trays.length} trays ready`, 'ok');
    location.hash = '#show/' + id + '/overview';
  };
}
// A practice show with made-up orders
async function makeSample() {
  const names = ['squishqueen', 'mochi.mel', 'tay_buys', 'jaylen22', 'cozycrafts', 'nana.rose', 'kidzcorner', 'brookeee', 'dealhunter_nj', 'lilyypad', 'marcus.t', 'soft.things', 'ari_shops', 'zoe.collects', 'big.dawg.deals'];
  const weights = [9, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1];
  const orders = []; let num = 1;
  names.forEach((b, bi) => {
    const items = [];
    for (let k = 0; k < weights[bi]; k++) { const n = num++; items.push({ title: `Mystery Squishy #${n}`, name: 'Mystery Squishy', num: n, qty: 1, price: +(3 + ((n * 37) % 13)).toFixed(2) }); }
    orders.push({ orderId: 'PRACTICE' + (1000 + bi), extraOrderIds: [], buyer: b, buyerKey: nameKey(b), items, slipPages: [], labelPages: [], tracking: [], firstSeq: bi });
  });
  const byBuyer = new Map();
  orders.forEach(o => { if (!byBuyer.has(o.buyerKey)) byBuyer.set(o.buyerKey, '9400' + String(1e17 + Math.floor(Math.random() * 9e17)).slice(0, 18)); o.tracking = [byBuyer.get(o.buyerKey)]; });
  const plan = planShow(orders);
  const id = db.uid('show');
  await db.createShow({ id, name: 'Practice show', date: today(), platform: 'tiktok', createdAt: Date.now(), trayCount: plan.trays.length, itemCount: plan.items.length, hasLabels: false, noNumber: 0, sample: true }, plan, []);
  setShowId(id);
  toast('Practice show ready. Print its stickers on Pre-show labels ("Mystery Squishy", 1 to ' + (num - 1) + '), or just type the numbers.', 'ok');
  location.hash = '#show/' + id + '/overview';
}

// ================= Pre-show labels =================
function loadRows() { try { const r = JSON.parse(localStorage.getItem('preshowRows') || 'null'); if (Array.isArray(r) && r.length) return r; } catch (e) { /* ignore */ } return [{ name: '', from: 1, to: 100 }]; }
function viewLabels() {
  let rows = loadRows();
  const plat = localStorage.getItem('platform') || 'tiktok';
  const st = S.settings;
  const draw = () => {
    const total = rows.reduce((n, r) => n + Math.max(0, (+r.to || 0) - (+r.from || 0) + 1), 0);
    view().innerHTML = `
    <h1>Pre-show labels</h1>
    <p class="muted">Print numbered stickers before you go live. Stick one on each item as it sells — the number is what the buyer sees on their order.</p>
    <div class="ov-grid">
    <section class="panel">
      <div class="seg"><button data-p="tiktok" class="${plat === 'tiktok' ? 'on' : ''}">TikTok Shop</button><button data-p="whatnot" class="${plat === 'whatnot' ? 'on' : ''}">Whatnot</button></div>
      <p class="muted small">${plat === 'whatnot' ? 'Use the same listing name you sell under, and number your lots to match the sticker.' : 'Name your TikTok LIVE auction listing exactly like the sticker (for example "Mystery Squishy #1" … "#100"), so the packing slips show the same name and number.'}</p>
      <div class="pre-rows">${rows.map((r, i) => `<div class="pre-row">
        <label class="grow">Listing name<input data-f="name" data-i="${i}" value="${esc(r.name)}" placeholder="e.g. Mystery Squishy" maxlength="40"></label>
        <label>From #<input data-f="from" data-i="${i}" type="number" min="1" max="1000" value="${r.from}"></label>
        <label>To #<input data-f="to" data-i="${i}" type="number" min="1" max="1000" value="${r.to}"></label>
        ${rows.length > 1 ? `<button class="icon-btn" data-del="${i}" aria-label="Remove">✕</button>` : ''}</div>`).join('')}</div>
      <button class="btn ghost small" id="add-row">+ Add another listing name</button>
      <p class="muted small">Up to 1,000 sales per listing name. <button class="link" id="why">Why?</button></p>
      <div class="row wrap"><button class="btn primary" id="print">Print labels (${nf(total)})</button><button class="btn" id="dl">Download PDF</button><button class="btn ghost" id="test">Test print</button></div>
      <p class="muted small">Sticker size: ${st.labelWidthMm} × ${st.labelHeightMm} mm. <a href="#settings">Change</a></p>
      <div class="sticker-preview"><div class="sticker" style="aspect-ratio:${st.labelWidthMm}/${st.labelHeightMm}"><div class="bars-fake"></div><b>${esc(rows[0].name || 'Listing name')} #${rows[0].from || 1}</b></div></div>
    </section>
    <aside>
      <div class="card"><h3>How it works</h3><ol class="steps-list">
        <li><b>Print</b> a roll of numbered stickers for each listing name.</li>
        <li><b>Go live.</b> When an item sells, stick the next number on it and drop it in the "sold" pile.</li>
        <li><b>After the show</b>, import the labels + packing slips PDF. Every buyer gets a tray — the biggest buyer gets Tray 1.</li>
        <li><b>Scan</b> each sticker: the screen shows which tray it goes in. Then pack each tray into its box.</li></ol></div>
      <div class="card"><h3>Printer tips</h3><ul class="plain small">
        <li>Thermal label printers (Rollo, Munbyn, Zebra, Phomemo…): load ${st.labelWidthMm} × ${st.labelHeightMm} mm labels and set the paper size to match.</li>
        <li>Print at <b>100% / actual size</b> — not "fit to page".</li>
        <li>Do a <b>Test print</b> first and scan it to check the barcode reads.</li>
        <li>Phone app: the PDF opens the share sheet — pick your printer's app or Print.</li></ul></div>
    </aside></div>`;
    $$('[data-p]').forEach(b => { b.onclick = () => { localStorage.setItem('platform', b.dataset.p); viewLabels(); }; });
    $$('[data-f]').forEach(inp => { inp.oninput = () => { const r = rows[+inp.dataset.i]; r[inp.dataset.f] = inp.dataset.f === 'name' ? inp.value : parseInt(inp.value, 10) || ''; save(); const pb = $('#print'); if (pb) pb.textContent = `Print labels (${nf(rows.reduce((n, x) => n + Math.max(0, (+x.to || 0) - (+x.from || 0) + 1), 0))})`; }; });
    $$('[data-del]').forEach(b => { b.onclick = () => { rows.splice(+b.dataset.del, 1); save(); draw(); }; });
    $('#add-row').onclick = () => { rows.push({ name: '', from: 1, to: 100 }); save(); draw(); };
    $('#why').onclick = () => modal(`<div class="modal-head"><h2>Why 1,000 per name?</h2><button class="icon-btn" data-close>✕</button></div>
      <p>Each sticker is matched to the order by its listing name and number. Numbers stop at 1,000 so they stay short enough to read and type quickly.</p>
      <p>Selling more than 1,000 under one name? Add a second listing name (for example "Mystery Squishy B") and start again from #1.</p>`);
    $('#print').onclick = () => go('print');
    $('#dl').onclick = () => go('download');
    $('#test').onclick = () => go('test');
  };
  const save = () => { try { localStorage.setItem('preshowRows', JSON.stringify(rows)); } catch (e) { /* ignore */ } };
  const go = async how => {
    const ok = rows.map(r => ({ name: String(r.name || '').trim(), from: +r.from, to: +r.to }));
    const bad = ok.find(r => !r.name || !(r.from >= 1) || !(r.to >= r.from) || r.to > 1000 || r.to - r.from >= 1000);
    if (bad) return toast(!bad.name ? 'Type a listing name for every row.' : 'Numbers go from 1 up to 1,000, and "To" must be at least "From".', 'error');
    toast('Making the labels…');
    const bytes = await preShowPdf(ok, S.settings, how === 'test');
    const name = how === 'test' ? 'test label.pdf' : `${ok.map(r => r.name).join(', ')} stickers.pdf`;
    how === 'download' ? saveFile(bytes, name) : printPdf(bytes, name);
  };
  draw();
}

// ================= Analytics =================
async function viewAnalytics(params) {
  const days = +(params.get('d') || 30);
  const now = Date.now(), from = now - days * 864e5, prevFrom = from - days * 864e5;
  const inRange = (s, a, b) => { const t = s.sum?.last || s.createdAt || 0; return t >= a && t < b; };
  const all = db.shows();
  const cur = all.filter(s => inRange(s, from, now + 1)), prev = all.filter(s => inRange(s, prevFrom, from));
  const agg = list => {
    const out = { scans: 0, busy: 0, methods: {}, people: new Map(), items: 0 };
    list.forEach(s => {
      const m = s.sum || {}; out.scans += m.scans || 0; out.items += m.items || 0;
      Object.entries(m.methods || {}).forEach(([k, v]) => { out.methods[k] = (out.methods[k] || 0) + v; });
      (m.people || []).forEach(p => {
        const x = out.people.get(p.key) || { name: p.name, kind: p.kind, tray: 0, box: 0, busy: 0, trayMs: 0, boxMs: 0 };
        x.tray += p.tray || 0; x.box += p.box || 0; x.busy += p.busy || 0;
        if (p.trayRate) x.trayMs += (p.tray / p.trayRate) * 3600000; if (p.boxRate) x.boxMs += (p.box / p.boxRate) * 3600000;
        out.people.set(p.key, x); out.busy += p.busy || 0;
      });
    });
    return out;
  };
  const a = agg(cur), b = agg(prev);
  const rate = x => (x.busy ? Math.round(x.scans / (x.busy / 3600000)) : 0);
  const delta = (n, o) => (o ? `<span class="${n >= o ? 'green' : 'red'} small">${n >= o ? '▲' : '▼'} ${Math.abs(Math.round(((n - o) / o) * 100))}% vs previous ${days} days</span>` : '<span class="muted small">No data for the previous period</span>');
  const mt = Object.values(a.methods).reduce((x, y) => x + y, 0);
  const sorted = all.slice().sort((x, y) => (y.date || '').localeCompare(x.date || '') || (y.createdAt || 0) - (x.createdAt || 0));
  const pick = params.get('show') || (S.showId && db.getShow(S.showId) ? S.showId : sorted[0]?.id);
  view().innerHTML = `
  <div class="row between wrap"><h1>Analytics</h1><div class="seg">${[30, 60, 90].map(d => `<a class="${d === days ? 'on' : ''}" href="#analytics?d=${d}${pick ? '&show=' + encodeURIComponent(pick) : ''}">${d} days</a>`).join('')}</div></div>
  <div class="tiles three">
    <div class="tile"><span class="label">Items scanned</span><b>${nf(a.scans)}</b>${delta(a.scans, b.scans)}</div>
    <div class="tile"><span class="label">Per hour while scanning</span><b>${rate(a)}</b>${delta(rate(a), rate(b))}</div>
    <div class="tile"><span class="label">Shows</span><b>${cur.length}</b><span class="muted small">${nf(a.items)} items sold</span></div>
  </div>
  <section class="panel"><h2>Your team</h2>
    ${a.people.size ? `<div class="team-cards">${[...a.people.values()].sort((x, y) => (y.tray + y.box) - (x.tray + x.box)).map(p => `<div class="card person"><span class="avatar">${esc(p.name.slice(0, 2).toUpperCase())}</span><div><b>${esc(p.name)}</b><span class="muted small">${p.kind === 'packer' ? 'Packer login' : p.kind === 'phone' ? 'Named phone' : 'Your login'}</span></div>
      <div class="pstats"><span><b>${nf(p.tray + p.box)}</b> items packed</span><span><b>${p.trayMs ? Math.round(p.tray / (p.trayMs / 3600000)) : 0}</b> into trays/hr</span><span><b>${p.boxMs ? Math.round(p.box / (p.boxMs / 3600000)) : 0}</b> into boxes/hr</span></div></div>`).join('')}</div>` : '<p class="muted">No scans in this period yet.</p>'}
    <p class="muted small">Rates count only time spent scanning — gaps over 10 minutes are left out.</p></section>
  <section class="panel"><h2>How items are scanned</h2>
    ${mt ? Object.entries(a.methods).sort((x, y) => y[1] - x[1]).map(([k, n]) => `<div class="bar-line"><span>${METHOD_LABEL[k] || k}</span><span>${nf(n)} · ${pct(n, mt)}%</span></div><div class="bar"><i class="${k === 'camera' ? 'orange' : k === 'scanner' ? 'blue' : 'green'}" style="width:${pct(n, mt)}%"></i></div>`).join('') : '<p class="muted small">No scans yet.</p>'}
  </section>
  <section class="panel"><div class="row between wrap"><h2>By show</h2>
    <select id="an-show">${sorted.map(s => `<option value="${esc(s.id)}" ${s.id === pick ? 'selected' : ''}>${esc(s.name)} · ${fmtDateStr(s.date)}</option>`).join('')}</select></div>
    <div id="an-report">${pick ? '<p class="muted">Loading…</p>' : '<p class="muted">No shows yet.</p>'}</div></section>`;
  const sel = $('#an-show');
  if (sel) sel.onchange = () => { location.hash = `#analytics?d=${days}&show=${encodeURIComponent(sel.value)}&keep=1`; };
  if (pick) {
    const s = db.getShow(pick);
    const data = await db.showData(pick);
    const evs = await db.showEvents(pick);
    const el = $('#an-report'); if (!el) return;
    el.innerHTML = `<p class="small"><a href="#show/${esc(pick)}/overview">Open this show →</a></p>` + showReport(s, buildState(data, evs));
  }
}

// ================= Team =================
function viewTeam() {
  const t = db.team();
  const code = t?.code || '…';
  const link = `${appUrl()}?join=${encodeURIComponent(code)}`;
  const mem = db.members().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const reqs = mem.filter(m => m.status === 'pending');
  const packers = mem.filter(m => m.status !== 'pending');
  const stats = new Map();
  const since = Date.now() - 30 * 864e5;
  db.shows().filter(s => (s.sum?.last || 0) >= since).forEach(s => (s.sum.people || []).forEach(p => {
    const x = stats.get(p.key) || { name: p.name, kind: p.kind, n: 0, ms: 0, last: 0 };
    x.n += (p.tray || 0) + (p.box || 0); x.ms += p.busy || 0; x.last = Math.max(x.last, s.sum.last || 0);
    stats.set(p.key, x);
  }));
  const own = [...stats.entries()].filter(([k]) => !k.startsWith('packer:'));
  view().innerHTML = `
  <h1>Team</h1>
  <p class="muted">Packers join with your team code — no passwords. They can only scan and pack: no imports, labels, billing or settings.</p>
  <div class="ov-grid">
  <div>
    ${reqs.length ? `<section class="panel attention"><h2>Waiting for approval (${reqs.length})</h2><ul class="mem-list">${reqs.map(m => `<li><span class="avatar">${esc(m.name.slice(0, 2).toUpperCase())}</span><div class="grow"><b>${esc(m.name)}</b><div class="muted small">Asked ${ago(m.createdAt)}</div></div>
      <button class="btn primary small" data-ok="${esc(m.uid)}">Approve</button><button class="btn ghost small" data-no="${esc(m.uid)}">Decline</button></li>`).join('')}</ul></section>` : ''}
    <section class="panel"><h2>Packers</h2>
      ${packers.length ? `<ul class="mem-list">${packers.map(m => { const x = stats.get('packer:' + m.name) || { n: 0, ms: 0, last: 0 }; return `<li class="${m.status === 'deactivated' ? 'off' : ''}"><span class="avatar">${esc(m.name.slice(0, 2).toUpperCase())}</span>
        <div class="grow"><b>${esc(m.name)}</b>${m.status === 'deactivated' ? ' <span class="pill">Deactivated</span>' : ''}<div class="muted small">${nf(x.n)} scans · ${x.ms ? Math.round(x.n / (x.ms / 3600000)) : 0} per hour · last active ${x.last ? ago(x.last) : 'never'} (30 days)</div></div>
        ${m.status === 'deactivated' ? `<button class="btn small" data-re="${esc(m.uid)}">Reactivate</button><button class="btn ghost small" data-rm="${esc(m.uid)}">Remove</button>` : `<button class="btn ghost small" data-off="${esc(m.uid)}">Deactivate</button>`}</li>`; }).join('')}</ul>` : '<p class="muted">No packers yet. Share your team code to invite one.</p>'}
    </section>
    <section class="panel"><h2>Scanning on your own login</h2><p class="muted small">Phones signed in with your owner login, by the name set in each phone's Settings → This device's name.</p>
      ${own.length ? `<ul class="mem-list">${own.map(([k, x]) => `<li><span class="avatar">${esc(x.name.slice(0, 2).toUpperCase())}</span><div class="grow"><b>${esc(x.name)}</b><div class="muted small">${x.kind === 'phone' ? 'Named phone' : 'Unnamed device'} · ${nf(x.n)} scans · ${x.ms ? Math.round(x.n / (x.ms / 3600000)) : 0} per hour · last active ${ago(x.last)}</div></div></li>`).join('')}</ul>` : '<p class="muted small">No scans on your own login in the last 30 days.</p>'}
    </section>
  </div>
  <aside><section class="panel invite"><h2>Invite a packer</h2>
    <p class="muted small">They scan this with their phone camera, type their name and tap Join. You approve them here.</p>
    <div class="qr-card">${qrSvg(link, 200)}</div>
    <p class="center">Team code <b class="code big">${esc(code)}</b></p>
    <div class="row wrap center"><button class="btn" id="copy">Copy invite</button><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('Join my packing team on JC Got Trays: ' + link + '  (team code ' + code + ')')}">Share on WhatsApp</a></div>
    <button class="btn ghost small" id="change">Change code</button>
    <p class="muted small">Changing the code stops new people joining with the old one. People already on the team stay.</p>
  </section></aside></div>`;
  $$('[data-ok]').forEach(b => { b.onclick = () => db.setMember(b.dataset.ok, { status: 'active', approvedAt: Date.now() }).then(() => toast('Approved', 'ok')); });
  $$('[data-no]').forEach(b => { b.onclick = () => db.removeMember(b.dataset.no); });
  $$('[data-off]').forEach(b => confirmTap(b, 'Tap again to deactivate', () => db.setMember(b.dataset.off, { status: 'deactivated' })));
  $$('[data-re]').forEach(b => { b.onclick = () => db.setMember(b.dataset.re, { status: 'active' }); });
  $$('[data-rm]').forEach(b => confirmTap(b, 'Tap again to remove', () => db.removeMember(b.dataset.rm)));
  $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(`Join my packing team on JC Got Trays: ${link} (team code ${code})`); toast('Invite copied', 'ok'); } catch (e) { toast(link); } };
  const ch = $('#change'); confirmTap(ch, 'Tap again to make a new code', async () => { await db.changeTeamCode(OWNER_NAME); viewTeam(); });
}

// ================= Settings =================
function viewSettings() {
  const st = S.settings, p = prefs();
  const tog = (id, on, label, sub) => `<label class="toggle"><span><b>${label}</b>${sub ? `<span class="muted small">${sub}</span>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  view().innerHTML = `
  <h1>Settings</h1>
  ${S.owner ? `<section class="panel"><h2>Packing</h2>
    <label>Packing mode<select id="p-mode"><option value="post" selected>Post-show — sort everything after the live</option><option value="live" disabled>Live — trays as items sell (needs a live sales feed; TikTok doesn't share one)</option></select></label>
    <p class="muted small">Trays: one per package, biggest package gets Tray 1 — the same as Scan2Tray.</p>
    ${tog('p-count', p.itemCount, 'Show item count on labels', 'Stamps "N items" next to the tray number on shipping labels.')}
    ${tog('p-hide', p.hideRevenue, 'Hide show revenue', 'Hides sales amounts on every screen — handy when packers look at the screen.')}
  </section>` : ''}
  <section class="panel"><h2>This device</h2>
    <label>This device's name<input id="d-name" maxlength="30" value="${esc(st.deviceName)}" placeholder="${S.owner ? 'e.g. Packing table phone' : esc(S.me?.name || '')}" ${S.owner ? '' : 'disabled'}></label>
    <span class="muted small">${S.owner ? "Scans from this device show under this name in Scan history, Analytics and Team." : 'Your scans show under your name.'}</span>
    ${tog('d-scanner', st.scannerMode, 'Dedicated scanner mode', 'For Android scanner phones with a trigger button (Chainway, Zebra, Honeywell, Urovo…). Turns the camera button off and keeps the scan box ready so every trigger press lands in it. The on-screen keyboard stays hidden.')}
    <details class="small"><summary>Setting up a scanner phone</summary><ol class="steps-list">
      <li>Open the scanner's own settings app (Chainway: <b>Keyboard emulator</b> / <b>KeyboardEmulator</b>; Zebra: <b>DataWedge</b>; Honeywell: <b>Scan settings</b>).</li>
      <li>Set output mode to <b>Keyboard</b> (also called "keystroke", "simulate keyboard" or "keyboard wedge").</li>
      <li>Set the suffix / end character to <b>Enter</b> (sometimes "\\n" or "CR+LF").</li>
      <li>Make sure <b>Code 128</b> is switched on (stickers) along with the usual shipping-label codes.</li>
      <li>Here, turn on <b>Dedicated scanner mode</b>, open Scan to Tray and press the trigger.</li></ol>
      <p class="muted">USB and Bluetooth hand scanners work the same way on a computer — no setting needed.</p></details>
    ${tog('d-sounds', st.sounds, 'Sounds', 'Beep for good scans, buzz for problems.')}
    ${tog('d-voice', st.voice, 'Say the tray number out loud')}
    ${tog('d-vibrate', st.vibrate, 'Vibrate on problems')}
    <div class="grid2"><label>Sticker width (mm)<input type="number" id="d-w" min="20" max="120" value="${st.labelWidthMm}"></label><label>Sticker height (mm)<input type="number" id="d-h" min="10" max="120" value="${st.labelHeightMm}"></label></div>
  </section>
  ${S.owner ? `<section class="panel"><h2>Sign in on your phone</h2><p class="muted small">Scan with your phone camera to open the app, then sign in with your owner login. Packers use the Team page instead.</p>
    <div class="qr-card small-qr">${qrSvg(appUrl(), 150)}</div>
    <p class="small"><a href="https://github.com/jcsgotdeals-lab/shopops-pack/releases/latest/download/JC-Got-Trays.apk">Download the Android app (APK)</a></p></section>` : ''}
  <section class="panel"><h2>Account</h2>
    <p>${S.owner ? `Signed in as <b>${esc(S.user.email)}</b> (owner)` : `Packing as <b>${esc(S.me?.name || '')}</b> on your team`}</p>
    ${window.__installPrompt ? '<button class="btn" id="install">Install app on this device</button>' : ''}
    <button class="btn ghost" id="signout">Sign out</button>
    <p class="muted small">JC Got Trays ${APP_VERSION}</p></section>`;
  const saveLocal = () => { db.saveLocalSettings(S.settings); };
  const bindTog = (id, key) => { const el = $('#' + id); if (el) el.onchange = () => { S.settings[key] = el.checked; saveLocal(); toast('Saved', 'ok'); }; };
  bindTog('d-scanner', 'scannerMode'); bindTog('d-sounds', 'sounds'); bindTog('d-voice', 'voice'); bindTog('d-vibrate', 'vibrate');
  const dn = $('#d-name');
  if (dn && S.owner) dn.onchange = () => { S.settings.deviceName = dn.value.trim(); saveLocal(); const nm = S.settings.deviceName; db.setDevice({ id: db.deviceId(), who: nm || 'You', whoKind: nm ? 'phone' : 'owner' }); $('#who').textContent = nm || 'Owner'; toast('Saved', 'ok'); };
  const num = (id, key) => { const el = $('#' + id); el.onchange = () => { const v = parseInt(el.value, 10); if (v >= 10) { S.settings[key] = v; saveLocal(); toast('Saved', 'ok'); } }; };
  num('d-w', 'labelWidthMm'); num('d-h', 'labelHeightMm');
  if (S.owner) {
    $('#p-count').onchange = e => db.savePrefs({ itemCount: e.target.checked }).then(() => toast('Saved', 'ok'));
    $('#p-hide').onchange = e => db.savePrefs({ hideRevenue: e.target.checked }).then(() => toast('Saved', 'ok'));
  }
  const ins = $('#install'); if (ins) ins.onclick = () => window.__installPrompt.prompt();
  $('#signout').onclick = () => db.signOut();
}

// ================= Help =================
function viewHelp() {
  const q = (title, body) => `<details class="faq"><summary>${title}</summary><div>${body}</div></details>`;
  view().innerHTML = `
  <h1>Help</h1>
  <div class="ov-grid"><div>
  <section class="panel"><h2>How a show goes</h2><ol class="steps-list">
    <li><b>Before the live:</b> Pre-Show Labels → print numbered stickers for your listing name.</li>
    <li><b>During the live:</b> stick the next number on each item as it sells.</li>
    <li><b>After the live:</b> download the labels + packing slips PDF from TikTok Seller Center and import it (Shows → Pack a finished show).</li>
    <li><b>Sort into trays:</b> scan each sticker. The screen shows a big tray number and the buyer. Biggest buyer = Tray 1.</li>
    <li><b>Print labels:</b> Pack &amp; ship → Labels. Pages come out in tray order with the tray number stamped on.</li>
    <li><b>Pack boxes:</b> scan an item to open its box, scan each item in, then scan the postage label — it tells you if anything is missing.</li>
    <li><b>Hand over:</b> scan each parcel as it goes in the courier's sack.</li></ol></section>
  <section class="panel"><h2>Questions</h2>
    ${q('A sticker says "Not in this show"', 'Check you picked the right show (tap the show name), and that the listing name on the sticker matches the one in TikTok. You can also type just the number and press Enter.')}
    ${q('"More than one match"', 'Two listing names used the same number. Scan the barcode instead of typing, so the name is included.')}
    ${q('An item is damaged, missing or cancelled', 'Open the tray, tap ⋯ next to the item and pick Mark as damaged / missing / on the floor / cancelled. Cancelled items no longer count towards the tray.')}
    ${q('I scanned the wrong thing', 'Tap Undo. It takes back your last scan on this device. On the computer, ▾ next to Undo can reset every tray in the show.')}
    ${q('Does it work without internet?', 'Yes. Scans are saved on the device and sync to everyone as soon as the connection is back.')}
    ${q('Using a scanner phone (Chainway, Zebra, Honeywell)', 'Set the scanner to keyboard output with an Enter suffix, then turn on Settings → Dedicated scanner mode. Full steps are on the Settings page.')}
    ${q('Adding packers', S.owner ? 'Team → Invite a packer. They scan the QR code, type their name and tap Join; you tap Approve.' : 'Ask the owner for the team code.')}
  </section></div>
  <aside><section class="panel"><h2>Install the app</h2>
    <p><b>Android phone:</b> <a href="https://github.com/jcsgotdeals-lab/shopops-pack/releases/latest/download/JC-Got-Trays.apk">download the APK</a> and open it (allow "install unknown apps" if asked). Or open this page in Chrome → ⋮ → Install app.</p>
    <p><b>iPhone:</b> open this page in Safari → Share → Add to Home Screen.</p>
    <p><b>Computer:</b> open this page in Chrome or Edge → the install icon in the address bar.</p>
  </section></aside></div>`;
}

boot();
