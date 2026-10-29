/* 六项细化的浏览器端验收 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'outputs') + '/';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1400);

  // 这套用例校验几何/碰撞/方位等确定性逻辑，固定走本地规则规划，避免被网关延迟干扰
  await p.evaluate(() => { window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }); });
  const say = async (t, w) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, typing: !!document.querySelector('.msg.ai.typing') }));
      if (!st.typing && st.n > before) break;
    }
    await sleep(w || 1200);
  };
  const shot = n => p.screenshot({ path: OUT + 'feat-' + n + '.png' });
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | '));
  const clickBim = async (x, y, z, w) => {
    const q = await p.evaluate((a, b2, c) => BIM.scene.project(a, b2, c), x, y, z);
    await p.mouse.click(q.x, q.y); await sleep(w || 1500);
  };
  const ok = (name, cond, extra) => console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''));

  console.log('\n【1】同房间多台设备');
  await say('把空压机放到2楼202');
  await clickBim(9.9, 3.3, 4.5);                 // 202 室（2F 3.3~6.6? 用房间中心）
  let st = await p.evaluate(() => ({ n: BIM.app.state.placed.length, room: BIM.app.state.placed[0] && BIM.app.state.placed[0].room }));
  console.log('  第一台 placed=', st.n, 'room=', st.room);
  await say('再放一台空压机到2楼202');
  await clickBim(12.6, 5.4, 4.5);
  const second = await lastAI();
  const st2 = await p.evaluate(() => BIM.app.state.placed.map(e => ({ room: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })));
  ok('第二台落在同一间房', st2.length === 2 && st2[0].room === st2[1].room, JSON.stringify(st2));
  ok('结果里体现叠加', /已有|合计|这块板上已有/.test(second), second.slice(0, 90));
  await shot('1-multi');

  console.log('\n【4】已有东西就不让放');
  await say('再放一台空压机到2楼202');
  await clickBim(st2[1].x, st2[1].y, 4.5);        // 正好点在第二台上
  const refuse = await lastAI();
  const blocked = await p.evaluate(() => document.querySelectorAll('.res.bad').length);
  ok('点在被占位置被拒', /放不下|占着|撞|太近/.test(refuse), refuse.slice(0, 80));
  ok('界面出现拒绝卡片', blocked > 0, 'bad卡片 ' + blocked);
  const chipTxt = await p.evaluate(() => [...document.querySelectorAll('.chips')].pop().innerText.replace(/\n/g, ' / '));
  ok('给了挪位建议', /挪到|换/.test(chipTxt), chipTxt);
  await shot('4-blocked');

  console.log('\n【5】语音方位：靠里');
  await say('把服务器机柜放到2楼203靠里一些', 1600);
  const st3 = await p.evaluate(() => {
    const e = BIM.app.state.placed[BIM.app.state.placed.length - 1];
    return e ? { room: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2), n: BIM.app.state.placed.length } : null;
  });
  ok('不用点就直接落位', st3 && st3.n >= 3, JSON.stringify(st3));
  await shot('5-pref');

  console.log('\n【2】任意尺寸门');
  // 说了"左边"= 已经指明哪面墙，直接落位（不再让用户点一下）
  await say('在3楼306左边开一个1.5米宽2.2米高的门', 1500);
  const d2 = await p.evaluate(() => {
    const m = BIM.app.model();
    const d = m.doors[m.doors.length - 1];
    const r = m.rooms.find(x => x.num === '306');
    const west = (r.sides || {}).west;
    return d && d.added ? { w: d.w, h: d.h, floor: d.floor, onWest: d.wall === west } : null;
  });
  ok('说了方位就直接落位 1.5×2.2', d2 && Math.abs(d2.w - 1.5) < 0.01 && Math.abs(d2.h - 2.2) < 0.01,
    JSON.stringify(d2));
  ok('落在 306 的西墙（"左边"按镜头换算）', d2 && d2.onWest === true, JSON.stringify(d2));

  // 什么都没说的"给我开个门"：仍然进点选模式，由用户点位置
  await say('给306开个门', 1200);
  const pend = await p.evaluate(() => {
    const p2 = BIM.app.state.pending;
    return p2 ? { w: p2.width, h: p2.height, num: p2.room.num } : null;
  });
  ok('没说方位就进点选模式', !!pend && pend.num === '306', JSON.stringify(pend));

  // 点选开一扇：在 306 的墙上试几个位置，第一个能开的位置就落一扇
  const before = await p.evaluate(() => BIM.app.model().doors.length);
  const pts = await p.evaluate(() => {
    const m = BIM.app.model();
    const r = m.rooms.find(x => x.num === '306');
    const out = [];
    ['south', 'east', 'west', 'north'].forEach(k => {
      const w = m.walls.find(x => x.id === (r.sides || {})[k]);
      if (!w) return;
      const L = Math.hypot(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]) || 1;
      const ux = (w.p2[0] - w.p1[0]) / L, uy = (w.p2[1] - w.p1[1]) / L;
      [-2.0, -1.0, 0, 1.0, 2.0].forEach(off => {
        out.push({ x: (w.p1[0] + w.p2[0]) / 2 + ux * off, y: (w.p1[1] + w.p2[1]) / 2 + uy * off, z: r.elev + 1.3 });
      });
    });
    return out;
  });
  let hitPt = null, after1 = before, msg1 = '';
  for (const pt of pts.slice(0, 8)) {
    // 每次失败后点选模式会退出，重新进一次再点
    await say('给306开个门', 650);
    await clickBim(pt.x, pt.y, pt.z, 1300);
    after1 = await p.evaluate(() => BIM.app.model().doors.length);
    msg1 = await lastAI();
    if (after1 > before) { hitPt = pt; break; }
  }
  ok('点选位置能开门', after1 === before + 1, '门数 ' + before + '→' + after1 + ' | ' + msg1.slice(0, 50));
  const dw = await p.evaluate(() => { const d = BIM.app.model().doors[BIM.app.model().doors.length - 1]; return { w: d.w, h: d.h, added: !!d.added }; });
  ok('新增门按对话尺寸（默认 1.0×2.1）', Math.abs(dw.w - 1.0) < 0.01 && Math.abs(dw.h - 2.1) < 0.01, JSON.stringify(dw));

  // 同一个位置再点一次：应当拒绝，并给"挪一点"的建议
  if (hitPt) {
    await say('给306再开个门', 650);            // 成功后点选模式已退出，重新进
    await clickBim(hitPt.x, hitPt.y, hitPt.z, 1400);
    const after2 = await p.evaluate(() => BIM.app.model().doors.length);
    const msg2 = await lastAI();
    ok('同一位置再开被拒', after2 === after1 && /开不了|重叠|太挤|撞|挨太近/.test(msg2), '门数 ' + after1 + '→' + after2 + ' | ' + msg2.slice(0, 50));
  }
  await shot('2-door');

  console.log('\n【6】阀门影响路径');
  await say('关闭4楼405的阀门会影响哪些房间', 1800);
  const topo = await p.evaluate(() => ({
    rows: document.querySelectorAll('#topoBody .tp-row').length,
    tree: document.querySelectorAll('#topoBody .topo-row').length,
    tags: document.querySelectorAll('#topoBody .tags span').length
  }));
  ok('列出影响路径', topo.rows >= 1, JSON.stringify(topo));
  const hl = await p.evaluate(() => {
    const row = document.querySelector('#topoBody .tp-row');
    if (!row) return null;
    row.click();
    return { on: !!document.querySelector('#topoBody .tp-row.on'), toast: document.getElementById('toast').textContent };
  });
  ok('点击路径可高亮', hl && hl.on, JSON.stringify(hl));
  await shot('6-route');

  console.log('\n【3】上传自己的 IFC');
  const input = await p.$('#fileIfc');
  await input.uploadFile(path.join(ROOT, 'outputs/AIBIM_Haibin_Tower_A.ifc'));
  await sleep(4200);
  const imp = await p.evaluate(() => {
    const m = BIM.app.model();
    return { rooms: m.rooms.length, walls: m.walls.length, ducts: m.ducts.length, valves: m.valves.length, doors: m.doors.length, floors: m.floors.length, src: m.meta.source };
  });
  ok('IFC 解析成模型', imp.rooms > 40 && imp.src === 'ifc', JSON.stringify(imp));
  const impMsg = await lastAI();
  ok('对话给了导入回执', /模型换好了|已导入/.test(impMsg), impMsg.slice(0, 80));
  await shot('3-ifc');

  // 导入模型上还能放设备和开门
  const r0 = await p.evaluate(() => {
    const m = BIM.app.model();
    const r = m.rooms.filter(x => x.zone !== 'corr')[2] || m.rooms[0];
    return { num: r.num, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, elev: r.elev };
  });
  await say('把空压机放到' + r0.num, 1200);
  await clickBim(r0.x, r0.y, r0.elev + 0.3, 1600);
  // 门偏小时最后一条会是「要不要拓门」的追问，所以这里看最近三条 AI 话
  const impPlace = await p.evaluate(() => [...document.querySelectorAll('.msg.ai')].slice(-3).map(x => x.innerText).join('\n'));
  ok('导入模型上能放设备', /安全系数|可以放|当心|不建议|放不下|放好了|搬不进来/.test(impPlace), impPlace.replace(/\n+/g, ' | ').slice(-90));
  await shot('3b-ifc-place');

  // 导入模型上开门，验碰撞判断走的是新几何
  const d0 = await p.evaluate(() => BIM.app.model().doors.length);
  await say('在' + r0.num + '室开一个1.2米的门', 1200);
  const wp2 = await p.evaluate(num => {
    const m = BIM.app.model();
    const r = m.rooms.find(x => x.num === num);
    const ids = Object.values(r.sides || {});
    const w = m.walls.find(x => x.id === ids[0]);
    if (!w) return null;
    const L = Math.hypot(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]);
    return { x: w.p1[0] + (w.p2[0] - w.p1[0]) * 0.5, y: w.p1[1] + (w.p2[1] - w.p1[1]) * 0.5, z: w.base + 1.3 };
  }, r0.num);
  if (wp2) {
    await clickBim(wp2.x, wp2.y, wp2.z, 1700);
    const d1 = await p.evaluate(() => BIM.app.model().doors.length);
    const msg = await lastAI();
    ok('导入模型上能判碰撞开门', d1 >= d0 && /可以开|开不了/.test(msg), '门数 ' + d0 + '→' + d1 + ' | ' + msg.slice(0, 60));
  }
  await shot('3c-ifc-door');

  console.log('\n【5b】靠走廊开门的方位识别');
  await p.reload({ waitUntil: 'load' });
  await sleep(2000);
  await p.waitForFunction(() => window.BIM && window.BIM.app, { timeout: 20000 });
  await say('在3楼306靠走廊的位置开一个1.5米宽的门', 1600);
  const side = await p.evaluate(() => {
    const m = BIM.app.model();
    const d = m.doors[m.doors.length - 1];
    const r = m.rooms.find(x => x.num === '306');
    if (!d || !d.added || !r) return null;
    const sides = r.sides || {};
    let on = null;
    Object.keys(sides).forEach(k => { if (sides[k] === d.wall) on = k; });
    return { side: on, w: d.w, num: r.num };
  });
  ok('方位选到走廊那面墙', !!side && Math.abs(side.w - 1.5) < 0.01 && (side.side === 'south' || side.side === 'north'),
    JSON.stringify(side));
  await shot('5b-corridor');

  console.log('\n错误数:', errs.length);
  errs.slice(0, 6).forEach(e => console.log('   ! ' + e));
  const of = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log('横向溢出:', of);

  await b.close();
})();
