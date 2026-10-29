const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823', { waitUntil: 'networkidle2' });
  await sleep(2000);
  const r0 = await p.evaluate(() => ({ mode: BIM.app.voice.mode(), st: BIM.app.voice.state() }));
  console.log('初始', JSON.stringify(r0));
  await p.evaluate(() => document.getElementById('btnMic').click());
  await sleep(1500);
  const r1 = await p.evaluate(() => ({ mode: BIM.app.voice.mode(), st: BIM.app.voice.state() }));
  console.log('点麦后', JSON.stringify(r1));
  await p.evaluate(() => window.__sr.inst.emit('把空压机放到2楼202靠墙', false));
  await sleep(400);
  const r2 = await p.evaluate(() => ({ mode: BIM.app.voice.mode(), st: BIM.app.voice.state(), txt: document.getElementById('txt').value }));
  console.log('中间结果', JSON.stringify(r2));
  await sleep(3000);
  const r3 = await p.evaluate(() => ({ mode: BIM.app.voice.mode(), st: BIM.app.voice.state(), txt: document.getElementById('txt').value, n: document.querySelectorAll('.msg.ai').length }));
  console.log('3 秒后', JSON.stringify(r3));
  await b.close();
})();
