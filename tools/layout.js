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

  /* ---------- ⑧ 打通视图：墙 30% / 牵涉分路 50% / 随墙作废的管留在原位 ---------- */
  H('【8】打通 505+504：墙 30% 半透明、牵涉的管 50%、随墙作废那几根留在原位');
  const rp3 = await call('open_passage', { room: '505', to: '504' });
  await sleep(2600);
  const hits3 = (rp3 && rp3.data && rp3.data.conduit_hit) || [];
  const v8 = await p.evaluate(hits => {
    const S = window.BIM.scene;
    const g = S.ghostStat();
    const alpha = {};
    hits.forEach(h => { alpha[h] = +S.conduitAlphaValue(h).toFixed(2); });
    return {
      ghost: g, alpha: alpha, base: +S.conduitAlphaValue().toFixed(2),
      dead: S.removedConduitStat(), on: S.conduitsOn(), floor: S.floorIsolated()
    };
  }, hits3);
  P('打通成功并切到本层打通视图', !!(rp3 && rp3.data && rp3.data.passage) && v8.on && v8.floor === 5,
    'floor=' + v8.floor + ' on=' + v8.on);
  P('被拆的那面墙 30% 半透明', v8.ghost.length === 1 && Math.abs(v8.ghost[0].opacity - 0.30) < 0.02,
    JSON.stringify(v8.ghost));
  P('牵涉到的分路 50% 半透明，其余压暗到 30% 以下',
    hits3.length > 0 && hits3.every(h => v8.alpha[h] > 0.45) && v8.base <= 0.32,
    '牵涉 ' + JSON.stringify(v8.alpha) + ' / 其余 ' + v8.base);
  P('随墙作废的那几段线管按 50% 留在原位（不是直接消失）',
    !!v8.dead && v8.dead.n > 0 && Math.abs(v8.dead.alpha - 0.5) < 0.02, JSON.stringify(v8.dead));

  /* ---------- ⑨ 合并板上按当前视角的前后左右放设备 ---------- */
  H('【9】合并大板上按"当前视角的前后左右"放设备');
  /* 镜头放在 504 西侧朝东看：屏幕右 = 南（y 小），屏幕左 = 北（y 大） */
  await p.evaluate(() => window.BIM.scene.setCam(20.5, 18.0, -3.3, 33, 17.2, -3.3));
  await sleep(1000);
  const rr9 = await call('place_equipment', { room: '505和504', device: '空气压缩机', side: 'right' });
  await sleep(2000);
  const rl9 = await call('place_equipment', { room: '505和504', device: '空气压缩机', side: 'left' });
  await sleep(2000);
  const pr = (rr9 && rr9.data && rr9.data.positions && rr9.data.positions[0]) || null;
  const pl2 = (rl9 && rl9.data && rl9.data.positions && rl9.data.positions[0]) || null;
  P('说"放右边"就落在合并板的南半边（不再是永远回中间）', !!pr && pr[1] < 2.2, JSON.stringify(pr));
  P('说"放左边"就落在合并板的北半边', !!pl2 && pl2[1] > 4.2, JSON.stringify(pl2));
  P('两次落位方向相反、确实按视角分开了', !!pr && !!pl2 && (pl2[1] - pr[1]) > 3,
    '右 ' + (pr && pr[1]) + ' / 左 ' + (pl2 && pl2[1]));
  P('合并板上的承载按整块大板给（不是单间小板）',
    !!(rr9 && rr9.data && rr9.data.plate && rr9.data.plate.merged) && Math.abs(rr9.data.plate.size_m[0] - 13.2) < .05,
    JSON.stringify(rr9 && rr9.data && rr9.data.plate));

  /* ---------- ⑩ 点门窗高亮 + 对话改这扇的尺寸 ---------- */
  H('【10】点门/点窗高亮，并可按"这一扇"改尺寸');
  const doorId = await p.evaluate(() => {
    const M = window.BIM_MODEL, S = window.BIM.scene;
    const wall = M.walls.find(w => w.id === (M.rooms.find(r => r.num === '501') || {}).sides.north);
    const ds = M.doors.filter(d => d.floor === 5 && d.wall === wall.id)
      .map(d => ({ id: d.id, at: S.doorAt(d, wall) })).sort((a, b) => a.at - b.at);
    return ds.length ? ds[0].id : null;
  });
  const selD = await call('select_opening', { kind: 'door', name: doorId });
  await sleep(1500);
  const hlD = await p.evaluate(() => window.BIM.scene.openingHighlightOf());
  P('选中一扇门就在场景里出高亮框', !!(selD && selD.data) && !!hlD && hlD.tag === 'door',
    JSON.stringify(hlD));
  const szD = await call('resize_door', { width: 1.15 });
  await sleep(1800);
  P('不报门名，直接改的是"刚点中的那一扇"',
    !!(szD && szD.ok !== false && szD.data && Math.abs(szD.data.width - 1.15) < 0.01),
    JSON.stringify(szD && szD.data));
  const selW = await call('select_opening', { kind: 'window', room: '505', floor: 5 });
  await sleep(1400);
  const hlW = await p.evaluate(() => window.BIM.scene.openingHighlightOf());
  P('选中一扇窗也出高亮框', !!(selW && selW.data) && !!hlW && hlW.tag === 'window', JSON.stringify(hlW));
  const szW = await call('resize_window', { width: 2.0 });
  await sleep(1800);
  P('窗也能按"这一扇"改尺寸（不用先重新开一扇）',
    !!(szW && szW.data && Math.abs(szW.data.size.w - 2.0) < 0.01), JSON.stringify(szW && szW.data));

  /* ---------- ⑪ 搬不进门：把这块板上每一扇门都列出来，任选一扇拓 ---------- */
  H('【11】放不进门时，打通的两间各一扇门都列出来，任选一扇拓');
  const dp = await p.evaluate(() => {
    const ST = window.BIM.state, C = window.BIM.calc, M = window.BIM_MODEL;
    const e = ST.placed.filter(x => x.floor === 5).slice(-1)[0];
    const pd = C.passDoor({ room: M.rooms.find(r => r.num === '505'), equip: e });
    return {
      ok: pd.ok, needW: pd.needW,
      doors: (pd.candidates || []).map(c => ({ n: c.name, r: c.roomNum, w: c.w, fit: c.fit }))
    };
  });
  P('候选门覆盖打通的两间（不是只看设备所在那一间）',
    !!dp.doors && dp.doors.length >= 2 && dp.doors.some(d => d.r === '505') && dp.doors.some(d => d.r === '504'),
    JSON.stringify(dp.doors));
  const wchips = await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#chat .chips'));
    const last = rows.filter(r => /拓/.test(r.textContent)).slice(-1)[0];
    return last ? Array.from(last.querySelectorAll('button')).map(b => b.textContent) : [];
  });
  P('回执里给出"拓哪一扇"的按钮', wchips.some(t => /拓/.test(t)) && wchips.length >= 2, wchips.join(' / '));
  /* 点那颗真能拓的，门要真的变宽 */
  await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#chat .chips')).filter(r => /拓/.test(r.textContent));
    const last = rows[rows.length - 1];
    const bs = Array.from(last.querySelectorAll('button')).filter(b => /^拓 /.test(b.textContent.trim()));
    if (bs.length) bs[0].click();
  });
  await sleep(3200);
  const widened = await p.evaluate(() => {
    const M = window.BIM_MODEL;
    const hit = M.doors.filter(d => d.floor === 5 && d.w > 1.2).map(d => ({ n: d.name, w: +d.w.toFixed(2) }));
    return hit;
  });
  P('选中的那扇门被真的拓宽了', widened.length > 0 && widened.some(d => d.w >= 1.3), JSON.stringify(widened));

  /* ---------- ⑫ 第十二阶段：绿色区块 / 计算书亮板 / 撤门复原 / 改尺寸不误判 / 只开内墙 / 点哪扇改哪扇 ---------- */
  H('【12】去掉绿块 · 计算书亮两块板 · 撤门复原 · 改尺寸不误判 · 只开内墙 · 点哪扇改哪扇');

  /* ① 平时不再铺绿色区块：房间高亮只剩描边 */
  const hlState = await p.evaluate(() => {
    const M = window.BIM_MODEL, S = window.BIM.scene;
    const r = M.rooms.find(x => x.num === '505' && x.floor === 5);
    S.highlightRoom(r, 0x10a394);          // 平时那条路径：只给颜色，不给填充
    const grp = S.root().children.filter(o => o.userData && o.userData.line && 'fill' in o.userData);
    const g = grp[grp.length - 1];
    return { fill: g ? g.userData.fill : null, mesh: g ? !!g.userData.m : null, beam: g ? !!g.userData.beam : null };
  });
  P('放置后房间里不再铺绿色色块（只剩描边、没有光柱）',
    hlState.fill === 0 && hlState.mesh === false && hlState.beam === false, JSON.stringify(hlState));

  /* ② 看计算书时才亮，而且是打通后的两块板 */
  const lit = await p.evaluate(() => {
    const r = window.BIM.agent.mem.lastResult;
    return r ? window.BIM.showCalcPlate(r) : null;
  });
  P('看计算书时高亮对应的板（打通时是两块）',
    !!lit && lit.merged && lit.rooms.length === 2 && lit.rooms.indexOf('505') >= 0 && lit.rooms.indexOf('504') >= 0,
    JSON.stringify(lit));

  /* ③ 门窗编号唯一：模型里 45 扇门都叫 M1021，必须分得开 */
  const codes = await p.evaluate(() => {
    const M = window.BIM_MODEL, c = {};
    (M.doors || []).forEach(d => { c[d.code] = (c[d.code] || 0) + 1; });
    return { n: M.doors.length, dup: Object.keys(c).filter(k => c[k] > 1).length,
      sample: (M.doors || []).filter(d => d.name === 'M1021').slice(0, 3).map(d => d.code) };
  });
  P('每扇门都有唯一代号（重名的自动编号）', codes.dup === 0 && codes.sample.every(c => /-\d\d$/.test(c || '')),
    codes.n + ' 扇，重码 ' + codes.dup + '，例：' + codes.sample.join(' '));

  /* ④ 点哪扇就是哪扇：选中一扇重名的门，说改尺寸时不许乱认 */
  const pickOne = await p.evaluate(() => {
    const M = window.BIM_MODEL;
    const d = (M.doors || []).find(x => x.floor === 5 && x.name === 'M1021');
    window.BIM.selectOpening({ kind: 'door', data: d }, true);
    return { id: d.id, code: d.code, w: d.w };
  });
  const rd = await call('resize_door', { door: 'M1021', width: +(pickOne.w + 0.15).toFixed(2) });
  await sleep(2000);
  P('重名的门被点中后，改的就是点中的那一扇',
    !!(rd && rd.data && rd.data.door_id === pickOne.id), JSON.stringify(rd && rd.data));

  /* ⑤ 随便说"开个门"不许开到外墙 */
  const extOpen = await call('open_door', { room: '510', width: 1.0, height: 2.1 });
  await sleep(2400);
  const extKind = await p.evaluate(s => {
    const M = window.BIM_MODEL, r = M.rooms.find(x => x.num === '510' && x.floor === 5);
    const w = M.walls.find(y => y.id === (r.sides || {})[s]);
    return w && w.kind;
  }, extOpen && extOpen.data && extOpen.data.side);
  P('说"开个门"不会开在外墙上（走廊墙/内墙优先）', !!extKind && extKind !== 'ext',
    '开在 ' + (extOpen && extOpen.data && extOpen.data.side) + '(' + extKind + ')');

  /* ⑥ 改尺寸时只剩线管挡着 → 判"能改，再牵一次线"，不是"碰撞" */
  const wp = await p.evaluate(() => {
    const M = window.BIM_MODEL, C = window.BIM.calc;
    for (const room of M.rooms.filter(x => x.floor === 5 && x.zone !== 'corr')) {
      for (const side of ['north', 'south', 'west', 'east']) {
        const wall = M.walls.find(w => w.id === (room.sides || {})[side]);
        if (!wall || wall.kind === 'ext') continue;
        const L = Math.hypot(wall.p2[0] - wall.p1[0], wall.p2[1] - wall.p1[1]);
        for (let at = 1.0; at <= L - 1.0; at += 0.05) {
          const chk = C.door({ wall: wall, at: at, w: 1.0, h: 2.1, room: room });
          const bl = chk.blocks || [];
          if (bl.length === 1 && bl[0].k === 'conduit') {
            const plan = C.widenPlan({ wall: wall, at: at, w: 1.0, h: 2.1, need: 1.35, room: room, equipments: [] });
            return { room: room.num, side: side, conduits: (chk.conduits || []).length,
              pass: !!(plan.best && plan.best.pass), rr: plan.best ? (plan.best.reroutes || []).length : 0,
              need: !!(plan.best && plan.best.needReroute), blocked: (plan.blocked || []).map(b => b.t) };
          }
        }
      }
    }
    return null;
  });
  P('只被墙里线管挡着时，拓门判"能拓（要再牵一次线）"，不再判碰撞',
    !!wp && wp.pass && wp.need && wp.rr > 0, JSON.stringify(wp));

  /* ⑦ 撤门恢复原装：改道的线管放回原走法 */
  const undoTest = await p.evaluate(() => {
    const M = window.BIM_MODEL, C = window.BIM.calc, S = window.BIM.scene;
    /* 找一处"只被线管挡着"的门位（点了就得牵线才开得成） */
    let room = null, side = null, at = null;
    outer:
    for (const rm of M.rooms.filter(x => x.floor === 5 && x.zone !== 'corr')) {
      for (const sd of ['north', 'south', 'west', 'east']) {
        const w = M.walls.find(x => x.id === (rm.sides || {})[sd]);
        if (!w || w.kind === 'ext') continue;
        const L = Math.hypot(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]);
        for (let a = 1.0; a <= L - 1.0; a += 0.05) {
          const chk = C.door({ wall: w, at: a, w: 1.0, h: 2.1, room: rm });
          const bl = chk.blocks || [];
          if (bl.length === 1 && bl[0].k === 'conduit') { room = rm; side = sd; at = +a.toFixed(2); break outer; }
        }
      }
    }
    if (!room) return { none: true };
    const rr0 = Object.keys(window.BIM.elec.data.reroutes || {}).length;
    const o = window.BIM.doorDbg.openAt(room, side, at, 1.0, 2.1);
    const rr1 = Object.keys(window.BIM.elec.data.reroutes || {}).length;
    const u = window.BIM.doorDbg.undo();
    const rr2 = Object.keys(window.BIM.elec.data.reroutes || {}).length;
    return { at: at, opened: !!o && o.ok, rerouted: o && o.rerouted, rr0: rr0, rr1: rr1, rr2: rr2,
      restored: u ? u.conduitsRestored : null, hl: S.openingHighlightOf() };
  });
  P('点在有管线的位置开门：自动牵线', !!undoTest.opened && undoTest.rerouted > 0, JSON.stringify(undoTest));
  P('撤掉这扇门 → 改道的线管退回原走法（恢复原装）',
    undoTest.rr1 > undoTest.rr0 && undoTest.rr2 === undoTest.rr0 && (undoTest.restored || 0) > 0,
    'reroutes ' + undoTest.rr0 + '→' + undoTest.rr1 + '→' + undoTest.rr2 + '，退回 ' + undoTest.restored + ' 根');

  /* ⑧ 点门窗不再每次都飞镜头（只按洞口周围判断在不在画面里） */
  const cam = await p.evaluate(() => {
    const M = window.BIM_MODEL, S = window.BIM.scene;
    window.__fly = 0;
    const old = S.focusDoor;
    S.focusDoor = function () { window.__fly++; return old.apply(this, arguments); };
    const r = M.rooms.find(x => x.num === '505' && x.floor === 5);
    /* 必须挑"真的开在 505 这一段墙上"的那扇门。
       注意 d.rooms 是**整面墙上的所有房间**，同一面 33 米长的墙挂着 501~505 的门，
       只按 rooms 过滤会挑到别人家的门，镜头当然框不到。 */
    const d = (M.doors || []).filter(x => !x.added && x.floor === 5 && (x.rooms || []).indexOf(r.id) >= 0)
      .find(x => {
        const wall = M.walls.find(w => w.id === x.wall);
        if (!wall) return false;
        const L = Math.hypot(wall.p2[0] - wall.p1[0], wall.p2[1] - wall.p1[1]) || 1;
        const ux = (wall.p2[0] - wall.p1[0]) / L, uy = (wall.p2[1] - wall.p1[1]) / L;
        const at = S.doorAt(x, wall);
        const ts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]
          .map(([px, py]) => (px - wall.p1[0]) * ux + (py - wall.p1[1]) * uy);
        return at > Math.min.apply(null, ts) + 0.2 && at < Math.max.apply(null, ts) - 0.2;
      });
    if (!d) return { none: true };
    S.setFocus(5, false);
    S.frameBounds(5, r.x0 - 4, r.y0 - 4, r.x1 + 4, r.y1 + 4, false, 0.9);
    return { id: d.id };
  });
  await sleep(1200);
  /* 用户要的是"视角别转"，不是"一次都别动相机"：
     洞口在画面外时允许把视点平移过去，但**朝向必须一点不变**。
     所以这里量的是 camera 的视线方向（position-target），不是调用次数。 */
  const camDir = () => p.evaluate(() => {
    const S = window.BIM.scene, c = S.camera(), t = S.controls();
    const v = c.position.clone().sub(t.target || t).normalize();
    return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
  });
  const d0 = await camDir();
  const cam2 = await p.evaluate(id => {
    const M = window.BIM_MODEL;
    const d = (M.doors || []).find(x => x.id === id);
    window.__fly = 0;
    window.BIM.selectOpening({ kind: 'door', data: d }, true);
    return { w: window.__fly };
  }, cam.id);
  await sleep(900);
  const d1 = await camDir();
  const cam3 = await p.evaluate(async id => {
    const M = window.BIM_MODEL;
    const d = (M.doors || []).find(x => x.id === id);
    window.__fly = 0;
    for (let i = 0; i < 3; i++) {
      window.BIM.selectOpening({ kind: 'door', data: d }, true);
      await new Promise(r => setTimeout(r, 600));
    }
    return { fly: window.__fly };
  }, cam.id);
  await sleep(600);
  const d2 = await camDir();
  const same = (a, b) => Math.abs(a.x - b.x) < 5e-3 && Math.abs(a.y - b.y) < 5e-3 && Math.abs(a.z - b.z) < 5e-3;
  P('点门窗不转视角（朝向一点不变）', same(d0, d1) && same(d0, d2),
    '朝向 ' + JSON.stringify(d0) + ' → 第1次 ' + JSON.stringify(d1) + ' → 连点3次后 ' + JSON.stringify(d2) +
    '（镜头调用 ' + cam2.w + ' / ' + cam3.fly + ' 次，只平移不旋转）');

  /* ---------- ⑬ 2.4 m 以上能拓 · 打通后"放中间"接得上上下文 ---------- */
  H('【13】门洞 2.4 m 不是死线 · 打通后不报房号也接得上');
  /* 磁共振这类设备立起来搬要 2.55 m 宽，模型里 2.4 m 的门以前被一票否决 */
  const wide = await p.evaluate(() => {
    const M = window.BIM_MODEL, S = window.BIM.scene, C = window.BIM.calc;
    const wall = M.walls.find(w => w.floor === 2 && w.kind === 'corr');
    const a = C.door({ wall: wall, at: 4.8, w: 2.55, h: 2.3, conduitBlock: false });
    const b2 = C.door({ wall: wall, at: 4.8, w: 4.5, h: 2.3, conduitBlock: false });
    function spanOf(wl, r) {
      const [ax, ay] = wl.p1, [bx, by] = wl.p2;
      const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
      const ts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      return { lo: Math.min.apply(null, ts), hi: Math.max.apply(null, ts) };
    }
    let n = 0;
    (M.doors || []).forEach(d => {
      const wl = M.walls.find(w => w.id === d.wall);
      if (!wl || wl.kind === 'ext') return;
      const at = S.doorAt(d, wl);
      if (at == null) return;
      const rr = (M.rooms || []).filter(x => (wl.rooms || []).indexOf(x.id) >= 0 && x.zone !== 'corr')
        .find(x => { const s2 = spanOf(wl, x); return at > s2.lo + 0.02 && at < s2.hi - 0.02; });
      if (!rr) return;
      const plan = C.widenPlan({ wall: wl, at: at, w: d.w, h: 2.3, need: 2.55, room: rr, equipments: [], self: d });
      if (plan.best && plan.best.w >= 2.54) n++;
    });
    return {
      w255: { pass: a.pass, blocks: a.blocks.map(x => x.k + ':' + x.t), warns: a.warns },
      w450: { pass: b2.pass, blocks: b2.blocks.map(x => x.k + ':' + x.t) },
      n: n
    };
  });
  P('2.55 m 宽不再判"不能开"，只提示按特殊门做',
    !wide.w255.blocks.some(t => /^size/.test(t)) && wide.w255.warns.some(w => /2\.4/.test(w)),
    'blocks=' + JSON.stringify(wide.w255.blocks) + ' warns=' + wide.w255.warns[0]);
  P('4.5 m 才算结构洞口拦下', wide.w450.pass === false && wide.w450.blocks.some(t => /^size/.test(t)),
    JSON.stringify(wide.w450).slice(0, 120));
  P('全楼有 10 扇以上的门真能拓到 2.55 m', wide.n >= 10, wide.n + ' 扇（修之前 2.4 m 一票否决，必然是 0）');

  await call('open_passage', { room: '202', to: '203' });
  await sleep(2400);
  const ctx2 = await p.evaluate(() => {
    const A = window.BIM.agent;
    const lp = A.local('放个设备到中间');
    return {
      room: A.mem.ctx.room && A.mem.ctx.room.num,
      lastPassage: A.mem.lastPassage && A.mem.lastPassage.room.num,
      step: (lp.steps || [])[0] ? { act: lp.steps[0].act, roomRef: lp.steps[0].roomRef && lp.steps[0].roomRef.num, pref: lp.steps[0].pref } : null
    };
  });
  P('打通后上下文记着是哪间、哪块板',
    ctx2.room === '202' && ctx2.lastPassage === '202', JSON.stringify(ctx2));
  P('「放个设备到中间」不反问房号，直接落到 202 的合并板中间',
    !!(ctx2.step && ctx2.step.roomRef === '202' && ctx2.step.pref === 'center'), JSON.stringify(ctx2.step));

  const put = await call('place_equipment', { device: '空气压缩机' });
  await sleep(2200);
  const mid = await p.evaluate(() => {
    const S = window.BIM.state, M = window.BIM_MODEL;
    const e = S.placed[S.placed.length - 1];
    const a = M.rooms.find(r => r.num === '202'), b2 = M.rooms.find(r => r.num === '203');
    const mx = (Math.min(a.x0, b2.x0) + Math.max(a.x1, b2.x1)) / 2, my = (Math.min(a.y0, b2.y0) + Math.max(a.y1, b2.y1)) / 2;
    return e ? { d: +Math.hypot(e.x - mx, e.y - my).toFixed(2), merged: !!(S.last && S.last.merged) } : null;
  });
  P('设备落在打通两间的几何中间', mid && mid.merged && mid.d < 1.5, JSON.stringify(mid));

  await b.close();
  console.log('\n控制台错误：' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'));
  console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
