/* 诊断：净距标注在屏幕上到底有多大、镜头停在哪（不走大模型，直接调工具） */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('pageerror: ' + e.message));
  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2600);

  console.log('放设备: ' + JSON.stringify(await p.evaluate(async () =>
    await BIM.mcp.call('place_equipment', { device: '空气压缩机', room: '203', floor: 5, pref: 'inner' }))));
  await sleep(900);

  console.log('查净距: ' + JSON.stringify(await p.evaluate(async () =>
    await BIM.mcp.call('query_clearance', { target: '空气压缩机' }))));
  await sleep(1400);

  const m = await p.evaluate(() => {
    const s = window.BIM.scene;
    const cam = s.camera();
    const tgt = s.controls ? s.controls().target : null;
    const info = s.clearanceInfo();
    const px = s.clearanceScreen();
    const room = (window.BIM.app.state.lastClr || {}).room;
    return {
      info, px,
      room: room && { num: room.num, w: +(room.x1 - room.x0).toFixed(2), d: +(room.y1 - room.y0).toFixed(2) },
      cam: {
        pos: [cam.position.x, cam.position.y, cam.position.z].map(v => +v.toFixed(1)),
        tgt: tgt ? [tgt.x, tgt.y, tgt.z].map(v => +v.toFixed(1)) : null,
        dist: tgt ? +cam.position.distanceTo(tgt).toFixed(1) : null,
        fov: cam.fov, aspect: +cam.aspect.toFixed(2)
      },
      canvas: { w: cam.userData && 0, h: null }
    };
  });
  console.log(JSON.stringify(m, null, 1));

  await b.close();
})();
