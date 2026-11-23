const { PDFDocument } = require('/opt/npm-tools/node_modules/pdf-lib'); const fs=require('fs');
(async()=>{ const src=await PDFDocument.load(fs.readFileSync(__dirname+'/fixture-tiktok.pdf'));
 const mk=async(idx,f)=>{const d=await PDFDocument.create(); (await d.copyPages(src,idx)).forEach(p=>d.addPage(p)); fs.writeFileSync(__dirname+'/'+f, await d.save());};
 const n=src.getPageCount(); await mk([...Array(n).keys()].filter(i=>i%2), 'fixture-slips.pdf'); await mk([...Array(n).keys()].filter(i=>i%2===0), 'fixture-labels.pdf');})();
