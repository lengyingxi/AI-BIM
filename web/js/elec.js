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

  /* 分路配色：和界面图例、三维线管用同一套，不要各写各的。
     每类拆成 1/2 两条回路，第二条用同色系深一档 ——
     走廊里六根管子并排跑，同色的话根本分不出哪根是哪根。 */
  E.COLOR = {
    light: 0xf0b429,     // 照明1：琥珀
    light2: 0xd08b0e,    // 照明2：深琥珀
    socket: 0x3b9ae1,    // 插座1：蓝
    socket2: 0x2168ab,   // 插座2：深蓝
    power: 0xd8544f,     // 动力1：红
    power2: 0xa03229,    // 动力2：深红
    reroute: 0x17a673,   // 改线后的走向：绿
    hit: 0xff3b30,       // 冲突：亮红
    off: 0x8a929b        // 分路断开：灰
  };
  /* 大类别名。三类别名照旧（照明/插座/动力），要带序号的用 circ.kind_cn */
  E.KIND_CN = { light: '照明', socket: '插座', power: '动力', riser: '楼层进线' };
  /* 电工嘴里说的"空开 / 电闸 / 空气开关"指的都是这排分路开关本身 */
  E.CIRCUIT_ALIAS = ['空开', '空气开关', '电闸', '闸刀', '断路', '开关'];
  E.colorOf = function (circ) {
    if (!circ) return E.COLOR.off;
    const k = circ.kind, sub = circ.sub === 2 ? 2 : 1;
    return E.COLOR[sub === 2 ? k + '2' : k] || E.COLOR[k] || E.COLOR.off;
  };

  /* 线管截面（米）：外径/槽宽 + 墙内埋深。数字按常见做法取：
     照明 BV2.5 穿 PC20、插座 BV4 穿 PC25、动力 YJV 走 40×25 线槽 */
  const SEC = {
    light: { s: 0.030, d: 0.13 },     // s=竖向占位（含保护层），d=墙内埋深（从墙面往里）
    socket: { s: 0.037, d: 0.15 },
    power: { s: 0.050, d: 0.18 }
  };
  E.SEC = SEC;

  /* 走廊干线的截面比支线粗一档：干线是"一根管子喂一层"，支线只是末端 */
  const MAIN_SEC = {
    light: { s: 0.041, d: 0.14 },
    socket: { s: 0.049, d: 0.16 },
    power: { s: 0.064, d: 0.19 }
  };
  E.MAIN_SEC = MAIN_SEC;

  /* 走廊干线（桥架）标高：三条分路分层敷设，都走在吊顶里。
     这几个数都高于常用门洞（2.1~2.4 m）和窗顶（2.4 m），
     所以干线本身不会跟开门开窗打架 —— 会打架的永远是房间里的支线。
     这也符合现场：桥架在吊顶上，凿墙开门根本碰不到它。 */
  const MAIN_Z = { light: 3.00, socket: 2.80, power: 2.60 };
  E.MAIN_Z = MAIN_Z;

  /* 房间支线标高（相对楼板面）。这三个数字是冲突行为的来源，别随手改：
       插座 0.32 —— 贴地走，新开门洞（sill=0）撞的就是它，最真实的一种冲突
       动力 2.35 —— 房间内沿墙的动力线槽，门洞 2.1~2.6 有时擦到，2.4 顶的高窗也会撞
       照明 2.90 —— 吊顶里，普通窗（窗台 0.9 + 高 1.5，顶 2.4）够不着，
                   只有做到顶的高窗、落地窗才会碰上 */
  const BRANCH_Z = { light: 2.90, socket: 0.32, power: 2.35 };
  E.BRANCH_Z = BRANCH_Z;

  /* 同类两条回路必须错开标高，否则六根管子在墙里/桥架里叠在一起，看着是一根。
     第二条（照明2/插座2/动力2）统一比第一条再高 0.10 m 走干线、低 0.10 m 走支线 ——
     干线在上、支线在下，两条之间始终留着间距，图上能一根根数出来。 */
  const SUB_DZ = 0.10;
  E.zMain = (kind, sub) => (MAIN_Z[kind] || 2.9) + (sub === 2 ? SUB_DZ : 0);
  E.zBranch = (kind, sub) => (BRANCH_Z[kind] || 2.9) - (sub === 2 ? SUB_DZ : 0);

  /* 管线在拓扑里属于哪一层。原来所有线管一视同仁，看不出"主干—干线—支线"，
     加了这个字段，图例、统计、"这条管归谁"都能说清楚。 */
  E.LAYER_CN = {
    trunk: '主干立管', feed: '层进线', out: '箱到桥架', corridor: '走廊干线',
    drop: '墙内下引', room: '房间支线'
  };

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

  /* 把墙上的可用区间按已有洞口切成子段，每段两头各留 GUARD。

     ★ 第二个参数 z / s 很关键：只在"高度上真能碰上"的洞口处断开。
       不给 z 就是老行为（任何洞口都断）——干线在吊顶里、门洞只有 2.1 m 高，
       按老行为会被每个门洞切断，看上去就是一截一截的，这正是之前
       "红色管线不连续"的根源之一。 */
  function splitByOpenings(wall, a, b, z, s) {
    const L = axis(wall).L;
    let lo = Math.max(0, a), hi = Math.min(L, b);
    if (hi - lo < 1e-6) return [];
    const z0 = z == null ? null : z - (s || 0) / 2 - 0.02;
    const z1 = z == null ? null : z + (s || 0) / 2 + 0.02;
    const ops = (wall.openings || []).slice()
      .filter(o => {
        if (z0 == null) return true;
        const sill = o.sill || 0;
        return !(sill + (o.h || 2.1) <= z0 || sill >= z1);   // 高度不重叠 → 不算挡路
      })
      .sort((p, q) => p.at - q.at);
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

  /* 扫一面墙：把可用区间切成"保留段"和"缺口段"。
     缺口段要拿来做绕行——真实施工碰上门窗洞不会把线剪断，
     而是上翻（或下翻）绕过去再落回来。原来只切不断，所以线看着一截一截的。

     返回 { segs: [[at0,at1]...], gaps: [{at0,at1,top,sill}] }
       top  = 洞口顶标高（绕行要爬到它上面）
       sill = 洞口底标高（下翻时用） */
  function scanWall(wall, a, b, z, s) {
    const L = axis(wall).L;
    let lo = Math.max(0, a), hi = Math.min(L, b);
    if (hi - lo < 1e-6) return { segs: [], gaps: [] };
    const zc = z - (s || 0) / 2 - 0.02, zH = z + (s || 0) / 2 + 0.02;
    const ops = (wall.openings || []).slice()
      .filter(o => {
        const sill = o.sill || 0;
        return !(sill + (o.h || 2.1) <= zc || sill >= zH);   // 高度不重叠 → 不算挡路
      })
      .sort((p, q) => p.at - q.at);
    const segs = [], gaps = [];
    let cur = lo;
    for (const o of ops) {
      const o0 = o.at - o.w / 2 - GUARD, o1 = o.at + o.w / 2 + GUARD;
      if (o1 <= cur) continue;
      if (o0 > cur) {
        segs.push([cur, Math.min(o0, hi)]);
        /* 只有整段洞口都在本次铺管范围内、而且**两头都还有管子**，才做绕行。
           洞口正好开在墙段起点（或终点）时，那一头本来就没有管子，
           绕过去也没东西可接，硬画就是一根悬空的短管。 */
        if (o0 >= lo && o1 <= hi && o0 > lo + 0.06 && o1 < hi - 0.06) {
          gaps.push({ at0: o0, at1: o1, top: (o.sill || 0) + (o.h || 2.1), sill: o.sill || 0 });
        }
      }
      cur = Math.max(cur, o1);
      if (cur >= hi) break;
    }
    if (cur < hi) segs.push([cur, hi]);
    /* 碎段门槛跟 runWall 保持一致（0.06 m）。定 0.3 时，墙角到第一个洞口之间
       经常只剩十几厘米，一砍掉，下引管和洞口绕行段的底端就都悬空了。 */
    return { segs: segs.filter(x => x[1] - x[0] >= 0.06), gaps: gaps };
  }
  E.scanWall = scanWall;

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

  /* ---------------- 生成 ----------------
     拓扑（真实配电的四级，别拿"每间房顶上一根照明管"糊弄）：
       
       ① 主干立管 TRUNK —— 一条，在电气竖井里从 1F 楼板下直通顶层楼板上。
          各层取同一平面位置、首尾严格相接，所以看上去是一根通到底的管子。
       ② 层配电箱 PANEL + 层进线 FEED —— 每层一部箱子贴墙挂在电气间，
          从主干水平引一根进线到箱子顶部。
       ③ 走廊干线 CORRIDOR —— 从箱子出线，沿走廊两侧墙整段连续敷设（三条分路分层走桥架）。
          走廊是"每层配电的主动脉"，一层的电先在这里横向跑一圈。
       ④ 房间支线 ROOM —— 从走廊干线在墙里下引，进房间后沿四周墙整段连续敷设。
          照明 / 插座 / 动力各一根；动力只进机房类房间。

     为什么这么改（原来那版的毛病）：
       · 原来逐墙逐房间铺，且每段只铺一部分（照明整段、插座 62%、动力中段 50%），
         结果红色动力管一段一段的，看着像断线。现在**干线支线都整段连续**。
       · 原来洞口切段不判标高，门洞（2.1 m）会把吊顶里的干线（2.8~3.0 m）也切断。
         现在 splitByOpenings 带标高，够不着的洞口不断管。
       · 原来每层配电箱各找各的墙，立管跟着箱子走，上下不在一条线上，
         上一层和下一层的竖管错开，看着就"不连贯"。现在立管位置全楼统一。
  */
  /* 模型换过（导入 IFC）之后必须重建：几何全变了，旧线管一根都不能留 */
  E.build = function () {
    const m = M();
    const D = { panels: [], circuits: [], conduits: [], risers: [], joints: [], reroutes: {}, state: {}, trunk: null };
    if (!m || !m.walls) { E.data = D; return D; }

    /* ★ 旧数据里的改线记录先搬过来 —— 铺管时 detourAt 要看它来决定"绕到多高"。
       以前是铺完才搬，于是几何按老规矩拍一个标高（2.27），
       规划却按"避开别的管"给另一个标高（2.47），画面上两条线各走各的。 */
    if (E.data && E.data.reroutes) {
      Object.keys(E.data.reroutes).forEach(k => { D.reroutes[k] = E.data.reroutes[k]; });
    }

    const allRooms = m.rooms || [], allWalls = m.walls || [];
    const floors = (m.floors || []).slice().sort((a, b) => a.level - b.level);
    const byId = {};
    const seen = {};                 // 去重：同一面墙同一区间不重复铺同一根管
    const addC = c => { D.circuits.push(c); byId[c.id] = c; return c; };
    const liveCircs = [];            // 本层三条分路，铺管时要用

    /* ---- ① 电气竖井：每层各挑一间 ---- */
    const shaftOf = {};
    floors.forEach(fl => {
      const rooms = allRooms.filter(r => r.floor === fl.level);
      if (!rooms.length) return;
      shaftOf[fl.level] = rooms.find(r => /电气|配电|强电|变电|竖井/.test((r.use || '') + (r.name || '')))
        || rooms.find(r => isPowerRoom(r))
        || rooms.find(r => r.zone === 'core')
        || rooms[0];
    });
    const shafts = floors.map(f => shaftOf[f.level]).filter(Boolean);

    /* 主干立管的平面位置：取各层竖井平面区域的**公共部分**再往里收 0.45 m。
       收得进去就说明各层竖井是一摞，立管就能真正竖直；收不进去（各层电气间
       错得很开）就退回平均位置 —— 宁可立管穿过一点点房间，也不要它上下错位断掉。 */
    let tx = 0, ty = 0;
    if (shafts.length) {
      const ix0 = Math.max.apply(null, shafts.map(s => s.x0));
      const iy0 = Math.max.apply(null, shafts.map(s => s.y0));
      const ix1 = Math.min.apply(null, shafts.map(s => s.x1));
      const iy1 = Math.min.apply(null, shafts.map(s => s.y1));
      if (ix1 - ix0 > 1.0 && iy1 - iy0 > 1.0) { tx = ix0 + 0.45; ty = iy0 + 0.45; }
      else {
        tx = shafts.reduce((a, s) => a + (s.x0 + s.x1) / 2, 0) / shafts.length;
        ty = shafts.reduce((a, s) => a + (s.y0 + s.y1) / 2, 0) / shafts.length;
      }
    }
    D.trunk = { x: tx, y: ty, s: 0.16, d: 0.16 };

    /* ---- 通用铺管：沿一面墙铺一段**连续**线管 ----
       这是全文件唯一拼 at 区间的地方。以前每处自己算 cover/中点，才会一段一段。
       遇到门窗洞会切成两段，再在洞口两端各补一段"绕行"把两段接起来——
       所以不管中间隔了多少洞口，这条管在墙里是通的。 */
    function runWall(wall, a, b, kind, circ, z, sec, layer, room) {
      if (!wall || !circ) return;
      if (z + sec.s / 2 > (wall.h || 3) - 0.03) return;      // 墙比这还矮就别铺了
      const sc = scanWall(wall, a, b, z, sec.s);
      sc.segs.forEach(([s0, s1]) => {
        /* 太短的碎段不铺。但门槛不能定太高：墙角到下引点的这一小截常常只有
           0.15~0.2 m，砍掉它，下引管下端和洞口绕行段的底端就都没东西可接，
           图上会冒出两根吊在半空的短管。0.10 m 只用来滤真正的噪声。 */
        if (s1 - s0 < 0.06) return;
        const tag = layer === 'corridor' ? 'C' : 'R';
        /* id 里必须带回路号：分成六路以后，同一面墙同一种线管会同时出现两条
           （照明1/照明2、插座1/插座2、动力1/动力2），只按"墙+种类+区段"做键的话，
           后一条会被当成重复直接丢掉 —— 表现就是 2 号那三条回路在走廊里根本没有干线，
           墙内的下引管从桥架那头顶不到任何东西，光点也就跑不过去。 */
        const id = 'CD-' + wall.id + '-' + circ.id + '-' + kind + '-' + tag + '-' +
          Math.round(s0 * 100) + '-' + Math.round(s1 * 100);
        if (seen[id]) {
          /* 同一面墙、同一条回路、同一段：两间房共用这面墙的两侧，物理上就是同一根管。
             不重复画（两根完全重合的盒子只会互相 z-fighting），但要把这间房
             记进这根管和这条回路 —— 否则这间房的插座/照明在拓扑里是断的。 */
          const ex = D.conduits.find(c => c.id === id);
          if (ex && room) {
            ex.rooms = ex.rooms || (ex.room ? [ex.room] : []);
            if (ex.rooms.indexOf(room.id) < 0) ex.rooms.push(room.id);
            if (circ.rooms.indexOf(room.id) < 0) circ.rooms.push(room.id);
          }
          return;
        }
        seen[id] = 1;
        const c = {
          id: id, floor: wall.floor, wall: wall.id, kind: kind, circuit: circ.id,
          layer: layer, at0: s0, at1: s1, z: z, s: sec.s, d: sec.d,
          room: room ? room.id : null, roomNum: room ? room.num : null, added: false
        };
        D.conduits.push(c);
        circ.conduits.push(id);
        if (room && circ.rooms.indexOf(room.id) < 0) circ.rooms.push(room.id);
      });
      /* 缺口处绕过去：三段折线（竖-横-竖），落在洞口上方或下方。
         绕行段标 detour=true（查询和统计要靠它区分"这是绕过洞口的一小段"），
         颜色仍用本回路色 —— 它本来就是这根管子的一部分，不是"规划中的改线"；
         真正的改线方案（开洞前给的备选走向）才用绿色。 */
      sc.gaps.forEach(g => detourAt(wall, g, z, sec, circ, layer, room));
    }

    /* 洞口绕行：上翻或下翻跨过洞口，再落回原标高。
       哪边翻得过去走哪边；两边都不行（洞做到顶又贴地）就留缺口，不硬绕。 */
    function detourAt(wall, g, z, sec, circ, layer, room) {
      if (!circ) return;
      const half = (sec.s || 0) / 2;
      const hMax = (wall.h || 3) - 0.10;
      let zr = null;

      /* ★ 先看"规划"怎么说的：开门/开窗时已经算过一个真正避开别的线管的标高，
         并且记在 D.reroutes 里。几何必须照着它画，否则规划一条线、实际一条线，
         用户看到的就是"绿色改道叠在别的管子上、管子还是照老路走"。
         记录按"同墙 + 同回路 + 洞口对得上"找（重建后线管会换 id，不能按 id 找）。 */
      const rec = Object.keys(D.reroutes || {}).map(k => D.reroutes[k]).find(r =>
        r && !r.off && r.wall === wall.id && r.circuit === circ.id && r.hole && r.z != null &&
        r.hole.at0 <= g.at0 + 0.25 && r.hole.at1 >= g.at1 - 0.25);
      if (rec) zr = rec.z;

      if (zr == null) {
        /* 没规划过（比如这扇门是模型里本来就有的）：按老规矩取洞口上/下最近的空位，
           但要避开**同一面墙上已经铺好的**别的线管，别把绕行段怼到人家身上。 */
        const a0 = axis(wall);
        const bands = [];
        D.conduits.forEach(o => {
          if (!o || o.circuit === circ.id || o.wall !== wall.id) return;
          const sp = spanOnWall(wall, o, a0);
          if (!sp) return;
          if (sp.a1 <= g.at0 - 0.20 || sp.a0 >= g.at1 + 0.20) return;
          bands.push([sp.s0 - 0.03, sp.s1 + 0.03]);
        });
        const clear2 = z2 => !bands.some(b => z2 + half + 0.03 > b[0] && z2 - half - 0.03 < b[1]);
        const up0 = g.top + 0.12 + half + 0.03;
        let zp = up0;
        while (zp <= hMax && !clear2(zp)) zp += 0.04;
        if (zp <= hMax) zr = zp;
        else {
          let zd = g.sill - 0.12 - half - 0.03;
          while (zd >= 0.08 && !clear2(zd)) zd -= 0.04;
          if (zd >= 0.08) zr = zd;
        }
      }
      if (zr == null) return;                       // 上下都翻不过去，只能留缺口
      if (Math.abs(zr - z) < 0.02) return;          // 洞口本身就比管高，不用绕
      const a = axis(wall);
      const tag = layer === 'corridor' ? 'C' : 'R';
      const base = 'DT-' + wall.id + '-' + circ.id + '-' + circ.kind + '-' + tag + '-' +
        Math.round(g.at0 * 100) + '-' + Math.round(g.at1 * 100);
      const lay = () => ({
        floor: wall.floor, wall: wall.id, kind: circ.kind, circuit: circ.id,
        layer: layer, detour: true, s: sec.s, d: sec.d,
        room: room ? room.id : null, roomNum: room ? room.num : null, added: false
      });
      const push = (id, obj) => {
        if (seen[id]) return;
        seen[id] = 1;
        obj.id = id;
        D.conduits.push(obj);
        circ.conduits.push(id);
        if (room && circ.rooms.indexOf(room.id) < 0) circ.rooms.push(room.id);
      };
      /* 横段：跨过洞口 */
      push(base + '-h', Object.assign(lay(), { at0: g.at0, at1: g.at1, z: zr }));
      /* 两端竖段：把原标高和绕行标高接起来 */
      [g.at0, g.at1].forEach((at, i) => {
        const x = a.ax + a.ux * at, y = a.ay + a.uy * at;
        push(base + '-v' + i, Object.assign(lay(), {
          vert: true, x: x, y: y, at0: at, at1: at,
          z0: Math.min(z, zr), z1: Math.max(z, zr), z: (z + zr) / 2
        }));
      });
    }

    /* 墙内竖直段：把不同标高的两根管接起来（走廊桥架 → 房间支线就是靠它"分下去"） */
    function dropDown(wall, x, y, L, zLow, zHigh, sec, circ, room) {
      if (!circ) return;
      const id = 'VD-' + wall.id + '-' + Math.round(x * 100) + '-' + Math.round(y * 100) + '-' + circ.id;
      if (seen[id]) return;
      seen[id] = 1;
      const c = {
        id: id, floor: L, wall: wall.id, kind: circ.kind, circuit: circ.id,
        layer: 'drop', vert: true, x: x, y: y, z0: zLow, z1: zHigh,
        at0: 0, at1: 0, z: (zLow + zHigh) / 2, s: sec.s, d: sec.d,
        room: room ? room.id : null, roomNum: room ? room.num : null, added: false
      };
      D.conduits.push(c);
      circ.conduits.push(id);
      if (room && circ.rooms.indexOf(room.id) < 0) circ.rooms.push(room.id);
    }

    /* ---- ② 每层：配电箱 + 三条分路 + 走廊干线 + 房间支线 ---- */
    floors.forEach(fl => {
      const L = fl.level;
      const shaft = shaftOf[L];
      if (!shaft) return;
      const wAll = allWalls.filter(w => w.floor === L);

      const pid = 'AL-' + L;
      /* 分路编号：用户嘴里说的是"2 楼第一回路"，不是"L2A 照明回路"；
         电工平时直接叫"空开 / 电闸 / 空气开关"，说的都是箱子里这排开关。
         每层**六路**：照明 1/2、插座 1/2、动力 1/2，编号在本层内从 1 到 6。
         为什么要拆成两条：一层十几间房全压在一路照明上不合规范，
         实际也是一层分好几个照明回路、几个插座回路，按区域分开带。
         sub 是同类里的第几条，kind_cn 是给人看的全名（照明1），
         short 给气泡按钮用，label/name 给回复和卡片用。 */
      let seq = 0;
      const mkCirc = (suffix, kind, sub, cn, rated) => {
        seq++;
        const no = seq;
        return addC({
          id: 'L' + L + suffix, panel: pid, floor: L,
          kind: kind, sub: sub, no: no, kind_cn: cn, short: cn,
          label: L + 'F 第' + no + '回路',
          name: L + 'F 第' + no + '回路（' + cn + '）',
          color: E.COLOR[sub === 2 ? kind + '2' : kind] || E.COLOR[kind],
          rooms: [], conduits: [], rated: rated,
          /* 三相轮着接：1/4 接 L1，2/5 接 L2，3/6 接 L3，一层三相基本平衡 */
          phase: 'L' + ((no - 1) % 3 + 1),
          on: true
        });
      };
      const cA = mkCirc('A', 'light', 1, '照明1', 32);
      const cB = mkCirc('B', 'light', 2, '照明2', 32);
      const cC = mkCirc('C', 'socket', 1, '插座1', 32);
      const cD = mkCirc('D', 'socket', 2, '插座2', 32);
      const cE = mkCirc('E', 'power', 1, '动力1', 63);
      const cF = mkCirc('F', 'power', 2, '动力2', 63);
      const myCircs = [cA, cB, cC, cD, cE, cF];
      liveCircs.push({ L: L, list: myCircs });

      /* 一间房归哪一条：照明和插座按区域分（南侧走 X1、北侧走 X2，
         走廊和设备间是公共部分并到 1 号）—— 断一路影响的是连续一片。
         动力不能这么分：一层只有一间空调机房，按南北分会让动力2 白跑一条回路。
         实际做法是动力分两级——**动力1 供空调主机（机房），动力2 供各房间的空调末端**，
         这样两条都带得上房间，语义也对。 */
      const circOf = (room, kind) => {
        const second = room.zone === 'north';
        if (kind === 'light') return second ? cB : cA;
        if (kind === 'socket') return second ? cD : cC;
        return isPowerRoom(room) ? cE : cF;
      };
      const zM = (c) => E.zMain(c.kind, c.sub);
      const zB = (c) => E.zBranch(c.kind, c.sub);

      /* ---- 配电箱：贴电气间的一面墙上，箱子中心标高 1.5 m ----
         挑墙的顺序：内墙且不朝走廊 > 不朝走廊 > 随便。
         理由：箱子凸出墙面 0.09 m，挂在走廊墙上会侵占疏散净宽；
         挂外墙上冬天结露。实在没有内墙才退让。 */
      const cand = [];
      ['south', 'north', 'east', 'west'].forEach(k => {
        const w = wAll.find(x => x.id === (shaft.sides || {})[k]);
        if (!w) return;
        const sp = roomSpans(w).find(s => s.room.id === shaft.id);
        if (!sp) return;
        if (sp.hi - sp.lo < 1.05) return;                      // 墙太短，0.95 m 的箱子挂不住
        const onWall = (w.rooms || []).map(id => allRooms.find(r => r.id === id)).filter(Boolean);
        cand.push({ w: w, at: (sp.lo + sp.hi) / 2, corr: onWall.some(r => r.zone === 'corr') });
      });
      const pick = cand.filter(x => !x.corr && x.w.kind !== 'ext')[0]
        || cand.filter(x => !x.corr)[0]
        || cand[0] || null;

      const panel = {
        id: pid, floor: L, room: shaft.id, roomNum: shaft.num,
        name: L + 'F 配电箱 ' + pid, wall: pick ? pick.w.id : null, at: pick ? pick.at : 0,
        /* 六路分路比三路占地方，箱子加宽到 0.95 m，手柄才排得下一排 */
        z: 1.5, w: 0.95, h: 0.9, d: 0.18,
        /* 总开关（进线断路器）：一断，本层六条分路全部失电。
           分路断路器（circuits 里那六个）只管自己那一路。 */
        mainOn: true,
        circuits: [cA.id, cB.id, cC.id, cD.id, cE.id, cF.id]
      };
      if (pick) {
        const a = axis(pick.w);
        panel.x = a.ax + a.ux * pick.at;      // 墙中心线上的点
        panel.y = a.ay + a.uy * pick.at;
        panel.dir = [a.ux, a.uy];             // 沿墙方向
        /* 墙上法向：由"房间中心在哪一侧"定死，直接存进数据。
           以前是渲染时自己推，推反了箱子就朝墙里翻，看着像悬空/歪着。 */
        let nx = -a.uy, ny = a.ux;
        const cx = (shaft.x0 + shaft.x1) / 2 - panel.x;
        const cy = (shaft.y0 + shaft.y1) / 2 - panel.y;
        if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
        panel.n = [nx, ny];
        panel.t = pick.w.t;
      } else {
        panel.x = (shaft.x0 + shaft.x1) / 2; panel.y = shaft.y0 + 0.25;
        panel.dir = [1, 0]; panel.n = [0, 1]; panel.t = 0.2;
      }
      D.panels.push(panel);

      /* ---- ③ 走廊干线：沿走廊两侧墙整段连续，三条分路分层走桥架 ---- */
      const corrs = allRooms.filter(r => r.floor === L && r.zone === 'corr');
      const doneWall = {};
      corrs.forEach(cr => {
        Object.keys(cr.sides || {}).forEach(k => {
          const w = wAll.find(x => x.id === cr.sides[k]);
          if (!w || doneWall[w.id]) return;
          if (w.kind === 'ext') return;                        // 干线不挂建筑外皮
          const sp = roomSpans(w).find(s => s.room.id === cr.id);
          if (!sp) return;
          doneWall[w.id] = 1;
          /* 六条分路都在走廊桥架里横铺一圈，各自错开标高（3.00/3.10、2.80/2.90、2.60/2.70），
             不然同类两条叠在一起，图上看着还是一条。 */
          myCircs.forEach(c => {
            runWall(w, sp.lo + 0.08, sp.hi - 0.08, c.kind, c, zM(c), MAIN_SEC[c.kind], 'corridor', cr);
          });
        });
      });

      /* ---- ④ 房间支线：四周墙整段连续，靠"墙内下引"接走廊干线 ---- */
      allRooms.filter(r => r.floor === L && r.zone !== 'corr').forEach(room => {
        const pw = isPowerRoom(room);
        const sides = room.sides || {};
        /* ① 先把这间房四面墙看清楚：每面墙上属于本房的那一段、以及这面墙贴不贴走廊。
           以前是一边遍历一边铺，动力2 只能"遇到第一面非走廊墙就铺"，
           结果经常铺到下引点对面的那面墙上 —— 下引管在走廊墙角落地，
           支线在房间另一头，中间横跨整间房，两头都是悬空的断头管。 */
        const info = [];
        ['south', 'north', 'east', 'west'].forEach(k => {
          const wall = wAll.find(x => x.id === sides[k]);
          if (!wall) return;
          const spans = roomSpans(wall);
          const sp = spans.find(s => s.room.id === room.id);
          if (!sp) return;
          /* 这间房的这一段是不是贴着走廊。
             以前判的是"这面墙上有没有走廊房间"，长墙把走廊和房间串在一起时
             （比如西外墙同时挨着 101 和走廊 100），整面墙的插座全被跳过，
             墙角落里就断出一截。改成看**本房间那一段**跟走廊区段有没有重叠。 */
          const isCorr = spans.some(s => s.room.zone === 'corr'
            && s.hi > sp.lo + 0.05 && s.lo < sp.hi - 0.05);
          info.push({ k: k, wall: wall, sp: sp, isCorr: isCorr });
        });
        const ci = info.find(x => x.isCorr) || null;
        /* 去掉外墙以后，有的房间（比如 205）除了走廊墙就只剩外墙了 ——
           这时候插座支线没处铺，墙上那根下引管下面就是空的。
           这种房间把插座也铺到走廊墙上（和下引管同一个墙角，两头接得住）。 */
        const onlyCorrWall = !info.some(x => x.wall.kind !== 'ext' && !x.isCorr);
        /* 下引点：贴走廊那面墙靠房间墙角 6 cm 处 */
        let drop = null;
        if (ci) {
          const a0 = axis(ci.wall), atp = ci.sp.lo + 0.06;
          drop = { x: a0.ax + a0.ux * atp, y: a0.ay + a0.uy * atp, wall: ci.wall };
        }
        /* ② 铺管 */
        info.forEach(x => {
          const wall = x.wall, sp = x.sp;
          /* 建筑外皮（最外墙）不走管 —— 外墙是保温 + 防水构造，线管埋进去既不合做法，
             凿墙还会破防水；图上绕着一圈外立面跑管子也不像真的。
             用户明确要求："优化管线，去掉最外墙的管线"。
             只去掉分支（room 层）：走廊干线和竖井主干本来就不上外皮。 */
          if (wall.kind === 'ext') return;
          /* 铺到墙角（只留 2 cm 让位），不缩 15 cm —— 缩了以后相邻两面墙的管段
             在墙角差出半米，图上就是"四面墙各画一段、角上断开"。贴到角上，
             下面 ⑦ 的接头逻辑才能在墙角生成弯头，房间一圈才是通到底的。 */
          const a = sp.lo + 0.02, b = sp.hi - 0.02;
          if (b - a >= 0.4) {
            /* 照明走吊顶，哪面墙都得穿，满铺。这间房归哪条照明回路由区域定，
               不是六条都铺 —— 一间房一条照明回路，这才符合"分回路带"的实际做法。 */
            const cl = circOf(room, 'light');
            runWall(wall, a, b, 'light', cl, zB(cl), SEC.light, 'room', room);
            /* 插座和动力不布在走廊那面墙上 —— 真实做法也是这么干的：
               走廊侧全是门，插座开关在房间内侧墙上，设备更不会靠门摆。
               顺带一个好处：在走廊墙上开门不用每次都撞到贴地线管，
               而隔墙、外墙开门照样会撞，两种结果用户都能看到。 */
            if (!x.isCorr) {
              const cs = circOf(room, 'socket');
              runWall(wall, a, b, 'socket', cs, zB(cs), SEC.socket, 'room', room);
              /* 动力1（空调主机、机房）：房间非走廊墙满铺 */
              if (pw) {
                const cp = circOf(room, 'power');
                runWall(wall, a, b, 'power', cp, zB(cp), SEC.power, 'room', room);
              }
            } else if (!pw && ci && wall.id === ci.wall.id) {
              /* 动力2（各房间空调末端）：铺在**下引管所在的那面走廊墙**上。
                 为什么不进房间：这一路走吊顶（2.25~2.35 m，在门顶之上），末端在
                 吊顶里接线，不落地；铺在走廊墙上正好和下引管同一个墙角，两头接得住，
                 也不会往房间那三面墙里再塞一根管 —— 那三面墙本来就要开门开窗，
                 管子一多，改门改窗就动不动"撞管线"被拦下来。 */
              const cp = circOf(room, 'power');
              runWall(wall, a, b, 'power', cp, zB(cp), SEC.power, 'room', room);
              /* 除了走廊墙只剩外墙的房间：插座也只能铺这儿了 */
              if (onlyCorrWall) {
                const cs = circOf(room, 'socket');
                runWall(wall, a, b, 'socket', cs, zB(cs), SEC.socket, 'room', room);
              }
            } else if (onlyCorrWall && ci && wall.id === ci.wall.id) {
              /* 机房这种不走上面那条分支（pw=true），但同样可能只剩走廊墙 */
              const cs = circOf(room, 'socket');
              runWall(wall, a, b, 'socket', cs, zB(cs), SEC.socket, 'room', room);
            }
          }
        });

        /* 从走廊干线引下来：在走廊墙靠房间墙角处立一根短管，
           把 2.80 m 的桥架接到 0.32 m 的插座支线 —— 这就是"分到房间"的那一下。
           为什么贴着墙角下：插座支线不铺走廊那面墙，只铺另外三面，
           它的端头正好停在房间墙角。下引管如果立在墙中间（原来退 0.45 m），
           管子到 0.32 m 就悬在半空，下面没有管可接 —— 图上就是一根断头管。
           贴到墙角，下引管的底端和支线端头重合，接头逻辑就把它接上了。
           照明支线 2.90 和干线 3.00 本来就挨着，不用单独下引。 */
        if (drop) {
          const cs = circOf(room, 'socket'), cp = circOf(room, 'power');
          dropDown(drop.wall, drop.x, drop.y, L, zB(cs), zM(cs), SEC.socket, cs, room);
          /* 每间房都要把动力引下来（机房是主机、别的是末端），
             不引的话动力2 在房里那一段就是根悬空的断头管 */
          dropDown(drop.wall, drop.x, drop.y, L, zB(cp), zM(cp), SEC.power, cp, room);
        }
      });

      /* ---- ④b 下引管落点对齐 ----
         下引管理论上落在"房间墙角的支线端头"上，但那个墙角往往正好卡着门/窗洞口，
         墙角到洞口之间的那一小截会被当成碎段去掉，或者端头差了几厘米 ——
         结果就是一根从桥架垂下来、底下没接任何东西的短管。
         这里统一兜一次底：把每根下引管的平面位置挪到**同回路、同标高、最近的那个
         支线端头**上（最多挪 0.6 m，通常只有几厘米），保证下端一定接得住。
         上端还在原来那面走廊墙上、也没挪出干线覆盖范围，所以不影响"从干线引下来"。 */
      {
        const roomEnds = D.conduits.filter(c => c.floor === L && c.layer === 'room' && !c.vert);
        const kill = [];
        D.conduits.filter(c => c.floor === L && c.layer === 'drop').forEach(d => {
          const zLow = Math.min(d.z0, d.z1);
          let best = null, bd = 1.2;
          roomEnds.forEach(x => {
            if (x.circuit !== d.circuit) return;
            if (Math.abs(x.z - zLow) > 0.03) return;
            const w = wAll.find(q => q.id === x.wall);
            if (!w) return;
            const a = axis(w);
            [x.at0, x.at1].forEach(at => {
              const px = a.ax + a.ux * at, py = a.ay + a.uy * at;
              const dd = Math.hypot(px - d.x, py - d.y);
              if (dd < bd) { bd = dd; best = { x: px, y: py }; }
            });
          });
          /* 找不到任何可接的支线端头（比如那面墙后来被拆了、支线跟着没了）：
             这根下引管就是纯粹的悬空短管，直接不画。 */
          if (best) { d.x = best.x; d.y = best.y; } else kill.push(d);
        });
        kill.forEach(d => {
          const i = D.conduits.indexOf(d);
          if (i >= 0) D.conduits.splice(i, 1);
          const circ = (D.circuits || []).find(c => c.id === d.circuit);
          if (circ && circ.conduits) {
            const j = circ.conduits.indexOf(d.id);
            if (j >= 0) circ.conduits.splice(j, 1);
          }
        });
      }
    });

    /* ---- ⑤ 主干立管：一条，从 1F 楼板下直通顶层楼板上 ----
       每层一段，z0/z1 严格按该层层高接起来：上一段的顶 = 下一段的底，
       所以视觉上是一根通管，而不是五个断开的短柱。
       归到各层动力分路（进线总开关）名下，这样"断某层动力"能看出是哪一段。 */
    if (shafts.length) {
      floors.forEach((fl, i) => {
        const L = fl.level;
        const circ = byId['L' + L + 'E'] || byId['L' + L + 'C'] || byId['L' + L + 'A'];
        if (!circ) return;
        const next = floors[i + 1];
        const thk = fl.height || 4.2;
        const id = 'TR-' + L;
        const rs = {
          id: id, floor: L, from: L, to: next ? next.level : L,
          x: tx, y: ty, z0: 0, z1: thk, circuit: circ.id, kind: 'riser',
          layer: 'trunk', vert: true, s: 0.16, d: 0.16,
          wall: null, at0: 0, at1: 0, z: thk / 2
        };
        D.risers.push(rs);
        D.conduits.push(rs);          // 也放进 conduits：高亮、统计、查询一条路走通
        circ.conduits.push(id);
      });
    }

    /* 明敷自由段：一段两端点。若这段为某个洞口改过线（记录里有 cuts），
       就按"原标高 → 抬到门头以上 → 跨过去 → 落回原标高"拆成五段。
       ★ 少了这一步，门头上那根层进线就成了"数据上已经改道、画面上还从门洞里穿过去"，
         用户看到的就是"连接管撞到门了却没有绕行的处理"。 */
    function freeRun(idBase, fl, circ, sec, A, B, room, roomNum, layer) {
      const rec = (D.reroutes || {})[idBase];
      const mk = (id, a, b) => ({
        id: id, floor: fl, wall: null, kind: circ ? circ.kind : 'power',
        circuit: circ ? circ.id : null, layer: layer || 'feed',
        free: true, p1: a, p2: b, z: (a[2] + b[2]) / 2,
        at0: 0, at1: 0, s: sec.s, d: sec.d,
        room: room || null, roomNum: roomNum || null, added: false
      });
      const emit = (id, a, b) => {
        if (seen[id]) return;
        seen[id] = 1;
        D.conduits.push(mk(id, a, b));
        if (circ) circ.conduits.push(id);
      };
      if (!(rec && rec.cuts && rec.cuts.length === 4)) { emit(idBase, A, B); return; }
      const q = rec.cuts;
      emit(idBase + '-s0', A, q[0]);          // 原标高走到洞口左侧
      emit(idBase + '-v0', q[0], q[1]);       // 竖着抬上去
      emit(idBase + '-h', q[1], q[2]);        // 跨过门头
      emit(idBase + '-v1', q[2], q[3]);       // 竖着落回来
      emit(idBase + '-s1', q[3], B);          // 接着走到原终点
    }

    /* ---- ⑥ 层进线：从主干水平引到本层配电箱顶部 ----
       这一段没有墙可依附，是房间里明敷的桥架/母线，所以用自由段（free）：
       只给两端点，渲染时按两点连线建盒子。 */
    D.panels.forEach(p => {
      const circ = byId['L' + p.floor + 'E'] || byId['L' + p.floor + 'C'] || byId['L' + p.floor + 'A'];
      if (!circ || !shafts.length) return;
      const nx = (p.n || [1, 0])[0], ny = (p.n || [1, 0])[1];
      const bx = p.x + nx * ((p.t || 0.2) / 2);      // 箱子贴墙那一面的中点
      const by = p.y + ny * ((p.t || 0.2) / 2);
      if (Math.hypot(bx - tx, by - ty) < 0.25) return;
      const zE = p.z + p.h / 2 + 0.10;              // 从箱子顶进线
      freeRun('FD-' + p.floor, p.floor, circ, { s: 0.12, d: 0.12 },
        [tx, ty, zE], [bx, by, zE], p.room, p.roomNum, 'feed');
      if (circ.rooms.indexOf(p.room) < 0) circ.rooms.push(p.room);
    });

    /* ---- ⑥b 箱到桥架：六路各自从配电箱接到自己那条走廊干线上 ----
       以前只有"层进线"那一路（动力1）真的有线：立管 → 层进线 → 箱子。
       其余五路（照明 1/2、插座 1/2、动力 2）的走廊干线两头全悬在墙端，
       图上就是红/蓝/黄横管"停在半空"，看不出电是从哪儿上去的 ——
       用户说的"到主管的路径缺乏连接"就是这个。
       现在把配电箱出线补上：
         箱顶 →（引上到本路桥架标高）→（水平搭到本路走廊干线，接成三通）。
       六路沿墙各错开 7 cm 排成一小束：既不会互相 z-fighting，也像真的出线束。 */
    D.panels.forEach(p => {
      const dir = p.dir || [1, 0], nrm = p.n || [1, 0];
      const bx = p.x + nrm[0] * ((p.t || 0.2) / 2 + 0.05);
      const by = p.y + nrm[1] * ((p.t || 0.2) / 2 + 0.05);
      const zTop = p.z + p.h / 2;
      const mine = (p.circuits || []).map(id => byId[id]).filter(Boolean);
      mine.forEach((c, k) => {
        const z = E.zMain(c.kind, c.sub);
        const off = (k - (mine.length - 1) / 2) * 0.07;
        const px = bx + dir[0] * off, py = by + dir[1] * off;
        /* ① 箱顶引上 */
        if (z > zTop + 0.03) {
          const id = 'PU-' + p.floor + '-' + c.id;
          D.conduits.push({
            id: id, floor: p.floor, wall: null, kind: c.kind, circuit: c.id,
            layer: 'out', vert: true, x: px, y: py, z0: zTop, z1: z,
            s: 0.05, d: 0.05, at0: 0, at1: 0, z: (zTop + z) / 2,
            room: p.room, roomNum: p.roomNum, added: false
          });
          c.conduits.push(id);
        }
        /* ② 水平搭到本路走廊干线：就近取它上面的一点，端点落在管身中段就是三通 */
        const mains = D.conduits.filter(q => q.circuit === c.id && q.layer === 'corridor' && q.wall);
        let best = null;
        mains.forEach(q => {
          const w = allWalls.find(x => x.id === q.wall);
          if (!w) return;
          const a = axis(w);
          const x0 = a.ax + a.ux * q.at0, y0 = a.ay + a.uy * q.at0;
          const x1 = a.ax + a.ux * q.at1, y1 = a.ay + a.uy * q.at1;
          const vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy;
          let t = L2 ? ((px - x0) * vx + (py - y0) * vy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const hx = x0 + vx * t, hy = y0 + vy * t;
          const d = Math.hypot(px - hx, py - hy);
          if (!best || d < best.d) best = { x: hx, y: hy, d: d };
        });
        if (!best || best.d < 0.06) return;               // 已经贴在干线上，不用再搭
        freeRun('PO-' + p.floor + '-' + c.id, p.floor, c, { s: 0.05, d: 0.05 },
          [px, py, z], [best.x, best.y, z], p.room, p.roomNum, 'out');
      });
    });

    /* ---- ⑦ 接头 / 弯头 ----
       真实线管不会"一根到这儿停住、下一根从那头开始"，中间一定有直通接头、
       弯头或者接线盒。原来只画管段，拐弯的地方就是两个方头硬怼在一起，
       看上去等于没接上 —— 用户说的"线段中间需要有弯头链接"就是这个。
       做法：把同一条分路的所有管段端点按位置聚类，
         · 两个以上端点重合（±0.10 m） → 弯头 / 直通接头
         · 端点落在另一根管段中段      → 三通（走廊干线分进房间就是这种）
       一个簇只放一个接头盒子，比管截面大两成，看着就是个管件。 */
    const JTOL = 0.14;      // 端点算不算"接上了"的距离容差（墙角落差一般 < 0.1）
    function endsOf(c) {
      if (c.free && c.p1 && c.p2) {
        return [{ x: c.p1[0], y: c.p1[1], z: c.p1[2] },
                { x: c.p2[0], y: c.p2[1], z: c.p2[2] }];
      }
      if (c.vert) {
        return [{ x: c.x, y: c.y, z: c.z0 }, { x: c.x, y: c.y, z: c.z1 }];
      }
      const w = allWalls.find(q => q.id === c.wall);
      if (!w) return [];
      const a = axis(w);
      return [c.at0, c.at1].map(at => ({
        x: a.ax + a.ux * at, y: a.ay + a.uy * at, z: c.z
      }));
    }
    function boxOf(c, e) {
      const hs = (c.s || 0.05) / 2 + 0.02;
      return {
        x0: Math.min(e[0].x, e[1].x) - hs, x1: Math.max(e[0].x, e[1].x) + hs,
        y0: Math.min(e[0].y, e[1].y) - hs, y1: Math.max(e[0].y, e[1].y) + hs,
        z0: Math.min(e[0].z, e[1].z) - hs, z1: Math.max(e[0].z, e[1].z) + hs
      };
    }

    const jointPerCirc = {};
    D.conduits.forEach(c => (jointPerCirc[c.circuit] = jointPerCirc[c.circuit] || []).push(c));
    Object.keys(jointPerCirc).forEach(cid => {
      const list = jointPerCirc[cid], circ = byId[cid];
      if (!circ || list.length < 2) return;
      const ends = list.map(c => endsOf(c));
      const boxes = list.map((c, i) => (ends[i].length === 2 ? boxOf(c, ends[i]) : null));
      const pts = [];
      list.forEach((c, i) => ends[i].forEach(p => pts.push({ p: p, c: c, i: i })));

      /* 三通：端点压在别的管段身上（且不在它的端头） */
      pts.forEach(o => {
        for (let k = 0; k < list.length; k++) {
          if (k === o.i) continue;
          const b = boxes[k];
          if (!b) continue;
          const p = o.p;
          if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1 || p.z < b.z0 || p.z > b.z1) continue;
          const onEnd = ends[k].some(e =>
            Math.abs(e.x - p.x) < JTOL * 1.6 && Math.abs(e.y - p.y) < JTOL * 1.6 && Math.abs(e.z - p.z) < JTOL * 1.6);
          if (onEnd) continue;
          o.tee = true;
          break;
        }
      });

      /* 端点聚类：格子粗一点，同簇的取平均位置当接头中心 */
      const groups = [];
      pts.forEach(o => {
        const p = o.p;
        let g = null;
        for (let k = 0; k < groups.length; k++) {
          const q = groups[k];
          if (Math.abs(q.x - p.x) < JTOL && Math.abs(q.y - p.y) < JTOL && Math.abs(q.z - p.z) < JTOL) { g = q; break; }
        }
        if (!g) { g = { x: 0, y: 0, z: 0, n: 0, s: 0, d: 0, tee: false, ly: {} }; groups.push(g); }
        g.n++;
        g.ly[o.c.layer] = 1;        // 这个接头是哪几层的管交汇出来的（图层开关要用）
        g.x += (p.x - g.x) / g.n; g.y += (p.y - g.y) / g.n; g.z += (p.z - g.z) / g.n;
        g.s = Math.max(g.s, o.c.s || 0.05);
        g.d = Math.max(g.d, o.c.d || 0.05);
        if (o.tee) g.tee = true;
      });

      groups.forEach((g, gi) => {
        if (g.n < 2 && !g.tee) return;           // 单根管子的自由端不放接头
        /* 接头块 = 管径的 2.3 倍左右（弯头/三通本来就比管身鼓一圈）。
           上下限跟着管径一起缩小过：下限 0.10 在管径缩到 0.03 以后会让接头
           比管子粗三倍，看着像一串"糖葫芦"，所以改成 0.055。 */
        const r = Math.min(0.18, Math.max(0.055, g.s * 2.3));
        D.joints.push({
          id: 'JT-' + cid + '-' + gi, floor: circ.floor, circuit: cid, kind: circ.kind,
          x: g.x, y: g.y, z: g.z, r: r, d: Math.min(r, g.d || r),
          type: g.tee ? 'tee' : 'elbow', n: g.n, layers: Object.keys(g.ly)
        });
      });
    });

    /* 带 0 间房的回路 = 备用空开。现场配电箱上留备用回路是常规做法，
       但如果不说清楚，用户会以为是数据漏了 —— 标记出来，回复里按"预留"讲。 */
    D.circuits.forEach(c => { c.spare = (c.rooms || []).length === 0; });

    /* 分路状态：重建时把原来的通断状态带过来。
       用户掐掉一路电以后再开个窗，电不能自己又合上。
       注意这里要带的是**断路器手柄位置**（c.on），不是"有没有电"：
       总开关断掉时六路都是没电的，但手柄仍停在合位 —— 这两件事分开存，
       否则总开关一断、重建一次，六个分路的手柄就会被悄悄按下去。 */
    const prevC = {};
    ((E.data && E.data.circuits) || []).forEach(c => { prevC[c.id] = c.on; });
    const prevP = {};
    ((E.data && E.data.panels) || []).forEach(p => { prevP[p.id] = p.mainOn; });
    D.circuits.forEach(c => { c.on = prevC[c.id] !== false; });
    D.panels.forEach(p => { p.mainOn = prevP[p.id] !== false; });

    /* 改线记录活过重建。
       ★ 这里修的是"撤掉门再点回来就判碰撞"的根子：reroutes 原来只活在 E.data 里，
         E.rebuild() 一跑（开窗、打通、改尺寸、导入模型……任何一次重建都会跑）就整包清零。
         于是墙上那扇门明明是"牵着线开出来的"，过一会儿再校核又变成"墙里有管、撞"。
         记录在开头就已经搬进 D.reroutes 了（铺管要用），这里只做清理：
         墙都没了的记录留着没意义。 */
    const wallSet = {};
    (m.walls || []).forEach(w => { wallSet[w.id] = 1; });
    Object.keys(D.reroutes || {}).forEach(k => {
      const r = D.reroutes[k];
      if (!r || (r.wall && !wallSet[r.wall])) delete D.reroutes[k];
    });

    applyLive(D);
    E.data = D;
    return D;
  };

  /* 由"开关位置"算出"这一路现在到底有没有电"：
       分路带电 = 本层总开关合着 且 这一路断路器合着
     总开关（进线断路器）断掉时，下游六路全部失电，但六个分路手柄仍停在合位 ——
     这就是"总开关管全部、分路只管自己"在数据上的表达。 */
  function applyLive(D) {
    D.state = D.state || {};
    (D.circuits || []).forEach(c => {
      const p = (D.panels || []).find(x => x.id === c.panel);
      c.live = (p ? p.mainOn !== false : true) && c.on !== false;
      D.state[c.id] = c.live;
    });
    (D.panels || []).forEach(p => {
      const mine = (D.circuits || []).filter(c => c.panel === p.id);
      p.liveCount = mine.filter(c => c.live).length;
      p.anyLive = p.liveCount > 0;
    });
    return D;
  }

  function ready() {
    if (!E.data) E.build();
    return E.data;
  }
  E.ready = ready;

  E.conduit = id => (ready().conduits || []).find(c => c.id === id) || null;
  E.circuit = id => (ready().circuits || []).find(c => c.id === id) || null;
  E.panel = id => (ready().panels || []).find(c => c.id === id) || null;

  /* ---------------- 冲突检测 ---------------- */
  /* 一根线管在**这面墙上**占的那一段：沿墙位置 [a0, a1] × 高度 [s0, s1]。
     横管本来就有 at0/at1；竖直管（墙内下引、箱到桥架）没有"沿墙长度"，
     得把它的平面坐标投影到墙轴上算出来 —— 这一步以前缺了，于是所有竖管
     都被当成"在墙的另一头"，开洞时一根都报不出来（用户原话：
     "在管线开门汇集处没有考虑所有管线的绕行"）。 */
  function spanOnWall(wall, c, a) {
    if (c.vert) {
      if (c.x == null || c.y == null) return null;
      const ax = a || axis(wall);
      const at = (c.x - ax.ax) * ax.ux + (c.y - ax.ay) * ax.uy;
      const perp = Math.abs((c.x - ax.ax) * (-ax.uy) + (c.y - ax.ay) * ax.ux);
      /* 竖直管必须**埋在墙里**才算这面墙的管：贴着墙面外面走的（比如桥架）
         只是路过，凿洞并不碰它。厚度按墙厚一半再放 6 cm 施工误差。 */
      if (perp > wall.t / 2 + 0.06) return null;
      const s = c.s || 0.04;
      return {
        vert: true, at: at, a0: at - s / 2, a1: at + s / 2,
        s0: Math.min(c.z0, c.z1), s1: Math.max(c.z0, c.z1)
      };
    }
    if (c.at0 == null || c.at1 == null) return null;
    return { vert: false, at: (c.at0 + c.at1) / 2, a0: c.at0, a1: c.at1, s0: c.z - c.s / 2, s1: c.z + c.s / 2 };
  }
  E.spanOnWall = spanOnWall;

  /* 没挂在墙上、但贴着这面墙明敷的一段（配电箱层进线 FD、箱到桥架 PO/PU）。
     这类段只有两端点，没有 at0/at1，按"墙 id"过滤永远取不到 ——
     于是"控制箱后面开门"时，门头上那根 2.05 m 的层进线明明从洞前横过去，
     既没被判冲突、也没有绕法（用户原话："连接管碰撞到了门但是没有绕行的处理"）。
     做法：按采样点投影回墙轴，取 at/标高的包络。
     "附近"取墙厚一半再放 0.30 m —— 门框带门套的安装空间就是这个量级；
     再远的（走廊对面那排桥架）不能算，否则满楼都是假冲突。 */
  const OFF_GAP = 0.30;
  function spanOffWall(wall, c, a) {
    if (!c || c.wall) return null;
    const half = (c.s || 0.04) / 2;
    const lim = wall.t / 2 + OFF_GAP + half;
    let pts = null;
    if (c.free && c.p1 && c.p2) {
      pts = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        pts.push([c.p1[0] + (c.p2[0] - c.p1[0]) * t,
                  c.p1[1] + (c.p2[1] - c.p1[1]) * t,
                  c.p1[2] + (c.p2[2] - c.p1[2]) * t]);
      }
    } else if (c.vert && c.x != null && c.y != null) {
      pts = [[c.x, c.y, Math.min(c.z0, c.z1)], [c.x, c.y, Math.max(c.z0, c.z1)]];
    }
    if (!pts) return null;
    const ax = a || axis(wall);
    let a0 = Infinity, a1 = -Infinity, s0 = Infinity, s1 = -Infinity, near = false;
    pts.forEach(q => {
      const at = (q[0] - ax.ax) * ax.ux + (q[1] - ax.ay) * ax.uy;
      const perp = Math.abs((q[0] - ax.ax) * (-ax.uy) + (q[1] - ax.ay) * ax.ux);
      if (perp > lim) return;
      near = true;
      if (at < a0) a0 = at;
      if (at > a1) a1 = at;
      if (q[2] - half < s0) s0 = q[2] - half;
      if (q[2] + half > s1) s1 = q[2] + half;
    });
    if (!near) return null;
    return { off: true, a0: a0, a1: a1, s0: s0, s1: s1, at: (a0 + a1) / 2 };
  }
  E.spanOffWall = spanOffWall;

  /* 开一个洞会不会打断墙里的线管。
       洞：沿墙 [at-w/2, at+w/2] × 高度 [sill, sill+h]
       线管：沿墙 [a0, a1] × 高度 [s0, s1]（横管按 at0/at1，竖管按平面投影）
     两个矩形相交就是打架。已经改过线的线管（reroutes 里有记录且覆盖这个洞）不算。 */
  E.hitWall = function (wall, o) {
    if (!wall || !E.data) return [];
    const at = o.at, w = o.w || 0.9, h = o.h || 2.1;
    const sill = o.sill == null ? 0 : o.sill;
    const h0 = at - w / 2 - 0.05, h1 = at + w / 2 + 0.05;
    const z0 = sill - 0.05, z1 = sill + h + 0.05;
    const a = axis(wall);
    const out = [];
    (E.data.conduits || []).forEach(c => {
      if (c.wall !== wall.id) return;
      const sp = spanOnWall(wall, c, a);
      if (!sp) return;
      if (sp.a1 <= h0 || sp.a0 >= h1) return;                  // 沿墙方向不相交
      if (sp.s1 <= z0 || sp.s0 >= z1) return;                   // 高度方向不相交
      if (reroutedOver(c, h0, h1)) return;                      // 已经改过线了
      out.push(c);
    });
    /* ★ 第二遍：没挂在墙上、但贴着这面墙明敷的段（配电箱层进线 FD、箱到桥架 PO/PU）。
       它们 wall=null，第一遍按墙 id 过滤永远看不到 —— "控制箱后面开门"时，
       门头上那根 2.05 m 的进线就从门框前横过去，既不报冲突也没有绕法。
       只认 feed / out 这两层：别的层要么本来就在墙里（第一遍已经管），
       要么是走道对面那排干线（不该算到"这扇门"头上）。
       ★ 整面拆墙时不算：明敷段不属于这面墙，墙拆了它还在，不能记成"随墙作废"。 */
    if (o.demolish) return out;
    (E.data.conduits || []).forEach(c => {
      if (c.wall || c.floor !== wall.floor) return;
      if (c.layer !== 'feed' && c.layer !== 'out') return;
      const sp = spanOffWall(wall, c, a);
      if (!sp) return;
      if (sp.a1 <= h0 || sp.a0 >= h1) return;
      if (sp.s1 <= z0 || sp.s0 >= z1) return;
      if (reroutedOver(c, h0, h1)) return;
      if (out.some(x => x.id === c.id)) return;
      out.push(c);
    });
    return out;
  };

  /* 这根线管在这个洞口范围里是不是已经改过线了。
     比的是"覆盖关系"：改线时记的洞要能罩住这次查的洞。
     两边各留 0.1 m 容差 —— 查冲突时洞会外扩 5 cm 当保护层，
     不放容差的话改完线再查回来还是判"撞"，等于白改。
     ★ 还认第二种情况：同一面墙、同一条回路上"洞对得上"的记录。
       因为一旦重建（开窗/打通/导入模型），被洞口切开的线管会换成新的 id，
       按 id 就再也对不上，墙上那扇门立刻变回"撞管" —— 用户看到的就是
       "刚才还能开，撤掉再点回来怎么又撞了"。 */
  function reroutedOver(c, h0, h1) {
    const R = (E.data.reroutes || {});
    const cover = r => !!(r && r.hole && r.hole.at0 <= h0 + 0.10 && r.hole.at1 >= h1 - 0.10);
    if (cover(R[c.id])) return true;
    return Object.keys(R).some(k => {
      const r = R[k];
      if (!r || k === c.id) return false;
      if (r.wall !== c.wall || r.circuit !== c.circuit) return false;
      return cover(r);
    });
  }
  E.reroutedOver = reroutedOver;

  /* 把"某个洞口范围内"的改线记录全部撤掉（不管记在哪个 conduit id 上）。
     撤门要用它：门撤了，为它改的道就该全部放回原样，
     原来只按门身上记的那几个 id 撤，重建过一次 id 变了就撤不掉，
     图上就一直挂着一截绿线（用户原话："撤掉门后还是有原来绕行的管线"）。 */
  E.undoReroutesAt = function (wallId, at0, at1) {
    const D = ready();
    const gone = [];
    Object.keys(D.reroutes || {}).forEach(k => {
      const r = D.reroutes[k];
      if (!r || !r.hole) return;
      /* 明敷段的记录自己 wall=null，得回落到 wallId 才认得出是哪面墙的 */
      const wid = r.wall || r.wallId;
      if (wallId && wid !== wallId) return;
      /* 有重叠就算这个门的（门可能被挪过一点，别要求完全一致） */
      const ov = Math.min(r.hole.at1, at1) - Math.max(r.hole.at0, at0);
      if (ov > -0.05) { gone.push(r.conduit || k); delete D.reroutes[k]; }
    });
    return gone;
  };

  /* 某根线管在某个洞口的绕行方案
     往洞顶以上或洞底以下翻过去——真实施工就是"上翻/下翻"。
     哪边近走哪边；近了会顶梁或贴地就换另一边；两边都不行就明确说不行。 */
  E.planReroute = function (c, hole, avoid) {
    if (!c) return { ok: false, why: '找不到这根线管' };
    const wall = (M().walls || []).find(w => w.id === (c.wall || (hole && hole.wall)));
    if (!wall) return { ok: false, why: '找不到这根线管所在的墙' };

    /* ── 不挂在墙上的明敷段（配电箱层进线 FD、箱到桥架 PO）──
       它们只有两端点，wall=null，按墙 id 取不到，所以以前既不算冲突也没有绕法。
       绕法和横管同一个道理：把洞口那一段整段抬到门头以上（或压到门底以下），
       两头各加一个竖向短段接回原标高。真实施工就是把桥架/线槽"过门头".
       箱子顶上的立管（PU）不一样：它一头焊在箱子上，只能挪箱或改门位。 */
    if (!c.wall) {
      const a0 = axis(wall);
      const spo = spanOffWall(wall, c, a0);
      if (!spo) return { ok: false, why: '这段明敷线不在这面墙附近' };
      if (c.vert || spo.s1 - spo.s0 > 0.30) {
        return {
          ok: false, c: c, hole: hole,
          why: '这是配电箱顶上那根立管，上翻下翻都动不了 —— 要么把箱子挪开，要么门换个位置'
        };
      }
    }

    /* ── 竖直管（墙内下引、箱到桥架）──
       它没有"上翻/下翻"这条路：一头接吊顶干线、一头接墙上的支线端头，
       上下都动不了。真实施工里只能**沿墙横着让到洞口旁边**，
       两头各补一段水平短段接回去（就是一个 U 形）。
       以前这类管子压根不进 hitWall，所以从来没被"考虑"过；现在算进来了，
       就得给它一条真能落地的走法，否则 plans 里有一根不 ok，整扇门都判开不了。 */
    if (c.vert) {
      const a = axis(wall);
      const sp = spanOnWall(wall, c, a);
      if (!sp) return { ok: false, why: '这根竖直管不在这面墙里' };
      const half = (c.s || 0.04) / 2 + 0.06;
      const left = hole.at0 - GUARD - half;         // 让到洞口左边
      const right = hole.at1 + GUARD + half;        // 让到洞口右边
      const lo = 0.10, hi = (a.L || 3) - 0.10;
      const okL = left >= lo, okR = right <= hi;
      /* 让到洞口旁边时别撞上同一面墙上别的竖管：它俩的 at 太近就等于两根管叠在一起 */
      const nearVert = at2 => (E.data.conduits || []).some(o => {
        if (!o || o.id === c.id || !o.vert || o.wall !== wall.id) return false;
        const sp2 = spanOnWall(wall, o, a);
        return sp2 && Math.abs(sp2.at - at2) < 0.12;
      });
      const shift = (at2, sign) => {
        let v = at2;
        for (let i = 0; i < 6 && nearVert(v); i++) v += sign * 0.10;
        return v;
      };
      const L2 = at2 => at2 >= lo && at2 <= hi;
      let to = null;
      if (okL && okR) to = (sp.at - left) <= (right - sp.at) ? left : right;
      else if (okL) to = left;
      else if (okR) to = right;
      if (to != null) {
        const backup = to;
        to = shift(to, to < sp.at ? -1 : 1);
        if (!L2(to)) to = backup;                 // 挪出墙端就退回原方案
      }
      if (to == null) {
        return {
          ok: false, c: c, hole: hole,
          why: '这根下引管在距墙端 ' + fmt(sp.at) + ' m 处竖着下来，洞口两边都留不出位置让它躲开'
        };
      }
      const zTop = sp.s1, zBot = sp.s0;
      /* 顶端横挪 → 贴着新位置下来 → 底端再横挪回去 */
      const pts = [
        { at: sp.at, z: zTop }, { at: to, z: zTop },
        { at: to, z: zBot }, { at: sp.at, z: zBot }
      ];
      const addLen = Math.abs(to - sp.at) * 2;
      return {
        ok: true, c: c, hole: hole, dir: to < sp.at ? 'left' : 'right', z: to, pts: pts,
        addLen: addLen, wall: wall, vert: true,
        why: '这根墙内下引是竖直的，上翻下翻都不行，只能沿墙让到洞口' +
          (to < sp.at ? '左' : '右') + '侧 ' + fmt(to) + ' m 处重新下来，多走 ' + fmt(addLen) + ' 米线'
      };
    }

    const seg = 0.18;                          // 洞两侧各让出的水平距离
    const ax0 = axis(wall);
    const L = ax0.L;
    /* 沿墙位置与标高：墙上横管直接读 at0/at1/z；
       明敷段（层进线、箱到桥架）按投影取包络，标高取管中心 ——
       它没有 at0/at1，这两个字段在数据里一直是占位的 0。 */
    const off = c.wall ? null : spanOffWall(wall, c, ax0);
    const zC = off ? (off.s0 + off.s1) / 2 : c.z;
    const aLo = off ? off.a0 : Math.max(0, c.at0);
    const aHi = off ? off.a1 : Math.min(L, c.at1);
    const half = (c.s || 0.04) / 2 + 0.03;

    /* ── 绕行标高不能撞别的管子 ──
       以前只判断"洞顶以上还有没有空间"，于是同一个洞口的三根管会全部被安排到
       **同一个标高**上：画出来是一条绿线，实际上是三根管叠在一起；
       旁边紧挨着的那根（比如动力的 2.35 m）也照样贴着走。
       用户原话："在管线开门汇集处没有考虑所有管线的绕行"。
       所以先把"这段 at 区间里已经被占掉的标高"收集起来：
         · 同一面墙上别的线管（含竖管的上下区间）
         · 贴着这面墙明敷的段（配电箱的连接管束，以前根本没算进来）
         · 这一轮已经排好的其它绕行（avoid）
       再在这个区间里找一个真正空着的标高。 */
    const bands = [];
    const a2 = ax0;
    (E.data.conduits || []).forEach(o => {
      if (!o || o.id === c.id) return;
      let sp2 = null;
      if (o.wall === wall.id) sp2 = spanOnWall(wall, o, a2);
      else if (!o.wall && o.floor === wall.floor && (o.layer === 'feed' || o.layer === 'out')) sp2 = spanOffWall(wall, o, a2);
      if (!sp2) return;
      if (sp2.a1 <= hole.at0 - seg || sp2.a0 >= hole.at1 + seg) return;   // 沿墙不搭界
      bands.push([sp2.s0 - 0.03, sp2.s1 + 0.03]);
    });
    (avoid || []).forEach(b => bands.push(b));
    const clearOf = (z2, h2) => !bands.some(b => z2 + h2 > b[0] && z2 - h2 < b[1]);
    const stepPick = (dir2) => {
      const st = 0.04;
      if (dir2 === 'up') {
        let z2 = hole.z1 + 0.12 + half;
        while (z2 <= (wall.h || 3) - 0.10) { if (clearOf(z2, half)) return z2; z2 += st; }
        return null;
      }
      let z2 = hole.z0 - 0.12 - half;
      while (z2 >= 0.08) { if (clearOf(z2, half)) return z2; z2 -= st; }
      return null;
    };
    const up = stepPick('up');
    const dn = stepPick('down');

    let dir = null, z = null;
    if (up != null && dn != null) {
      // 线管本来就在洞上方 → 上翻更顺；否则比距离
      const preferUp = (zC >= hole.z1) || (Math.abs(up - zC) <= Math.abs(dn - zC));
      dir = preferUp ? 'up' : 'down'; z = preferUp ? up : dn;
    } else if (up != null) { dir = 'up'; z = up; }
    else if (dn != null) { dir = 'down'; z = dn; }

    if (!dir) {
      const free2 = hole.z1 + 0.12 + half <= (wall.h || 3) - 0.10 || hole.z0 - 0.12 - half >= 0.08;
      return {
        ok: false, c: c, hole: hole,
        why: free2
          ? '洞口顶以上、底以下都被这面墙里别的线管占着，这根管没地方翻过去（' +
            (bands.length) + ' 处已被占用的标高）'
          : '洞口高 ' + fmt(hole.z1 - hole.z0) + ' m，墙净高只有 ' + fmt(wall.h) +
            ' m，线管上下都翻不过去（上翻要占 ' + fmt(hole.z1 + 0.15) + ' m，下翻要占 ' + fmt(0.15) + ' m）'
      };
    }
    /* 绕行折线：从这根管子的**真实起点**走过去，绕完再回到**真实终点**。
       以前只画洞口两侧那一小段，0.36 m 宽贴在墙里，屏幕上几乎看不见，
       用户反馈"改线看不到路线"。现在整根画出来，一眼就知道电改走哪儿了。 */
    const e0 = aLo, e1 = aHi;
    const pts = [];
    if (e0 < hole.at0 - seg - 0.02) pts.push({ at: e0, z: zC });
    pts.push({ at: hole.at0 - seg, z: zC });
    pts.push({ at: hole.at0 - seg, z: z });
    pts.push({ at: hole.at1 + seg, z: z });
    pts.push({ at: hole.at1 + seg, z: zC });
    if (e1 > hole.at1 + seg + 0.02) pts.push({ at: e1, z: zC });
    const addLen = Math.abs(z - zC) * 2 + seg * 2;
    /* 明敷段不是"墙里的 at/z"，它是三维里的两点连线，
       所以额外算出四个 3D 转角，铺管时按它把原段拆成五段（见 build 的 freeRun）。 */
    let cuts = null, perp = null;
    if (off && c.free && c.p1 && c.p2) {
      const fAt = q => (q[0] - ax0.ax) * ax0.ux + (q[1] - ax0.ay) * ax0.uy;
      const fPp = q => (q[0] - ax0.ax) * (-ax0.uy) + (q[1] - ax0.ay) * ax0.ux;
      perp = (fPp(c.p1) + fPp(c.p2)) / 2;       // 绿线要跟着管子偏出墙面，别贴在墙里画
      const aA = fAt(c.p1), aB = fAt(c.p2), den = aB - aA;
      if (Math.abs(den) > 1e-6) {
        const P2 = atv => {
          const t = Math.max(0, Math.min(1, (atv - aA) / den));
          return [c.p1[0] + (c.p2[0] - c.p1[0]) * t, c.p1[1] + (c.p2[1] - c.p1[1]) * t];
        };
        const q0 = P2(hole.at0 - seg), q1 = P2(hole.at1 + seg);
        cuts = [
          [q0[0], q0[1], zC], [q0[0], q0[1], z],
          [q1[0], q1[1], z], [q1[0], q1[1], zC]
        ];
      }
    }
    return {
      ok: true, c: c, hole: hole, dir: dir, z: z, pts: pts,
      addLen: addLen, wall: wall, off: !!off, cuts: cuts, perp: perp,
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
      conduit: c.id, circuit: c.circuit, floor: c.floor,
      wall: c.wall || null,
      /* 这条改道是为**哪面墙**做的。明敷段自己 wall=null，靠 wallId 才找得回那面墙：
         撤门要按它撤、绿线要按它画。但不写进 wall，免得 detourAt 把
         "同回路 + 同墙"的墙内横管错当成这段明敷的改线（那会把两根管拉到同一标高）。 */
      wallId: (plan.wall && plan.wall.id) || c.wall || null,
      hole: { at0: hole.at0, at1: hole.at1, z0: hole.z0, z1: hole.z1 },
      dir: plan.dir, z: plan.z, pts: plan.pts, addLen: plan.addLen,
      /* 明敷段（配电箱层进线）不是墙里的 at/z，铺管时要按这四个 3D 转角拆段 */
      off: !!plan.off, cuts: plan.cuts || null, perp: plan.perp == null ? null : plan.perp
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

  /* ---------------- 分路控制 ----------------
     两层控制，范围必须分清（用户原话：总开关和各分路断路器的控制范围要分清楚）：
       · 分路断路器 E.toggle(circ)  —— 只管自己那一路；总开关合着的时候才有意义
       · 总开关     E.togglePanel(层) —— 一断，本层六路全部失电，但六个分路手柄不动
     所以"有没有电"永远是 live = mainOn && on，别拿 on 当带电用。 */
  E.toggle = function (id, on) {
    const D = ready();
    const c = E.circuit(id);
    if (!c) return null;
    c.on = on !== false;
    applyLive(D);
    return c;
  };
  E.isOn = function (id) {
    const c = E.circuit(id);
    return !!c && c.live !== false;
  };
  /* 通路（断路器位置）和带电是两回事，查询时都要能拿到 */
  E.switchOn = function (id) {
    const c = E.circuit(id);
    return !!c && c.on !== false;
  };

  E.panelOf = function (floor) {
    return (ready().panels || []).find(p => p.floor === floor) || null;
  };
  /* 这一层的总开关（进线断路器）合着没有 */
  E.mainOn = function (floor) {
    const p = E.panelOf(floor);
    return p ? p.mainOn !== false : true;
  };
  E.togglePanel = function (floor, on) {
    const D = ready();
    const p = E.panelOf(floor);
    if (!p) return null;
    p.mainOn = on !== false;
    applyLive(D);
    return p;
  };
  E.syncLive = function () { return applyLive(ready()); };

  /* 总开关一断 = 整层所有分路同时停，影响面是本层全部房间。
     和分路不同：分路只停一类功能，总开关是三类全停。 */
  E.panelImpact = function (floor) {
    const D = ready();
    const p = E.panelOf(floor);
    if (!p) return null;
    const mine = (D.circuits || []).filter(c => c.panel === p.id);
    const rooms = (M().rooms || []).filter(r => r.floor === floor && r.zone !== 'corr');
    const powered = rooms.filter(r => E.roomsCircuits(r).length > 0);
    return {
      panel: p, floor: floor, mainOn: p.mainOn !== false,
      circuits: mine, circuit_count: mine.length,
      kinds: mine.map(c => c.kind_cn || E.KIND_CN[c.kind] || c.kind),
      rooms: powered, room_nums: powered.map(r => r.num),
      count: powered.length,
      /* 一整层全黑：总开关一断，照明也没了 */
      dark_rooms: powered.map(r => r.num)
    };
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
     注意：一层有六条分路，但一间房每类只归其中一条（照明1 或 2、插座1 或 2、
     动力1 或 2），"断了一条"不等于"这间房没电"，而是"这间房失去了这一类功能"。
     所以这里按功能分开算，别拿 on.length 一概而论。 */
  E.roomPower = function (room) {
    const cs = E.roomsCircuits(room);
    /* 一律按 live（有没有电）分，不按 c.on（手柄位置）：
       总开关一断，六个手柄都还合着，但这间房同样一点电都没有。 */
    const on = cs.filter(c => c.live !== false);
    const off = cs.filter(c => c.live === false);
    const cnOf = c => c.kind_cn || E.KIND_CN[c.kind] || c.kind;
    const kindsAll = cs.map(c => c.kind);
    const kindsOff = off.map(c => c.kind);
    const lost = off.map(cnOf);
    const mains = {};
    cs.forEach(c => { mains[c.panel] = E.mainOn(c.floor); });
    const noMain = Object.keys(mains).filter(k => !mains[k]);
    return {
      circuits: cs, on: on, off: off,
      main_off: noMain,                             // 总开关断着的配电箱（这时六路一起停）
      all_off: cs.length > 0 && on.length === 0,    // 一间房连一条通的都没有（含竖井未进）
      any_off: off.length > 0,
      lost: lost,                                   // ['照明1'] / ['插座1','动力1'] / 全三类
      still: on.map(cnOf),
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
    const kind = c.kind;
    /* 显示名带序号：断的是"照明1"，不是笼统的"照明" */
    const cn = c.kind_cn || E.KIND_CN[kind] || kind;
    const rooms = E.circuitRooms(id);
    const rows = rooms.map(r => {
      const p = E.roomPower(r);
      const others = p.on.filter(x => x.id !== id);
      return {
        id: r.id, num: r.num, name: r.name, use: r.use, floor: r.floor,
        func: cn,                                    // 这条分路在这间房里管什么
        dark: kind === 'light',                      // 断照明就是这一间黑了
        still: others.map(x => x.kind_cn || E.KIND_CN[x.kind] || x.kind),   // 这间房还剩下什么
        fully_dark: p.all_off && kind === 'light'
      };
    });
    return {
      circuit: c, kind: kind, kind_cn: cn,
      panel: c.panel, phase: c.phase, rated: c.rated,
      on: c.live !== false,                 // 带电（已算上总开关）
      switch_on: c.on !== false,            // 断路器手柄位置
      main_on: E.mainOn(c.floor),
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
      if (opt.room && c.room !== opt.room && c.roomNum !== opt.room &&
        !(c.rooms && c.rooms.indexOf(opt.room) >= 0)) return false;
      if (opt.circuit && c.circuit !== opt.circuit) return false;
      if (opt.kind && c.kind !== opt.kind) return false;
      if (opt.layer && c.layer !== opt.layer) return false;
      if (opt.wall && c.wall !== opt.wall) return false;
      return true;
    });
  };

  /* 分路清单：给"这层有哪些分路"这种问题用 */
  E.list = function (floor) {
    return (ready().circuits || []).filter(c => floor == null || c.floor === floor)
      .map(c => {
        /* 一条分路自己在拓扑里各层级的管段数：干线几段、支线几段。
           回答"这路是怎么走的"要用，不然只能说"带 11 间房"，说不出路径。 */
        const mine = (ready().conduits || []).filter(x => x.circuit === c.id);
        const layers = ['trunk', 'feed', 'out', 'corridor', 'drop', 'room'].reduce((a, k) => {
          const n = mine.filter(x => x.layer === k).length;
          if (n) a[k] = n;
          return a;
        }, {});
        return {
          id: c.id, no: c.no, label: c.label, name: c.name, kind: c.kind,
          kind_cn: c.kind_cn || E.KIND_CN[c.kind], sub: c.sub,
          panel: c.panel, phase: c.phase, rated: c.rated,
          on: c.live !== false,                  // 现在有没有电（含总开关）
          switch_on: c.on !== false,             // 分路断路器手柄
          main_on: E.mainOn(c.floor),            // 本层总开关
          rooms: c.rooms.length, conduits: c.conduits.length, layers: layers,
          room_nums: E.circuitRooms(c.id).map(r => r.num)
        };
      });
  };

  /* 按"本层第几回路"找分路：用户说"2 楼第一回路"走这里 */
  E.circuitByNo = function (floor, no) {
    const list = (ready().circuits || []).filter(c => c.floor === floor);
    return list.find(c => c.no === no) || null;
  };

  /* 按"哪一类 + 同类里第几条"找：照明2 → L{x}B，插座1 → L{x}C，动力2 → L{x}F。
     用户说"把 2 楼照明 2 断电"走这条，说"第 2 个空开"走 circuitByNo。 */
  E.circuitByKind = function (floor, kind, sub) {
    const list = (ready().circuits || []).filter(c => c.floor === floor && c.kind === kind);
    if (!list.length) return null;
    if (sub == null) return list[0];
    return list.find(c => (c.sub || 1) === sub) || null;
  };

  /* 某条分路的接头/弯头（渲染和查询都用） */
  E.jointsOf = function (cid) {
    const all = ready().joints || [];
    return cid ? all.filter(j => j.circuit === cid) : all;
  };

  /* 一段线管的两端坐标（BIM 平面 x/y + 标高 z）。
     流向动画要把光点撒在管子上，碰撞点定位也要用到它。 */
  E.segEnds = function (c) {
    if (!c) return null;
    if (c.free && c.p1 && c.p2) {
      return [{ x: c.p1[0], y: c.p1[1], z: c.p1[2] },
              { x: c.p2[0], y: c.p2[1], z: c.p2[2] }];
    }
    if (c.vert) {
      return [{ x: c.x, y: c.y, z: c.z0 }, { x: c.x, y: c.y, z: c.z1 }];
    }
    const w = (M().walls || []).find(q => q.id === c.wall);
    if (!w) return null;
    const a = axis(w);
    return [c.at0, c.at1].map(at => ({ x: a.ax + a.ux * at, y: a.ay + a.uy * at, z: c.z }));
  };

  E.stats = function () {
    const D = ready();
    return {
      panels: D.panels.length, circuits: D.circuits.length,
      conduits: D.conduits.length, joints: (D.joints || []).length,
      reroutes: Object.keys(D.reroutes || {}).length,
      by_kind: ['light', 'socket', 'power', 'riser'].reduce((a, k) => {
        a[k] = D.conduits.filter(c => c.kind === k).length; return a;
      }, {}),
      /* 按拓扑层级统计：主干几根、走廊干线几根、房间支线几根，一眼看出是"树"不是"一盘散沙" */
      by_layer: ['trunk', 'feed', 'out', 'corridor', 'drop', 'room'].reduce((a, k) => {
        a[k] = D.conduits.filter(c => c.layer === k).length; return a;
      }, {}),
      trunk: D.trunk || null
    };
  };

  /* ---------------- 给校核和回复用的中文描述 ---------------- */
  E.hitText = function (c) {    const circ = c.circuit ? E.circuit(c.circuit) : null;
    const nm = (circ && (circ.kind_cn || circ.short)) || E.KIND_CN[c.kind] || '电';
    return nm + '回路的' + (E.LAYER_CN[c.layer] || '线管') +
      '（' + c.circuit + '，管中距地 ' + fmt(c.z) + ' m，截面 ' + fmt(c.s * 100) + ' cm）';
  };
  E.circuitText = function (c) {
    const rs = E.circuitRooms(c.id);
    return c.name + '（' + c.id + '，' + c.phase + ' 相，' + c.rated + 'A，带 ' + rs.length + ' 间房）';
  };

  /* 模型结构变了就重建（导入 IFC 后调用）
     ★ 不要先把 E.data 置空再 build：build 要从旧数据里把"分路通断 / 总开关 /
       改线记录"带过来，先置空等于把它们全扔了（改线记录尤其致命，
       墙上那扇门明明是牵着线开的，重建一次就变成"撞管"）。
       现在直接 build，build 内部会读旧 E.data、算完再覆盖。 */
  E.rebuild = function () { return E.build(); };
})();
