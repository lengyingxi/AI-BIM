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

  /* ---------------- 【14】门口汇集处的每根管都要算进来 ----------------
     用户原话："在管线开门汇集处没有考虑所有管线的绕行，撤掉门后还是有原来绕行的管线，
     撤掉再点回来会碰撞"。根子有三条：
       ① hitWall 只认"沿墙有长度"的横管，墙内下引（竖直管）的 at0/at1 是占位的 0，
          于是永远被当成"在墙的另一头"，门口那几根竖着下来的管一根都没被算进来；
       ② 撤门只删数据，不擦画面 —— 红色碰撞标记、绿色绕行线、只剩那几根的隔离全留着；
       ③ 改线记录只活在 E.data 里，任何一次 rebuild 就整包清零，
          墙上那扇门明明是牵着线开的，过一会儿再校核又变成"撞管"。 */
  H('【14】门口汇集处所有管线都算进来 · 撤门不留痕 · 改线记录活过重建');

  /* ① 单元级：洞口盖住墙内下引管时，hitWall 必须报出来，而且方案能落地 */
  const vt = await p.evaluate(() => {
    const E = window.BIM.elec, M = window.BIM_MODEL, C = window.BIM.calc;
    E.ready();
    let found = null, nVert = 0;
    M.rooms.forEach(rm => {
      if (found) return;
      ['north', 'south', 'east', 'west'].forEach(side => {
        if (found) return;
        const wl = M.walls.find(w => w.id === (rm.sides || {})[side]);
        if (!wl || wl.kind === 'ext') return;
        const a = E.axis(wl);
        const ts = [[rm.x0, rm.y0], [rm.x1, rm.y0], [rm.x0, rm.y1], [rm.x1, rm.y1]]
          .map(q => (q[0] - a.ax) * a.ux + (q[1] - a.ay) * a.uy);
        const lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
        for (let at = lo + 0.6; at <= hi - 0.6; at += 0.1) {
          const hit = E.hitWall(wl, { at: at, w: 1.0, h: 2.1, sill: 0 }) || [];
          const vs = hit.filter(c => c.vert);
          if (!vs.length) continue;
          nVert++;
          const hole = { at0: at - 0.5, at1: at + 0.5, z0: 0, z1: 2.1 };
          const plans = vs.map(c => E.planReroute(c, hole));
          if (!plans.every(q => q && q.ok)) continue;
          const pl = plans[0];
          found = {
            room: rm.num, side: side, wall: wl.id, at: +at.toFixed(2),
            hit: hit.length, vert: vs.length,
            why: pl.why, pts: (pl.pts || []).length, dir: pl.dir, addLen: +(+pl.addLen).toFixed(2)
          };
        }
      });
    });
    return { found: found, nVert: nVert };
  });
  P('洞口盖住墙内下引管时，hitWall 现在报得出来（以前一根都看不到）',
    vt.nVert > 0 && !!vt.found, vt.nVert + ' 个洞口位置报出了竖直管');
  P('竖直管也有可落地的绕行方案（沿墙让到洞口一侧，U 形四段）',
    !!(vt.found && vt.found.pts === 4 && vt.found.dir && /竖直/.test(vt.found.why)),
    JSON.stringify(vt.found));

  /* ② 链路级：开（撞横管）→ rebuild → 撤 → 再开 */
  const v14 = await p.evaluate(async () => {
    const E = window.BIM.elec, S = window.BIM.scene, M = window.BIM_MODEL, D = window.BIM.doorDbg, C = window.BIM.calc;
    E.ready();
    let best = null, hitsRef = null;
    M.rooms.forEach(rm => {
      if (best) return;
      ['north', 'south', 'east', 'west'].forEach(side => {
        if (best) return;
        const wl = M.walls.find(w => w.id === (rm.sides || {})[side]);
        if (!wl || wl.kind === 'ext') return;
        const a = E.axis(wl);
        const ts = [[rm.x0, rm.y0], [rm.x1, rm.y0], [rm.x0, rm.y1], [rm.x1, rm.y1]]
          .map(q => (q[0] - a.ax) * a.ux + (q[1] - a.ay) * a.uy);
        const lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
        for (let at = lo + 0.6; at <= hi - 0.6; at += 0.1) {
          const chk = C.door({ wall: wl, at: at, w: 1.0, h: 2.1, room: rm, equipments: [] });
          if ((chk.blocks || []).filter(q => q.k !== 'conduit').length) continue;
          const hit = chk.conduits || [];
          if (!hit.length) continue;
          const hole = { at0: at - 0.5, at1: at + 0.5, z0: 0, z1: 2.1 };
          if (!hit.map(c => E.planReroute(c, hole)).every(q => q && q.ok)) continue;
          best = { room: rm.num, side: side, wall: wl.id, at: +at.toFixed(2), hit: hit.length };
          hitsRef = hit;
        }
      });
    });
    if (!best) return { best: null };
    const rm = M.rooms.find(r => r.num === best.room);
    S.setFocus(rm.floor);
    const gcount = name => { const g = S.root().getObjectByName(name); return g ? g.children.length : 0; };
    const S2 = window.BIM.state;
    const wl = M.walls.find(w => w.id === best.wall);
    const ax = E.axis(wl);
    const hole = { at0: best.at - 0.5, at1: best.at + 0.5, z0: 0, z1: 2.1 };
    /* 一根管子在这面墙上的占位（沿墙 × 标高），用来量"洞口里还剩没剩管子" */
    const spans = () => (E.conduitsOf({ wall: wl.id }) || []).map(c => {
      const sp = E.spanOnWall(wl, c, ax);
      return sp ? { id: c.id, circ: c.circuit, a0: sp.a0, a1: sp.a1, s0: sp.s0, s1: sp.s1 } : null;
    }).filter(Boolean);
    const inHole = sp => sp.a1 > hole.at0 + 0.01 && sp.a0 < hole.at1 - 0.01 &&
      sp.s1 > hole.z0 + 0.01 && sp.s0 < hole.z1 - 0.01;
    const before = { n: spans().length, cross: spans().filter(inHole).map(s => s.id) };

    const o1 = D.openAt(rm, best.side, best.at, 1.0, 2.1);
    const plan = E.reroutes()[0];
    if (plan) S.showReroute(plan, 0x17a673);      // 等价于 UI 里 showHoleConflict 画的那条绿线
    /* 开门之后洞口里必须一根管都不剩：按新洞口铺过的管子本来就该断在洞口两侧 */
    const afterSpans = spans();
    const cross = afterSpans.filter(inHole).map(s => s.id);

    /* 红色标记的实际范围：只该是洞口两侧各 0.18 m 的断头 */
    const stubs = (D.stubs && hitsRef) ? D.stubs(wl, hitsRef, hole) : [];
    const stubLen = stubs.map(s => (s.vert ? Math.abs(s.z1 - s.z0) : Math.abs(s.at1 - s.at0)));
    const stubInHole = stubs.filter(s => {
      const sp = E.spanOnWall(wl, s, ax);
      if (!sp) return true;
      const mid = (sp.a0 + sp.a1) / 2;
      return mid > hole.at0 + 0.02 && mid < hole.at1 - 0.02;
    }).length;

    /* 绿线（规划）的标高 与 实际铺出来的 DT-* 绕行段 必须是一回事 */
    const dtH = afterSpans.filter(s => !s.vert && /^DT-/.test(s.id) && s.circ === (plan && plan.circuit));
    const recZ = plan ? +plan.z.toFixed(3) : null;
    const greenZ = plan && plan.pts && plan.pts.length
      ? +Math.max.apply(null, plan.pts.map(q => q.z)).toFixed(3) : null;
    const dtZ = dtH.length ? +((dtH[0].s0 + dtH[0].s1) / 2).toFixed(3) : null;

    const opened = {
      ok: !!(o1 && o1.ok), rerouted: (o1 && o1.rerouted) || 0,
      rrData: Object.keys(E.data.reroutes || {}).length, sceneRr: gcount('reroutes'),
      beforeCross: before.cross.length, cross: cross.length, crossIds: cross.slice(0, 4),
      stubs: stubs.length, stubMax: stubLen.length ? +Math.max.apply(null, stubLen).toFixed(3) : 0,
      stubInHole: stubInHole, recZ: recZ, greenZ: greenZ, dtZ: dtZ, dtN: dtH.length
    };
    E.rebuild();                                   // 开窗 / 打通 / 改尺寸都会走这里
    const afterRebuild = Object.keys(E.data.reroutes || {}).length;
    const u = D.undo();
    await new Promise(rs => setTimeout(rs, 60));
    const undone = {
      restored: (u && u.conduitsRestored) || 0,
      rrData: Object.keys(E.data.reroutes || {}).length,
      sceneRr: gcount('reroutes'),
      lastUndone: S2.lastUndone ? { at: +S2.lastUndone.at.toFixed(3), wall: S2.lastUndone.wall } : null
    };
    const o2 = D.openAt(rm, best.side, best.at, 1.0, 2.1);
    const again = { ok: !!(o2 && o2.ok), rerouted: (o2 && o2.rerouted) || 0, why: o2 && o2.why };
    if (o2 && o2.ok) D.undo();
    return { best: best, opened: opened, afterRebuild: afterRebuild, undone: undone, again: again };
  });
  P('找到一个"能开、墙里真有横管"的位置', !!(v14.best && v14.best.hit > 0), JSON.stringify(v14.best));
  P('开门时那几根管都改道了', !!(v14.opened && v14.opened.ok && v14.opened.rerouted === v14.best.hit),
    JSON.stringify(v14.opened));
  P('改线记录活过一次 rebuild（不再被整包清零）', v14.afterRebuild >= v14.best.hit,
    '开门后 ' + v14.opened.rrData + ' 条 → 重建后 ' + v14.afterRebuild + ' 条');
  P('撤门把改线记录清干净', v14.undone.rrData === 0, '剩 ' + v14.undone.rrData + ' 条，退回 ' + v14.undone.restored + ' 根');
  P('撤门把画面上的绕行线一起收掉（不留痕）', v14.undone.sceneRr === 0,
    '场景 reroutes 组剩 ' + v14.undone.sceneRr + ' 条');
  P('撤门记下"刚撤掉的是哪一扇"', !!(v14.undone.lastUndone && Math.abs(v14.undone.lastUndone.at - v14.best.at) < 0.01),
    JSON.stringify(v14.undone.lastUndone));
  P('撤掉再点回来：同一个位置照样能开、照样改线',
    !!(v14.again.ok && v14.again.rerouted >= 1), JSON.stringify(v14.again));

  /* ③ 画面口径：门洞里一根管都不能剩 · 红的是断头不是整根管 · 绿线跟真管子同标高
     用户第二次反馈"这个地方还是没有修复"，看的就是这一屏：
       门洞里还横着两根粗红管、绿线只贴着门底走一小段。
     根子是三处各算一套：显示层拿的是开门**前**的旧线管对象（还跨着门洞），
     红标把整根管罩粗（于是穿过门洞），规划与几何又各挑一个标高（2.47 vs 2.27）。
     下面四条就是这三处各自的"量得出来"的口径。 */
  H('【15】门洞画面口径：洞里不剩管 · 红的是断头 · 绿线与真管子同标高');
  P('开门后洞口里一根线管都不剩（以前整根横着穿过去）',
    v14.opened.cross === 0,
    '开门前跨洞 ' + v14.opened.beforeCross + ' 根 → 开门后 ' + v14.opened.cross + ' 根' +
    (v14.opened.crossIds && v14.opened.crossIds.length ? '：' + v14.opened.crossIds.join('、') : ''));
  P('红色只点在洞口两侧的断头上（每段 ≤ 0.2 m，没有落在洞里的）',
    v14.opened.stubs >= 2 && v14.opened.stubMax <= 0.2 && v14.opened.stubInHole === 0,
    '断头 ' + v14.opened.stubs + ' 段，最长 ' + v14.opened.stubMax + ' m，落洞里 ' + v14.opened.stubInHole + ' 段');
  P('绿色改线的标高就是实际绕行段的标高（不再规划一套、几何一套）',
    v14.opened.recZ != null && v14.opened.dtN > 0 &&
    Math.abs(v14.opened.recZ - v14.opened.dtZ) < 0.011 &&
    Math.abs(v14.opened.recZ - v14.opened.greenZ) < 0.011,
    '记录 ' + v14.opened.recZ + ' m / 绿线 ' + v14.opened.greenZ + ' m / 实铺 DT 段 ' +
    v14.opened.dtZ + ' m（' + v14.opened.dtN + ' 段）');

  /* ④ 同一个洞口好几根管时，每根要排到**互不相同**的标高上。
     以前三根管全被排到"洞顶以上第一个空位"，画出来是一条绿线，实际三根叠死。 */
  const mv = await p.evaluate(() => {
    const E = window.BIM.elec, M = window.BIM_MODEL;
    E.ready();
    let found = null;
    M.rooms.forEach(rm => {
      if (found) return;
      ['north', 'south', 'east', 'west'].forEach(side => {
        if (found) return;
        const wl = M.walls.find(w => w.id === (rm.sides || {})[side]);
        if (!wl || wl.kind === 'ext') return;
        const a = E.axis(wl);
        const ts = [[rm.x0, rm.y0], [rm.x1, rm.y0], [rm.x0, rm.y1], [rm.x1, rm.y1]]
          .map(q => (q[0] - a.ax) * a.ux + (q[1] - a.ay) * a.uy);
        const lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
        for (let at = lo + 0.6; at <= hi - 0.6; at += 0.1) {
          const hit = (E.hitWall(wl, { at: at, w: 1.0, h: 2.1, sill: 0 }) || []).filter(c => !c.vert);
          if (hit.length < 2) continue;
          const hole = { at0: at - 0.5, at1: at + 0.5, z0: 0, z1: 2.1 };
          const avoid = [];
          const plans = hit.map(c => {
            const pp = E.planReroute(c, hole, avoid);
            if (pp && pp.ok) {
              const hf = (c.s || 0.04) / 2 + 0.04;
              avoid.push([pp.z - hf, pp.z + hf]);
            }
            return pp;
          });
          if (!plans.every(q => q && q.ok)) continue;
          found = {
            room: rm.num, side: side, at: +at.toFixed(2), n: hit.length,
            zs: plans.map(q => +q.z.toFixed(2)),
            distinct: new Set(plans.map(q => +q.z.toFixed(2))).size
          };
        }
      });
    });
    return found;
  });
  P('一个洞口里好几根管时，每根排到互不相同的标高（不再叠死）',
    !!(mv && mv.n >= 2 && mv.distinct === mv.n), JSON.stringify(mv));

  /* ---------------- 【16】配电箱的连接管撞门也要改道 ----------------
     用户原话："这个目前在405的控制箱后面开门时候连接管碰撞到了门但是没有绕行的处理"。
     那根是**层进线 FD**（从立管水平引到箱顶，2.05 m 高），它 wall=null 只有两端点，
     以前 hitWall 按"墙 id"过滤，这类明敷段根本进不了冲突集合 ——
     于是门头前面横着一根管，既不报冲突、也没有绿线，用户只能说"没处理"。
     另外用户还指出："把原先需要展示的涉及到的原管线去掉了" ——
     上一版隔离清单只取 conduitsOf({wall})，明敷段照样被漏掉，这一节一起验。 */
  H('【16】配电箱层进线撞门：算进冲突 · 抬过门头 · 撤门还原');
  const v16 = await p.evaluate(async () => {
    const E = window.BIM.elec, M = window.BIM_MODEL, S = window.BIM.scene, D = window.BIM.doorDbg;
    E.ready();
    const rm = M.rooms.find(x => x.num === '405');
    const wl = M.walls.find(w => w.id === rm.sides.west);
    const a = E.axis(wl);
    const f = M.floors.find(x => x.level === 4);
    const AT = 1.90, W = 1.0, H = 2.1;
    const HOLE = { at0: AT - W / 2, at1: AT + W / 2, z0: 0, z1: H };
    const R2 = v => +v.toFixed(3);

    const hitObjs = E.hitWall(wl, { at: AT, w: W, h: H, sill: 0 }) || [];
    const hits = hitObjs.map(c => c.id);
    const fdBefore = (E.data.conduits || []).filter(c => /^FD-4$/.test(c.id)).length;

    S.setFocus(4, false);
    const o = D.openAt(rm, 'west', AT, W, H);

    /* 铺出来的 FD 段（改道后应该拆成 5 段，跨门那段在门头以上） */
    const fd = (E.data.conduits || []).filter(c => /^FD-4/.test(c.id)).map(c => {
      const zs = c.free ? [c.p1[2], c.p2[2]] : [c.z0, c.z1];
      return { id: c.id, z0: R2(Math.min.apply(null, zs)), z1: R2(Math.max.apply(null, zs)) };
    });
    const fdHigh = fd.filter(x => /-h$/.test(x.id));

    /* 画面上到底有没有东西落在门洞里：直接读场景几何。
       ★ 注意 three.js 的轴：v.x = 模型 x，v.y = 标高，v.z = -模型 y，
         平面坐标要还原成 (x, -z) 再投影，别拿 v.y 当平面 y 用。 */
    /* 按**方盒**判重叠，不是按顶点：一根 6.6 m 长的管只在其两端有顶点，
       拿顶点判会把"整根穿过门洞"错判成没碰到。boxGeo 每个盒子 24 个顶点，
       把每个盒子的 24 个点都换成 (沿墙 at, 法向 perp, 标高 z)，取包络再做矩形相交。 */
    const scan = (g, pad) => {
      if (!g) return { boxes: 0, inHole: 0 };
      let boxes = 0, hitN = 0;
      g.traverse(o2 => {
        if (!o2.isMesh || !o2.geometry || !o2.geometry.attributes.position) return;
        o2.updateWorldMatrix(true, false);
        const pos = o2.geometry.attributes.position;
        const v = new window.THREE.Vector3();
        for (let b = 0; b + 23 < pos.count; b += 24) {
          boxes++;
          let a0 = 1e9, a1 = -1e9, p0 = 1e9, p1 = -1e9, z0 = 1e9, z1 = -1e9;
          for (let i = b; i < b + 24; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o2.matrixWorld);
            const at = (v.x - a.ax) * a.ux + ((-v.z) - a.ay) * a.uy;
            const pp = (v.x - a.ax) * (-a.uy) + ((-v.z) - a.ay) * a.ux;
            const zz = v.y - f.elev;
            if (at < a0) a0 = at; if (at > a1) a1 = at;
            if (pp < p0) p0 = pp; if (pp > p1) p1 = pp;
            if (zz < z0) z0 = zz; if (zz > z1) z1 = zz;
          }
          if (a1 > HOLE.at0 + pad && a0 < HOLE.at1 - pad &&
              z1 > HOLE.z0 + pad && z0 < HOLE.z1 - pad &&
              p0 < wl.t / 2 + 0.06 && p1 > -(wl.t / 2 + 0.06)) hitN++;
        }
      });
      return { boxes: boxes, inHole: hitN };
    };
    const iso = scan(S.root().getObjectByName('elec-iso'), 0.01);
    const hitG = (S.root().children || []).filter(c => c.type === 'Group' && !c.name).map(g => scan(g, 0.12))[0];
    const rer = scan(S.root().getObjectByName('reroutes'), 0.01);
    /* 原管线虚影（elec-dead）：它**应该**穿过门洞 —— 这就是"原来从这儿过去"的那一层 */
    const dead = scan(S.root().getObjectByName('elec-dead'), 0.01);

    /* 明敷段有没有被显示出来：FD 的两截 2.05 m 段在 at 2.58~3.30 一带 */
    let fdShown = 0;
    const isoG = S.root().getObjectByName('elec-iso');
    if (isoG) {
      isoG.traverse(o2 => {
        if (!o2.isMesh || !o2.geometry || !o2.geometry.attributes.position) return;
        o2.updateWorldMatrix(true, false);
        const pos = o2.geometry.attributes.position;
        const v = new window.THREE.Vector3();
        for (let i = 0; i < pos.count; i += 3) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o2.matrixWorld);
          const at = (v.x - a.ax) * a.ux + ((-v.z) - a.ay) * a.uy;
          const zz = v.y - f.elev;
          if (at > 2.66 && at < 3.34 && Math.abs(zz - 2.05) < 0.10) fdShown++;
        }
      });
    }

    /* 红色断头：4 处（插座 0.32 m 两处 + 层进线 2.05 m 两处），都很短。
       用**开门前**的命中对象算，跟 showHoleConflict 里的调用完全一致。 */
    const stubs = (D.stubs ? D.stubs(wl, hitObjs, HOLE) : []) || [];
    const stubLen = stubs.map(s => (s.free ? Math.hypot(s.p1[0] - s.p2[0], s.p1[1] - s.p2[1], s.p1[2] - s.p2[2])
      : (s.vert ? Math.abs(s.z1 - s.z0) : Math.abs(s.at1 - s.at0))));

    const rr = E.reroutes().map(x => ({ c: x.conduit, z: R2(x.z), off: !!x.off, cuts: x.cuts ? x.cuts.length : 0 }));

    E.rebuild();
    const afterRebuild = { fdN: (E.data.conduits || []).filter(c => /^FD-4/.test(c.id)).length,
                           rr: Object.keys(E.data.reroutes || {}).length };
    D.undo();
    const afterUndo = { fd: (E.data.conduits || []).filter(c => /^FD-4/.test(c.id)).map(c => c.id),
                        rr: Object.keys(E.data.reroutes || {}).length };

    return {
      hits: hits, fdBefore: fdBefore, opened: o, fd: fd, fdHigh: fdHigh,
      iso: iso, hitG: hitG, rer: rer, dead: dead, fdShown: fdShown,
      stubs: stubs.length, stubMax: stubLen.length ? R2(Math.max.apply(null, stubLen)) : 0,
      rr: rr, afterRebuild: afterRebuild, afterUndo: afterUndo
    };
  });
  P('配电箱的层进线被算进这扇门的冲突（以前 hitWall 只认墙里的管）',
    v16.hits.indexOf('FD-4') >= 0, JSON.stringify(v16.hits));
  P('开门时墙里那根和连接管一起改道', !!(v16.opened && v16.opened.rerouted === 2),
    JSON.stringify(v16.rr));
  P('连接管的绕行方案带 4 个三维转角（铺管要按它拆段）',
    v16.rr.some(x => x.off && x.cuts === 4), JSON.stringify(v16.rr.filter(x => x.off)));
  P('连接管真的被拆成 5 段铺出来、跨门那段抬到门头以上',
    v16.fd.length === 5 && v16.fdHigh.length === 1 && v16.fdHigh[0].z0 > 2.1,
    v16.fd.map(x => x.id + '@' + x.z0 + '~' + x.z1).join(' '));
  P('画面上门洞里一根实心管都不剩（隔离管 / 红标 / 绿线三批方盒全是 0）',
    v16.iso.inHole === 0 && (!v16.hitG || v16.hitG.inHole === 0) && v16.rer.inHole === 0,
    '隔离 ' + v16.iso.boxes + ' 个方盒/' + v16.iso.inHole + ' 落洞里，红标 ' +
    (v16.hitG ? v16.hitG.boxes : 0) + '/' + (v16.hitG ? v16.hitG.inHole : 0) +
    '，绿线 ' + v16.rer.boxes + '/' + v16.rer.inHole);
  P('原管线整根按虚影留着（不是只剩两个断头）',
    v16.dead.boxes > 0 && v16.dead.inHole > 0,
    '虚影 ' + v16.dead.boxes + ' 个方盒，其中 ' + v16.dead.inHole + ' 个与门洞重叠（"原来从这儿穿过"）');  P('涉及到的原管线仍然显示（含明敷的层进线，不再被漏掉）',
    v16.iso.boxes >= 8 && v16.fdShown > 0,
    '隔离出 ' + v16.iso.boxes + ' 个方盒，其中箱前 2.05 m 那段有 ' + v16.fdShown + ' 个顶点');  P('红色断头 4 处（插座 2 + 层进线 2），每段都很短',
    v16.stubs >= 4 && v16.stubMax <= 0.2,
    v16.stubs + ' 段，最长 ' + v16.stubMax + ' m');
  P('重建之后还是 5 段、记录还在', v16.afterRebuild.fdN === 5 && v16.afterRebuild.rr === 2,
    JSON.stringify(v16.afterRebuild));
  P('撤门后连接管接回一整段、记录清空',
    v16.afterUndo.fd.length === 1 && v16.afterUndo.fd[0] === 'FD-4' && v16.afterUndo.rr === 0,
    JSON.stringify(v16.afterUndo));

  await b.close();
  console.log('\n控制台错误：' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'));
  console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
