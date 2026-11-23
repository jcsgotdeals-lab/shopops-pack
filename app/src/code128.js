// Code 128 (set B) encoder and a scanline decoder for camera frames.
// Widths are bar/space module counts per symbol value 0..106.
const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112').split(' ');
export const PATTERNS = P;
const START_B = 104, STOP = 106;

export function encode(text) {
  const vals = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 127) throw new Error('Unsupported character in barcode: ' + ch);
    vals.push(c - 32);
  }
  let sum = START_B;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, STOP);
  // modules: array of widths alternating bar, space, bar...
  const widths = [];
  vals.forEach(v => P[v].split('').forEach(d => widths.push(+d)));
  return widths; // starts with a bar
}
export function totalModules(widths) { return widths.reduce((a, b) => a + b, 0); }

// Draw onto a canvas 2d context (for previews)
export function drawToCanvas(ctx, text, x, y, w, h) {
  const widths = encode(text);
  const total = totalModules(widths);
  const m = w / total;
  let cx = x;
  widths.forEach((wd, i) => {
    if (i % 2 === 0) ctx.fillRect(Math.round(cx), y, Math.max(1, Math.round(cx + wd * m) - Math.round(cx)), h);
    cx += wd * m;
  });
}

// ---- Decoder ----
const lookup = new Map(P.slice(0, 106).map((p, i) => [p, i]));

function matchSymbol(runs, start, unit) {
  // runs: 6 widths; normalize to modules summing to 11
  const sum = runs.slice(start, start + 6).reduce((a, b) => a + b, 0);
  const u = sum / 11;
  let key = '';
  for (let i = start; i < start + 6; i++) {
    let m = Math.round(runs[i] / u);
    if (m < 1) m = 1; if (m > 4) m = 4;
    key += m;
  }
  if (lookup.has(key)) return lookup.get(key);
  // tolerant match: closest pattern by squared error
  let best = -1, bestErr = Infinity;
  for (let v = 0; v < 106; v++) {
    const p = P[v];
    let err = 0;
    for (let i = 0; i < 6; i++) { const d = runs[start + i] / u - +p[i]; err += d * d; }
    if (err < bestErr) { bestErr = err; best = v; }
  }
  return bestErr < 0.9 ? best : -1;
}

// runs: alternating widths starting with a bar (dark)
export function decodeRuns(runs) {
  for (let s = 0; s + 6 * 3 + 7 <= runs.length; s += 2) {
    const v0 = matchSymbol(runs, s);
    if (v0 !== 104 && v0 !== 103 && v0 !== 105) continue;
    const vals = [v0];
    let i = s + 6;
    let ok = false;
    while (i + 6 <= runs.length) {
      // stop pattern check: 7 elements 2331112
      if (i + 7 <= runs.length) {
        const seg = runs.slice(i, i + 7), sum = seg.reduce((a, b) => a + b, 0), u = sum / 13;
        const key = seg.map(r => Math.max(1, Math.min(4, Math.round(r / u)))).join('');
        if (key === '2331112') { ok = true; break; }
      }
      const v = matchSymbol(runs, i);
      if (v < 0) break;
      vals.push(v);
      i += 6;
      if (vals.length > 60) break;
    }
    if (!ok || vals.length < 3) continue;
    const check = vals.pop();
    let sum = vals[0];
    for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
    if (sum % 103 !== check) continue;
    // decode set B / C (we only print B; support C digits and switches for other labels)
    let set = vals[0] === 103 ? 'A' : vals[0] === 104 ? 'B' : 'C';
    let out = '';
    for (let k = 1; k < vals.length; k++) {
      const v = vals[k];
      if (set === 'C') {
        if (v < 100) out += String(v).padStart(2, '0');
        else if (v === 100) set = 'B'; else if (v === 101) set = 'A';
      } else {
        if (v === 99) { set = 'C'; continue; }
        if (set === 'B' && v === 101) { set = 'A'; continue; }
        if (set === 'A' && v === 100) { set = 'B'; continue; }
        if (v >= 96) continue; // FNC/shift ignored
        if (set === 'B') out += String.fromCharCode(v + 32);
        else out += v < 64 ? String.fromCharCode(v + 32) : String.fromCharCode(v - 64);
      }
    }
    return out;
  }
  return null;
}

// Scan a grayscale row (Uint8 luminance array) for a Code128 symbol, both directions.
export function decodeRow(lum) {
  const n = lum.length;
  // adaptive threshold: local mean over window
  let min = 255, max = 0;
  for (let i = 0; i < n; i++) { if (lum[i] < min) min = lum[i]; if (lum[i] > max) max = lum[i]; }
  if (max - min < 40) return null;
  const win = Math.max(16, n >> 4);
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + lum[i];
  const runs = [];
  let cur = null, len = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win), b = Math.min(n, i + win);
    const mean = (pref[b] - pref[a]) / (b - a);
    const thr = Math.min(mean, (min + max) / 2 + (max - min) * 0.1);
    const dark = lum[i] < thr;
    if (cur === null) { cur = dark; len = 1; }
    else if (dark === cur) len++;
    else { runs.push([cur, len]); cur = dark; len = 1; }
  }
  runs.push([cur, len]);
  const tryDir = arr => {
    const first = arr.findIndex(r => r[0]);
    if (first < 0) return null;
    const widths = arr.slice(first).map(r => r[1]);
    return decodeRuns(widths);
  };
  return tryDir(runs) || tryDir(runs.slice().reverse());
}

// Decode from ImageData by sampling several horizontal lines (and vertical if needed)
export function decodeImageData(img) {
  const { width: w, height: h, data } = img;
  const lines = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];
  const row = new Uint8Array(w);
  for (const f of lines) {
    const y = Math.floor(h * f);
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      row[x] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    const r = decodeRow(row);
    if (r) return r;
  }
  const col = new Uint8Array(h);
  for (const f of [0.5, 0.4, 0.6]) {
    const x = Math.floor(w * f);
    for (let y = 0; y < h; y++) {
      const p = (y * w + x) * 4;
      col[y] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    const r = decodeRow(col);
    if (r) return r;
  }
  return null;
}
