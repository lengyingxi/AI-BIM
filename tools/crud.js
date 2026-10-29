/* 设备 / 门的增删改查移 + 视角聚焦隔离 —— 全走工具层（大模型将来调的就是这一套）
   重点验：
     ① 相机转过以后，"往左"仍然是画面左边
     ② 设备：放 / 建议位 / 改尺寸 / 换型号 / 挪 / 撤（含整间清空）/ 撤回
     ③ 门：开 / 改尺寸 / 挪 / 查 / 列 / 拆 / 撤回
     ④ 聚焦只显示这一间、还原全楼
*/
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

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

  await p.goto(SITE, { waitUntil: 'load' });
  await p.evaluate(() => window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }));
  await sleep(1200);

  // 页面里常用的小工具
  await p.evaluate(() => {
    window.T = {
      call: (n, a) => window.BIM.mcp.call(n, a || {}),
      S: window.BIM.scene,
      M: window.BIM.app.model(),
      st: () => window.BIM.app.state,
      room: num => window.BIM.app.model().rooms.find(r => r.num === num),
      eqs: () => window.BIM.app.state.placed,
      chat: () => document.getElementById('chat').innerText,
      toolNames: () => window.BIM.mcp.names.slice(),
      bound: () => Object.keys(window.BIM.mcp.handlers)
    };
  });

  console.log('\n【0】工具层完整性');
  const meta = await p.evaluate(() => ({
    names: window.T.toolNames(),
    bound: window.T.bound(),
    guide: (window.BIM.mcp.guide || '').length
  }));
  const missing = meta.names.filter(n => meta.bound.indexOf(n) < 0);
  ok('工具数 = ' + meta.names.length + '，全部有执行体', missing.length === 0 && meta.names.length >= 23, '缺：' + missing.join(','));
  ok('给了大模型调用说明书（guide）', meta.guide > 400, meta.guide + ' 字');

  console.log('\n【1】设备·增：放到 201 靠里');
  const p1 = await p.evaluate(async () => {
    const r = await window.T.call('place_equipment', { device: '空压机', room: '201', pref: 'inner' });
    const e = window.T.eqs()[0];
    return { ok: r.ok, say: r.say, data: r.data, n: window.T.eqs().length, name: e && e.name, x: e && e.x };
  });
  ok('放好了 1 台', p1.ok && p1.n === 1, p1.say);
  ok('落位有真实数据（安全系数）', !!(p1.data && p1.data.K), 'K = ' + (p1.data && p1.data.K));

  console.log('\n【2】设备·引导：202 室该放哪（用户不知道往哪放时）');
  const sug = await p.evaluate(async () => {
    const r = await window.T.call('suggest_positions', { device: '精密空调', room: '202', count: 3, apply: false });
    const gs = document.querySelectorAll('.chips');
    const last = gs[gs.length - 1];
    return {
      ok: r.ok, say: r.say, data: r.data,
      chips: last ? last.querySelectorAll('button').length : 0,
      placed: window.T.eqs().filter(q => q.room === '202').length
    };
  });
  ok('给出了候选位置并说明利弊', sug.ok && /靠/.test(sug.say) && /离门口|贴|省地方|检修|通风/.test(sug.say), sug.say);
  ok('每个候选都有 pref + 优点', !!(sug.data && sug.data.options && sug.data.options.length >= 2), JSON.stringify(sug.data && sug.data.options && sug.data.options.length));
  ok('顺手给出可点的按钮', sug.chips >= 2, sug.chips + ' 个');
  ok('apply=false 时只给建议不动手', sug.data && sug.data.placed === false && sug.placed === 0, '房内设备 ' + sug.placed);

  const sug2 = await p.evaluate(async () => {
    const r = await window.T.call('suggest_positions', { device: '精密空调', room: '202', count: 3 });
    const inRoom = window.T.eqs().filter(q => q.room === '202');
    const gs = document.querySelectorAll('.chips');
    const last = gs[gs.length - 1];
    return {
      ok: r.ok, say: r.say, data: r.data, n: inRoom.length,
      chips: [...(last ? last.querySelectorAll('button') : [])].map(b => b.textContent)
    };
  });
  ok('说"你看着放"就直接落地（不反问）', sug2.ok && sug2.n === 1 && sug2.data && sug2.data.placed === true, (sug2.say || '').slice(0, 70));
  ok('落地时说明为什么放这儿 + 给备选改法', /放好了/.test(sug2.say || '') && sug2.chips.some(s => /改到/.test(s)), (sug2.say || '').slice(0, 80));

  console.log('\n【3】设备·挪：相机转 90°，"往左"必须还是画面左边');
  const leftA = await p.evaluate(async () => {
    const S = window.T.S, room = window.T.room('202');
    S.setFocus(room.floor, false);
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    // 相机放在房间西南上方，斜着看：这时世界 -x 并不是画面左
    S.setCam(cx - 16, room.elev + 13, -(cy - 12), cx, room.elev, -cy);
    const before = window.BIM.scene.viewInfo();
    await window.T.call('move_equipment', { target: '精密空调', pref: 'center' });
    const e = window.T.eqs().filter(q => q.room === room.id)[0];
    const s0 = S.project(e.x, e.floorElev + 0.5, e.y);
    const r = await window.T.call('move_equipment', { target: '精密空调', direction: 'left', distance: 0.6 });
    const s1 = S.project(e.x, e.floorElev + 0.5, e.y);
    return { ok: r.ok, say: r.say, view: before, dx: s1.x - s0.x, wx: e.x, room: room.id };
  });
  ok('相机已侧过来（屏幕右不再是东）', leftA.view && leftA.view.rightIs !== '东', '镜头朝' + (leftA.view && leftA.view.looking) + '，右边是' + (leftA.view && leftA.view.rightIs));
  ok('往左挪 → 屏幕上确实往左走了', leftA.ok && leftA.dx < -3, 'Δ屏幕 x = ' + leftA.dx.toFixed(1) + ' px');
  ok('回话里说清方向 + 距离', /往左挪了/.test(leftA.say || ''), leftA.say);

  console.log('\n【4】设备·挪：把相机转到反方向，再往左一次');
  const leftB = await p.evaluate(async () => {
    const S = window.T.S, room = window.T.room('202');
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    S.setCam(cx + 15, room.elev + 14, -(cy + 13), cx, room.elev, -cy);   // 东北上方俯视
    const before = window.BIM.scene.viewInfo();
    const e = window.T.eqs().filter(q => q.room === room.id)[0];
    const s0 = S.project(e.x, e.floorElev + 0.5, e.y);
    const r = await window.T.call('move_equipment', { target: '精密空调', direction: 'left', distance: 0.5 });
    const s1 = S.project(e.x, e.floorElev + 0.5, e.y);
    return { ok: r.ok, say: r.say, view: before, dx: s1.x - s0.x };
  });
  ok('换了观察方向，往左依然往左', leftB.dx < -3, 'Δ屏幕 x = ' + leftB.dx.toFixed(1) + ' px（镜头朝' + (leftB.view && leftB.view.looking) + '）');

  console.log('\n【5】设备·改：加宽到 1.6 米');
  const rs = await p.evaluate(async () => {
    const e = window.T.eqs().filter(q => q.room === window.T.room('202').id)[0];
    const w0 = e.w, x0 = e.x, y0 = e.y;
    const r = await window.T.call('resize_equipment', { target: '精密空调', width: 1.6 });
    return { ok: r.ok, say: r.say, w0: w0, w1: e.w, moved: Math.hypot(e.x - x0, e.y - y0) };
  });
  ok('尺寸改成功并重新校核', rs.ok && Math.abs(rs.w1 - 1.6) < 1e-6, rs.w1 + ' m');
  ok('回话说清改了哪一项', /宽 /.test(rs.say || '') && /安全系数/.test(rs.say || ''), rs.say);

  console.log('\n【6】设备·换：换成风冷冷水机组');
  const rp = await p.evaluate(async () => {
    const e = window.T.eqs().filter(q => q.room === window.T.room('202').id)[0];
    const nm0 = e.name, x0 = e.x, y0 = e.y;
    const r = await window.T.call('replace_equipment', { device: '风冷冷水机组', target: '精密空调' });
    return { ok: r.ok, say: r.say, nm0: nm0, nm1: e.name, keep: Math.hypot(e.x - x0, e.y - y0) };
  });
  ok('型号换掉了', rp.ok && rp.nm1 !== rp.nm0 && /风冷/.test(rp.nm1), rp.nm0 + ' → ' + rp.nm1);
  ok('换完重新算了承重', /安全系数/.test(rp.say || ''), rp.say);

  console.log('\n【7】设备·查 + 撤回');
  const q1 = await p.evaluate(async () => {
    const r = await window.T.call('query_equipment', { target: '风冷' });
    return { ok: r.ok, say: r.say, data: r.data };
  });
  ok('查得出重量/尺寸/房间/安全系数', q1.ok && /吨/.test(q1.say) && /安全系数/.test(q1.say), q1.say);

  const un = await p.evaluate(async () => {
    const before = window.T.eqs().filter(q => q.room === window.T.room('202').id)[0].name;
    const r = await window.T.call('undo_last', {});
    const after = window.T.eqs().filter(q => q.room === window.T.room('202').id)[0].name;
    return { ok: r.ok, say: r.say, before: before, after: after };
  });
  ok('撤回把型号换回去了', un.ok && un.after !== un.before, un.before + ' ← ' + un.after);

  console.log('\n【8】门·开 / 改 / 挪 / 查 / 列');
  const d1 = await p.evaluate(async () => {
    const r = await window.T.call('open_door', { room: '301', side: 'east', width: 1.0 });
    const M = window.T.M;
    const adds = M.doors.filter(d => d.added);
    return { ok: r.ok, say: r.say, n: adds.length, name: adds[0] && adds[0].name, w: adds[0] && adds[0].w };
  });
  ok('门开出来了', d1.ok && d1.n === 1, d1.name + ' ' + d1.w + ' m');

  const d2 = await p.evaluate(async () => {
    const r = await window.T.call('resize_door', { width: 1.4, height: 2.2 });
    const d = window.T.M.doors.filter(x => x.added)[0];
    return { ok: r.ok, say: r.say, w: d && d.w, h: d && d.h };
  });
  ok('门改尺寸成功', d2.ok && Math.abs(d2.w - 1.4) < 1e-6 && Math.abs(d2.h - 2.2) < 1e-6, d2.w + '×' + d2.h);

  const d3 = await p.evaluate(async () => {
    const before = window.T.S.doorAt(window.T.M.doors.filter(x => x.added)[0], null);
    const r = await window.T.call('move_door', { along: 'center' });
    const after = window.T.S.doorAt(window.T.M.doors.filter(x => x.added)[0], null);
    return { ok: r.ok, say: r.say, before: before, after: after };
  });
  ok('门挪到墙中间了', d3.ok && Math.abs(d3.after - d3.before) > 0.02, d3.before.toFixed(2) + ' → ' + d3.after.toFixed(2) + ' m');
  ok('挪门回话可读', /挪好了/.test(d3.say || ''), d3.say);

  const d4 = await p.evaluate(async () => {
    const r = await window.T.call('query_door', {});
    return { ok: r.ok, say: r.say, data: r.data };
  });
  ok('查门给出宽高/所在墙/净距', d4.ok && /米宽/.test(d4.say), d4.say);

  const d5 = await p.evaluate(async () => {
    const r = await window.T.call('list_doors', { room: '301' });
    return { ok: r.ok, say: r.say, data: r.data };
  });
  ok('列门能列出这间房的门', d5.ok && d5.data && d5.data.count >= 1, d5.data && d5.data.count + ' 扇');

  console.log('\n【9】门·拆 + 撤回');
  const d6 = await p.evaluate(async () => {
    const r = await window.T.call('remove_door', {});
    const n0 = window.T.M.doors.filter(x => x.added).length;
    const u = await window.T.call('undo_last', {});
    const n1 = window.T.M.doors.filter(x => x.added).length;
    return { ok: r.ok, say: r.say, after: n0, back: n1 };
  });
  ok('拆掉了', d6.ok && d6.after === 0, d6.say);
  ok('撤回又把门开回去了', d6.back === 1, d6.back + ' 扇');

  console.log('\n【10】视图·只显示这一间 / 还原');
  const v1 = await p.evaluate(async () => {
    const r = await window.T.call('focus_view', { room: '202', only_this: true });
    const S = window.T.S;
    return {
      ok: r.ok, say: r.say,
      f1: S.floorOf(1) ? S.floorOf(1).g.visible : null,
      f2: S.floorOf(2) ? S.floorOf(2).g.visible : null,
      f3: S.floorOf(3) ? S.floorOf(3).g.visible : null
    };
  });
  ok('只显示这间：别的楼层藏起来了', v1.ok && v1.f1 === false && v1.f3 === false && v1.f2 === true,
    '1F=' + v1.f1 + ' 2F=' + v1.f2 + ' 3F=' + v1.f3);
  ok('回话告诉用户怎么还原', /都显示出来/.test(v1.say || ''), v1.say);

  const v2 = await p.evaluate(async () => {
    const r = await window.T.call('show_all', {});
    const S = window.T.S;
    return { ok: r.ok, say: r.say, f1: S.floorOf(1).g.visible, f3: S.floorOf(3).g.visible };
  });
  ok('还原后全楼都在', v2.ok && v2.f1 === true && v2.f3 === true, '1F=' + v2.f1 + ' 3F=' + v2.f3);

  console.log('\n【11】设备·整间清空 + 列清单');
  const l1 = await p.evaluate(async () => {
    const r = await window.T.call('list_devices', {});
    return { ok: r.ok, say: r.say, data: r.data };
  });
  ok('列设备有数量合计', l1.ok && /\d+ 台/.test(l1.say), l1.say);

  const rm = await p.evaluate(async () => {
    const n0 = window.T.eqs().length;
    const r = await window.T.call('remove_equipment', { room: '202', all: true });
    const n1 = window.T.eqs().length;
    return { ok: r.ok, say: r.say, n0: n0, n1: n1 };
  });
  ok('整间清空生效', rm.ok && rm.n1 < rm.n0, rm.n0 + ' → ' + rm.n1 + ' 台');

  const un2 = await p.evaluate(async () => {
    const n0 = window.T.eqs().length;
    const r = await window.T.call('undo_last', {});
    return { ok: r.ok, say: r.say, n0: n0, n1: window.T.eqs().length };
  });
  ok('撤回把撤掉的设备放回去了', un2.ok && un2.n1 > un2.n0, un2.n0 + ' → ' + un2.n1 + ' 台');

  await p.evaluate(() => { window.T.S.setFocus(0); });
  await sleep(600);
  await p.screenshot({ path: OUT + 'crud.png' });

  console.log('\n【12】"只看这一间"要真的干净 + 能完整还原');
  // 只藏墙是不够的：门会悬在半空、别的房间的风管/阀门/梁还插在画面里
  const snap = () => p.evaluate(() => {
    const S = window.T.S, KINDS = ['slab', 'wall', 'wallseg', 'door', 'window', 'column', 'beam', 'beamseg', 'duct', 'valve'];
    const out = {}; KINDS.forEach(k => out[k] = 0);
    S.root().traverse(o => {
      const k = o.userData && o.userData.kind;
      if (!k || KINDS.indexOf(k) < 0) return;
      let v = o.visible, q = o.parent;
      while (v && q) { v = q.visible; q = q.parent; }
      if (v) out[k]++;
    });
    let sp = 0;
    S.root().traverse(o => {
      if (!o.isSprite) return;
      let v = o.visible, q = o.parent;
      while (v && q) { v = q.visible; q = q.parent; }
      if (v) sp++;
    });
    out.labels = sp;
    // 窗按"组"数，不按 mesh 数（一樘窗 = 框 + 玻璃 + 窗台板）
    let wg = 0;
    S.root().traverse(o => {
      if (!o.name || o.name.indexOf('win-') !== 0) return;
      let v = o.visible, q = o.parent;
      while (v && q) { v = q.visible; q = q.parent; }
      if (v) wg++;
    });
    out.winGroups = wg;
    return out;
  });

  const base = await snap();
  await p.evaluate(() => window.T.call('focus_view', { room: '202', only_this: true }));
  await sleep(700);
  const iso = await snap();
  ok('别的楼层藏了', iso.slab <= 1, '楼板 ' + base.slab + ' → ' + iso.slab);
  ok('墙只剩这间的（长墙已按房间段裁）', iso.wall + iso.wallseg <= 5, '墙 ' + base.wall + ' → ' + iso.wall + '+' + iso.wallseg + ' 段');
  ok('门不会悬在别处', iso.door <= 2, '门 ' + base.door + ' → ' + iso.door);
  ok('窗跟着房间走', iso.winGroups <= 1, '窗 ' + base.winGroups + ' → ' + iso.winGroups + ' 樘');
  ok('梁柱只留房间顶上那几根', iso.column <= 5 && iso.beam + iso.beamseg <= 6,
    '柱 ' + base.column + '→' + iso.column + ' 梁 ' + base.beam + '→' + iso.beam + '+' + iso.beamseg + ' 段');
  ok('风管阀门不串到别间', iso.duct <= 2, '风管 ' + base.duct + ' → ' + iso.duct);
  ok('房间名只留这一间的', iso.labels <= 1, iso.labels + ' 个');
  await p.screenshot({ path: OUT + 'iso-clean.png' });

  await p.evaluate(() => window.T.call('show_all', {}));
  await sleep(800);
  const back = await snap();
  const miss = Object.keys(base).filter(k => back[k] !== base[k] && k !== 'wallseg' && k !== 'beamseg');
  ok('还原后一个不少', miss.length === 0,
    miss.length ? miss.map(k => k + ' ' + back[k] + '/' + base[k]).join(', ') : '全部回到原样');

  // 连着切两间房，确认不会越看越少（临时段墙用完要清掉）
  await p.evaluate(() => window.T.call('focus_view', { room: '306', only_this: true }));
  await sleep(600);
  await p.evaluate(() => window.T.call('show_all', {}));
  await sleep(700);
  const back2 = await snap();
  const miss2 = Object.keys(base).filter(k => back2[k] !== base[k] && k !== 'wallseg' && k !== 'beamseg');
  ok('反复切房间也不丢东西', miss2.length === 0, miss2.join(',') || '同上');

  console.log('\n【13】稳定性');

  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
