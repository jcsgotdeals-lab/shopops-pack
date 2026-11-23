const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ acceptDownloads: true }); const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text()));
  await p.goto('http://127.0.0.1:8765/#shows'); await p.waitForSelector('#new-show');
  await p.fill('#show-name','Split'); await p.click('#new-show button'); await p.waitForSelector('#batch-form');
  await p.fill('#b-name','Toys'); await p.fill('#b-count','10');
  await Promise.all([p.waitForEvent('download'), p.click('#batch-form button[type=submit]')]);
  await p.goto('http://127.0.0.1:8765/#import'); await p.setInputFiles('#pdf-input', __dirname+'/fixture-slips.pdf');
  await p.waitForSelector('#commit-import'); console.log((await p.innerText('.stats.big')).replace(/\n/g,' ')); await p.click('#commit-import'); await p.waitForSelector('.tray-tile');
  await p.goto('http://127.0.0.1:8765/#import'); await p.waitForSelector('#labels-input');
  await p.setInputFiles('#labels-input', __dirname+'/fixture-labels.pdf'); await p.waitForTimeout(2500);
  console.log('toast:', await p.$$eval('.toast', t=>t.map(x=>x.textContent)));
  await p.goto('http://127.0.0.1:8765/#trays'); await p.waitForSelector('#dl-labels');
  const [d] = await Promise.all([p.waitForEvent('download'), p.click('#dl-labels')]); await d.saveAs(__dirname+'/out/split-labels.pdf');
  console.log('errors', errs); await b.close();
})();
