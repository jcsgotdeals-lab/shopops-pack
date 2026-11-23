const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('http://127.0.0.1:8765/index.html#settings');
  const r = await p.evaluate(async () => {
    const { decodeImageData } = await import('/src/code128.js');
    const img = new Image(); img.src = '/_t.png'; await img.decode();
    const out = [];
    for (const [scale, blur, rot] of [[1,0,0],[0.6,0,0],[1.5,1,0],[0.8,1.2,3],[1,0,180]]) {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const g = c.getContext('2d'); g.fillStyle = '#bbb'; g.fillRect(0,0,640,480);
      g.filter = blur ? `blur(${blur}px)` : 'none';
      g.translate(320,240); g.rotate(rot*Math.PI/180); g.scale(scale,scale);
      g.drawImage(img, -img.width/2, -img.height/2);
      out.push([scale,blur,rot, decodeImageData(g.getImageData(0,0,640,480))]);
    }
    return out;
  });
  console.log(r); await b.close();
})();
