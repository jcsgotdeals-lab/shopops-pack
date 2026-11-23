// Builds a fake TikTok-style labels+slips PDF for testing (not real data).
const { PDFDocument, StandardFonts } = require('/opt/npm-tools/node_modules/pdf-lib');
const fs = require('fs');
(async () => {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const buyers = ['Maria Lopez', 'Dan Kim', 'Maria Lopez', 'Tyrell Banks', 'Ana Silva', 'Dan Kim'];
  const lots = [[3], [1, 2], [7], [4], [5, 6], [8]];
  buyers.forEach((b, i) => {
    const oid = String(577000000000000000n + BigInt(i * 7919));
    const lp = doc.addPage([288, 432]);
    let y = 400; const t = (s, sz = 10) => { lp.drawText(s, { x: 18, y, size: sz, font: f }); y -= sz + 8; };
    t('USPS GROUND ADVANTAGE', 14); t('Ship from: ShopOps Test, Miami FL'); t(b.toUpperCase()); t('123 Main St, Orlando FL 32801');
    t('USPS TRACKING # 9400 1118 9922 3' + String(100000000 + i).slice(1) + ' 1');
    const sp = doc.addPage([288, 432]); y = 400;
    const u = (s, sz = 10) => { sp.drawText(s, { x: 18, y, size: sz, font: f }); y -= sz + 8; };
    u('Packing Slip', 16); u('Order ID: ' + oid); u('Ship to: ' + b); u('Product name            Qty');
    lots[i].forEach(n => u(`Toys #${n}     Default     Qty: 1`));
  });
  fs.writeFileSync(__dirname + '/fixture-tiktok.pdf', await doc.save());
  console.log('ok');
})();
