import { PATTERNS, encode, decodeRuns, decodeRow } from '../app/src/code128.js';
const bad = PATTERNS.filter((p,i)=>[...p].reduce((a,b)=>a+ +b,0)!==(i===106?13:11));
console.log('bad sums', bad, 'unique', new Set(PATTERNS).size===PATTERNS.length, PATTERNS.length);
// even-position bar sum must be even for code128 (bars total even)
console.log('parity bad', PATTERNS.slice(0,106).filter(p=>(+p[0]+ +p[2]+ +p[4])%2).length);
for (const t of ['TOY0001','A-123','Hello World!','0042']) {
  const w = encode(t); console.log(t, decodeRuns(w));
  // simulate pixel row with scale 3.3 + noise, reversed too
  const row=[]; for(let i=0;i<40;i++) row.push(240);
  w.forEach((wd,i)=>{const px=Math.round(wd*3.3);for(let k=0;k<px;k++)row.push(i%2?235+Math.random()*15:20+Math.random()*30)});
  for(let i=0;i<40;i++) row.push(240);
  console.log('  row', decodeRow(Uint8Array.from(row)), decodeRow(Uint8Array.from(row.reverse())));
}
