/* 第九阶段回归（三条用户要求）
   ① 优化管线：最外墙（建筑外皮）上不许有管线，但每间房的照明/插座支线都得还在；
   ② 打通以后：视角只留当前楼层；在此房间放设备默认落在两块板的**中间**，
      并给出合并后大板的承载校核；
   ③ 开门：视角只留当前楼层；门洞压在配电箱上要被拦下来；
      门洞涉及到的线管改道要**减小管径**并在转角**加弯头**。
*/
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8823';
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let fail = 0;
const P = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; };
const H = t => console.log('\n' + t);

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 900 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/asr\/warm/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', async d => { await d.dismiss(); });
  await p.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(4300);

  const call = (n, a) => p.evaluate((n, a) => window.BIM.mcp.call(n, a), n, a);
  const body = () => p.evaluate(() => window.BIM.scene.bodyVis());
  const lastSays = (k) => p.evaluate(k => Array.from(document.querySelectorAll('#chat .ai .body'))
    .map(e => e.innerText.replace(/\n/g, ' | ')).slice(-k), k || 3);

  /* ---------- ① 外墙不出管 ---------- */
  H('【1】管线优化：最外墙不再走管');
  const c1 = await p.evaluate(() => {
    const M = window.BIM_MODEL, D = window.BIM.elec.data;
    const onExt = D.conduits.filter(c => { const w = M.walls.find(x => x.id === c.wall); return w && w.kind === 'ext'; });
    const miss = [];
    [1, 2, 3, 4, 5].forEach(f => {
      M.rooms.filter(r => r.zone !== 'corr' && r.floor === f).forEach(r => {
        const kinds = D.conduits.filter(c => c.room === r.id || (c.rooms || []).indexOf(r.id) >= 0)
          .map(c => (D.circuits.find(x => x.id === c.circuit) || {}).kind);
        if (kinds.indexOf('light') < 0 && kinds.indexOf('light2') < 0) miss.push(r.num + '照明');
        if (kinds.indexOf('socket') < 0 && kinds.indexOf('socket2') < 0) miss.push(r.num + '插座');
      });
    });
    return { total: D.conduits.length, onExt: onExt.length, miss: miss };
  });
  P('外墙上没有任何一段线管', c1.onExt === 0, '管线共 ' + c1.total + ' 段，外墙 ' + c1.onExt + ' 段');
  P('去掉外墙后每间房仍有照明和插座支线', c1.miss.length === 0, c1.miss.join('、') || '五层全覆盖');

  /* ---------- ② 打通：视角 + 放设备 + 承载 ---------- */
  H('【2】打通 204+205：只显当前楼层 / 设备落在中间 / 合并板校核');
  const rp = await call('open_passage', { room: '204', to: '205' });
  await sleep(2600);
  P('打通成功', rp && rp.ok !== false, JSON.stringify(rp && rp.data && rp.data.passage));
  const b1 = await body();
  const others = Object.keys(b1.floors).filter(k => k !== '2');
  P('视角只显示当前楼层（别层整层收起）', others.every(k => b1.floors[k].visible === false),
    others.map(k => 'F' + k + ':' + b1.floors[k].visible).join(' '));
  P('当前楼层保持实心（打通的墙一望到底）', b1.floors['2'] && b1.floors['2'].visible === true && Math.abs(b1.floors['2'].opacity - 1) < .02,
    JSON.stringify(b1.floors['2']));
  P('顶梁不再压在头上', !!b1.roof && b1.roof.visible === false, JSON.stringify(b1.roof));

  const rq = await call('place_equipment', { room: '204', device: '空气压缩机' });
  await sleep(2600);
  const eq = await p.evaluate(() => {
    const e = window.BIM.state.placed[window.BIM.state.placed.length - 1];
    return e ? { x: +e.x.toFixed(2), y: +e.y.toFixed(2), room: e.room } : null;
  });
  /* 204 是 19.8~26.4，205 是 26.4~33，y 都是 0~6.6 → 中间点在 (26.4, 3.3) */
  P('设备默认落在两间打通的中间', !!eq && Math.abs(eq.x - 26.4) < 0.6 && Math.abs(eq.y - 3.3) < 0.6,
    JSON.stringify(eq));
  const says = (await lastSays(4)).join(' ');
  P('回执给出合并后大板的承载校核', /合并后的大板/.test(says) && /安全系数/.test(says),
    (says.match(/按合并后的大板[^。]*。/) || [''])[0]);
  const k = await p.evaluate(() => {
    const r = window.BIM.state.placed[window.BIM.state.placed.length - 1];
    const rr = window.BIM.calc.check({ room: window.BIM_MODEL.rooms.find(x => x.id === r.room), equip: r, cx: r.x, cy: r.y, others: [] });
    return { merged: rr.merged, lx: +rr.lx.toFixed(2), ly: +rr.ly.toFixed(2), K: +rr.K.toFixed(2), plate: (rr.plate.rooms || []).map(x => x.num) };
  });
  P('校核用的确实是合并后的大板 13.20×6.60', k.merged && Math.abs(k.lx - 13.2) < .05 && Math.abs(k.ly - 6.6) < .05,
    JSON.stringify(k));

  /* ---------- ③ 开门：配电箱碰撞 / 视角 / 改线管径 ---------- */
  H('【3】开门：配电箱碰撞 / 只显当前楼层 / 改线减小管径加弯头');
  const pin = await p.evaluate(() => {
    const D = window.BIM.elec.data;
    const pn = D.panels.find(x => x.floor === 2);
    const M = window.BIM_MODEL;
    const wall = M.walls.find(x => x.id === pn.wall);
    const room = M.rooms.find(x => x.id === pn.room) || null;
    return { id: pn.id, wall: pn.wall, at: pn.at, room: room ? room.num : null };
  });
  const dchk = await p.evaluate((pin) => {
    const M = window.BIM_MODEL;
    const wall = M.walls.find(x => x.id === pin.wall);
    const room = M.rooms.find(x => x.num === pin.room);
    const c = window.BIM.calc.door({ wall, at: pin.at, w: 1.0, h: 2.1, room: room, equipments: [], self: null });
    return { pass: c.pass, blocks: (c.blocks || []).map(x => x.k + '|' + x.t) };
  }, pin);
  P('门洞压在配电箱上会被拦下来', dchk.pass === false && dchk.blocks.some(x => /^panel\|/.test(x) && /配电箱/.test(x)),
    dchk.blocks.filter(x => /^panel\|/.test(x))[0] || JSON.stringify(dchk.blocks).slice(0, 90));

  /* 真开一扇会撞管线的门，看视角与改线 */
  const dr = await p.evaluate(async () => {
    const M = window.BIM_MODEL, E = window.BIM.elec;
    /* 找一面有 2 段以上管线、且有门洞余地的内墙 */
    const cand = M.walls.filter(w => w.kind === 'part' && E.conduitsOf({ wall: w.id }).length >= 2);
    for (const w of cand) {
      const room = M.rooms.find(r => (r.sides || {}).south === w.id || (r.sides || {}).north === w.id ||
        (r.sides || {}).east === w.id || (r.sides || {}).west === w.id);
      if (!room) continue;
      const cs = E.conduitsOf({ wall: w.id });
      const c0 = cs[0];
      const at = (c0.at0 + c0.at1) / 2;
      const chk = window.BIM.calc.door({ wall: w, at: at, w: 1.0, h: 2.1, room: room, equipments: [], self: null });
      if (!chk.conduits || !chk.conduits.length) continue;
      return { wall: w.id, room: room.num, at: at, cond: chk.conduits.length };
    }
    return null;
  });
  if (dr) {
    const res = await p.evaluate(async (dr) => {
      const M = window.BIM_MODEL;
      const wall = M.walls.find(x => x.id === dr.wall);
      const room = M.rooms.find(x => x.num === dr.room);
      const cs = window.BIM.elec.conduitsOf({ wall: dr.wall });
      const hole = { at0: dr.at - .5, at1: dr.at + .5, z0: 0, z1: 2.1 };
      const plan = window.BIM.elec.planReroute(cs[0], hole);
      if (!plan.ok) return { why: plan.why };
      window.BIM.scene.setFocus(room.floor, false);
      window.BIM.scene.showConduits(true);
      window.BIM.scene.setXray(false);
      window.BIM.scene.isolateFloor(room.floor);            // 开门时走的就是这一条
      const g = window.BIM.scene.showReroute(plan, 0x17a673);
      return { sec: cs[0].s, u: g ? g.userData : null, pts: plan.pts.length };
    }, dr);
    P('改线管径跟真管子同量级（不再固定 10 cm）', !!res.u && res.u.th <= 0.06 && res.u.th >= res.sec,
      '真管 ' + (res.sec * 100).toFixed(0) + ' cm → 画 ' + (res.u ? (res.u.th * 100).toFixed(1) : '?') + ' cm');
    P('每个转角都有弯头', !!res.u && res.u.boxes > res.u.pts - 1,
      '路径 ' + res.u.pts + ' 个点、' + res.u.boxes + ' 个方头（含弯头）');
    const b2 = await body();
    const o2 = Object.keys(b2.floors).filter(k => k !== String(b2.focus));
    P('开门时视角只显示当前楼层', o2.every(k => b2.floors[k].visible === false),
      o2.map(k => 'F' + k + ':' + b2.floors[k].visible).join(' '));
    P('当前楼层墙体保持实心（只把要开的墙挑出来看）', Math.abs((b2.floors[String(b2.focus)] || {}).opacity - 1) < .02,
      JSON.stringify(b2.floors[String(b2.focus)]));
  } else {
    P('找一面能验改线的墙', false, '模型里没有"内墙 + 埋着 2 段管"的墙');
  }

  /* ---------- ④ 功能区「管线」按钮 + 悬浮图层开关 ---------- */
  H('【4】功能区管线按钮：点一下看当前画面，悬停挑图层');
  const pb = await p.evaluate(() => {
    const btn = document.querySelector('#toolbar button[data-k="pipe"]');
    const pop = document.querySelector('.pipe-pop');
    return {
      has: !!btn, pop: !!pop,
      lay: pop ? pop.querySelectorAll('[data-lay]').length : 0,
      knd: pop ? pop.querySelectorAll('[data-knd]').length : 0,
      label: btn ? btn.innerText.trim() : ''
    };
  });
  P('工具栏里多了「管线」按钮', pb.has && /管线/.test(pb.label), pb.label);
  P('悬停浮层有 6 个管线图层 + 3 个分路开关', pb.pop && pb.lay === 6 && pb.knd === 3,
    '图层 ' + pb.lay + ' 个、分路 ' + pb.knd + ' 个');

  /* 先把电气视图关掉（前面开门/打通会把它打开），才测得准"点一下打开" */
  await call('show_conduits', { scope: 'off' });
  await sleep(1200);
  await p.click('#toolbar button[data-k="pipe"]');
  await sleep(2400);
  const on1 = await p.evaluate(() => {
    const S = window.BIM.scene, bv = S.bodyVis();
    const fl = Object.keys(bv.floors).map(k => bv.floors[k]);
    return { on: S.conduitsOn(), minOp: Math.min.apply(null, fl.map(f => f.opacity)),
             vis: fl.filter(f => f.visible).length, btnOn: document.querySelector('#toolbar button[data-k="pipe"]').classList.contains('on') };
  });
  P('点一下就把当前画面的管线打开', on1.on === true && on1.btnOn === true, JSON.stringify(on1));
  P('同时楼板/楼体压成半透明', on1.minOp <= 0.5, '最不透明的一层 ' + on1.minOp);

  const boxesAll = await p.evaluate(() => Object.values(window.BIM.scene.conduitStat().byCirc).reduce((a, b) => a + b, 0));
  await p.evaluate(() => { const pop = document.querySelector('.pipe-pop'); pop.classList.add('show'); pop.querySelector('[data-lay="room"]').click(); });
  await sleep(2200);
  const boxesNoRoom = await p.evaluate(() => ({
    n: Object.values(window.BIM.scene.conduitStat().byCirc).reduce((a, b) => a + b, 0),
    off: window.BIM.scene.conduitFilter().layer.room === 1
  }));
  P('关掉「房间支线」这一层，屋里那圈支线就真的不画了',
    boxesNoRoom.off && boxesNoRoom.n > 0 && boxesNoRoom.n < boxesAll,
    '关前 ' + boxesAll + ' 个方头 → 关后 ' + boxesNoRoom.n);
  /* 还原，后面还要看整层管子 */
  await p.evaluate(() => { const pop = document.querySelector('.pipe-pop'); pop.querySelector('[data-all]').click(); pop.classList.remove('show'); });
  await sleep(1600);

  /* ---------- ⑤ 每层每一路都要接到主干立管上 ---------- */
  H('【5】红/蓝/黄各层横管都要接到竖着的主干立管');
  const conn = await p.evaluate(() => {
    const D = window.BIM.elec.data, M = window.BIM_MODEL, E = window.BIM.elec;
    const ends = c => {
      if (c.free && c.p1) return [{ x: c.p1[0], y: c.p1[1], z: c.p1[2] }, { x: c.p2[0], y: c.p2[1], z: c.p2[2] }];
      if (c.vert) return [{ x: c.x, y: c.y, z: c.z0 }, { x: c.x, y: c.y, z: c.z1 }];
      const w = M.walls.find(q => q.id === c.wall); if (!w) return [];
      const a = E.axis(w);
      return [c.at0, c.at1].map(at => ({ x: a.ax + a.ux * at, y: a.ay + a.uy * at, z: c.z }));
    };
    const segDist = (pt, c) => {
      const e = ends(c); if (e.length < 2) return 99;
      const a = e[0], b = e[1];
      const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
      const wx = pt.x - a.x, wy = pt.y - a.y, wz = pt.z - a.z;
      const L2 = vx * vx + vy * vy + vz * vz;
      let t = L2 ? (wx * vx + wy * vy + wz * vz) / L2 : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(wx - vx * t, wy - vy * t, wz - vz * t);
    };
    const out = { floors: {}, bad: [] };
    [1, 2, 3, 4, 5].forEach(f => {
      const list = D.conduits.filter(c => c.floor === f);
      const corr = list.filter(c => c.layer === 'corridor');
      const outN = list.filter(c => c.layer === 'out').length;
      const corrDangle = corr.filter(c => ends(c).some(pt =>
        !list.some(o => o !== c && segDist(pt, o) < 0.12))).length;
      out.floors[f] = { corr: corr.length, out: outN, corrDangle: corrDangle };
      if (corrDangle > 0) out.bad.push(f + 'F 有 ' + corrDangle + ' 段干线悬空');
      if (outN < 12) out.bad.push(f + 'F 箱到桥架只有 ' + outN + ' 段');
    });
    out.trunk = D.conduits.filter(c => c.layer === 'trunk').length;
    out.riserFloor = D.conduits.filter(c => c.layer === 'trunk').map(c => c.floor);
    return out;
  });
  P('五层的主干立管都在，且逐层相接', conn.trunk === 5, '立管 ' + conn.trunk + ' 段（' + conn.riserFloor.join('/') + 'F）');
  P('每层的走廊干线都接到了配电箱（不再悬在半空）', conn.bad.length === 0,
    conn.bad.join('；') || [1, 2, 3, 4, 5].map(f => f + 'F干' + conn.floors[f].corr + '/出线' + conn.floors[f].out).join(' '));

  /* ---------- ⑥ 开门回执要有"我自己点位置" ---------- */
  H('【6】开门回执自带"我自己点位置"按钮');
  await call('open_door', { room: '207' });
  await sleep(2600);
  const dchips = await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#chat .chips'));
    const last = rows[rows.length - 1];
    return last ? Array.from(last.querySelectorAll('button')).map(b => b.textContent) : [];
  });
  P('开门回执挂了自选位置的按钮', dchips.some(t => /我自己点位置|再挑个位置/.test(t)), dchips.join(' / '));
  /* 点它要真进入"自己点位置"的模式（点完照样走校核 + 改线规划） */
  await p.evaluate(() => {
    const rows = document.querySelectorAll('#chat .chips');
    const row = rows[rows.length - 1];
    const b = Array.from(row.querySelectorAll('button')).find(x => /我自己点位置|再挑个位置/.test(x.textContent));
    if (b) b.click();
  });
  await sleep(1600);
  const dmode = await p.evaluate(() => ({
    mode: window.BIM.state.mode,
    chip: (document.getElementById('modeChip') || {}).hidden === false,
    txt: ((document.getElementById('modeTxt') || {}).textContent || '')
  }));
  P('点完进入点选开门的模式', dmode.mode === 'door' && dmode.chip && /开门/.test(dmode.txt), dmode.txt);
  await p.evaluate(() => { const c = document.getElementById('modeCancel'); if (c && !document.getElementById('modeChip').hidden) c.click(); });
  await sleep(1200);

  /* ---------- ⑦ 209+210 打通：按一整块板放设备、校核、量净距 ---------- */
  H('【7】209+210 打通后是一块板：中间放设备 / 合并板校核 / 净距按大板量');
  const rp2 = await call('open_passage', { room: '209', to: '210' });
  await sleep(2400);
  P('209 和 210 打通', !!(rp2 && rp2.data && rp2.data.passage), JSON.stringify(rp2 && rp2.data && rp2.data.passage));
  /* 用户原话就是"放到这俩个房间中间"——两个房号一起丢给 place_equipment */
  const rq2 = await call('place_equipment', { room: '209和210', device: '空气压缩机' });
  await sleep(2600);
  const eq2 = await p.evaluate(() => {
    const e = window.BIM.state.placed[window.BIM.state.placed.length - 1];
    const M = window.BIM_MODEL, C = window.BIM.calc;
    const r209 = M.rooms.find(x => x.num === '209');
    const pl = C.plateOf(r209);
    const space = { x0: pl.x0, x1: pl.x1, y0: pl.y0, y1: pl.y1, num: r209.num, id: r209.id, floor: r209.floor, slab: r209.slab };
    const cl = C.clearance({ room: space, equip: e, x: e.x, y: e.y, others: [] });
    return e ? {
      x: +e.x.toFixed(2), y: +e.y.toFixed(2),
      merged: pl.merged, lx: +pl.lx.toFixed(2), ly: +pl.ly.toFixed(2),
      west: +cl.west.v.toFixed(2), east: +cl.east.v.toFixed(2)
    } : null;
  });
  /* 209 是 19.8~26.4，210 是 26.4~33，y 都是 9~15.6 → 合并后中间点 (26.4, 12.3) */
  P('两个房号一起说，"中间"就是合并后这块板的中间', !!eq2 &&
    Math.abs(eq2.x - 26.4) < 0.7 && Math.abs(eq2.y - 12.3) < 0.7, JSON.stringify(eq2));
  P('板和板合并成 13.20×6.60', !!eq2 && eq2.merged && Math.abs(eq2.lx - 13.2) < .05 && Math.abs(eq2.ly - 6.6) < .05,
    eq2 ? eq2.lx + '×' + eq2.ly : '');
  P('净距按合并后的大板量（不再把中间那道墙当墙）', !!eq2 && Math.min(eq2.west, eq2.east) > 3,
    '左 ' + (eq2 && eq2.west) + ' / 右 ' + (eq2 && eq2.east));

  await b.close();
  console.log('\n控制台错误：' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'));
  console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
