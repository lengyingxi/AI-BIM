const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1600, height: 950, deviceScaleFactor: 2 },
  });
  const c = b.defaultBrowserContext();
  await c.overridePermissions('http://127.0.0.1:8823', ['microphone']);
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1600);
  await p.screenshot({ path: 'outputs/ui-4-mic.png', clip: { x: 0, y: 800, width: 340, height: 150 } });
  const s = await p.evaluate(() => ({ cls: document.getElementById('btnMic').className, bar: !document.getElementById('listenBar').hidden, txt: document.getElementById('listenBar').innerText }));
  console.log(JSON.stringify(s));
  await b.close();
})();
