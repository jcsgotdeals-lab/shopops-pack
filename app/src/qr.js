// Minimal QR code generator (byte mode, error correction M, versions 1-10), for invite links.
const ECC = { // version: [ecPerBlock, [[blocks, dataPerBlock], ...]]
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256) arithmetic
const EXP = new Array(512), LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGen(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const n = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= mul(g[j], EXP[i]); }
    g = n;
  }
  return g;
}
function rsRem(data, deg) {
  const g = rsGen(deg);
  const r = data.concat(new Array(deg).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c);
  }
  return r.slice(data.length);
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const dataCw = ECC[v][1].reduce((n, [b, d]) => n + b * d, 0);
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCw * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('Text too long for a QR code');
  const [ecLen, groups] = ECC[ver];
  const dataCw = groups.reduce((n, [b, d]) => n + b * d, 0);
  // bit stream
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; cw.length < dataCw; p++) cw.push(p % 2 ? 0x11 : 0xec);
  // blocks + interleave
  const blocks = [];
  let k = 0;
  for (const [b, d] of groups) for (let i = 0; i < b; i++) { const data = cw.slice(k, k + d); k += d; blocks.push({ data, ec: rsRem(data, ecLen) }); }
  const final = [];
  const maxD = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxD; i++) blocks.forEach(b => { if (i < b.data.length) final.push(b.data[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach(b => final.push(b.ec[i]));

  const size = 17 + ver * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inR = dr >= 0 && dr <= 6, inC = dc >= 0 && dc <= 6;
      const v = inR && inC && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(rr, cc, v);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // dark module
  // reserve format areas
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) set(8, size - 1 - i, false); if (!fn[size - 1 - i][8]) set(size - 1 - i, 8, false); }
  // version info (v7+)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((vbits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b); set(c, a, b);
    }
  }
  // data placement (zigzag)
  const dataBits = [];
  final.forEach(b => { for (let i = 7; i >= 0; i--) dataBits.push((b >>> i) & 1); });
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        m[r][c] = bi < dataBits.length ? dataBits[bi] === 1 : false;
        bi++;
      }
    }
  }
  // pick the mask with the lowest simple penalty
  const masks = [
    (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best = null;
  for (let mk = 0; mk < 8; mk++) {
    const g = m.map((row, r) => row.map((v, c) => (fn[r][c] ? v : v !== masks[mk](r, c))));
    drawFormat(g, size, mk);
    const p = penalty(g, size);
    if (!best || p < best.p) best = { p, g };
  }
  return best.g;
}
function drawFormat(g, size, mask) {
  const data = (0 << 3) | mask; // ECC level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = i => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
  g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
  for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
  g[size - 8][8] = true;
}
function penalty(g, size) {
  let p = 0, dark = 0;
  for (let r = 0; r < size; r++) {
    let runR = 1, runC = 1;
    for (let c = 0; c < size; c++) {
      if (g[r][c]) dark++;
      if (c > 0) {
        if (g[r][c] === g[r][c - 1]) { runR++; if (runR === 5) p += 3; else if (runR > 5) p++; } else runR = 1;
        if (g[c][r] === g[c - 1][r]) { runC++; if (runC === 5) p += 3; else if (runC > 5) p++; } else runC = 1;
      }
      if (r > 0 && c > 0 && g[r][c] === g[r - 1][c] && g[r][c] === g[r][c - 1] && g[r][c] === g[r - 1][c - 1]) p += 3;
    }
  }
  p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}
// SVG markup for a QR code
export function qrSvg(text, px = 180) {
  const g = qrMatrix(text);
  const n = g.length, q = 4, total = n + q * 2;
  let d = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + q} ${r + q}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
