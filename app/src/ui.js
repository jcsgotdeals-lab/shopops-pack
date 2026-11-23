// Small shared UI helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const view = () => $('#view');
export const at = b => '@' + String(b || '').replace(/^@/, '');

export function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
export function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''; }
export function fmtDay(ts) { return ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
export function fmtDateStr(d) { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
export function fmtWhen(ts) { return ts ? new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
export function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
export function dur(ms) { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
export const money = (n, hide) => (hide ? '••••' : 'US$' + (n || 0).toFixed(2));
export const nf = n => (n || 0).toLocaleString();

export function modal(html, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = 'modal-back ' + cls;
  wrap.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  wrap.close = close;
  return wrap;
}
// "Tap again to confirm" for anything that can't be undone
export function confirmTap(btn, label, fn) {
  btn.onclick = async () => {
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = old; }, 4000); return; }
    btn.dataset.armed = '';
    await fn();
  };
}

const native = () => window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
async function saveNative(bytes, filename) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  const res = await Filesystem.writeFile({ path: filename, data: btoa(s), directory: 'CACHE' });
  await Share.share({ title: filename, url: res.uri, dialogTitle: 'Save or print ' + filename });
}
export function saveFile(bytes, filename, mime = 'application/pdf') {
  if (native()) { saveNative(bytes, filename).catch(err => toast('Could not save the file: ' + err.message, 'error')); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Open a PDF in a new tab (to print), or share it on the Android app.
export function printPdf(bytes, filename) {
  if (native()) return saveFile(bytes, filename);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const w = window.open(url, '_blank');
  if (!w) saveFile(bytes, filename);
}
export function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}
export function readText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(file); });
}
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show';
export const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
