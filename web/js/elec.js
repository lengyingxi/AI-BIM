/* AIbim 电气专业层
   —— 墙内暗敷线管（照明 / 插座 / 动力三条分路）+ 楼层配电箱 + 分路控制
   —— 这一层是"看不见的墙里那部分"，也是拆墙、开门、开窗真正会撞上的东西

   为什么要单独一层：
     建筑图里门窗是画出来的，墙里预埋的线管不画。所以演示"在这里开个门"时，
     如果只算墙、柱、风管，结论永远是"可以开"——现场一凿就打断一路线。
     这一层把线管当成真实存在的实体：有走向、有标高、有截面、归属某个分路，
     开洞前先查一遍，撞上了就给出"改线 / 挪门 / 不建议开"三个选项。

   生成规则（通用，不写死房号）：
     · 每层一部配电箱 AL-{层}，放在该层的电气间/核心筒房间（找不到就取该层第一间）
     · 每层三条分路：照明、插座、动力。颜色固定，图上不同分路一眼区分
     · 每面墙按"贴在这面墙上的房间"切成若干段，每段里铺该房间的线管：
         照明管 z≈2.42 m（吊顶里走，门洞够不着，高窗才会撞）
         插座管 z≈0.32 m（贴地走，新开门最容易撞的就是它）
         动力管 z≈2.15 m（只铺在有设备/机房类房间，窗顶容易撞）
     · 已有门窗洞的地方，线管自动绕开（真实施工就这么干），
       所以旧洞口不会假报冲突——只有**新开**的洞才可能撞上
     · 线管不是满铺：每个房间段只铺其中一部分，所以同一面墙上
       有的位置能开洞、有的不能，用户挪一挪就有解

   坐标约定：at 是沿墙轴从 p1 起算的距离；z 是相对该层楼板面的高度。
    墙的立面 = (at, z) 二维平面，开洞矩形与线管区间求交就是冲突判定。
*/
(function () {
  const B = (window.BIM = window.BIM || {});
  const E = (B.elec = {});
  const M = () => window.BIM_MODEL;

  const fmt = v => (Math.round(v * 100) / 100).toFixed(2);

  /* 分路配色：和界面图例、三维线管用同一套，不要各写各的 */
  E.COLOR = {
    light: 0xf0b429,     // 照明：琥珀
    socket: 0x3b9ae1,    // 插座：蓝
    power: 0xd8544f,     // 动力：红
    reroute: 0x17a673,   // 改线后的走向：绿
    hit: 0xff3b30,       // 冲突：亮红
    off: 0x8a929b        // 分路断开：灰
  };
  E.KIND_CN = { light: '照明', socket: '插座', power: '动力', riser: '楼层进线' };

  /* 线管截面（米）：外径/槽宽 + 墙内埋深。数字按常见做法取：
     照明 BV2.5 穿 PC20、插座 BV4 穿 PC25、动力 YJV 走 40×25 线槽 */
  const SEC = {
    light: { s: 0.045, d: 0.20 },     // s=竖向占位（含保护层），d=墙内埋深（从墙面往里）
    socket: { s: 0.055, d: 0.24 },
    power: { s: 0.075, d: 0.28 }
  };
  E.SEC = SEC;

  /* 标高（相对楼板面）
     这三个数字是冲突行为的来源，别随手改：
       插座 0.32 —— 贴地走，新开门洞（sill=0）撞的就是它，最真实的一种冲突
       动力 2.35 —— 吊顶下沿的桥架/线槽，门洞 2.1~2.6 有时擦到，2.4 顶的高窗也会撞
       照明 2.90 —— 吊顶里，普通窗（窗台 0.9 + 高 1.5，顶 2.4）够不着，
                   只有做到顶的高窗、落地窗才会碰上 */
  const Z = { socket: 0.32, power: 2.35, light: 2.90 };

  /* 洞口两侧要留的保护距离：线管不能贴着洞边，得留抹灰和护角 */
  const GUARD = 0.12;

  E.data = null;

  /* ---------------- 几何小工具 ---------------- */
  function axis(wall) {
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1e-6;
    return { ax: ax, ay: ay, ux: (bx - ax) / L, uy: (by - ay) / L, L: L };
  }
  E.axis = axis;
  E.len = wall => axis(wall).L;

  /* 把墙上的可用区间按已有洞口切成子段，每段两头各留 GUARD */
  function splitByOpenings(wall, a, b) {
    const L = axis(wall).L;
    let lo = Math.max(0, a), hi = Math.min(L, b);
    if (hi - lo < 1e-6) return [];
    const ops = (wall.openings || []).slice().sort((p, q) => p.at - q.at);
    const out = [];
    let cur = lo;
    for (const o of ops) {
      const o0 = o.at - o.w / 2 - GUARD, o1 = o.at + o.w / 2 + GUARD;
      if (o1 < cur) continue;
      if (o0 > cur) out.push([cur, Math.min(o0, hi)]);
      cur = Math.max(cur, o1);
      if (cur >= hi) break;
    }
    if (cur < hi) out.push([cur, hi]);
    return out.filter(s => s[1] - s[0] >= 0.3);
  }
  E.splitByOpenings = splitByOpenings;

  /* 一面墙上有哪些房间，各自占哪一段。
     做法：房间四角投到墙轴上取并集，再看房间是否真的贴在这面墙上
     （四角到墙线的垂直距离最小值 < 0.35 m）——长墙串多间房时全靠这个分。 */
  function roomSpans(wall) {
    const { ax, ay, ux, uy, L } = axis(wall);
    const out = [];
    (M().rooms || []).filter(r => r.floor === wall.floor).forEach(r => {
      const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]];
      // 到墙直线的垂直距离
      let dmin = 1e9;
      pts.forEach(([x, y]) => {
        const px = x - ax, py = y - ay;
        const t = px * ux + py * uy;
        const d = Math.hypot(px - ux * t, py - uy * t);
        if (d < dmin) dmin = d;
      });
      if (dmin > 0.35) return;                       // 不贴这面墙
      const ts = pts.map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      const lo = Math.max(0, Math.min.apply(null, ts));
      const hi = Math.min(L, Math.max.apply(null, ts));
      if (hi - lo < 0.5) return;
      out.push({ room: r, lo: lo, hi: hi });
    });
    return out;
  }
  E.roomSpans = roomSpans;

  /* 这间房算不算"机房类"：动力回路只铺到这类房间，否则满楼都是动力管 */
  const POWER_USE = /机房|设备|变电|配电|泵|冷冻|空调|电梯|电气|影像|CT|MR|手术|检查|治疗|消毒|供氧|吸引/;
  function isPowerRoom(r) {
    return POWER_USE.test((r.use || '') + ' ' + (r.name || ''));
  }

  /* ---------------- 生成 ---------------- */
  /* 模型换过（导入 IFC）之后必须重建：几何全变了，旧线管一根都不能留 */
  E.build = function () {
    const m = M();
    const D = { panels: [], circuits: [], conduits: [], reroutes: {}, state: {} };
    if (!m || !m.walls) { E.data = D; return D; }

    const byId = {};
    const addC = c => { D.circuits.push(c); byId[c.id] = c; return c; };

    (m.floors || []).forEach(fl => {
      const L = fl.level;
      const rooms = (m.rooms || []).filter(r => r.floor === L);
      if (!rooms.length) return;
      /* 配电间：电气/机房类 > 核心筒 > 第一间。竖井位置决定了干线怎么落 */
      const shaft = rooms.find(r => /电气|配电|强电|变电|竖井/.test((r.use || '') + (r.name || '')))
        || rooms.find(r => isPowerRoom(r))
        || rooms.find(r => r.zone === 'core')
        || rooms[0];

      const pid = 'AL-' + L;
      const mkCirc = (suffix, kind, name) => addC({
        id: 'L' + L + suffix, panel: pid, floor: L, kind: kind,
        name: L + 'F ' + name, color: E.COLOR[kind],
        rooms: [], conduits: [], rated: kind === 'power' ? 63 : 32,
        phase: suffix === 'A' ? 'L1' : (suffix === 'B' ? 'L2' : 'L3'),
        on: true
      });
      const cA = mkCirc('A', 'light', '照明回路');
      const cB = mkCirc('B', 'socket', '插座回路');
      const cC = mkCirc('C', 'power', '动力回路');

      /* 配电箱：贴在配电间的一面墙上，箱中心标高 1.5 m。
         优先选这层"不朝走廊"的那面墙，免得箱子挡在走道上 */
      const wAll = (m.walls || []).filter(w => w.floor === L);
      let pw = null, pat = 0;
      const shaftWalls = [];
      Object.keys(shaft.sides || {}).forEach(k => {
        const w = wAll.find(x => x.id === shaft.sides[k]);
        if (!w) return;
        const sp = roomSpans(w).find(s => s.room.id === shaft.id);
        if (sp) shaftWalls.push({ w: w, at: (sp.lo + sp.hi) / 2, span: sp });
      });
      // 走廊那面墙尽量不用（箱子凸出 0.15 m，走廊有净宽要求）
      const corrW = shaftWalls.find(x => {
        const other = (x.w.rooms || []).map(id => (m.rooms || []).find(r => r.id === id)).find(r => r && r.zone === 'corr');
        return !other;
      });
      const pick = corrW || shaftWalls[0];
      if (pick) { pw = pick.w; pat = pick.at; }
      const panel = {
        id: pid, floor: L, room: shaft.id, roomNum: shaft.num,
        name: L + 'F 配电箱 ' + pid, wall: pw ? pw.id : null, at: pat,
        z: 1.5, w: 0.7, h: 0.9, d: 0.18,
        circuits: [cA.id, cB.id, cC.id]
      };
      /* 位置换算成世界坐标，渲染与聚焦都要用 */
      if (pw) {
        const a = axis(pw);
        const sgn = 0.5;   // 从墙中心往房间一侧偏
        panel.x = a.ax + a.ux * pat;
        panel.y = a.ay + a.uy * pat;
        panel.dir = [a.ux, a.uy];
      } else {
        panel.x = (shaft.x0 + shaft.x1) / 2; panel.y = shaft.y0 + 0.2;
        panel.dir = [1, 0];
      }
      D.panels.push(panel);

      /* 逐面墙铺线管 */
      wAll.forEach(wall => {
        roomSpans(wall).forEach(sp => {
          const room = sp.room;
          if (room.zone === 'corr') {
            // 走廊里只走照明与公共插座，不做动力
            pushConduit(wall, sp, 'light', cA);
            pushConduit(wall, sp, 'socket', cB, 0.5);
            return;
          }
          pushConduit(wall, sp, 'light', cA);
          pushConduit(wall, sp, 'socket', cB);
          if (isPowerRoom(room)) pushConduit(wall, sp, 'power', cC, 0.34);
        });
      });

      function pushConduit(wall, sp, kind, circ, cover) {
        const sec = SEC[kind], z = Z[kind], room = sp.room;
        if (z + sec.s / 2 > (wall.h || 3) - 0.05) return;      // 墙比这还矮就别铺了
        const spanLen = sp.hi - sp.lo;
        /* 铺多长：不是满铺。照明沿整段（吊顶里本来就通长），
           插座只铺靠墙角起的一截（真实做法：从门口/墙角引过去就够），
           动力只铺房间中段。留白的位置就是以后能开洞的位置。 */
        let a, b;
        if (kind === 'light') {
          a = sp.lo + 0.28; b = sp.hi - 0.28;
        } else if (kind === 'socket') {
          const run = Math.min(2.3, spanLen * (cover || 0.62));
          a = sp.lo + 0.42; b = a + run;
        } else {
          const run = Math.min(2.6, spanLen * (cover || 0.5));
          const mid = (sp.lo + sp.hi) / 2;
          a = mid - run / 2; b = mid + run / 2;
        }
        if (b - a < 0.45) return;
        splitByOpenings(wall, a, b).forEach(([s0, s1]) => {
          if (s1 - s0 < 0.3) return;
          const id = 'CD-' + wall.id + '-' + kind + '-' + Math.round(s0 * 100) + '-' + Math.round(s1 * 100);
          if (D.conduits.some(c => c.id === id)) return;
          const c = {
            id: id, floor: wall.floor, wall: wall.id, kind: kind, circuit: circ.id,
            at0: s0, at1: s1, z: z, s: sec.s, d: sec.d,
            room: room.id, roomNum: room.num, added: false
          };
          D.conduits.push(c);
          circ.conduits.push(id);
          if (circ.rooms.indexOf(room.id) < 0) circ.rooms.push(room.id);
        });
      }
    });

    /* 楼层进线（竖管）：从本层配电箱竖直上去，接到上一层的配电箱。
       这是"控制一个分路，整栋楼哪几层跟着动"能看出来的关键——
       没有竖管，每层看着都是孤立的。归到该层动力回路（进线总开关）名下。 */
    (m.floors || []).slice().sort((a, b) => a.level - b.level).forEach(fl => {
      const L = fl.level;
      const p = D.panels.find(x => x.floor === L);
      const up = D.panels.find(x => x.floor === L + 1);
      const circ = D.circuits.find(c => c.id === 'L' + L + 'C');
      if (!p || !circ) return;
      const thk = fl.height || 4.5;
      const z0 = (p.z || 1.5);
      const z1 = up ? (thk + up.z) : (thk + 0.4);
      D.risers = D.risers || [];
      const rs = {
        id: 'RS-' + L, floor: L, from: L, to: up ? L + 1 : L,
        x: p.x, y: p.y, z0: p.z, z1: z1, circuit: circ.id, kind: 'riser',
        vert: true, s: 0.09, d: 0.09, wall: null, at0: 0, at1: 0, z: 0
      };
      D.risers.push(rs);
      D.conduits.push(rs);          // 也放进 conduits：高亮、统计、查询一条路走通
      circ.conduits.push('RS-' + L);
    });

    /* 分路状态：重建时把原来的通断状态带过来。
       用户掐掉一路电以后再开个窗，电不能自己又合上。 */
    const prev = (E.data && E.data.state) || {};
    D.circuits.forEach(c => {
      const on = prev[c.id] != null ? prev[c.id] : true;
      c.on = on;
      D.state[c.id] = on;
    });
    E.data = D;
    return D;
  };

  function ready() {
    if (!E.data) E.build();
    return E.data;
  }
  E.ready = ready;

  E.conduit = id => (ready().conduits || []).find(c => c.id === id) || null;
  E.circuit = id => (ready().circuits || []).find(c => c.id === id) || null;
  E.panel = id => (ready().panels || []).find(c => c.id === id) || null;

  /* ---------------- 冲突检测 ---------------- */
  /* 开一个洞会不会打断墙里的线管。
       洞：沿墙 [at-w/2, at+w/2] × 高度 [sill, sill+h]
       线管：沿墙 [at0, at1] × 高度 [z-s/2, z+s/2]
     两个矩形相交就是打架。已经改过线的线管（reroutes 里有记录且覆盖这个洞）不算。 */
  E.hitWall = function (wall, o) {
    if (!wall || !E.data) return [];
    const at = o.at, w = o.w || 0.9, h = o.h || 2.1;
    const sill = o.sill == null ? 0 : o.sill;
    const h0 = at - w / 2 - 0.05, h1 = at + w / 2 + 0.05;
    const z0 = sill - 0.05, z1 = sill + h + 0.05;
    const out = [];
    (E.data.conduits || []).forEach(c => {
      if (c.wall !== wall.id) return;
      if (c.at1 <= h0 || c.at0 >= h1) return;                 // 沿墙方向不相交
      if (c.z + c.s / 2 <= z0 || c.z - c.s / 2 >= z1) return;  // 高度方向不相交
      if (reroutedOver(c, h0, h1)) return;                     // 已经改过线了
      out.push(c);
    });
    return out;
  };

  /* 这根线管在这个洞口范围里是不是已经改过线了。
     比的是"覆盖关系"：改线时记的洞要能罩住这次查的洞。
     两边各留 0.1 m 容差 —— 查冲突时洞会外扩 5 cm 当保护层，
     不放容差的话改完线再查回来还是判"撞"，等于白改。 */
  function reroutedOver(c, h0, h1) {
    const r = (E.data.reroutes || {})[c.id];
    if (!r) return false;
    return r.hole.at0 <= h0 + 0.10 && r.hole.at1 >= h1 - 0.10;
  }
  E.reroutedOver = reroutedOver;

  /* 某根线管在某个洞口的绕行方案
     往洞顶以上或洞底以下翻过去——真实施工就是"上翻/下翻"。
     哪边近走哪边；近了会顶梁或贴地就换另一边；两边都不行就明确说不行。 */
  E.planReroute = function (c, hole) {
    const wall = (M().walls || []).find(w => w.id === c.wall);
    if (!wall || !c) return { ok: false, why: '找不到这根线管所在的墙' };
    const half = c.s / 2 + 0.03;
    const up = hole.z1 + 0.12 + half;          // 洞顶以上
    const dn = hole.z0 - 0.12 - half;          // 洞底以下
    const upOK = up <= (wall.h || 3) - 0.10;
    const dnOK = dn >= 0.08;
    let dir = null, z = null;
    if (upOK && dnOK) {
      // 线管本来就在洞上方 → 上翻更顺；否则比距离
      const preferUp = (c.z >= hole.z1) || (Math.abs(up - c.z) <= Math.abs(dn - c.z));
      dir = preferUp ? 'up' : 'down'; z = preferUp ? up : dn;
    } else if (upOK) { dir = 'up'; z = up; }
    else if (dnOK) { dir = 'down'; z = dn; }

    if (!dir) {
      return {
        ok: false, c: c, hole: hole,
        why: '洞口高 ' + fmt(hole.z1 - hole.z0) + ' m，墙净高只有 ' + fmt(wall.h) +
          ' m，线管上下都翻不过去（上翻要占 ' + fmt(hole.z1 + 0.15) + ' m，下翻要占 ' + fmt(0.15) + ' m）'
      };
    }
    /* 绕行折线：原高度 → 竖段 → 洞顶/底跨过去 → 竖段落回原高度 */
    const seg = 0.18;     // 洞两侧各让出的水平距离
    const pts = [
      { at: hole.at0 - seg, z: c.z },
      { at: hole.at0 - seg, z: z },
      { at: hole.at1 + seg, z: z },
      { at: hole.at1 + seg, z: c.z }
    ];
    const addLen = Math.abs(z - c.z) * 2 + seg * 2;
    return {
      ok: true, c: c, hole: hole, dir: dir, z: z, pts: pts,
      addLen: addLen, wall: wall,
      why: (dir === 'up' ? '上翻' : '下翻') + '到洞口' + (dir === 'up' ? '顶' : '底') +
        '以上 ' + fmt(z) + ' m 处绕过，多走 ' + fmt(addLen) + ' 米线'
    };
  };

  /* 真正改线：记进 reroutes，之后这根线管在这个洞口不再算冲突 */
  E.applyReroute = function (c, hole, plan) {
    const D = ready();
    plan = plan || E.planReroute(c, hole);
    if (!plan.ok) return null;
    D.reroutes[c.id] = {
      conduit: c.id, circuit: c.circuit, wall: c.wall, floor: c.floor,
      hole: { at0: hole.at0, at1: hole.at1, z0: hole.z0, z1: hole.z1 },
      dir: plan.dir, z: plan.z, pts: plan.pts, addLen: plan.addLen
    };
    return D.reroutes[c.id];
  };

  E.undoReroute = function (conduitId) {
    const D = ready();
    const r = D.reroutes[conduitId];
    delete D.reroutes[conduitId];
    return r;
  };

  E.reroutes = () => Object.keys(ready().reroutes || {}).map(k => ready().reroutes[k]);

  /* ---------------- 分路控制 ---------------- */
  E.toggle = function (id, on) {
    const D = ready();
    const c = E.circuit(id);
    if (!c) return null;
    c.on = on !== false;
    D.state[c.id] = c.on;
    return c;
  };
  E.isOn = function (id) {
    const D = ready();
    return D.state[id] !== false;
  };

  /* 这条分路管哪些房间（带房号与用途，回复里要用） */
  E.circuitRooms = function (id) {
    const c = E.circuit(id);
    if (!c) return [];
    return (c.rooms || []).map(rid => (M().rooms || []).find(r => r.id === rid)).filter(Boolean);
  };

  /* 这间房由哪几条分路供电 */
  E.roomsCircuits = function (room) {
    if (!room) return [];
    return (ready().circuits || []).filter(c => (c.rooms || []).indexOf(room.id) >= 0);
  };

  /* 房间的供电状态。
     注意：一层只有一条照明、一条插座、一条动力回路，"断了一条"不等于"这间房没电"，
     而是"这间房失去了这一类功能"。所以这里按功能分开算，别拿 on.length 一概而论。 */
  E.roomPower = function (room) {
    const cs = E.roomsCircuits(room);
    const on = cs.filter(c => c.on !== false);
    const off = cs.filter(c => c.on === false);
    const kindsAll = cs.map(c => c.kind);
    const kindsOff = off.map(c => c.kind);
    const lost = kindsOff.map(k => E.KIND_CN[k] || k);
    return {
      circuits: cs, on: on, off: off,
      all_off: cs.length > 0 && on.length === 0,   // 一间房连一条通的都没有（含竖井未进）
      any_off: off.length > 0,
      lost: lost,                                   // ['照明'] / ['插座','动力']
      still: on.map(c => E.KIND_CN[c.kind] || c.kind),
      has_light: kindsAll.indexOf('light') >= 0,
      dark: kindsOff.indexOf('light') >= 0,         // 照明断了 = 这间黑了
      no_socket: kindsOff.indexOf('socket') >= 0,   // 插座断了 = 插座没电
      no_power: kindsOff.indexOf('power') >= 0      // 动力断了 = 设备停
    };
  };

  /* 断/合一条分路，影响面到底有多大——回复里要按"功能"说，不能笼统说"还有别的回路" */
  E.impact = function (id) {
    const c = E.circuit(id);
    if (!c) return null;
    const kind = c.kind, cn = E.KIND_CN[kind] || kind;
    const rooms = E.circuitRooms(id);
    const rows = rooms.map(r => {
      const p = E.roomPower(r);
      const others = p.on.filter(x => x.id !== id);
      return {
        id: r.id, num: r.num, name: r.name, use: r.use, floor: r.floor,
        func: cn,                                    // 这条分路在这间房里管什么
        dark: kind === 'light',                      // 断照明就是这一间黑了
        still: others.map(x => E.KIND_CN[x.kind] || x.kind),   // 这间房还剩下什么
        fully_dark: p.all_off && kind === 'light'
      };
    });
    return {
      circuit: c, kind: kind, kind_cn: cn,
      panel: c.panel, phase: c.phase, rated: c.rated, on: c.on !== false,
      rooms: rows, count: rows.length,
      room_nums: rooms.map(r => r.num),
      /* 这条分路一断，整间房彻底变黑的（照明回路才有） */
      dark_rooms: kind === 'light' ? rooms.map(r => r.num) : [],
      /* 一断就什么功能都不剩的房间（本来就只靠这一路） */
      bare_rooms: rooms.filter(r => E.roomPower(r).on.filter(x => x.id !== id).length === 0).map(r => r.num),
      /* 还有别的功能在，但这间房的这一类功能没了 */
      partial_rooms: rooms.filter(r => E.roomPower(r).on.filter(x => x.id !== id).length > 0).map(r => r.num)
    };
  };

  /* 某层/某间的线管清单 */
  E.conduitsOf = function (opt) {
    opt = opt || {};
    return (ready().conduits || []).filter(c => {
      if (opt.floor != null && c.floor !== opt.floor) return false;
      if (opt.room && c.room !== opt.room && c.roomNum !== opt.room) return false;
      if (opt.circuit && c.circuit !== opt.circuit) return false;
      if (opt.kind && c.kind !== opt.kind) return false;
      return true;
    });
  };

  /* 分路清单：给"这层有哪些分路"这种问题用 */
  E.list = function (floor) {
    return (ready().circuits || []).filter(c => floor == null || c.floor === floor)
      .map(c => ({
        id: c.id, name: c.name, kind: c.kind, kind_cn: E.KIND_CN[c.kind],
        panel: c.panel, phase: c.phase, rated: c.rated, on: c.on !== false,
        rooms: c.rooms.length, conduits: c.conduits.length,
        room_nums: E.circuitRooms(c.id).map(r => r.num)
      }));
  };

  E.stats = function () {
    const D = ready();
    return {
      panels: D.panels.length, circuits: D.circuits.length,
      conduits: D.conduits.length, reroutes: Object.keys(D.reroutes || {}).length,
      by_kind: ['light', 'socket', 'power', 'riser'].reduce((a, k) => {
        a[k] = D.conduits.filter(c => c.kind === k).length; return a;
      }, {})
    };
  };

  /* ---------------- 给校核和回复用的中文描述 ---------------- */
  E.hitText = function (c) {
    return E.KIND_CN[c.kind] + '回路的线管（' + c.circuit + '，管中距地 ' + fmt(c.z) + ' m，截面 ' +
      fmt(c.s * 100) + ' cm）';
  };
  E.circuitText = function (c) {
    const rs = E.circuitRooms(c.id);
    return c.name + '（' + c.id + '，' + c.phase + ' 相，' + c.rated + 'A，带 ' + rs.length + ' 间房）';
  };

  /* 模型结构变了就重建（导入 IFC 后调用） */
  E.rebuild = function () { E.data = null; return E.build(); };
})();
