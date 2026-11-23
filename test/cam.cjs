const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture='+__dirname+'/cam.y4m'] });
  const ctx = await b.newContext({ permissions: ['camera'] }); const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8765/#shows'); await p.waitForSelector('#new-show');
  await p.fill('#show-name','Cam'); await p.click('#new-show button'); await p.waitForSelector('#batch-form');
  await p.fill('#b-name','Toys'); await p.fill('#b-count','10');
  await Promise.all([p.waitForEvent('download'), p.click('#batch-form button[type=submit]')]);
  await p.goto('http://127.0.0.1:8765/#import'); await p.setInputFiles('#pdf-input', __dirname+'/fixture-tiktok.pdf');
  await p.waitForSelector('#commit-import'); await p.click('#commit-import'); await p.waitForSelector('.tray-tile');
  await p.goto('http://127.0.0.1:8765/#scan'); await p.click('#cam-btn');
  await p.waitForFunction(() => !document.querySelector('#result').classList.contains('idle'), null, { timeout: 15000 });
  console.log('camera result:', (await p.innerText('#result')).replace(/\n/g,' | '), '| BarcodeDetector:', await p.evaluate(()=>'BarcodeDetector' in window));
  console.log('errors', errs); await b.close();
})();
