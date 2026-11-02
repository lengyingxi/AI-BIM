/* 电气管线 + 打穿/拆墙 验收脚本
   覆盖：线管数据规模与通用性、分路控制影响面、开洞撞线管、改线规划、
        打穿/拆墙的结构与尺寸限制、冲突可视化、MCP 工具暴露。
   用法：SITE=http://127.0.0.1:88xx node tools/elec.js */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8823';

let ok = 0, bad = 0;
const P = (name, cond, info) => {
  if (cond) { ok++; console.log('  ✅ ' + name + (info ? ' — ' + info : '')); }
  else { bad++; console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
};
const H = t => { console.log('\n' + t); };

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
  await sleep(2800);

  /* ---------- 1. 数据层规模与结构 ---------- */
  H('【1】线管数据层');
  const d1 = await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL;
    const st = E.stats();
    const byFloor = {};
    (E.data ? E.data.panels : []).forEach(p => { byFloor[p.floor] = (byFloor[p.floor] || 0) + 1; });
    /* 主干立管：必须全楼同一平面位置，且各层段首尾相接，才算"一条通到底" */
    const rs = (E.data.risers || []).slice().sort((a, b) => a.floor - b.floor);
    const aligned = rs.length > 0 && rs.every(r =>
      Math.abs(r.x - rs[0].x) < 1e-6 && Math.abs(r.y - rs[0].y) < 1e-6);
    const chained = rs.every((r, i) => {
      if (i === 0) return Math.abs(r.z0) < 1e-6;
      const prev = rs[i - 1];
      const pf = M.floors.find(f => f.level === prev.floor) || {};
      return Math.abs(r.z0) < 1e-6 && Math.abs(prev.z1 - (pf.height || 0)) < 1e-6;
    });
    return {
      st: st, panels: E.data.panels.length, circuits: E.data.circuits.length,
      floors: M.floors.length, rooms: M.rooms.length,
      floorPanel: byFloor,
      kinds: E.data.circuits.map(c => c.kind).filter((v, i, a) => a.indexOf(v) === i),
      perFloorCircuits: Object.keys(byFloor).map(f => E.list(+f).length),
      riserAligned: aligned && chained,
      trunkText: rs.length ? ('x=' + rs[0].x.toFixed(2) + ' y=' + rs[0].y.toFixed(2) + '，' + rs.length + ' 段首尾相接') : '无立管'
    };
  });
  P('每层一部配电箱', d1.panels === d1.floors, d1.panels + ' 箱 / ' + d1.floors + ' 层');
  P('每层三条分路（照明/插座/动力）', d1.perFloorCircuits.every(n => n === 3), JSON.stringify(d1.perFloorCircuits));
  /* 总量只是防退化的下限：55 间房 × 5 层规模的楼，三百多段是合理密度。
     插座/动力不铺走廊侧（那面墙全是门），所以比早先满铺时少一截，属预期。 */
  P('线管总量 > 300', d1.st.conduits > 300, JSON.stringify(d1.st.by_kind));
  P('四类线管齐全（含楼层进线竖井）',
    ['light', 'socket', 'power', 'riser'].every(k => d1.st.by_kind[k] > 0));

  /* 拓扑必须是"主干 → 干线 → 支线"的四级，不能还是逐墙乱铺 */
  const bl = d1.st.by_layer || {};
  P('五级拓扑齐全（主干/层进线/走廊干线/墙内下引/房间支线）',
    ['trunk', 'feed', 'corridor', 'drop', 'room'].every(k => bl[k] > 0),
    JSON.stringify(bl));
  P('主干立管每层一段且上下对齐（一条通到底）', d1.riserAligned === true, d1.trunkText);

  /* ---------- 1b. 管线连续性：干线支线都不能断成一截截 ---------- */
  H('【1b】管线连续性');
  const dc = await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL;
    /* 走廊干线：同一条分路在同一面墙上不该被切成很多小段 */
    const corr = E.conduitsOf({ floor: 1, layer: 'corridor' });
    const byWallKind = {};
    corr.forEach(c => { const k = c.wall + '|' + c.kind; (byWallKind[k] = byWallKind[k] || []).push(c); });
    const splits = Object.keys(byWallKind).map(k => byWallKind[k].length);
    /* 房间支线：每间房四面墙都得铺到，一侧空缺就成了"半圈"，
       看着就是断线。逐间逐面查。 */
    const room = E.conduitsOf({ floor: 1, layer: 'room', kind: 'light' });
    const miss = [];
    M.rooms.filter(r => r.floor === 1 && r.zone !== 'corr').forEach(r => {
      Object.keys(r.sides || {}).forEach(k => {
        const n = room.filter(c => c.wall === r.sides[k]).length;
        if (!n) miss.push(r.num + ':' + k);
      });
    });
    return {
      corrN: corr.length, maxSplit: Math.max.apply(null, splits.concat([0])),
      roomN: room.length, miss: miss
    };
  });
  P('走廊干线整段敷设（同一墙同一分路不被切碎）', dc.maxSplit <= 2,
    dc.corrN + ' 段，单墙最多 ' + dc.maxSplit + ' 段');
  P('房间照明支线绕满四周（四面墙都铺到，不留半圈）', dc.miss.length === 0,
    dc.roomN + ' 段' + (dc.miss.length ? '，缺：' + dc.miss.join(',') : ''));

  /* ---------- 2. 通用性：任意楼层任意房间都成立 ---------- */
  H('【2】通用性（不写死房号）');
  const d2 = await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL;
    /* 每层随机抽 3 间，看能不能查到分路 + 墙上有没有线管 */
    const out = [];
    M.floors.forEach(f => {
      const rs = M.rooms.filter(r => r.floor === f.level);
      const pick = [rs[0], rs[Math.floor(rs.length / 2)], rs[rs.length - 1]].filter(Boolean);
      pick.forEach(r => {
        const cs = E.roomsCircuits(r);
        const walls = Object.keys(r.sides || {});
        let cond = 0;
        walls.forEach(k => { cond += E.conduitsOf({ floor: r.floor }).filter(c => c.wall === r.sides[k]).length; });
        out.push({ floor: f.level, num: r.num, circuits: cs.length, conduits: cond });
      });
    });
    return out;
  });
  const noCirc = d2.filter(x => x.circuits === 0);
  const noCond = d2.filter(x => x.conduits === 0);
  P('抽样 ' + d2.length + ' 间房都能查到分路', noCirc.length === 0,
    noCirc.length ? '缺：' + noCirc.map(x => x.num).join(',') : '');
  P('抽样房间墙上都埋着线管', noCond.length === 0,
    noCond.length ? '缺：' + noCond.map(x => x.num).join(',') : '');

  /* ---------- 3. 分路控制：影响面按功能算 ---------- */
  H('【3】分路控制与影响面');
  const d3 = await p.evaluate(async () => {
    const E = BIM.elec;
    const cA = E.circuit('L2A');
    const before = E.impact('L2A');
    const r = await BIM.mcp.call('toggle_circuit', { circuit: 'L2A', action: 'off' });
    const after = E.impact('L2A');
    const xray = BIM.scene.xray;
    const back = await BIM.mcp.call('toggle_circuit', { circuit: 'L2A', action: 'on' });
    return {
      kind: cA.kind, n: before.count,
      dark: after.dark_rooms.length, total: after.count,
      say: (r.say || ''), on: r.ok,
      recovered: back.ok && E.circuit('L2A').on !== false,
      xray: xray,
      /* 断电后，同层其它两路不该被连累 */
      others: ['L2B', 'L2C'].map(id => E.circuit(id).on)
    };
  });
  P('照明分路断开后，本层全部房间被标黑', d3.dark === d3.total && d3.total > 0,
    d3.dark + '/' + d3.total + ' 间');
  P('回复不再自相矛盾（不出现"会变黑…不会黑"并存）',
    !(/变黑/.test(d3.say) && /不会黑/.test(d3.say)), d3.say.slice(0, 70));
  P('断一路不连累同层另外两路', d3.others.every(v => v !== false), JSON.stringify(d3.others));
  P('合闸能恢复', d3.recovered === true);
  P('切换分路时楼体变半透明', d3.xray === true);

  /* ---------- 4. 开洞撞墙内线管 ---------- */
  H('【4】开窗/开门撞墙内线管');
  const d4 = await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL, C = BIM.calc;
    /* 找一面带插座管（贴地 0.32 m）的墙 —— 取房间支线，
       不要拿走廊干线（2.80 m 桥架），那个高度门也撞不到 */
    const cs = E.conduitsOf({ floor: 1, kind: 'socket', layer: 'room' });
    const c0 = cs[0];
    const wall = M.walls.find(w => w.id === c0.wall);
    const at = (c0.at0 + c0.at1) / 2;
    const low = C.window({ wall, at, w: 1.5, h: 1.5, sill: 0.9, room: null });     // 普通窗，够不着
    const floorWin = C.window({ wall, at, w: 1.8, h: 2.4, sill: 0, room: null });  // 落地窗，必撞
    const door = C.door({ wall, at, w: 1.0, h: 2.1, room: null });                  // 门，必撞
    const cBlock = (floorWin.blocks || []).filter(x => x.k === 'conduit');
    return {
      wall: wall.id, z: c0.z, lowHit: (low.conduits || []).length,
      winHit: (floorWin.conduits || []).length, doorHit: (door.conduits || []).length,
      blocked: cBlock.length, text: cBlock[0] && cBlock[0].t,
      pass: floorWin.pass, doorPass: door.pass
    };
  });
  P('普通窗（台高 0.9）避开贴地插座管', d4.lowHit === 0, '管中距地 ' + d4.z + ' m');
  P('落地窗撞上插座管并被拦', d4.winHit > 0 && d4.blocked > 0,
    '撞 ' + d4.winHit + ' 根，拦 ' + d4.blocked + ' 条：' + String(d4.text || '').slice(0, 40));
  P('门撞上插座管并被拦', d4.doorHit > 0, '撞 ' + d4.doorHit + ' 根');

  /* ---------- 5. 改线规划 ---------- */
  H('【5】牵线改道规划');
  const d5 = await p.evaluate(() => {
    const E = BIM.elec;
    const c0 = E.conduitsOf({ floor: 1, kind: 'socket', layer: 'room' })[0];
    const hole = { at0: c0.at0 - 0.2, at1: c0.at1 + 0.2, z0: 0, z1: 2.4 };
    const plan = E.planReroute(c0, hole);
    const before = E.hitWall(BIM_MODEL.walls.find(w => w.id === c0.wall), { at: (c0.at0 + c0.at1) / 2, w: 1.8, h: 2.4, sill: 0 }).length;
    if (plan && plan.ok) E.applyReroute(c0, hole, plan);
    const after = E.hitWall(BIM_MODEL.walls.find(w => w.id === c0.wall), { at: (c0.at0 + c0.at1) / 2, w: 1.8, h: 2.4, sill: 0 }).length;
    return {
      ok: !!(plan && plan.ok), dir: plan && plan.dir, z: plan && +(+plan.z).toFixed(2),
      add: plan && +(+plan.addLen).toFixed(2), pts: plan && plan.pts.length,
      why: plan && plan.why, before: before, after: after,
      count: Object.keys(E.data.reroutes || {}).length
    };
  });
  P('给出改线方案', d5.ok === true, d5.why);
  P('改线方向为上翻或下翻', d5.dir === 'up' || d5.dir === 'down', d5.dir + ' → ' + d5.z + ' m');
  P('改线给出折点路径与增加的线长', d5.pts >= 4 && d5.add > 0, d5.pts + ' 个折点，多走 ' + d5.add + ' m');
  P('改线后再查同一位置不再报冲突', d5.after === 0, d5.before + ' → ' + d5.after);
  P('改线记录已落地', d5.count >= 1, d5.count + ' 条');

  /* ---------- 6. 打穿 / 拆墙 ---------- */
  H('【6】空间打穿与拆墙');
  const d6 = await p.evaluate(async () => {
    const M = BIM_MODEL, C = BIM.calc;
    /* 找一间有内隔墙、且隔壁有房间的房 */
    let target = null;
    for (const r of M.rooms) {
      const sides = r.sides || {};
      for (const k of ['north', 'south', 'east', 'west']) {
        const w = M.walls.find(x => x.id === sides[k]);
        if (w && w.kind !== 'ext' && (w.rooms || []).filter(id => id !== r.id).length) { target = { room: r, side: k, wall: w }; break; }
      }
      if (target) break;
    }
    /* 外墙必须拒绝 */
    const extWall = M.walls.find(w => w.kind === 'ext');
    const ext = C.passage({ wall: extWall, at: 2, w: 1.8, h: 2.2, room: null });

    /* 太矮（挖到顶，留不出过梁） */
    const tall = C.passage({ wall: target.wall, at: 2, w: 1.8, h: target.wall.h - 0.1, room: null });
    /* 太窄 */
    const thin = C.passage({ wall: target.wall, at: 2, w: 0.5, h: 2.0, room: null });

    const r1 = await BIM.mcp.call('open_passage', { room: target.room.num, side: target.side, width: 1.6, height: 2.2 });
    const r2 = await BIM.mcp.call('open_passage', { room: target.room.num, mode: 'demolish' });
    return {
      target: target.room.num + ' ' + target.side,
      extBlocked: !ext.pass && (ext.blocks || []).some(x => /外墙|承重/.test(x.t)),
      tallBlocked: !tall.pass, tallText: (tall.blocks[0] || {}).t,
      thinBlocked: !thin.pass,
      cut: { ok: r1.ok, d: r1.data },
      demo: { ok: r2.ok, d: r2.data },
      passages: (M.passages || []).length
    };
  });
  P('外墙打穿被拒绝', d6.extBlocked === true);
  P('挖到顶（留不出过梁）被拒绝', d6.tallBlocked === true, d6.tallText);
  P('洞口过窄被拒绝', d6.thinBlocked === true);
  P('内隔墙打穿成功', d6.cut.ok === true, d6.target + (d6.cut.d ? '，过梁 ' + d6.cut.d.above_m + ' m' : ''));
  P('打穿后记录连通房号', !!(d6.cut.d && d6.cut.d.to), d6.cut.d && ('→ ' + d6.cut.d.to));
  P('整段拆墙成功', d6.demo.ok === true, d6.demo.d ? (d6.demo.d.side + ' ' + d6.demo.d.width + '×' + d6.demo.d.height) : '');

  /* ---------- 7. 冲突可视化 ---------- */
  H('【7】冲突可视化');
  const d7 = await p.evaluate(async () => {
    const E = BIM.elec, M = BIM_MODEL, S = BIM.scene;
    const c0 = E.conduitsOf({ floor: 1, kind: 'socket', layer: 'room' })[0];
    const wall = M.walls.find(w => w.id === c0.wall);
    S.showConduits(true);
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    /* 只显示这一根：其它分路整体隐藏（不是压暗），屏幕上干净才看得清 */
    S.isolateConduits([c0]);
    S.markConduits([c0], 0xff3b30);
    const plan = E.planReroute(c0, { at0: c0.at0 - .2, at1: c0.at1 + .2, z0: 0, z1: 2.4 });
    S.showReroute(plan, 0x17a673);
    const R = S._dbg ? S._dbg() : {};
    return {
      conduitOn: S.elecOn(), xray: S.xray, isolated: S.hasIsolate ? S.hasIsolate() : null,
      /* 不依赖调试接口，用统计判断：标记后应该有线管处于高亮材质 */
      stats: E.stats()
    };
  });
  P('线管可整体显示', d7.conduitOn === true);
  P('显示线管时自动半透明楼体', d7.xray === true);
  P('碰撞时只显示命中的管线（其它分路收起）', d7.isolated === true);
  const shot1 = 'outputs/elec-conflict.png';
  await p.screenshot({ path: shot1 });

  /* ---------- 9. 绕行与弯头 ---------- */
  H('【9】管线绕行与弯头接头');
  const d9 = await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL;
    const D = E.ready();
    const joints = D.joints || [];
    const det = D.conduits.filter(c => c.detour);
    /* 每个管段的端点，看有多少端点没被任何接头盖住 —— 就是"断头管" */
    const endsOf = c => {
      if (c.free && c.p1 && c.p2) return [{ x: c.p1[0], y: c.p1[1], z: c.p1[2] }, { x: c.p2[0], y: c.p2[1], z: c.p2[2] }];
      if (c.vert) return [{ x: c.x, y: c.y, z: c.z0 }, { x: c.x, y: c.y, z: c.z1 }];
      const w = M.walls.find(q => q.id === c.wall); if (!w) return [];
      const a = E.axis(w);
      return [c.at0, c.at1].map(at => ({ x: a.ax + a.ux * at, y: a.ay + a.uy * at, z: c.z }));
    };
    const TOL = 0.15;
    const covered = (circ, p) => joints.some(j => j.circuit === circ &&
      Math.abs(j.x - p.x) < TOL && Math.abs(j.y - p.y) < TOL && Math.abs(j.z - p.z) < TOL);
    let total = 0, bare = 0;
    D.conduits.forEach(c => endsOf(c).forEach(p => { total++; if (!covered(c.circuit, p)) bare++; }));
    /* 绕行段两端必须接上：竖段底/顶 + 横段两端 */
    let detEnds = 0, detBare = 0;
    det.forEach(c => endsOf(c).forEach(p => { detEnds++; if (!covered(c.circuit, p)) detBare++; }));
    const types = joints.reduce((a, j) => (a[j.type] = (a[j.type] || 0) + 1, a), {});
    return {
      conduits: D.conduits.length, joints: joints.length, types: types,
      detour: det.length, detRooms: det.map(c => c.roomNum).filter(Boolean).slice(0, 4),
      detBare: detBare, detEnds: detEnds,
      barePct: Math.round(bare / total * 100), bare: bare, total: total,
      stat: E.stats().joints
    };
  });
  P('生成了弯头/接头', d9.joints > 100, d9.joints + ' 个（弯头 ' + (d9.types.elbow || 0) + ' / 三通 ' + (d9.types.tee || 0) + '）');
  P('接头进了统计（渲染和查询同一份数据）', d9.stat === d9.joints, 'stats.joints=' + d9.stat);
  P('门窗洞处的管段做了绕行', d9.detour >= 3, d9.detour + ' 段绕行，房间 ' + d9.detRooms.join('/'));
  P('绕行段两端都接上了（不是断头管）', d9.detBare === 0, d9.detBare + ' / ' + d9.detEnds + ' 个端点悬空');
  P('全楼断头端点 < 12%', d9.barePct < 12, d9.bare + ' / ' + d9.total + ' = ' + d9.barePct + '%');

  /* 接头几何真的进了场景：把 joints 清空重建，顶点数应该明显变少 */
  const d9b = await p.evaluate(() => {
    const S = BIM.scene, E = BIM.elec;
    const count = () => {
      const root = S.root().getObjectByName('elec');
      let v = 0;
      if (root) root.traverse(o => { if (o.isMesh && o.userData && o.userData.kind === 'conduit') v += o.geometry.attributes.position.count; });
      return v;
    };
    S.showConduits(true);
    S.rebuildElec();
    const withJ = count();
    const saved = E.ready().joints;
    E.ready().joints = [];
    S.rebuildElec();
    const noJ = count();
    E.ready().joints = saved;
    S.rebuildElec();
    return { withJ: withJ, noJ: noJ, diff: withJ - noJ };
  });
  P('接头真的画进了线管网格', d9b.diff > 0, '顶点 ' + d9b.noJ + ' → ' + d9b.withJ + '（+ ' + d9b.diff + '）');

  /* ---------- 10. 改线走向可视化 ---------- */
  H('【10】门窗改线的实际走向');
  const d10 = await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene, M = BIM_MODEL;
    const c0 = E.conduitsOf({ floor: 1, kind: 'socket', layer: 'room' })[0];
    const wall = M.walls.find(w => w.id === c0.wall);
    const hole = { at0: c0.at0 + .4, at1: c0.at0 + 1.4, z0: 0, z1: 2.1 };
    const plan = E.planReroute(c0, hole);
    S.showConduits(true);
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    S.isolateConduits([c0]);
    S.markConduits([c0], 0xff3b30);
    const mesh = S.showReroute(plan, 0x17a673);
    const grp = S.root().getObjectByName('reroutes');
    const nMesh = grp ? grp.children.length : 0;
    return {
      ok: plan.ok, pts: plan.pts.length, drew: !!mesh, groups: nMesh,
      /* 起点和终点要落在管子本身上：原来只画洞口那 0.36 m，屏幕上根本看不见 */
      fromEnd: Math.abs(plan.pts[0].at - c0.at0) < 0.02,
      toEnd: Math.abs(plan.pts[plan.pts.length - 1].at - c0.at1) < 0.02,
      addLen: plan.addLen
    };
  });
  P('改线方案可算', d10.ok === true);
  P('改线路线真的被画出来（不是返回空）', d10.drew === true, '场景里 reroutes 组 ' + d10.groups + ' 个对象');
  P('路线从这根管子的起点走到终点', d10.fromEnd && d10.toEnd, d10.pts + ' 个折点，多走 ' + d10.addLen + ' m');

  /* ---------- 11. 断电呈现：配电箱 + 断路器 + 回路影响 ---------- */
  H('【11】断电呈现');
  const d11 = await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene;
    S.showConduits(false);
    S.setXray(false);
    await BIM.app.send('把2楼第1回路断电');
    /* 镜头飞过去是 780 ms 的缓动，headless 里 rAF 会慢一点，多留些时间 */
    await new Promise(r => setTimeout(r, 3000));
    const c = E.circuit('L2A');
    const cam = S.camPos();
    const panel = E.ready().panels.find(p => p.floor === 2);
    const pel = (BIM_MODEL.floors.find(f => f.level === 2) || {}).elev || 0;
    const pd = Math.hypot(cam.p[0] - panel.x, cam.p[2] - (-panel.y));
    return {
      on: c.on, label: c.label, no: c.no, panel: c.panel,
      focus: S.focus, camDist: cam.dist, panDist: pd,
      chips: [].slice.call(document.querySelectorAll('.chips button')).map(b => b.textContent)
    };
  });
  P('按"第 1 回路"能找到 L2A', d11.label === '2F 第1回路' && d11.on === false, d11.label + ' on=' + d11.on);
  P('聚焦到 2 楼', d11.focus === 2, 'focus=' + d11.focus);
  P('镜头推到配电箱跟前（< 4 m，能看清手柄又看得见整台柜子）', d11.camDist < 4, '镜头距目标 ' + d11.camDist.toFixed(2) + ' m');
  P('回复里给了「查看回路影响」气泡', d11.chips.some(x => /查看回路影响/.test(x)), d11.chips.join(' / '));

  /* 断路器状态必须烘进几何：off 与 on 的顶点数不能一样，否则手柄动不了 */
  const d11b = await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene;
    const p = E.ready().panels.find(x => x.floor === 2);
    const grab = () => {
      const g = S.root().getObjectByName('panels');
      const m = g && g.children.find(x => x.userData && x.userData.data && x.userData.data.id === p.id);
      if (!m) return null;
      const pos = m.geometry.attributes.position;
      /* 只取前 200 个顶点做指纹，够判断几何有没有变 */
      let s = 0;
      for (let i = 0; i < Math.min(pos.count, 300); i++) s += pos.getX(i) + pos.getY(i) * 3 + pos.getZ(i) * 7;
      return { v: pos.count, sig: Math.round(s * 1000) };
    };
    S.showConduits(true);
    S.refreshPanels(2);
    E.toggle('L2A', false); S.refreshPanels(2);
    const off = grab();
    E.toggle('L2A', true); S.refreshPanels(2);
    const on = grab();
    return { off: off, on: on };
  });
  P('断路器断开/合闸的画法不一样（手柄会动）',
    !!(d11b.off && d11b.on) && d11b.off.sig !== d11b.on.sig,
    d11b.off && d11b.on ? '顶点签名 off=' + d11b.off.sig + ' on=' + d11b.on.sig : '取不到箱体');

  const d11c = await p.evaluate(async () => {
    const t = [].slice.call(document.querySelectorAll('.chips button')).filter(x => /查看回路影响/.test(x.textContent))[0];
    if (!t) return { clicked: false };
    t.click();
    await new Promise(r => setTimeout(r, 1600));
    const S = BIM.scene, E = BIM.elec;
    const iso = S.root().getObjectByName('elec-iso');
    let meshes = 0;
    if (iso) iso.traverse(o => { if (o.isMesh) meshes++; });
    return { clicked: true, isolated: S.hasIsolate(), meshes: meshes, focus: S.focus };
  });
  P('点「查看回路影响」后只看这一条路', d11c.clicked && d11c.isolated === true, '隔离组 ' + d11c.meshes + ' 个 mesh');
  P('影响视图回到本层全貌（能看全受影响的房间）', d11c.focus === 2);

  /* ---------- 12. 总开关 vs 分路：两层控制 ---------- */
  H('【12】总开关与分路：控制范围要分开');
  const d12 = await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene;
    S.clearIsolate(); S.showConduits(false);
    const p = E.panelOf(2);
    const out = { hasPanel: !!p, mainInit: !!p && p.mainOn !== false };
    /* 先复位：三路都合、总开关合 */
    E.togglePanel(2, true);
    E.list(2).forEach(c => E.toggle(c.id, true));
    out.allLive = E.list(2).every(c => c.on === true);
    /* 总开关一断 */
    E.togglePanel(2, false);
    const l = E.list(2);
    out.live = l.map(c => c.on);
    out.switchOn = l.map(c => c.switch_on);
    out.mainOn = E.mainOn(2);
    out.panelLiveCount = E.panelOf(2).liveCount;
    out.panelAnyLive = E.panelOf(2).anyLive;
    const imp = E.panelImpact(2) || { count: -1, room_nums: [], kinds: [] };
    out.impCount = imp.count;
    out.impKinds = imp.kinds.join('/');
    out.totalRooms = BIM_MODEL.rooms.filter(r => r.floor === 2 && r.zone !== 'corr').length;
    return out;
  });
  P('每层都有一台配电箱、且带总开关字段', d12.hasPanel && d12.mainInit === true);
  P('总开关一断：三路全部失电', d12.live.every(v => v === false), 'live=' + d12.live.join(','));
  P('总开关一断：三个分路手柄仍停在合位（没人去拨它们）',
    d12.switchOn.every(v => v === true), 'switch_on=' + d12.switchOn.join(','));
  P('配电箱统计跟着变成"一路都不带电"',
    d12.panelLiveCount === 0 && d12.panelAnyLive === false, 'liveCount=' + d12.panelLiveCount);
  P('总开关的控制面 = 整层全部房间',
    d12.impCount === d12.totalRooms && d12.impCount > 0,
    '受控 ' + d12.impCount + ' / 本层 ' + d12.totalRooms + ' 间，含 ' + d12.impKinds);

  /* 反过来：总开关合着，只断一路 —— 另两路不受影响 */
  const d12b = await p.evaluate(() => {
    const E = BIM.elec;
    E.togglePanel(2, true);
    E.list(2).forEach(c => E.toggle(c.id, true));
    E.toggle('L2A', false);
    const l = E.list(2);
    const ids = l.map(c => c.id);
    const imp = E.impact('L2A') || { count: 0, rooms: [] };
    return {
      main: E.mainOn(2), ids: ids, live: l.map(c => c.on), switchOn: l.map(c => c.switch_on),
      affected: imp.count,
      /* 分路只停"一类功能" —— impact 里每间房丢的都是同一类 */
      funcs: Array.from(new Set((imp.rooms || []).map(r => r.func))),
      total: BIM_MODEL.rooms.filter(r => r.floor === 2 && r.zone !== 'corr').length
    };
  });
  const iA = d12b.ids.indexOf('L2A');
  P('总开关合着、只断 L2A：另两路仍然带电',
    iA >= 0 && d12b.live[iA] === false && d12b.live.filter(v => v === true).length === d12b.live.length - 1,
    d12b.ids.join(',') + ' live=' + d12b.live.join(','));
  P('L2A 自己的手柄确实落下了',
    iA >= 0 && d12b.switchOn[iA] === false, 'switch_on=' + d12b.switchOn.join(','));
  P('分路只停一类功能（总开关是三类一起停）',
    d12b.affected > 0 && d12b.funcs.length === 1,
    '影响 ' + d12b.affected + ' 间，丢的功能=' + d12b.funcs.join(','));

  /* 画面上必须能区分三种态：全合 / 某分路被拉下 / 总开关拉下（分路手柄不动）。
     指纹要带索引权重 —— 只求和的话，"总开关手柄与分路手柄互换位置"会互相抵消，
     两种完全不同的画面算出同一个签名。 */
  const d12c = await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    const pd = E.panelOf(2);
    const W = () => {
      const g = S.root().getObjectByName('panels');
      const m = g && g.children.find(x => x.userData && x.userData.data && x.userData.data.id === pd.id);
      if (!m) return null;
      const pos = m.geometry.attributes.position;
      let s = 0;
      const n = Math.min(pos.count, 400);
      for (let i = 0; i < n; i++) {
        s += (pos.getX(i) + pos.getY(i) * 3 + pos.getZ(i) * 7) * ((i % 17) + 1);
      }
      return Math.round(s * 1000);
    };
    S.showConduits(true);
    E.togglePanel(2, true); E.list(2).forEach(c => E.toggle(c.id, true));
    S.refreshPanels(2); const allOn = W();
    E.toggle('L2A', false); S.refreshPanels(2); const brOff = W();
    E.toggle('L2A', true); E.togglePanel(2, false); S.refreshPanels(2); const mainOff = W();
    return { allOn: allOn, brOff: brOff, mainOff: mainOff };
  });
  P('三种状态的箱体画法互不相同（全合 / 分路断 / 总开关断）',
    d12c.allOn != null && d12c.brOff != null && d12c.mainOff != null &&
    d12c.allOn !== d12c.brOff && d12c.brOff !== d12c.mainOff && d12c.allOn !== d12c.mainOff,
    '全合=' + d12c.allOn + ' 分路断=' + d12c.brOff + ' 总开关断=' + d12c.mainOff);

  /* 主干立管只显示当前楼层那一段 */
  const d12d = await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    E.togglePanel(2, true); E.list(2).forEach(c => E.toggle(c.id, true));
    const c = E.circuit('L2A');
    const list = S.circuitRoute(c, E.circuitRooms('L2A')) || [];
    const trunks = list.filter(x => x.layer === 'trunk');
    const feeds = list.filter(x => x.layer === 'feed');
    return {
      total: list.length, trunks: trunks.length, feeds: feeds.length,
      trunkFloors: Array.from(new Set(trunks.map(x => x.floor))),
      feedFloors: Array.from(new Set(feeds.map(x => x.floor))),
      circFloor: c.floor,
      allTrunkInModel: E.ready().conduits.filter(x => x.layer === 'trunk').length
    };
  });
  P('查回路时主干立管只取本层那一段',
    d12d.trunks > 0 && d12d.trunkFloors.length === 1 && d12d.trunkFloors[0] === d12d.circFloor,
    '主干 ' + d12d.trunks + ' 段，只含 ' + d12d.trunkFloors.join(',') + 'F（全楼共 ' + d12d.allTrunkInModel + ' 段）');
  P('层进线也只在 / 本层', d12d.feedFloors.every(f => f === d12d.circFloor), '进线楼层=' + d12d.feedFloors.join(','));

  /* 配电箱是墙上设备，平时就得看得见 */
  const d12e = await p.evaluate(async () => {
    const S = BIM.scene;
    S.showConduits(false);
    S.setXray(false);
    S.setFocus(2, false);
    await new Promise(r => setTimeout(r, 300));
    const g = S.root().getObjectByName('panels');
    const vis = g ? g.children.filter(m => m.visible).map(m => m.userData && m.userData.floor) : [];
    return { gv: g ? g.visible : null, vis: vis, conduits: S.conduitsOn !== false };
  });
  P('不开电气视图也能看见配电箱',
    d12e.gv === true && d12e.vis.length > 0, 'group.visible=' + d12e.gv + ' 可见楼层=' + JSON.stringify(d12e.vis));

  const d12f = await p.evaluate(async () => {
    const S = BIM.scene;
    S.setFocus(3, false);
    await new Promise(r => setTimeout(r, 300));
    const g = S.root().getObjectByName('panels');
    const vis3 = g.children.filter(m => m.visible).map(m => m.userData && m.userData.floor);
    S.setFocus(2, false);
    return { vis3: vis3 };
  });
  P('切到 3 楼只剩 3 楼那只箱子（不留在空中）',
    d12f.vis3.length === 1 && d12f.vis3[0] === 3, JSON.stringify(d12f.vis3));

  /* 自然语言要能区分总开关和分路 */
  const d12g = await p.evaluate(() => {
    const N = window.BIM.nlp;
    const f = t => N.parse(t);
    const a = f('把2楼总闸拉下来');
    const b = f('关掉2楼第1回路');
    const c = f('2楼总开关现在是合着的吗');
    return {
      a: { intent: a.intent, main: a.mainSwitch === true, kind: a.kind, no: a.circuitNo, act: a.action },
      b: { intent: b.intent, main: b.mainSwitch === true, no: b.circuitNo, act: b.action },
      c: { intent: c.intent, main: c.mainSwitch === true, act: c.action || null }
    };
  });
  P('"把2楼总闸拉下来" → 识别成总开关 + 断电',
    d12g.a.intent === 'circuitset' && d12g.a.main === true && d12g.a.act === 'off',
    JSON.stringify(d12g.a));
  P('总开关不会被误当成某一路分路', d12g.a.no == null && d12g.a.kind == null, JSON.stringify(d12g.a));
  P('"关掉2楼第1回路" 仍是分路、不是总开关',
    d12g.b.intent === 'circuitset' && d12g.b.main === false && d12g.b.no === 1,
    JSON.stringify(d12g.b));
  P('"总开关现在合着吗" → 只查不改',
    d12g.c.main === true && !d12g.c.act, JSON.stringify(d12g.c));

  /* 真的走一遍对话：总开关断 → 整层失电 → 再合上 */
  const d12h = await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene;
    E.togglePanel(2, true);
    E.list(2).forEach(c => E.toggle(c.id, true));
    await BIM.app.send('把2楼总开关拉下来');
    await new Promise(r => setTimeout(r, 2600));
    const l = E.list(2);
    /* chips 气泡是追加在 chat 里的兄弟节点，所以 .msg.ai:last-child 选不到最后一条回复 */
    const all = document.querySelectorAll('.msg.ai');
    const txt = (all[all.length - 1] || {}).textContent || '';
    return {
      main: E.mainOn(2),
      live: l.map(c => c.on),
      switchOn: l.map(c => c.switch_on),
      mentionMain: /总开关|总闸/.test(txt),
      mentionScope: /整层|三路/.test(txt),
      focus: S.focus,
      last: BIM.app.lastData || null
    };
  });
  P('对话"把2楼总开关拉下来"真的把总开关断了', d12h.main === false, 'mainOn=' + d12h.main);
  P('三路一起失电，但手柄都没动',
    d12h.live.every(v => v === false) && d12h.switchOn.every(v => v === true),
    'live=' + d12h.live.join(',') + ' switch=' + d12h.switchOn.join(','));
  P('回复里点明是总开关、且讲清"整层三路"这个范围',
    d12h.mentionMain && d12h.mentionScope);
  P('总开关操作后回到 2 楼', d12h.focus === 2, 'focus=' + d12h.focus);

  const d12i = await p.evaluate(async () => {
    const E = BIM.elec;
    await BIM.app.send('把2楼总开关送电');
    await new Promise(r => setTimeout(r, 2600));
    return { main: E.mainOn(2), live: E.list(2).map(c => c.on) };
  });
  P('再合上总开关：三路一起恢复',
    d12i.main === true && d12i.live.every(v => v === true), 'live=' + d12i.live.join(','));


  /* ---------- 8. MCP 工具暴露 ---------- */
  H('【8】MCP 工具与说明');
  const d8 = await p.evaluate(() => {
    const names = BIM.mcp.names;
    const g = BIM.mcp.guide || '';
    const tc = (BIM.mcp.tools || []).find(t => t.function && t.function.name === 'toggle_circuit') || {};
    const qc = (BIM.mcp.tools || []).find(t => t.function && t.function.name === 'query_circuits') || {};
    const propsOf = t => Object.keys(((t.function || {}).parameters || {}).properties || {});
    return {
      total: names.length,
      has: ['open_passage', 'query_circuits', 'toggle_circuit', 'query_conduits'].filter(n => names.indexOf(n) >= 0),
      guide: ['打通', '分路', '线管'].map(k => g.indexOf(k) >= 0),
      /* 总开关这件事必须写进给大模型的说明，否则它只会按分路理解 */
      mainGuide: /总开关/.test(g) && /main_switch/.test(g),
      trunkGuide: /本层那一段|别的楼层的主干/.test(g),
      panelGuide: /平时看楼层就一直在|不用先打开电气视图/.test(g),
      mainProp: propsOf(tc).indexOf('main_switch') >= 0,
      mainPropQ: propsOf(qc).indexOf('main_switch') >= 0,
      desc: ((tc.function || {}).description || '')
    };
  });
  P('四个新工具都已注册', d8.has.length === 4, d8.has.join(','));
  P('工具总数 >= 32', d8.total >= 32, String(d8.total));
  P('给大模型的说明里提到打通/分路/线管', d8.guide.every(Boolean));
  P('toggle_circuit 暴露了 main_switch（总开关）参数', d8.mainProp);
  P('query_circuits 也能查总开关', d8.mainPropQ);
  P('说明里讲清"总开关管整层、分路管自己"', d8.mainGuide && /整层三路|一断三路/.test(d8.desc));
  P('说明里讲清"主干立管只画本层"', d8.trunkGuide);
  P('说明里讲清"配电箱平时就在"', d8.panelGuide);

  const shot2 = 'outputs/elec-view.png';
  await p.evaluate(() => {
    const E = BIM.elec, M = BIM_MODEL;
    const r = M.rooms.find(x => x.floor === 3 || x.floor === 2) || M.rooms[0];
    BIM.scene.circuitView(E.circuit('L3A'), E.circuitRooms('L3A'));
  });
  await sleep(900);
  await p.screenshot({ path: shot2 });

  console.log('\n错误：' + (errs.length ? errs.slice(0, 6).join(' | ') : 'none'));
  console.log('结果：' + ok + ' 通过 / ' + bad + ' 失败');
  await b.close();
  process.exit(bad ? 1 : 0);
})();
