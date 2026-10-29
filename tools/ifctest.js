const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  const load = Date.now() - t0;
  await sleep(1000);
  const info = await p.evaluate(() => {
    const b64 = window.BIM_IFC_B64;
    if (!b64) return { b64: false };
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const head = new TextDecoder().decode(buf.slice(0, 40));
    return { b64: true, bytes: blob.size, head: head.replace(/\n/g, ' ') };
  });
  // 点按钮不报错
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[5].click());
  await sleep(500);
  console.log('load(ms)', load, JSON.stringify(info), 'errs', errs);
  await b.close();
})();
