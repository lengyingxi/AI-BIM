/* AIbim 结构校核引擎
   依据：GB 50009-2012 建筑结构荷载规范（附录 C 等效均布活荷载）
        GB 50010-2010 混凝土结构设计规范（正截面承载力）
        GB 50068-2018 建筑结构可靠性设计统一标准（安全等级二级）
        GB 50292-2015 民用建筑可靠性鉴定标准（构件安全性评定）
*/
(function () {
  window.BIM = window.BIM || {};
  const C = (window.BIM.calc = {});
  const G = 9.81;              // kN/t
  const DEAD_FINISH = 1.5;     // 面层+吊顶 kN/m2
  const RHO = 25.0;            // 钢筋混凝土自重 kN/m3
  const TARGET = 1.3;          // 运维阶段推荐安全系数

  const fmt = (v, n) => {
    const p = Math.pow(10, n == null ? 2 : n);
    return (Math.round(v * p) / p).toFixed(n == null ? 2 : n);
  };
  C.fmt = fmt;

  /* 正截面受弯承载力 kN·m/m */
  function Mu(As, d, fc, fy) {
    let x = fy * As / (fc * 1000);
    if (x > 0.5 * d) x = 0.5 * d;
    return As * fy * (d - x / 2) / 1e6;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------------- 墙内预埋线管 ----------------
     建筑图不画这一层，但现场是实打实埋在墙里的。开洞前必须问一句：
     这个洞会不会打断某一路电。判定交给 elec 层（那边知道线管的走向、标高、分路），
     这里只负责把结果翻译成一句人能听懂的话。
     没装 elec 层（例如单测结构）时退化成"没有线管"，不影响原来的校核。 */
  function conduitHits(wall, at, w, h, sill) {
    const E = window.BIM && window.BIM.elec;
    if (!E || !E.data || !wall) return [];
    try { return E.hitWall(wall, { at: at, w: w, h: h, sill: sill }) || []; }
    catch (e) { return []; }
  }
  C.conduitHits = conduitHits;

  function conduitText(hits) {
    const E = window.BIM && window.BIM.elec;
    const kinds = [];
    const circs = [];
    hits.forEach(c => {
      const k = (E && E.KIND_CN[c.kind]) || c.kind;
      if (kinds.indexOf(k) < 0) kinds.push(k);
      if (circs.indexOf(c.circuit) < 0) circs.push(c.circuit);
    });
    return '墙里有 ' + hits.length + ' 根' + kinds.join('/') + '线管正好穿过（' +
      circs.join('、') + ' 回路），开洞会打断它';
  }

  /* 单台设备的等效板中弯矩与影响参数 */
  function meqOne(room, e, x, y, pad) {
    const sl = room.slab;
    const lx = room.x1 - room.x0, ly = room.y1 - room.y0;
    const l = Math.min(lx, ly);
    const s = sl.thk + (pad ? 0.32 : 0.05);
    const ae = e.w + 2 * s, be = e.d + 2 * s;
    const px = clamp(x - room.x0, 0, lx), py = clamp(y - room.y0, 0, ly);
    const dx = clamp(Math.min(px, lx - px) / (lx / 2), 0, 1);
    const dy = clamp(Math.min(py, ly - py) / (ly / 2), 0, 1);
    const kPos = clamp(((1 - (1 - dx) * (1 - dx)) + (1 - (1 - dy) * (1 - dy))) / 2, 0.3, 1);
    const bStrip = lx <= ly + 1e-6 ? be : ae;
    const bEff = Math.min(bStrip + 0.45 * l, Math.max(lx, ly) * 0.95);
    const P = e.weight * G / 1000;
    const Meq0 = P * l / 4 / bEff;
    return { P: P, Meq0: Meq0, Meq: Meq0 * kPos, kPos: kPos, ae: ae, be: be, A: ae * be, s: s, bEff: bEff, bStrip: bStrip, l: l, lx: lx, ly: ly, qDirect: P / (ae * be), px: px, py: py };
  }

  /* ---------------- 单板承载力校核（支持同房间多台设备叠加） ---------------- */
  C.check = function (opt, noAlt) {
    const room = opt.room, eq = opt.equip, sl = room.slab;
    const m0 = meqOne(room, eq, opt.cx, opt.cy, opt.pad);
    const l = m0.l, lx = m0.lx, ly = m0.ly;
    const oneWay = Math.max(lx, ly) / l >= 2;
    const h0 = sl.thk * 1000 - sl.cover - sl.dia / 2;

    const Mu_x = Mu(sl.asx, h0, sl.fc, sl.fy);
    const Mu_y = Mu(sl.asy, h0, sl.fc, sl.fy);
    const Mu_min = Math.min(Mu_x, Mu_y);

    const dead = sl.thk * RHO + DEAD_FINISH;
    const Mdead = oneWay ? dead * l * l / 8 : dead * l * l / 24;

    // 同房间已有的其它设备一起叠加
    const others = (opt.others || []).filter(e => e && e !== eq);
    const oth = others.map(e => ({ eq: e, m: meqOne(room, e, e.x, e.y, e.pad) }));
    const MeqOthers = oth.reduce((s, o) => s + o.m.Meq, 0);
    const POthers = oth.reduce((s, o) => s + o.m.P, 0);

    const MeqSum = MeqOthers + m0.Meq;
    const qEq = 8 * MeqSum / (l * l);                 // 叠加后等效均布荷载 kN/m2
    const qEqOthers = 8 * MeqOthers / (l * l);
    const area = lx * ly;
    const qAvg = (POthers + m0.P) / Math.max(area, 1e-6);   // 满布平均荷载

    const Kstruct = Mu_min / (Mdead + MeqSum);
    const Kload = room.live / Math.max(qEq, 1e-6);
    const Kavg = room.live / Math.max(qAvg, 1e-6);
    let K = Math.min(Kstruct, Kload, Kavg);

    // 挠度（按叠加后的总荷载近似）
    const I = m0.bStrip * 1000 * Math.pow(sl.thk * 1000, 3) / 12;
    const def = ((POthers + m0.P) * 1000) * Math.pow(l * 1000, 3) / (48 * 30000 * I);
    const defLimit = l * 1000 / 400;
    const Kdefv = defLimit / Math.max(def, 1e-6);
    K = Math.min(K, Kdefv);
    if (def > defLimit) K = Math.min(K, 0.99);

    // 抗冲切（最不利的单台）
    const u = 2 * ((m0.ae + h0 / 1000) + (m0.be + h0 / 1000));
    const VR = 0.7 * sl.ft * u * (h0 / 1000) * 1000;
    const punch = m0.P / VR;

    // 剩余可加设备重量（扣掉已有设备占用的份额）
    const qAllow = room.live / TARGET;
    const Pmax_load = Math.max(0, (qAllow - qEqOthers)) * m0.bEff * l / (2 * Math.max(m0.kPos, .3));
    const Pmax_st = Math.max(0, (Mu_min / TARGET - Mdead - MeqOthers)) / (m0.kPos * l / 4 / m0.bEff);
    const Pmax_area = Math.max(0, qAllow * area - POthers);
    const Pmax_kg = Math.max(0, Math.min(Pmax_load, Pmax_st, Pmax_area)) * 1000 / G;

    const verdict = K >= 1.5 ? 'ok' : K >= TARGET ? 'okw' : K >= 1.0 ? 'warn' : 'bad';
    const vmap = {
      ok: { tag: '可以放', cls: 'ok', word: '余量充足' },
      okw: { tag: '可以放', cls: 'ok', word: '留有余量' },
      warn: { tag: '要当心', cls: 'warn', word: '接近限值' },
      bad: { tag: '不建议', cls: 'bad', word: '超出承载' }
    };

    const r = {
      room, equip: eq, K, Kstruct, Kload, Kdef: Kdefv, verdict, v: vmap[verdict],
      l, lx, ly, oneWay, h0, Mu: Mu_min, dead, Mdead,
      Meq: m0.Meq, Meq0: m0.Meq0, MeqSum, MeqOthers, kPos: m0.kPos,
      bEff: m0.bEff, bStrip: m0.bStrip, P: m0.P, POthers, PTotal: m0.P + POthers,
      others: oth.map(o => ({ eq: o.eq, Meq: o.m.Meq, P: o.m.P })),
      qEq, qEqOthers, qAvg, Kavg, qDirect: m0.qDirect,
      ae: m0.ae, be: m0.be, A: m0.A, s: m0.s, pad: !!opt.pad, punch, VR,
      def, defLimit, Pmax_kg, qAllow, px: m0.px, py: m0.py, TARGET,
      cx: opt.cx, cy: opt.cy
    };
    r.advice = advice(r);
    r.alt = noAlt ? [] : alternatives(r, opt);
    return r;
  };

  /* ---------------- 周边构筑物 / 多设备碰撞 ---------------- */
  const rectOf = (e, grow) => ({
    x0: e.x - e.w / 2 - (grow || 0), x1: e.x + e.w / 2 + (grow || 0),
    y0: e.y - e.d / 2 - (grow || 0), y1: e.y + e.d / 2 + (grow || 0)
  });
  const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  /* 设备朝向 → 占地尺寸。
     转 90°/270° 时宽和深互换，这一点以前各算各的：
     放置按 w×d 挑点、旋转按 d 靠墙、碰撞又按 w×d 判边界，三套数对不上，
     于是「贴墙放好却离墙一米」「机柜深边横着戳出墙」。
     现在全工程只认这两个函数。 */
  function rotOf(eq) {
    if (!eq) return 0;
    if (eq.rot != null) return eq.rot;
    const dd = window.BIM && window.BIM.detail;
    return (dd && dd.equipRot) ? dd.equipRot(eq, window.BIM_MODEL) : 0;
  }
  /* foot(eq[,rot]) → 摆正之后沿 x / y 各占多少（w = x 向，d = y 向） */
  function foot(eq, rot) {
    const r = rot == null ? rotOf(eq) : rot;
    const swap = Math.abs(Math.sin(r)) > .5;
    return { w: swap ? eq.d : eq.w, d: swap ? eq.w : eq.d, swap: swap, rot: r };
  }
  /* 设备占地矩形（已考虑朝向） */
  function eqRect(eq, x, y, grow) {
    const f = foot(eq);
    const px = x == null ? eq.x : x, py = y == null ? eq.y : y, g = grow || 0;
    return { x0: px - f.w / 2 - g, x1: px + f.w / 2 + g, y0: py - f.d / 2 - g, y1: py + f.d / 2 + g };
  }
  /* 靠某面墙站 → 正面朝对面（与 equip.js 的 ROT 表一致） */
  const SIDE_ROT = { south: Math.PI, north: 0, west: Math.PI / 2, east: -Math.PI / 2 };
  C.sideRot = function (side) { return SIDE_ROT[side] || 0; };
  C.rotOf = rotOf;
  C.foot = foot;
  C.eqRect = eqRect;

  /* 同一条冲突/提醒只留一次（一间房有多扇窗时不会刷屏） */
  function dedupeBlocks(arr) {
    const out = [], seen = {};
    arr.forEach(b => { if (!seen[b.t]) { seen[b.t] = 1; out.push(b); } });
    return out;
  }
  function dedupeStrs(arr) {
    const out = [];
    arr.forEach(s => { if (out.indexOf(s) < 0) out.push(s); });
    return out;
  }

  /* 设备落位检查：墙/柱/别的设备/风管/阀件/门口/窗/房间里的家具
     返回的 hits 是「撞到的东西」本身（kind + data），界面可以把它们描红，
     用户不用猜"到底撞哪儿了"。 */
  C.obstruct = function (o) {
    const M = window.BIM_MODEL;
    const room = o.room, eq0 = o.equip;
    const x = o.cx, y = o.cy;
    const blocks = [], warns = [], hits = [];
    // 库里的设备还没落位，没有 x/y/room，先补上再算朝向
    const eq = (eq0.rot != null && eq0.x != null) ? eq0 : Object.assign({}, eq0, { x: x, y: y, room: room.id });
    const F = foot(eq);
    const R = rectOf({ x: x, y: y, w: F.w, d: F.d }, 0);
    const elev = room.elev;
    const B = (t, k, hk, hd, box) => {
      blocks.push({ t: t, k: k });
      if (box) hits.push({ kind: 'box', box: box, t: t });
      else if (hk && hd) hits.push({ kind: hk, data: hd, t: t });
    };

    // 1 房间边界（留 0.12 施工净距）
    const pad = 0.12;
    const out = [];
    if (R.x0 < room.x0 + pad) out.push('西边');
    if (R.x1 > room.x1 - pad) out.push('东边');
    if (R.y0 < room.y0 + pad) out.push('南边');
    if (R.y1 > room.y1 - pad) out.push('北边');
    if (out.length) {
      const tooBig = F.w > (room.x1 - room.x0) - 0.2 || F.d > (room.y1 - room.y0) - 0.2;
      B(tooBig ? '设备比这间房还大，放不进去' : '贴到' + out.join('、') + '的墙上了，留不出检修距离', 'wall');
    }

    // 2 框架柱
    M.columns.filter(c => c.floor === room.floor).forEach(c => {
      const cr = { x0: c.x - c.s / 2, x1: c.x + c.s / 2, y0: c.y - c.s / 2, y1: c.y + c.s / 2 };
      if (hit(R, cr)) B('正好压在框架柱（' + c.id + '）上', 'col', 'column', c);
    });

    // 3 同房间其它设备（留 0.3 m 检修通道）
    (o.others || []).forEach(ot => {
      if (!ot || ot === eq0 || ot === eq) return;
      const ro = eqRect(ot, ot.x, ot.y, 0.3);
      if (hit(R, ro)) {
        const fo = foot(ot);
        const gap = Math.max(
          Math.abs(ot.x - x) - (F.w + fo.w) / 2,
          Math.abs(ot.y - y) - (F.d + fo.d) / 2
        );
        B('和「' + ot.name + '」挨太近（净距 ' + fmt(Math.max(gap, 0), 2) + ' m，要留 0.3 m）', 'eq', 'equip', ot);
      }
    });

    // 4 上方风管（净高不够就顶上了）
    M.ducts.filter(d => d.floor === room.floor).forEach(d => {
      const dr = {
        x0: Math.min(d.a[0], d.b[0]) - d.w / 2, x1: Math.max(d.a[0], d.b[0]) + d.w / 2,
        y0: Math.min(d.a[1], d.b[1]) - d.w / 2, y1: Math.max(d.a[1], d.b[1]) + d.w / 2
      };
      if (!hit(R, dr)) return;
      const bottom = Math.min(d.a[2], d.b[2]) - d.h / 2;
      const clear = bottom - elev;
      if (clear < eq.h + 0.05) {
        B('上方风管净高只有 ' + fmt(clear, 2) + ' m，设备高 ' + fmt(eq.h, 2) + ' m，装不进去', 'duct', 'duct', d);
      } else if (clear < eq.h + 0.3) {
        warns.push('风管下面只剩 ' + fmt(clear - eq.h, 2) + ' m，检修会有点挤');
      }
    });

    // 5 阀件
    M.valves.filter(v => v.floor === room.floor).forEach(v => {
      const vr = { x0: v.pos[0] - .28, x1: v.pos[0] + .28, y0: v.pos[1] - .28, y1: v.pos[1] + .28 };
      if (hit(R, vr)) B('压住了阀件「' + v.name + '」，以后没法检修', 'valve', 'valve', v);
    });

    // 6 门口（门扇开启范围 0.9 m）
    M.doors.filter(d => d.floor === room.floor && (d.rooms || []).indexOf(room.id) >= 0).forEach(d => {
      const swing = { x0: d.pos[0] - .95, x1: d.pos[0] + .95, y0: d.pos[1] - .95, y1: d.pos[1] + .95 };
      if (hit(R, swing)) B('挡住了「' + d.name + '」的开启范围，门打不开', 'door', 'door', d);
    });

    // 7 房间里的家具 —— detail 层建家具时记下的落位矩形（工位、档案架、沙发…）
    //   这些是真东西，设备压上去这间房就没法用了
    const D2 = window.BIM.detail;
    const furn = (D2 && D2.furnRects && D2.furnRects[room.id]) || [];
    furn.forEach(f => {
      const cc = Math.abs(Math.cos(f.rot || 0)), ss = Math.abs(Math.sin(f.rot || 0));
      const ex = (f.w / 2) * cc + (f.d / 2) * ss;
      const ey = (f.w / 2) * ss + (f.d / 2) * cc;
      const rr = { x0: f.x - ex, x1: f.x + ex, y0: f.y - ey, y1: f.y + ey };
      if (hit(R, rr)) {
        B('压到房间里的「' + f.label + '」上了', 'furn', null, null,
          { x0: rr.x0, x1: rr.x1, y0: rr.y0, y1: rr.y1, z0: elev, z1: elev + (f.h || 1) });
      }
    });

    // 8 窗（挡采光只是提醒）
    M.windows.filter(w => w.floor === room.floor && (w.rooms || []).indexOf(room.id) >= 0).forEach(w => {
      const near = Math.min(Math.abs(x - w.pos[0]), Math.abs(y - w.pos[1]));
      if (near < 1.2 && eq.h > (w.pos[2] - elev) + 0.3) warns.push('靠窗太近，会挡掉一部分采光');
    });

    return { pass: blocks.length === 0, blocks: dedupeBlocks(blocks), warns: dedupeStrs(warns), hits: hits, rect: R };
  };

  /* ---------------- 设备能不能搬进这间房 ----------------
     按最小包裹尺寸算：设备竖起来搬时占的宽度 = min(w, d)，两侧各留 6 cm 才不蹭门框；
     高度同理（顶上留 8 cm 才抬得进去）。门不够宽 = 设备根本进不了这间房。 */
  /* 设备四周的净距：左/右/前/后各能走多远才碰到东西。
     用户问"旁边还有多少空间""离墙多远""够不够检修"时用——
     同一份结果既喂给场景里的虚框标注，也用来组织回答文字。

     口径：设备按实际朝向摆正后的矩形（foot），沿 ±x / ±y 各找最近的东西。
     墙面算本房间的边界；同房间的其他设备、本层框架柱按矩形投影算。 */
  C.clearance = function (o) {
    const room = o.room, eq = o.equip;
    if (!room || !eq) return null;
    const R = eqRect(eq, o.x, o.y, 0);
    const F = foot(eq);
    const S = {
      west: { key: 'west', v: R.x0 - room.x0, who: room.num + ' 室西墙', cn: '左侧' },
      east: { key: 'east', v: room.x1 - R.x1, who: room.num + ' 室东墙', cn: '右侧' },
      south: { key: 'south', v: R.y0 - room.y0, who: room.num + ' 室南墙', cn: '南侧' },
      north: { key: 'north', v: room.y1 - R.y1, who: room.num + ' 室北墙', cn: '北侧' }
    };

    const put = (k, v, who) => {
      if (v < -1e-6) return;
      if (v < S[k].v - 1e-6) { S[k].v = v; S[k].who = who; }
    };
    const M = window.BIM_MODEL || {};

    // 同房间的其他设备：只有在另一轴上有重叠，才算挡在那一侧
    (o.others || []).forEach(e => {
      if (!e || e === eq) return;
      const b = eqRect(e, null, null, 0);
      const name = '「' + (e.name || '设备') + '」';
      if (b.y1 > R.y0 + 1e-6 && b.y0 < R.y1 - 1e-6) {
        if (b.x1 <= R.x0) put('west', R.x0 - b.x1, name);
        if (b.x0 >= R.x1) put('east', b.x0 - R.x1, name);
      }
      if (b.x0 < R.x1 - 1e-6 && b.x1 > R.x0 + 1e-6) {
        if (b.y1 <= R.y0) put('south', R.y0 - b.y1, name);
        if (b.y0 >= R.y1) put('north', b.y0 - R.y1, name);
      }
    });

    // 本层框架柱
    (M.columns || []).filter(c => c.floor === room.floor).forEach(c => {
      const h = (c.s || 0.5) / 2;
      const b = { x0: c.x - h, x1: c.x + h, y0: c.y - h, y1: c.y + h };
      if (b.y1 > R.y0 + 1e-6 && b.y0 < R.y1 - 1e-6) {
        if (b.x1 <= R.x0) put('west', R.x0 - b.x1, '框架柱');
        if (b.x0 >= R.x1) put('east', b.x0 - R.x1, '框架柱');
      }
      if (b.x0 < R.x1 - 1e-6 && b.x1 > R.x0 + 1e-6) {
        if (b.y1 <= R.y0) put('south', R.y0 - b.y1, '框架柱');
        if (b.y0 >= R.y1) put('north', b.y0 - R.y1, '框架柱');
      }
    });

    // 正面（检修面）：rot 决定正面朝哪，那一侧够不够开柜门
    const rot = F.rot;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const face = Math.abs(sn) > 0.5 ? (sn > 0 ? 'east' : 'west') : (cs > 0 ? 'south' : 'north');
    const FACE_CN = { west: '西', east: '东', south: '南', north: '北' };

    let minK = 'west';
    ['east', 'south', 'north'].forEach(k => { if (S[k].v < S[minK].v) minK = k; });
    const stuck = ['west', 'east', 'south', 'north'].filter(k => S[k].v < 0.05);

    return {
      room: room, equip: eq, x: o.x == null ? eq.x : o.x, y: o.y == null ? eq.y : o.y,
      rect: R, foot: F,
      west: S.west, east: S.east, south: S.south, north: S.north,
      face: face, faceCn: FACE_CN[face], faceV: S[face].v, faceWho: S[face].who,
      minKey: minK, minV: S[minK].v, minWho: S[minK].who, minCn: S[minK].cn,
      stuck: stuck
    };
  };

  /* 净距 → 人话 */
  C.clearWord = function (v, forService) {
    if (v < 0.05) return '贴死了';
    if (v < 0.3) return '基本过不去';
    if (v < 0.6) return '只能侧身过';
    if (v < 0.9) return forService ? '检修有点挤' : '人能过';
    if (v < 1.5) return forService ? '够开柜门检修' : '走人不挤';
    return '很宽敞，搬运也够';
  };

  /* 一间房在某面墙上占的是哪一段（沿墙轴的投影区间） */
  function spanOn(room, wall, ux, uy) {
    const [ax, ay] = wall.p1;
    const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
      .map(q => (q[0] - ax) * ux + (q[1] - ay) * uy);
    return { lo: Math.min.apply(null, ts), hi: Math.max.apply(null, ts) };
  }

  /* 这扇门是不是真落在这间房的墙段上。
     长墙（比如 W-5F-005 一条 33 米挂了五间房的门）数据里 d.rooms 会把整面墙的
     房间都算进去，只按 d.rooms 判断就会拿隔壁的门来量这间房——505 的"门净宽
     1.00 m"其实量的是 501 的门，拓门自然怎么算都出界。 */
  function doorInRoom(d, room) {
    const wall = window.BIM_MODEL.walls.find(w => w.id === d.wall);
    if (!wall) return false;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const at = SELF_AT(d, wall, ux, uy);
    const sp = spanOn(room, wall, ux, uy);
    const half = (d.w || 1) / 2;
    return at - half >= sp.lo - 0.05 && at + half <= sp.hi + 0.05;
  }
  C.doorInRoom = doorInRoom;

  C.passDoor = function (o) {
    const M = window.BIM_MODEL;
    const room = o.room, eq = o.equip;
    if (!room || !eq) return { ok: true, door: null, needW: 0, needH: 0 };
    let doors = (M.doors || []).filter(d => d.floor === room.floor && (d.rooms || []).indexOf(room.id) >= 0);
    // 先用"门确实在这段墙上"筛；一条都没有时才退回原列表（宁可量错也别当成没门）
    const exact = doors.filter(d => doorInRoom(d, room));
    if (exact.length) doors = exact;
    const packW = Math.min(eq.w, eq.d);
    const needW = +(Math.ceil((packW + 0.12) * 20) / 20).toFixed(2);   // 取 5 cm 整数档
    const needH = +(Math.ceil((eq.h + 0.08) * 20) / 20).toFixed(2);
    if (!doors.length) {
      return { ok: false, why: 'no-door', door: null, needW: needW, needH: needH, packW: packW };
    }
    // 多扇门时按"最宽的那扇"当搬运通道（真实搬运也是挑大门走）
    const door = doors.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    const okW = door.w + 1e-6 >= needW;
    const okH = door.h + 1e-6 >= needH;
    return {
      ok: okW && okH, why: okW ? (okH ? 'ok' : 'height') : 'width',
      door: door, doorW: door.w, doorH: door.h,
      needW: needW, needH: needH, packW: packW, count: doors.length
    };
  };

  /* 正面朝的那个方向还剩多少净空（冲墙就是 0 附近） */
  function frontFree(room, eq, x, y, F) {
    const fx = Math.sin(F.rot), fy = -Math.cos(F.rot);
    const hx = F.w / 2, hy = F.d / 2;
    if (Math.abs(fx) > .5) return fx > 0 ? room.x1 - (x + hx) : (x - hx) - room.x0;
    return fy > 0 ? room.y1 - (y + hy) : (y - hy) - room.y0;
  }
  C.frontFree = frontFree;

  /* 找一个放得下的位置（优先靠近用户点的地方）。
     四种朝向她都试一遍：设备换个方向站，占的格子就不一样，硬按一个朝向来扫
     会得出"贴着墙却只能背对房间"的怪位子。挑的时候先要"正面有地方站人"，
     再挑离目标最近的。 */
  C.suggestSpot = function (o) {
    const room = o.room, eq0 = o.equip;
    const step = 0.3;
    const margin = 0.15;
    const per = [];
    [0, Math.PI / 2, Math.PI, -Math.PI / 2].forEach(rot => {
      const eq = Object.assign({}, eq0, { rot: rot });
      const F = foot(eq, rot);
      let best = null;
      for (let x = room.x0 + F.w / 2 + margin; x <= room.x1 - F.w / 2 - margin + 1e-6; x += step) {
        for (let y = room.y0 + F.d / 2 + margin; y <= room.y1 - F.d / 2 - margin + 1e-6; y += step) {
          const ob = C.obstruct({ room, equip: eq, cx: x, cy: y, others: o.others });
          if (!ob.pass) continue;
          const d = Math.hypot(x - o.cx, y - o.cy);
          if (!best || d < best.d) best = { x: x, y: y, d: d, rot: rot, free: frontFree(room, eq, x, y, F) };
        }
      }
      if (best) per.push(best);
    });
    if (!per.length) return null;
    per.sort((a, b) => a.d - b.d);
    const good = per.filter(p => p.free >= 0.6);      // 正面站得下人的优先
    return good[0] || per[0];
  };

  function advice(r) {
    const out = [];
    const n = r.others.length;
    const tail = n ? '加上原来那 ' + n + ' 台，这块板一共压着 ' + (r.PTotal * 1000 / G / 1000).toFixed(2) + ' 吨。' : '';
    if (r.K >= 1.5) {
      out.push('楼板余量充足，可以直接按现在的位置安装。' + (n ? tail : ''));
      return out;
    }
    if (r.K < 1.0) {
      out.push(n
        ? '这块板已经放了 ' + n + ' 台设备，再放这台就超了，别硬塞。'
        : '这台设备太重，这块板现在扛不住，别直接放上去。');
      out.push('垫钢板把力摊开，或者挪到靠梁、靠柱的位置再复算；都不行就换房间。');
      return out;
    }
    if (r.Kload < r.Kstruct) {
      out.push('这块板本身扛得住，只是设备太集中，局部压得偏紧。' + tail);
      out.push(n
        ? '加一块一米见方的钢板垫在底下，两台之间留开 0.5 米以上就稳了。'
        : '加一块一米见方的钢板垫在设备底下，把力摊开就稳了。');
    } else {
      out.push('设备重量已经让楼板吃紧，靠近梁或柱会好一些。' + tail);
      out.push('最好靠梁边放，或者换成轻一点的型号。');
    }
    return out.slice(0, 2);
  }

  function alternatives(r, opt) {
    const list = [];
    // 1) 加垫板
    if (!opt.pad) {
      const a = C.check(Object.assign({}, opt, { pad: true }), true);
      if (a.K > r.K + 0.05) list.push({ name: '加垫板', k: a.K, tip: '设备下垫钢板把力摊开' });
    }
    // 2) 靠近梁柱
    if (r.kPos > 0.62) {
      const a = C.check(Object.assign({}, opt, { cx: r.room.x0 + 0.9, cy: r.room.y0 + 0.9, pad: opt.pad }), true);
      if (a.K > r.K + 0.05) list.push({ name: '靠梁放', k: a.K, tip: '挪到靠梁或柱的位置' });
    }
    // 3) 换到机房层
    return list;
  }

  /* ---------------- 开门碰撞检查 ---------------- */
  /* 洞口是不是"就是这扇门自己"。模型自带的洞口在 wall.openings 里没有 ref，
     只按 op.ref === self.id 判断会把"自己"当成挡道的老门，结果每扇原有门都报
     "和原来的门重叠了"，永远改不动。所以再按 原中心位置 + 原宽度 认一遍。 */
  function SELF_AT(d, wall, ux, uy) {
    const [ax, ay] = wall.p1;
    return (d.pos[0] - ax) * ux + (d.pos[1] - ay) * uy;
  }
  function isSelf(op, self, selfAt) {
    if (!self) return false;
    if (op.ref && op.ref === self.id) return true;
    if (selfAt == null) return false;
    return Math.abs(op.at - selfAt) < 0.03 && Math.abs(op.w - (self.w || 0)) < 0.03;
  }

  C.door = function (o) {
    const M = window.BIM_MODEL;
    const wall = o.wall, at = o.at, w = o.w, h = o.h || 2.1;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const half = w / 2;
    const blocks = [], warns = [];

    const e0 = at - half, e1 = L - at - half;
    if (e0 < 0.22) blocks.push({ t: e0 < 0.02 ? '门已经压到墙角上，墙垛留不住' : '离墙角只有 ' + fmt(e0, 2) + ' 米，墙垛太窄', k: 'angle' });
    if (e1 < 0.22) blocks.push({ t: e1 < 0.02 ? '门已经压到另一头墙角' : '离另一头墙角只有 ' + fmt(e1, 2) + ' 米，墙垛太窄', k: 'angle' });

    // 尺寸本身是否合理
    if (w < 0.6) blocks.push({ t: '门宽 ' + fmt(w, 2) + ' m 太窄，人过不去（最小 0.6 m）', k: 'size' });
    if (w > 2.4) blocks.push({ t: '门宽 ' + fmt(w, 2) + ' m 超过 2.4 m，要做特殊门或加门套', k: 'size' });
    if (o.room) {
      const ts = [[o.room.x0, o.room.y0], [o.room.x1, o.room.y0], [o.room.x0, o.room.y1], [o.room.x1, o.room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      const lo2 = Math.min.apply(null, ts), hi2 = Math.max.apply(null, ts);
      if (at - half < lo2 - 0.05 || at + half > hi2 + 0.05) {
        blocks.push({ t: '这个位置已经出了本房间的墙面范围，会开到隔壁房间去', k: 'span' });
      }
    }

    // 改门时别把自己当成"挡道的旧门"：模型自带的洞口没有 ref，只能按原位置+原宽度认
    const selfAt = o.self ? SELF_AT(o.self, wall, ux, uy) : null;
    wall.openings.forEach(op => {
      if (op._new) return;
      if (isSelf(op, o.self, selfAt)) return;
      const gap = Math.abs(op.at - at) - (op.w + w) / 2;
      if (gap < 0.25) {
        const kind = op.kind === 'door' ? '门' : '窗';
        blocks.push({ t: gap <= 0.01 ? '和原来的' + kind + '重叠了' : '离原来的' + kind + '只有 ' + fmt(gap, 2) + ' 米，太挤', k: 'open' });
      }
    });

    // 柱子
    // 门洞平面范围：沿墙方向只取洞口宽度，垂直墙方向按墙厚扩展
    const px = Math.abs(uy) * wall.t / 2, py = Math.abs(ux) * wall.t / 2;
    const xa = ax + ux * (at - half), xb = ax + ux * (at + half);
    const ya = ay + uy * (at - half), yb = ay + uy * (at + half);
    const doorRect = {
      x0: Math.min(xa, xb) - px + 0.01, x1: Math.max(xa, xb) + px - 0.01,
      y0: Math.min(ya, yb) - py + 0.01, y1: Math.max(ya, yb) + py - 0.01
    };
    M.columns.filter(c => c.floor === wall.floor).forEach(c => {
      const r2 = { x0: c.x - c.s / 2, x1: c.x + c.s / 2, y0: c.y - c.s / 2, y1: c.y + c.s / 2 };
      if (doorRect.x0 < r2.x1 && doorRect.x1 > r2.x0 && doorRect.y0 < r2.y1 && doorRect.y1 > r2.y0) {
        blocks.push({ t: '正好开在框架柱上', k: 'col' });
      }
    });

    // 风管
    M.ducts.filter(d => d.floor === wall.floor).forEach(d => {
      const cross = segCross(d.a, d.b, [ax, ay], [bx, by]);
      if (cross == null) return;
      const cx2 = d.a[0] + (d.b[0] - d.a[0]) * cross, cy2 = d.a[1] + (d.b[1] - d.a[1]) * cross;
      const near = Math.hypot(cx2 - (ax + ux * at), cy2 - (ay + uy * at));
      const ductBottom = Math.min(d.a[2], d.b[2]) - d.h / 2;
      if (near < half + d.w && ductBottom < wall.base + h + 0.2) {
        blocks.push({ t: '风管从这里穿过，门洞会碰上', k: 'duct' });
      }
    });

    // 已放设备挡门（门扇要能开 0.9 m）
    (o.equipments || []).forEach(eq => {
      const fe = foot(eq);
      const ex0 = eq.x - fe.w / 2 - 0.9, ex1 = eq.x + fe.w / 2 + 0.9;
      const ey0 = eq.y - fe.d / 2 - 0.9, ey1 = eq.y + fe.d / 2 + 0.9;
      if (doorRect.x0 < ex1 && doorRect.x1 > ex0 && doorRect.y0 < ey1 && doorRect.y1 > ey0) {
        blocks.push({ t: '门口被「' + eq.name + '」挡住了，门扇开不出来', k: 'eq' });
      }
    });

    /* 墙里预埋的线管：真实施工里这一凿就断一路电，必须算进来。
       命中时把线管本身一并带回去，上层才好算"上翻／下翻绕过去"的方案；
       如果上层打算先改线再开洞，传 conduitBlock:false 就只报结构性问题。 */
    const chits = conduitHits(wall, at, w, h, 0);
    if (chits.length && o.conduitBlock !== false) {
      blocks.push({ t: conduitText(chits), k: 'conduit', conduits: chits });
    }

    if (h > wall.h - 0.35) blocks.push({ t: '门高 ' + fmt(h, 2) + ' m 顶到上面的梁了（墙净高 ' + fmt(wall.h, 2) + ' m）', k: 'height' });
    if (h < 1.8) warns.push('门高只有 ' + fmt(h, 2) + ' m，偏矮，搬运设备会不方便');
    if (wall.kind === 'ext') warns.push('这是外墙，开门还要看结构和防水');
    if (w > 1.4) warns.push('门比较宽，门顶上要加固');
    if (wall.kind === 'part') warns.push('这是内隔墙，门顶上要补一根过梁');

    return {
      pass: blocks.length === 0, blocks: dedupeBlocks(blocks), warns: dedupeStrs(warns),
      at, w, h, wall, L, conduits: chits
    };
  };

  /* ---------------- 窗洞校核 ----------------
     比门多两条：窗台高（低于 0.9 m 要防护）和窗顶标高（不能顶到梁底） */
  C.window = function (o) {
    const M = window.BIM_MODEL;
    const wall = o.wall, at = o.at, w = o.w, h = o.h || 1.5;
    const sill = o.sill == null ? 0.9 : o.sill;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const half = w / 2;
    const blocks = [], warns = [];

    const e0 = at - half, e1 = L - at - half;
    if (e0 < 0.28) blocks.push({ t: e0 < 0.02 ? '窗已经压到墙角上' : '离墙角只有 ' + fmt(e0, 2) + ' 米，窗垛太窄', k: 'angle' });
    if (e1 < 0.28) blocks.push({ t: e1 < 0.02 ? '窗已经压到另一头墙角' : '离另一头墙角只有 ' + fmt(e1, 2) + ' 米，窗垛太窄', k: 'angle' });

    if (w < 0.5) blocks.push({ t: '窗宽 ' + fmt(w, 2) + ' m 太窄（最小 0.5 m）', k: 'size' });
    if (w > 6) blocks.push({ t: '窗宽 ' + fmt(w, 2) + ' m 超过 6 m，要拆成几樘或做幕墙', k: 'size' });
    if (h < 0.45) blocks.push({ t: '窗高 ' + fmt(h, 2) + ' m 太矮（最小 0.45 m）', k: 'size' });
    if (sill + h > wall.h - 0.28) {
      blocks.push({ t: '窗顶到 ' + fmt(sill + h, 2) + ' m，顶到上面的梁了（墙净高 ' + fmt(wall.h, 2) + ' m）', k: 'height' });
    }
    if (o.room) {
      const ts = [[o.room.x0, o.room.y0], [o.room.x1, o.room.y0], [o.room.x0, o.room.y1], [o.room.x1, o.room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      const lo2 = Math.min.apply(null, ts), hi2 = Math.max.apply(null, ts);
      if (at - half < lo2 - 0.05 || at + half > hi2 + 0.05) {
        blocks.push({ t: '这个位置已经出了本房间的墙面范围，会开到隔壁去', k: 'span' });
      }
    }

    const selfAtW = o.self ? SELF_AT(o.self, wall, ux, uy) : null;
    wall.openings.forEach(op => {
      if (isSelf(op, o.self, selfAtW)) return;
      const gap = Math.abs(op.at - at) - (op.w + w) / 2;
      if (gap < 0.3) {
        const kind = op.kind === 'door' ? '门' : '窗';
        blocks.push({ t: gap <= 0.01 ? '和原来的' + kind + '重叠了' : '离原来的' + kind + '只有 ' + fmt(gap, 2) + ' 米，太挤', k: 'open' });
      }
    });

    const px = Math.abs(uy) * wall.t / 2, py = Math.abs(ux) * wall.t / 2;
    const xa = ax + ux * (at - half), xb = ax + ux * (at + half);
    const ya = ay + uy * (at - half), yb = ay + uy * (at + half);
    const rect = {
      x0: Math.min(xa, xb) - px + 0.01, x1: Math.max(xa, xb) + px - 0.01,
      y0: Math.min(ya, yb) - py + 0.01, y1: Math.max(ya, yb) + py - 0.01
    };
    M.columns.filter(c => c.floor === wall.floor).forEach(c => {
      const r2 = { x0: c.x - c.s / 2, x1: c.x + c.s / 2, y0: c.y - c.s / 2, y1: c.y + c.s / 2 };
      if (rect.x0 < r2.x1 && rect.x1 > r2.x0 && rect.y0 < r2.y1 && rect.y1 > r2.y0) {
        blocks.push({ t: '正好开在框架柱上', k: 'col' });
      }
    });

    // 风管正好在窗高区间里穿过
    M.ducts.filter(d => d.floor === wall.floor).forEach(d => {
      const cross = segCross(d.a, d.b, [ax, ay], [bx, by]);
      if (cross == null) return;
      const cx2 = d.a[0] + (d.b[0] - d.a[0]) * cross, cy2 = d.a[1] + (d.b[1] - d.a[1]) * cross;
      const near = Math.hypot(cx2 - (ax + ux * at), cy2 - (ay + uy * at));
      const dbot = Math.min(d.a[2], d.b[2]) - d.h / 2, dtop = Math.max(d.a[2], d.b[2]) + d.h / 2;
      if (near < half + d.w && dtop > wall.base + sill && dbot < wall.base + sill + h) {
        blocks.push({ t: '风管在这个高度穿过，窗洞会碰上', k: 'duct' });
      }
    });

    // 贴着窗放的柜子/设备挡光
    (o.equipments || []).forEach(eq => {
      const fe = foot(eq);
      const ex0 = eq.x - fe.w / 2 - 0.35, ex1 = eq.x + fe.w / 2 + 0.35;
      const ey0 = eq.y - fe.d / 2 - 0.35, ey1 = eq.y + fe.d / 2 + 0.35;
      if (rect.x0 < ex1 && rect.x1 > ex0 && rect.y0 < ey1 && rect.y1 > ey0 && eq.h > sill + 0.3) {
        warns.push('「' + eq.name + '」挡在窗前，采光会受影响');
      }
    });

    if (sill < 0.9) warns.push('窗台高 ' + fmt(sill, 2) + ' m 低于 0.9 m，临空时要加防护栏杆（GB 50096）');
    if (wall.kind === 'ext') warns.push('这是外墙，开窗要核窗过梁和防水节点');
    else warns.push('这是内隔墙，开的是观察窗，隔墙要加过梁');
    if (sill + h > 1.8 && wall.kind === 'ext') warns.push('窗洞偏高，注意幕墙分格和开启扇位置');

    /* 墙内线管冲突（同 C.door）。窗的 sill 参与判定：
       普通窗 0.9+1.5=2.4 够不着 2.9 m 的照明管，做成到顶的高窗才会碰上 */
    const chits = conduitHits(wall, at, w, h, sill);
    if (chits.length && o.conduitBlock !== false) {
      blocks.push({ t: conduitText(chits), k: 'conduit', conduits: chits });
    }

    return {
      pass: blocks.length === 0, blocks: dedupeBlocks(blocks), warns: dedupeStrs(warns),
      at, w, h, sill, wall, L, conduits: chits
    };
  };

  /* ---------------- 空间打穿 / 拆墙校核 ----------------
     跟开门不是一回事：门是"做一樘能关上的门"，打穿是"墙上挖个洞让两边连通"，
     尺寸大得多，结构上的忌讳也多——承重外墙、框架柱、墙里管线，
     还有消防分区和隔声。这里只判"能不能挖"，加固怎么补放在 warns 里讲。 */
  C.passage = function (o) {
    const M = window.BIM_MODEL;
    const wall = o.wall, at = o.at, w = o.w, h = o.h == null ? 2.2 : o.h;
    const sill = 0;                              // 打穿都是落到地面，没有窗台
    const whole = !!o.demolish;                  // 整段拆：连原有的门窗一起拆掉，不算"重叠"
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const half = w / 2;
    const blocks = [], warns = [];

    /* ① 结构：外墙在这栋楼里同时是承重墙，拆了受力体系就变了 */
    if (wall.kind === 'ext') {
      blocks.push({ t: '这是外墙（兼承重墙），拆了整栋楼的传力路径就变了，不能开', k: 'structure' });
    }
    if (w < 0.8) blocks.push({ t: '洞口宽 ' + fmt(w, 2) + ' m 太窄，打穿了也没用（最小 0.8 m）', k: 'size' });
    if (h > wall.h - 0.30) {
      blocks.push({
        t: '洞口高 ' + fmt(h, 2) + ' m，上方只剩 ' + fmt(wall.h - h, 2) + ' m，留不出过梁（墙净高 ' + fmt(wall.h, 2) + ' m）',
        k: 'height'
      });
    }
    const e0 = at - half, e1 = L - at - half;
    if (e0 < 0.12) blocks.push({ t: e0 < 0.01 ? '洞口已经切到墙端头' : '离墙端头只有 ' + fmt(e0, 2) + ' 米，留不住墙垛', k: 'angle' });
    if (e1 < 0.12) blocks.push({ t: e1 < 0.01 ? '洞口已经切到墙另一端头' : '离另一端头只有 ' + fmt(e1, 2) + ' 米，留不住墙垛', k: 'angle' });

    if (o.room && !whole) {
      const ts = [[o.room.x0, o.room.y0], [o.room.x1, o.room.y0], [o.room.x0, o.room.y1], [o.room.x1, o.room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      const lo2 = Math.min.apply(null, ts), hi2 = Math.max.apply(null, ts);
      if (at - half < lo2 - 0.05 || at + half > hi2 + 0.05) {
        blocks.push({ t: '洞口的范围出了这间房，会牵连到隔壁房间', k: 'span' });
      }
    }

    /* ② 和已有的门窗重叠（打穿时最容易踩：门就在旁边）
       整段拆除外——范围之内的门窗本来就一起拆了，这是拆墙的应有之义，
       拦下来会让"这面墙拆了"永远执行不了。改成在 warns 里点名。 */
    const selfAt = o.self ? SELF_AT(o.self, wall, ux, uy) : null;
    const eaten = [];
    wall.openings.forEach(op => {
      if (isSelf(op, o.self, selfAt)) return;
      const gap = Math.abs(op.at - at) - (op.w + w) / 2;
      const kind = op.kind === 'door' ? '门' : (op.kind === 'window' ? '窗' : '洞口');
      if (whole) {
        if (gap < 0.02) eaten.push({ kind: op.kind, name: op.name, w: op.w, at: op.at });
        return;
      }
      if (gap < 0.2) {
        blocks.push({ t: gap <= 0.01 ? '和原来的' + kind + '重叠了' : '离原来的' + kind + '只有 ' + fmt(gap, 2) + ' 米，太挤', k: 'open' });
      }
    });
    if (eaten.length) {
      warns.push('这段墙上的 ' + eaten.length + ' 处' + eaten.map(x => (x.kind === 'door' ? '门' : (x.kind === 'window' ? '窗' : '洞口')))
        .filter((v, i, a) => a.indexOf(v) === i).join('/') + '会一起拆掉，门扇和窗要另行处理');
    }

    /* ③ 框架柱。整段拆的时候墙两端的柱本来就留着不倒，只有柱子卡在洞口中间
       才是真问题——所以整拆时把判定范围沿墙各收 N 米，别拿端头柱误伤。 */
    const inset = whole ? Math.min(0.45, half * 0.35) : 0;
    const px = Math.abs(uy) * wall.t / 2, py = Math.abs(ux) * wall.t / 2;
    const xa = ax + ux * (at - half + inset), xb = ax + ux * (at + half - inset);
    const ya = ay + uy * (at - half + inset), yb = ay + uy * (at + half - inset);
    const rect = {
      x0: Math.min(xa, xb) - px + 0.01, x1: Math.max(xa, xb) + px - 0.01,
      y0: Math.min(ya, yb) - py + 0.01, y1: Math.max(ya, yb) + py - 0.01
    };
    M.columns.filter(c => c.floor === wall.floor).forEach(c => {
      const r2 = { x0: c.x - c.s / 2, x1: c.x + c.s / 2, y0: c.y - c.s / 2, y1: c.y + c.s / 2 };
      if (rect.x0 < r2.x1 && rect.x1 > r2.x0 && rect.y0 < r2.y1 && rect.y1 > r2.y0) {
        blocks.push({ t: '洞口范围内有框架柱，柱子不能拆', k: 'col' });
      }
    });

    // ④ 风管
    M.ducts.filter(d => d.floor === wall.floor).forEach(d => {
      const cross = segCross(d.a, d.b, [ax, ay], [bx, by]);
      if (cross == null) return;
      const cx2 = d.a[0] + (d.b[0] - d.a[0]) * cross, cy2 = d.a[1] + (d.b[1] - d.a[1]) * cross;
      const near = Math.hypot(cx2 - (ax + ux * at), cy2 - (ay + uy * at));
      if (near < half + d.w && Math.min(d.a[2], d.b[2]) - d.h / 2 < wall.base + h) {
        blocks.push({ t: '有风管从这里穿过洞口范围', k: 'duct' });
      }
    });

    // ⑤ 墙内线管
    const chits = conduitHits(wall, at, w, h, sill);
    if (chits.length && o.conduitBlock !== false) {
      blocks.push({ t: conduitText(chits), k: 'conduit', conduits: chits });
    }

    // ⑥ 提醒项：这些不是不能做，是要另外补
    if (wall.kind !== 'ext') warns.push('洞口上方要补过梁（预制或现浇），跨度大时按钢梁算');
    if (w > 3) warns.push('洞口超过 3 米，两侧要加构造柱，楼板边要复核');
    warns.push('打穿会连通两个防火分区，消防要重新核（喷淋、报警、疏散距离）');
    if (h >= 2.2) warns.push('隔声会明显下降，需要时加隔声门斗');
    if (wall.t < 0.2) warns.push('墙比较薄（' + fmt(wall.t, 2) + ' m），洞口边缘容易崩，要做护角');

    return {
      pass: blocks.length === 0, blocks: dedupeBlocks(blocks), warns: dedupeStrs(warns),
      at, w, h, sill, wall, L, conduits: chits
    };
  };


  /* 在墙面这一段落上找一个能开窗的位置。
     先按 0.1 m 粗扫；粗扫漏掉的窄缝（柱边到旧窗之间只剩几十公分）再按 0.02 m 细扫一遍。
     实在一个位置都没有，把"毛病最少"的那次校核带回去，好让界面说清楚到底卡在哪。 */
  C.suggestWindowAt = function (o) {
    const wall = o.wall, room = o.room, w = o.w, h = o.h, sill = o.sill;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    let lo = 0.35, hi = L - 0.35;
    if (room) {
      const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      lo = Math.min.apply(null, ts) + 0.05;
      hi = Math.max.apply(null, ts) - 0.05;
    }
    const want = o.at == null ? (lo + hi) / 2 : o.at;
    let best = null, worst = null;
    const scan = step => {
      for (let at = lo + w / 2; at <= hi - w / 2 + 1e-6; at += step) {
        const c = C.window({ wall: wall, at: at, w: w, h: h, sill: sill, room: room, equipments: o.equipments, self: o.self });
        const okHere = c.pass || (o.ignoreConduit && (c.blocks || []).every(b => b.k === 'conduit'));
        if (okHere) {
          const d = Math.abs(at - want);
          if (!best || d < best.d) best = { at: at, d: d, check: c };
        } else if (!worst || c.blocks.length < worst.blocks.length) {
          worst = { at: at, blocks: c.blocks, check: c };
        }
      }
    };
    scan(0.1);
    if (!best) scan(0.02);
    if (best) return best;
    return { at: null, check: worst ? worst.check : null, blocks: worst ? worst.blocks : [] };
  };

  /* 在墙上就近找一个能开门的位置 */
  C.suggestDoorAt = function (o) {
    const wall = o.wall, room = o.room, w = o.w, h = o.h;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    let lo = 0.3, hi = L - 0.3;
    if (room) {
      const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      lo = Math.min.apply(null, ts) + 0.05;
      hi = Math.max.apply(null, ts) - 0.05;
    }
    let best = null;
    for (let at = lo + w / 2; at <= hi - w / 2; at += 0.1) {
      const c = C.door({ wall: wall, at: at, w: w, h: h, room: room, equipments: o.equipments, self: o.self });
      /* ignoreConduit：只解决"位置"问题，线管留给上层另外处理（牵线/再挪） */
      const okHere = c.pass || (o.ignoreConduit && (c.blocks || []).every(b => b.k === 'conduit'));
      if (!okHere) continue;
      const d = Math.abs(at - o.at);
      if (!best || d < best.d) best = { at: at, d: d, check: c };
    }
    return best;
  };

  /* 就近找一个能打穿的位置（打穿的洞口通常比门宽，能挪的余地更小） */
  C.suggestPassageAt = function (o) {
    const wall = o.wall, room = o.room, w = o.w, h = o.h;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    let lo = 0.15, hi = L - 0.15;
    if (room) {
      const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
        .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      lo = Math.min.apply(null, ts) + 0.05;
      hi = Math.max.apply(null, ts) - 0.05;
    }
    let best = null;
    for (let at = lo + w / 2; at <= hi - w / 2 + 1e-6; at += 0.1) {
      const c = C.passage({ wall: wall, at: at, w: w, h: h, room: room, equipments: o.equipments, self: o.self });
      /* ignoreConduit：只解决"位置"问题，线管留给上层另外处理（牵线/再挪） */
      const okHere = c.pass || (o.ignoreConduit && (c.blocks || []).every(b => b.k === 'conduit'));
      if (!okHere) continue;
      const d = Math.abs(at - o.at);
      if (!best || d < best.d) best = { at: at, d: d, check: c };
    }
    return best;
  };

  /* ---------------- 拓门：先量两侧各剩多少 ----------------
     门能不能加宽，不是"以门心为轴两边各长一半"就算完 —— 现场十有八九是一侧贴着
     墙角或隔壁门，另一侧还有墙垛可挖。所以先把门洞左右两条边到障碍的净距离分别量出来，
     再据此生成「两侧各半 / 只扩左 / 只扩右」三个方案，最后仍由 C.door 做一次总校核。
     量的是沿墙方向的距离：墙角留 0.22 m 墙垛、洞口之间留 0.25 m、房间墙面留 0.05 m。 */
  C.doorRoom = function (o) {
    const M = window.BIM_MODEL;
    const wall = o.wall, at = o.at, w = o.w;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const proj = (x, y) => (x - ax) * ux + (y - ay) * uy;
    const perp = (x, y) => Math.abs(-(x - ax) * uy + (y - ay) * ux);
    const eL = at - w / 2, eR = at + w / 2;
    const JAMB = 0.22, GAP = 0.25;

    const L_ = [], R_ = [];                       // {lim, name}：门边最多能推到哪
    L_.push({ lim: JAMB, name: '这头墙角' });
    R_.push({ lim: L - JAMB, name: '另一头墙角' });
    if (o.room) {
      const ts = [[o.room.x0, o.room.y0], [o.room.x1, o.room.y0],
                  [o.room.x0, o.room.y1], [o.room.x1, o.room.y1]].map(p => proj(p[0], p[1]));
      L_.push({ lim: Math.min.apply(null, ts) + 0.05, name: '房间这头的墙端' });
      R_.push({ lim: Math.max.apply(null, ts) - 0.05, name: '房间那头的墙端' });
    }
    const selfAt0 = o.self ? SELF_AT(o.self, wall, ux, uy) : null;
    (wall.openings || []).forEach(op => {
      if (op._new) return;
      if (isSelf(op, o.self, selfAt0)) return;
      if (op.kind !== 'door' && op.kind !== 'window') return;
      const name = op.kind === 'door' ? '原来的门' : '原来的窗';
      const l = op.at - op.w / 2, r = op.at + op.w / 2;
      if (r <= eL + 1e-6) L_.push({ lim: r + GAP, name: name });
      else if (l >= eR - 1e-6) R_.push({ lim: l - GAP, name: name });
      else { L_.push({ lim: eL, name: name }); R_.push({ lim: eR, name: name }); }
    });
    (M.columns || []).filter(c => c.floor === wall.floor).forEach(c => {
      if (perp(c.x, c.y) > wall.t / 2 + c.s / 2) return;
      const tc = proj(c.x, c.y), l = tc - c.s / 2, r = tc + c.s / 2;
      if (r <= eL + 1e-6) L_.push({ lim: r, name: '框架柱' });
      else if (l >= eR - 1e-6) R_.push({ lim: l, name: '框架柱' });
    });

    // 门边最多能推到哪：左边取所有"下限"里最大的那个，右边取所有"上限"里最小的那个
    const goL = L_.reduce((a, b) => (b.lim > a.lim ? b : a), { lim: -1e9, name: '' });
    const goR = R_.reduce((a, b) => (b.lim < a.lim ? b : a), { lim: 1e9, name: '' });
    return {
      at: at, w: w, eL: eL, eR: eR, L: L,
      left: Math.max(0, Math.min(eL, +(eL - goL.lim).toFixed(3))),
      right: Math.max(0, Math.min(L - eR, +(goR.lim - eR).toFixed(3))),
      nearL: goL.name, nearR: goR.name
    };
  };

  /* 拓门方案：按「两侧各半 → 只扩余量大的一侧 → 顺墙平移 → 退而求其次的宽度」依次试，
     每个方案都过 C.door。返回第一个能过的，以及两侧余量（回执里要报给用户）。 */
  C.widenPlan = function (o) {
    const wall = o.wall, at = o.at, w = o.w, h = o.h;
    const need = Math.max(o.need || w, w);
    const D = +(need - w).toFixed(3);
    const side = C.doorRoom({ wall: wall, at: at, w: w, room: o.room, self: o.self });
    const equipments = o.equipments || [];
    const cands = [];
    const add = (mode, at2, w2, why) => {
      const chk = C.door({ wall: wall, at: at2, w: w2, h: h, room: o.room,
                           equipments: equipments, self: o.self });
      cands.push({ mode: mode, at: +at2.toFixed(3), w: +w2.toFixed(3), h: h,
                   chk: chk, pass: chk.pass, why: why || '' });
    };

    if (D <= 1e-6) add('sym', at, w);                       // 只改高度
    else {
      add('sym', at, need, '两侧各扩一半');
      // 只扩一侧：先试余量大的那侧
      const order = side.left >= side.right ? ['left', 'right'] : ['right', 'left'];
      order.forEach(sd => {
        const avail = sd === 'left' ? side.left : side.right;
        if (avail < D - 1e-6) return;
        add(sd, sd === 'left' ? at - D / 2 : at + D / 2, need,
            sd === 'left' ? '只往左侧扩' : '只往右侧扩');
      });
    }

    // 原位三个方案都不行 → 顺墙平移（但别让门跑到墙的另一头去，最多让 2 m）
    let slide = null;
    if (!cands.some(c => c.pass)) {
      const sug = C.suggestDoorAt({ wall: wall, room: o.room, at: at, w: need, h: h,
                                    equipments: equipments, self: o.self });
      if (sug && sug.check && sug.check.pass && Math.abs(sug.at - at) <= 2.0) {
        slide = { mode: 'slide', at: +sug.at.toFixed(3), w: need, h: h,
                  chk: sug.check, pass: true, why: '顺墙让 ' + Math.abs(sug.at - at).toFixed(2) + ' 米',
                  shift: +(sug.at - at).toFixed(3) };
        cands.push(slide);
      }
    }

    // 还是不行：找出"最多能拓到多宽"，好把话说清楚（差多少、差在哪）
    let reach = null;
    if (!cands.some(c => c.pass) && D > 1e-6) {
      for (let i = 1; i <= 40; i++) {
        const w2 = +(need - i * 0.05).toFixed(2);
        if (w2 <= w + 1e-6) break;
        const d2 = +(w2 - w).toFixed(3);
        const tries = [[at, 'sym'], [at - d2 / 2, 'left'], [at + d2 / 2, 'right']];
        let hit = null;
        for (const [at2, mode] of tries) {
          const chk = C.door({ wall: wall, at: at2, w: w2, h: h, room: o.room,
                               equipments: equipments, self: o.self });
          if (chk.pass) {
            hit = { mode: mode, at: +at2.toFixed(3), w: w2, h: h, chk: chk, pass: true, why: '' };
            break;
          }
        }
        if (hit) { reach = hit; cands.push(hit); break; }
      }
    }

    const best = cands.find(c => c.pass) || null;
    return { side: side, need: need, D: D, cands: cands, best: best, reach: reach,
             blocked: best ? null : (cands[0] ? cands[0].chk.blocks : []) };
  };

  // 两线段交点参数（返回 0~1 比例）
  function segCross(a, b, p1, p2) {
    const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
    const x3 = p1[0], y3 = p1[1], x4 = p2[0], y4 = p2[1];
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
    if (t >= -0.02 && t <= 1.02 && u >= 0 && u <= 1) return t;
    return null;
  }

  /* ---------------- 计算书 ---------------- */
  C.book = function (r) {
    const room = r.room, eq = r.equip;
    const rows = [
      ['房间', room.name + '（' + room.use + '）'],
      ['平面尺寸', r.lx.toFixed(2) + ' × ' + r.ly.toFixed(2) + ' m'],
      ['板厚 / 混凝土', (room.slab.thk * 1000) + ' mm / ' + room.slab.grade],
      ['配筋', 'φ' + room.slab.dia + '@' + room.slab.sp + ' (As=' + room.slab.asx + ' mm2/m)'],
      ['板跨类型', r.oneWay ? '单向板' : '双向板'],
      ['永久荷载 g', r.dead.toFixed(2) + ' kN/m²'],
      ['楼面活荷载标准值 q', room.live.toFixed(1) + ' kN/m²']
    ];
    const rows2 = [
      ['设备', eq.name],
      ['自重', (eq.weight / 1000).toFixed(2) + ' t（' + r.P.toFixed(1) + ' kN）'],
      ['设备尺寸', eq.w.toFixed(2) + ' × ' + eq.d.toFixed(2) + ' m'],
      ['垫层扩散', r.pad ? '有垫板（0.32 m）' : '无垫板（0.05 m）'],
      ['扩散后受压面积', r.A.toFixed(2) + ' m²（' + r.ae.toFixed(2) + '×' + r.be.toFixed(2) + '）'],
      ['接触压力', r.qDirect.toFixed(2) + ' kN/m²'],
      ['位置系数 k', r.kPos.toFixed(2) + '（跨中 1.00，越靠梁越小）'],
      ['有效分布宽度', r.bEff.toFixed(2) + ' m']
    ];
    if (r.others.length) {
      rows2.push(['同房间已有设备', r.others.map(o => o.eq.name + ' ' + (o.P * 1000 / G / 1000).toFixed(2) + ' t').join('、')]);
      rows2.push(['板上合计重量', (r.PTotal * 1000 / G / 1000).toFixed(2) + ' t（' + r.PTotal.toFixed(1) + ' kN）']);
      rows2.push(['其中已有设备分担', r.MeqOthers.toFixed(2) + ' kN*m/m（等效弯矩）']);
    }
    const rows3 = [
      ['板自重弯矩 M_g', r.Mdead.toFixed(2) + ' kN*m/m'],
      ['设备弯矩 M_q', r.Meq.toFixed(2) + ' kN*m/m' + (r.others.length ? '（含已有设备 ' + r.MeqSum.toFixed(2) + '）' : '')],
      ['截面抗力 M_u', r.Mu.toFixed(2) + ' kN*m/m'],
      ['承载力安全系数', fmt(r.Kstruct)],
      ['等效均布荷载 q_e', r.qEq.toFixed(2) + ' kN/m²' + (r.others.length ? '（叠加后）' : '')],
      ['满布平均荷载 q_avg', r.qAvg.toFixed(2) + ' kN/m²'],
      ['荷载安全系数', fmt(r.Kload) + (r.others.length ? ' / 均布 ' + fmt(r.Kavg) : '')],
      ['附加挠度', r.def.toFixed(2) + ' mm（限值 ' + r.defLimit.toFixed(1) + ' mm）'],
      ['抗冲切比 V/V_R', r.punch.toFixed(3)]
    ];
    const line = (arr) => '<table>' + arr.map(x => '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td></tr>').join('') + '</table>';
    const alts = r.alt.length ? '<ul>' + r.alt.map(a => '<li>' + a.name + '：安全系数可提升到 <b>' + fmt(a.k) + '</b>（' + a.tip + '）</li>').join('') + '</ul>' : '';
    return '' +
      '<h3>一、计算对象</h3>' + line(rows) +
      '<h3>二、荷载取值</h3>' + line(rows2) +
      '<div class="f">q_e = 8 * M_q / L^2          M_q = k * P * L / (4 * b_eff)</div>' +
      '<h3>三、承载力与变形校核</h3>' + line(rows3) +
      '<div class="f">M_u = fy * As * (h0 - x/2)     x = fy * As / (fc * b)</div>' +
      '<h3>四、结论</h3>' +
      '<div class="concl">最不利安全系数 <b>' + fmt(r.K) + '</b>，判定：<b>' + r.v.tag + '（' + r.v.word + '）</b>。<br>' +
      '按 1.3 倍余量，这块板建议最多承载约 <b>' + (r.Pmax_kg / 1000).toFixed(2) + ' t</b> 的设备，本次设备 ' +
      (eq.weight / 1000).toFixed(2) + ' t。</div>' +
      (alts ? '<h3>五、改善措施</h3>' + alts : '') +
      '<div style="margin-top:12px;color:#93a0ad;font-size:10px;line-height:1.6">' +
      '计算依据：GB 50009-2012 附录 C、GB 50010-2010 第 6.2 节、GB 50068-2018（安全等级二级）、GB 50292-2015。' +
      '本计算为单板运维阶段快速校核，不替代整体结构分析与正式鉴定。</div>';
  };
})();
