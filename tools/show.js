/* 出一组展示图：外观 / 单层 / 室内 / 走廊管线 / 流向 / 窗
   相机位置都用房间包围盒算，避免"镜头卡在墙里" */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
const tag = process.argv[2] || '';

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 }
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2200));

  const shot = async (name, fn) => {
    await p.evaluate(fn);
    await new Promise(r => setTimeout(r, 1100));
    await p.screenshot({ path: OUT + name + tag + '.png' });
    console.log('·', name);
  };

  await shot('show-1-all', () => {
    BIM.scene.setXray(false);
    BIM.scene.setFocus(0); BIM.scene.viewAll();
    BIM.scene.setCam(44, 42, 36, 16.5, 8.0, -7.8);
  });

  await shot('show-2-floor', () => { BIM.scene.setFocus(2); });

  await shot('show-3-room', () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    BIM.scene.setCam(r.x1 - .9, r.elev + 1.6, -(r.y1 - .9), r.x0 + .7, r.elev + 1.95, -(r.y0 + .7));
  });

  await shot('show-4-corridor', () => {
    const r = BIM_MODEL.rooms.find(x => x.floor === 2 && x.zone === 'corr');
    BIM.scene.setCam(r.x0 + 3, r.elev + 1.55, -(r.y0 + 1.9), r.x1 - 4, r.elev + 2.3, -(r.y1 - .4));
  });

  await shot('show-5-flow', () => {
    BIM.scene.setFlow(true);
    BIM.scene.setXray(false);
    const r = BIM_MODEL.rooms.find(x => x.floor === 2 && x.zone === 'corr');
    BIM.scene.setCam(r.x0 + 3, r.elev + 1.55, -(r.y0 + 1.9), r.x1 - 4, r.elev + 2.3, -(r.y1 - .4));
  });

  await shot('show-6-window', () => {
    BIM.scene.setFlow(false);
    BIM.scene.setXray(false);
    BIM.detail.setCeiling(true);
    const r = BIM_MODEL.rooms.find(x => x.num === '204');
    BIM.scene.setCam((r.x0 + r.x1) / 2, r.elev + 1.7, -(r.y0 + 4.4), (r.x0 + r.x1) / 2 - .4, r.elev + 1.35, -(r.y0 + .2));
  });

  const st = await p.evaluate(() => BIM.detail.flowState());
  console.log('流向', JSON.stringify(st));
  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
