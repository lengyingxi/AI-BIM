/* 设备实体模型陈列：把 12 种设备摆在楼外空地上排成一排，出图看真实度
   用法：node tools/equipshot.js [tag] */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'outputs') + '/';
const tag = process.argv[2] || '';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 940 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => window.BIM && BIM.scene && BIM.detail && BIM.detail.equipMesh, { timeout: 30000 });
  await sleep(1200);

  // 藏侧栏 / 工具栏 / 家具，全屏看设备
  await p.evaluate(() => {
    const s = document.querySelector('#side') || document.querySelector('.side');
    if (s) s.style.display = 'none';
    const t = document.querySelector('#toolbar');
    if (t) t.style.display = 'none';
    if (BIM.scene.setFurniture) BIM.scene.setFurniture(false);
  });

  // 楼外南侧空地：2 排 × 6 台，正面朝南（rot=0 → 局部 +z = BIM 南）
  const info = await p.evaluate(() => {
    const M = BIM.app.model();
    const lib = M.equipmentLibrary || [];
    const GAP = 1.6, PER = 6, ROWZ = [10, 17];   // 远排 / 近排 的 world z
    const placed = [];
    const widths = [0, 1].map(r => lib.slice(r * PER, (r + 1) * PER).reduce((s, d) => s + d.w + GAP, -GAP));
    const maxW = Math.max.apply(null, widths);
    [0, 1].forEach(r => {
      let x = (maxW - widths[r]) / 2;
      lib.slice(r * PER, (r + 1) * PER).forEach(d => {
        const eq = {
          id: 'DISP-' + d.id, lib: d.id, name: d.name, weight: d.weight,
          w: d.w, d: d.d, h: d.h, shape: d.shape, color: d.color,
          x: x + d.w / 2, y: -ROWZ[r], floor: 1, floorElev: 0, room: null, rot: 0
        };
        BIM.scene.addEquipment(eq);
        placed.push({ id: d.id, name: d.name, w: d.w, d: d.d, h: d.h, x: +eq.x.toFixed(2), z: ROWZ[r] });
        x += d.w + GAP;
      });
    });
    BIM.scene.setFocus(1, false);
    return { n: placed.length, placed: placed, maxW: +maxW.toFixed(2) };
  });
  console.log('摆设：', info.n, '台，2 排 × 6，排宽', info.maxW, 'm');
  console.log(info.placed.map(e => e.id + ' ' + e.name).join(' | '));

  // 全景：高角度俯视，压住透视，两排都在画面里
  await p.evaluate(mw => {
    BIM.scene.setCam(mw / 2 - 7, 15, 17 + 25, mw / 2, .5, 13.2);
  }, info.maxW);
  await sleep(1700);
  await p.screenshot({ path: OUT + 'eq-all' + tag + '.png' });

  // 近景：一行三台（阵列里每行正好三台）
  const groups = [];
  for (let i = 0; i < info.placed.length; i += 3) groups.push([i, Math.min(i + 3, info.placed.length)]);
  for (let i = 0; i < groups.length; i++) {
    const [a, b2] = groups[i];
    const r = await p.evaluate((list, g) => {
      const sel = list.slice(g[0], g[1]);
      const cx = sel.reduce((s, e) => s + e.x, 0) / sel.length;
      const w = sel.reduce((s, e) => s + e.w, 0) + (sel.length - 1) * .6;
      const z = sel[0].z;
      BIM.scene.setCam(cx - w * .26, 2.45, z + 2.6 + w * .72, cx, 1.05, z);
      return { cx: +cx.toFixed(2), w: +w.toFixed(2) };
    }, info.placed, [a, b2]);
    await sleep(1300);
    await p.screenshot({ path: OUT + 'eq-' + (i + 1) + tag + '.png' });
    console.log('  近景', i + 1, '组：x=' + r.cx, '宽', r.w);
  }

  const stats = await p.evaluate(() => {
    let mesh = 0, tri = 0;
    BIM.scene.root().traverse(o => {
      if (o.isMesh && o.userData && o.userData.kind === 'equip') {
        mesh++;
        const g = o.geometry;
        tri += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    return { mesh: mesh, tri: tri };
  });
  console.log('设备相关 mesh：', stats.mesh, '  三角面：', Math.round(stats.tri));
  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
