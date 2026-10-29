/* 设备在真实房间里的观感（确定性摆位，不依赖大模型）
   用法：node tools/equiproom.js [tag] */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'outputs') + '/';
const tag = process.argv[2] || '';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => window.BIM && BIM.app && BIM.detail && BIM.detail.equipMesh, { timeout: 30000 });
  await sleep(1500);

  // 藏侧栏 + 收家具（看设备时不挡视线）
  await p.evaluate(() => {
    const s = document.querySelector('.side'); if (s) s.style.display = 'none';
    const a = document.querySelector('.app'); if (a) a.style.gridTemplateColumns = '1fr';
    if (BIM.scene.setFurniture) BIM.scene.setFurniture(false);
    if (BIM.scene.setCeiling) BIM.scene.setCeiling(false);   // 收吊顶，像剖切一样看设备
  });

  const place = (ids, roomNum) => p.evaluate((ids, roomNum) => {
    const M = BIM.app.model();
    const r = M.rooms.find(x => x.num === roomNum);
    const lib = M.equipmentLibrary;
    let x = r.x0 + .45;
    const out = [];
    ids.forEach((id, i) => {
      const d = lib.find(q => q.id === id);
      const eq = {
        id: 'SHOW' + i, lib: d.id, name: d.name, weight: d.weight,
        w: d.w, d: d.d, h: d.h, shape: d.shape, color: d.color,
        x: x + d.w / 2, y: r.y0 + d.d / 2 + .14, floor: r.floor, floorElev: r.elev, room: r.id
      };
      BIM.scene.addEquipment(eq);
      BIM.app.state.placed.push(eq);
      out.push({ name: d.name, w: d.w, x: +eq.x.toFixed(2), rot: +(eq.rotApplied || 0).toFixed(2) });
      x += d.w + .3;
    });
    return { room: roomNum, used: +(x - r.x0).toFixed(2), roomW: +(r.x1 - r.x0).toFixed(2), out: out };
  }, ids, roomNum);

  const shot = async (roomNum, name) => {
    await p.evaluate(n => BIM.scene.setFocus(BIM.app.model().rooms.find(x => x.num === n).floor, false), roomNum);
    await sleep(1100);
    await p.evaluate(n => {
      const r = BIM.app.model().rooms.find(x => x.num === n);
      // 站到设备正前方（设备摆在南墙、正面朝房间），平视看细节
      const cx = (r.x0 + r.x1) / 2;
      BIM.scene.setCam(cx + .5, r.elev + 1.68, -(r.y0 + 2.6), cx - .4, r.elev + 1.02, -(r.y0 + 1.0));
    }, roomNum);
    await sleep(900);
    await p.screenshot({ path: OUT + name + tag + '.png' });
  };

  console.log('① 202 三台：', JSON.stringify(await place(['EQ-01', 'EQ-02', 'EQ-05'], '202')));
  await shot('202', 'room-eq-1');

  console.log('② 203 柴发：', JSON.stringify(await place(['EQ-10'], '203')));
  await shot('203', 'room-eq-2');

  console.log('③ 204 冷水机组：', JSON.stringify(await place(['EQ-11'], '204')));
  await shot('204', 'room-eq-3');

  console.log('④ 205 精密空调+水泵：', JSON.stringify(await place(['EQ-03', 'EQ-04'], '205')));
  await shot('205', 'room-eq-4');

  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
