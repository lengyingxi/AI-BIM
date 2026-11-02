/* 三件事的可视化取证：
     ① 绕行段 + 弯头接头   ② 门窗改线的实际走向   ③ 断电：配电箱断路器 + 回路影响
   用法：SITE=http://127.0.0.1:8899 node tools/shot3.js            */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8899';
const OUT = 'outputs';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 }
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/asr\/warm/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2600);
  /* 取证用：把模型树面板收起来，别挡画面 */
  await p.evaluate(() => {
    const t = document.querySelector('[data-close="pTree"]');
    if (t) t.click();
  });

  const shot = async name => { await p.screenshot({ path: OUT + '/' + name }); console.log('  → ' + OUT + '/' + name); };

  /* ---------- ① 弯头 / 接头 ---------- */
  console.log('【1】弯头与接头');
  const j = await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene, M = BIM_MODEL;
    const D = E.ready();
    S.setFocus(2, false);
    S.showConduits(true);
    S.setXray(true);
    S.showCircuit(null);
    /* 站在 2 楼走廊中段，稍微俯视，看得见墙角 */
    const f = M.floors.find(x => x.level === 2);
    S.setCam(16.5 - 9, f.elev + 5.2, -(7.8) - 11, 16.5, f.elev + 2.4, -7.8);
    return { joints: (D.joints || []).length, conduits: D.conduits.length };
  });
  console.log('  接头 ' + j.joints + ' 个 / 管段 ' + j.conduits + ' 段');
  await sleep(1200);
  await shot('p1_elbows.png');

  /* ①b 近距离看墙角：弯头到底接上没有（先看贴地的插座管，再看吊顶里的照明管） */
  const cams = await p.evaluate(() => {
    return { r: (BIM_MODEL.rooms.find(x => x.num === '201') || BIM_MODEL.rooms.find(x => x.floor === 2)) };
  });
  const room = cams.r;
  const el = await p.evaluate(lv => (BIM_MODEL.floors.find(f => f.level === lv) || {}).elev || 0, room.floor);
  await p.evaluate(() => {
    if (BIM.detail && BIM.detail.setCeiling) BIM.detail.setCeiling(false);       // 吊顶挡住看不见管
    if (BIM.detail && BIM.detail.setFurniture) BIM.detail.setFurniture(false);   // 家具也挡
  });
  /* 站在房间中央、贴着墙角高度看：墙面半透明，能看清管子在墙角怎么拐 */
  await p.evaluate(o => {
    const S = BIM.scene;
    const cx = (o.x0 + o.x1) / 2, cy = (o.y0 + o.y1) / 2;
    S.setCam(cx, o.el + 1.55, -cy, o.x1, o.el + 1.35, -o.y1);
  }, { x0: room.x0, y0: room.y0, x1: room.x1, y1: room.y1, el: el });
  await sleep(700);
  await shot('p1b_corner_low.png');
  await p.evaluate(o => {
    const S = BIM.scene;
    const cx = (o.x0 + o.x1) / 2, cy = (o.y0 + o.y1) / 2;
    S.setCam(cx, o.el + 3.1, -cy, o.x1, o.el + 2.85, -o.y1);
  }, { x0: room.x0, y0: room.y0, x1: room.x1, y1: room.y1, el: el });
  await sleep(700);
  await shot('p1c_corner_high.png');

  /* ---------- ② 改线走向 ---------- */
  console.log('【2】门窗改线的实际走向');
  const r = await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene, M = BIM_MODEL;
    /* 挑一根撞上会挡路的插座管：找 2 楼某间房贴地的房间支线 */
    const c0 = E.conduitsOf({ floor: 2, kind: 'socket', layer: 'room' })[0];
    const wall = M.walls.find(w => w.id === c0.wall);
    const hole = { at0: c0.at0 + 0.4, at1: c0.at0 + 1.4, z0: 0, z1: 2.1 };
    const plan = E.planReroute(c0, hole);
    S.showConduits(true);
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    S.isolateConduits([c0]);
    S.markConduits([c0], 0xff3b30);
    const mesh = S.showReroute(plan, 0x17a673);
    /* 镜头怼到洞口正前方 */
    const a = E.axis(wall);
    const at = (hole.at0 + hole.at1) / 2;
    const mx = a.ax + a.ux * at, my = a.ay + a.uy * at;
    const nx = -a.uy, ny = a.ux;
    S.setCam(mx + nx * 2.6, wall.base + 1.9, -(my + ny * 2.6), mx, wall.base + 1.5, -my);
    return { ok: !!plan.ok, pts: plan.pts.length, drew: !!mesh, wall: wall.id, why: plan.why };
  });
  console.log('  改线方案 ' + (r.ok ? '成立' : '不成立') + '，折点 ' + r.pts + '，绘制 ' + (r.drew ? '成功' : '失败') + ' — ' + r.why);
  await sleep(1100);
  await shot('p2_reroute.png');

  /* ---------- ③ 断电：聚焦配电箱 + 断路器 off ---------- */
  console.log('【3】断电：配电箱');
  await p.evaluate(() => BIM.app.send('把2楼第1回路断电'));
  await sleep(3600);
  const s3 = await p.evaluate(() => ({
    focus: BIM.scene.focus,
    circ: (BIM.elec.circuit('L2A') || {}).on,
    label: (BIM.elec.circuit('L2A') || {}).label,
    chips: [].map.call(document.querySelectorAll('.chips button'), b => b.textContent)
  }));
  console.log('  聚焦楼层 ' + s3.focus + '，' + s3.label + ' on=' + s3.circ + '，气泡：' + s3.chips.join(' / '));
  await shot('p3_panel_off.png');

  /* ---------- ④ 点气泡：查看回路影响 ---------- */
  console.log('【4】查看回路影响');
  const clicked = await p.evaluate(() => {
    const bs = [].slice.call(document.querySelectorAll('.chips button'));
    const t = bs.filter(x => /查看回路影响/.test(x.textContent))[0];
    if (!t) return false;
    t.click();
    return true;
  });
  await sleep(2800);
  console.log('  点击气泡 ' + (clicked ? '成功' : '没找到'));
  await shot('p4_impact.png');

  if (errs.length) console.log('\n错误：\n' + errs.slice(0, 6).join('\n'));
  else console.log('\n错误：none');
  await b.close();
})();
