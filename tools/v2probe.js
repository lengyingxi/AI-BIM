/* 单独复现几条没有回复的指令，抓异常 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1600,950'],
    defaultViewport: { width: 1600, height: 950 }
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.evaluateOnNewDocument(() => {
    window.__rej = [];
    window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.stack || e.reason)));
  });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.tree, { timeout: 30000 });
  await sleep(2200);

  const say = async t => {
    await p.evaluate(x => { document.getElementById('txt').value = x; }, t);
    await p.evaluate(() => document.getElementById('btnSend').click());
    await sleep(4500);
    return p.evaluate(() => {
      const m = [...document.querySelectorAll('.msg')];
      return m.slice(-4).map(x => x.className + ' :: ' + x.innerText.replace(/\n+/g, ' | ').slice(0, 150));
    });
  };

  for (const q of ['把柴油发电机组放到2楼202', '关闭2楼202的通气阀门会影响哪些房间']) {
    console.log('Q:', q);
    const r = await say(q);
    r.forEach(x => console.log('   ', x));
  }
  const rej = await p.evaluate(() => window.__rej);
  console.log('未捕获 rejection:', rej.length ? rej : '无');
  console.log('错误:', errs.length ? errs.slice(0, 6) : '无');
  await b.close();
})();
