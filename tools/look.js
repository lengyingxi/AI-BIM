/* 视觉检查：加载页面 → 报错 → 出几张图（全楼 / 单层 / 单间 / 流向）
   用法：node tools/look.js [后缀] */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
const tag = process.argv[2] || '';

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.scene && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2200));

  const info = await p.evaluate(() => {
    const n = k => { let c = 0; BIM.scene.root().traverse(o => { if (o.userData && o.userData.kind === k) c++; }); return c; };
    return {
      errs: window.__errs || [],
      ceil: n('ceil'), furn: n('furn'), floorfin: n('floorfin'), roof: n('roof'),
      win: n('window'), duct: n('duct'),
      mats: Object.keys(BIM.scene.floorOf(2).mats).length,
      tri: BIM.scene.root() ? (() => { let t = 0; BIM.scene.root().traverse(o => { if (o.isMesh) t++; }); return t; })() : 0
    };
  });
  console.log('对象：', JSON.stringify(info));

  await p.screenshot({ path: OUT + 'look-all' + tag + '.png' });

  await p.evaluate(() => BIM.scene.setFocus(2));
  await new Promise(r => setTimeout(r, 1400));
  await p.screenshot({ path: OUT + 'look-f2' + tag + '.png' });

  await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.num === '202');
    BIM.scene.focusRoom(r);
  });
  await new Promise(r => setTimeout(r, 1400));
  await p.screenshot({ path: OUT + 'look-room' + tag + '.png' });

  await p.evaluate(() => { BIM.scene.setFocus(2); BIM.scene.setFlow(true); });
  await new Promise(r => setTimeout(r, 900));
  await p.evaluate(() => BIM.scene.setCam(6, 8.6, 6, 16, 7.2, -7));
  await new Promise(r => setTimeout(r, 1200));
  await p.screenshot({ path: OUT + 'look-flow' + tag + '.png' });

  const st = await p.evaluate(() => BIM.detail.flowState());
  console.log('流向：', JSON.stringify(st));
  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

function BIT() { }
