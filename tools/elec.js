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
    return {
      st: st, panels: E.data.panels.length, circuits: E.data.circuits.length,
      floors: M.floors.length, rooms: M.rooms.length,
      floorPanel: byFloor,
      kinds: E.data.circuits.map(c => c.kind).filter((v, i, a) => a.indexOf(v) === i),
      perFloorCircuits: Object.keys(byFloor).map(f => E.list(+f).length)
    };
  });
  P('每层一部配电箱', d1.panels === d1.floors, d1.panels + ' 箱 / ' + d1.floors + ' 层');
  P('每层三条分路（照明/插座/动力）', d1.perFloorCircuits.every(n => n === 3), JSON.stringify(d1.perFloorCircuits));
  P('线管总量 > 400', d1.st.conduits > 400, JSON.stringify(d1.st.by_kind));
  P('四类线管齐全（含楼层进线竖井）',
    ['light', 'socket', 'power', 'riser'].every(k => d1.st.by_kind[k] > 0));

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
    /* 找一面带插座管（贴地 0.32 m）的墙 */
    const cs = E.conduitsOf({ floor: 1, kind: 'socket' });
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
    const c0 = E.conduitsOf({ floor: 1, kind: 'socket' })[0];
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
    const c0 = E.conduitsOf({ floor: 1, kind: 'socket' })[0];
    const wall = M.walls.find(w => w.id === c0.wall);
    S.showConduits(true);
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    S.markConduits([c0], 0xff3b30);
    const plan = E.planReroute(c0, { at0: c0.at0 - .2, at1: c0.at1 + .2, z0: 0, z1: 2.4 });
    S.showReroute(plan, 0x17a673);
    const R = S._dbg ? S._dbg() : {};
    return {
      conduitOn: S.elecOn(), xray: S.xray,
      /* 不依赖调试接口，用统计判断：标记后应该有线管处于高亮材质 */
      stats: E.stats()
    };
  });
  P('线管可整体显示', d7.conduitOn === true);
  P('显示线管时自动半透明楼体', d7.xray === true);
  const shot1 = 'outputs/elec-conflict.png';
  await p.screenshot({ path: shot1 });

  /* ---------- 8. MCP 工具暴露 ---------- */
  H('【8】MCP 工具与说明');
  const d8 = await p.evaluate(() => {
    const names = BIM.mcp.names;
    const g = BIM.mcp.guide || '';
    return {
      total: names.length,
      has: ['open_passage', 'query_circuits', 'toggle_circuit', 'query_conduits'].filter(n => names.indexOf(n) >= 0),
      guide: ['打通', '分路', '线管'].map(k => g.indexOf(k) >= 0)
    };
  });
  P('四个新工具都已注册', d8.has.length === 4, d8.has.join(','));
  P('工具总数 >= 32', d8.total >= 32, String(d8.total));
  P('给大模型的说明里提到打通/分路/线管', d8.guide.every(Boolean));

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
