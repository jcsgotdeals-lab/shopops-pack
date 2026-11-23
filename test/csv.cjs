const { chromium } = require('playwright'); const fs=require('fs');
(async () => {
  fs.writeFileSync(__dirname+'/fixture.csv', 'Order ID,Order Status,Buyer Username,Product Name,Variation,Quantity\nPlatform unique order ID.,,,,,\n577111111111111111,Awaiting shipment,toyhunter22,Toys #2,Default,1\n577111111111111112,Awaiting shipment,"Kim, Dan",Toys #1,Default,1\n577111111111111113,Awaiting shipment,toyhunter22,Toys #9,Default,1\n');
  const b = await chromium.launch(); const ctx = await b.newContext({ acceptDownloads: true, colorScheme: 'dark' }); const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text()));
  await p.goto('http://127.0.0.1:8765/#shows'); await p.waitForSelector('#new-show');
  await p.fill('#show-name','CSV show'); await p.click('#new-show button'); await p.waitForSelector('#batch-form');
  await p.fill('#b-name','Toys'); await p.fill('#b-prefix','TOY'); await p.fill('#b-start','1'); await p.fill('#b-count','10');
  await Promise.all([p.waitForEvent('download'), p.click('#batch-form button[type=submit]')]);
  await p.goto('http://127.0.0.1:8765/#import'); await p.setInputFiles('#pdf-input', __dirname+'/fixture.csv');
  await p.waitForSelector('#commit-import'); await p.click('#commit-import'); await p.waitForSelector('.tray-tile');
  console.log(await p.$$eval('.tray-tile', ts => ts.map(t => t.innerText.replace(/\n/g,' | '))));
  await p.screenshot({ path: __dirname+'/shots/8-dark-trays.png' });
  // backup + restore
  await p.goto('http://127.0.0.1:8765/#settings'); await p.waitForSelector('#backup');
  const [d] = await Promise.all([p.waitForEvent('download'), p.click('#backup')]); await d.saveAs(__dirname+'/out/backup.json');
  const [c] = await Promise.all([p.waitForEvent('download'), p.click('#csv')]); await c.saveAs(__dirname+'/out/show.csv');
  await p.setInputFiles('#restore', __dirname+'/out/backup.json'); await p.waitForTimeout(800);
  console.log('after restore shows:', await p.$$eval('.show-card h2', h => h.map(x=>x.textContent)));
  // offline reload via service worker
  await p.goto('http://127.0.0.1:8765/#trays'); await p.waitForTimeout(1500);
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForTimeout(800);
  await ctx.setOffline(true); await p.reload(); await p.waitForTimeout(1200);
  console.log('offline title:', await p.title(), '| main:', (await p.innerText('main')).slice(0,60).replace(/\n/g,' '));
  console.log('errors', errs);
  await b.close();
})();
