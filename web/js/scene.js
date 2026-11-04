/* AIbim 三维场景引擎 —— 数据坐标系 x(东) y(北) z(上) → 视口 y 向上 */
(function () {
  let M = window.BIM_MODEL;
  window.BIM = window.BIM || {};
  const S = (window.BIM.scene = {});

  const COL = {
    slab: 0xbcc6d2, wallExt: 0xc9d2dc, wallInt: 0xe4e9ef,
    col: 0xb0bbc7, beam: 0xc2cbd6, door: 0x9c6d3f, glass: 0x6ea6cc,
    duct: 0x8798a9, valveOpen: 0x0f8f63, valveClosed: 0xd04237,
    edge: 0x7d8b9a, edgeSoft: 0x99a6b4
  };

  let scene, camera, renderer, controls, raycaster, ptr;
  let floorGroups = [];
  let roof = null;
  let wallMeshById = {};
  let ductMeshById = {};
  const reg = { slab: [], wall: [], door: [], valve: [], equip: [], duct: [], window: [], col: [], beam: [] };
  let hl = null, anim = null;
  let lastFocusLevel = -1;
  let isoHidden = [];                       // 「只看这一间」藏起来的对象，还原时逐个点亮
  let isoTemp = [];                         // 隔离时临时造的"房间那一段墙"，还原时删掉
  S.mode = 'idle';
  S.focus = 0;

  /* ---------------- 几何工具 ---------------- */
  const BASE = new THREE.BoxGeometry(1, 1, 1);
  const BP = BASE.attributes.position.array, BN = BASE.attributes.normal.array, BI = BASE.index.array;
  const BUV = BASE.attributes.uv.array;
  const VPER = BP.length / 3;   // 24

  function boxGeo(items) {
    const n = items.length;
    const pos = new Float32Array(n * BP.length), nor = new Float32Array(n * BN.length);
    // 同一根管子上的法兰、支吊架要和管身分开色，靠顶点色解决（不拆 mesh，高亮/隔离逻辑不用改）
    const hasC = items.some(it => it.c);
    const col = hasC ? new Float32Array(n * BP.length) : null;
    // 带贴图的构件（风管、风口）要 UV，按"哪个面朝哪"挑投影平面，2 m 一个平铺周期
    const hasUV = items.some(it => it.uv);
    /* 线管的 UV 是另一套：u 必须沿**管子的走向**（米），不能按世界法向投影。
       按世界投影的话，南北向那根管的走向会落到 v 上、东西向的落到 u 上，
       流动条纹一会儿沿着管跑、一会儿横着扫过管子断面，像在管子上束腰带。
       it.uvp = { ax:'x'|'y', flip:±1 }：ax 说这段管沿盒子的哪个局部轴长，
       flip 说这个局部轴的正向是不是"顺电流"（+1 顺、-1 逆）。 */
    const hasUVP = items.some(it => it.uvp);
    const uvs = (hasUV || hasUVP) ? new Float32Array(n * VPER * 2) : null;
    let ui = 0;
    const idx = new (n * VPER > 65000 ? Uint32Array : Uint16Array)(n * BI.length);
    const v = new THREE.Vector3(), nm = new THREE.Vector3(), m = new THREE.Matrix4(), sc = new THREE.Matrix4();
    let vo = 0, io = 0, vi = 0;
    for (const it of items) {
      m.copy(it.matrix || new THREE.Matrix4());
      sc.makeScale(it.size[0], it.size[1], it.size[2]);
      m.multiply(sc);
      for (let i = 0; i < BP.length; i += 3) {
        v.set(BP[i], BP[i + 1], BP[i + 2]).applyMatrix4(m);
        nm.set(BN[i], BN[i + 1], BN[i + 2]).transformDirection(m);
        pos[vo] = v.x; pos[vo + 1] = v.y; pos[vo + 2] = v.z;
        nor[vo] = nm.x; nor[vo + 1] = nm.y; nor[vo + 2] = nm.z;
        vo += 3;
        if (col) {
          const c = it.c || [1, 1, 1];
          col[vi] = c[0]; col[vi + 1] = c[1]; col[vi + 2] = c[2];
          vi += 3;
        }
        if (uvs) {
          if (it.uvp) {
            /* 管身：u = 沿管子走向的米数（乘 flip 定方向），v 直接用盒子自带的 0~1 环向，
               条纹横跨整个周长，看着就是"管子自己在发光"而不是"贴了张图" */
            const t = (it.uvp.ax === 'y' ? BP[i + 1] * it.size[1] : BP[i] * it.size[0]) * (it.uvp.flip || 1);
            uvs[ui++] = t; uvs[ui++] = BUV[(i / 3) * 2 + 1] || 0;
          } else {
            const ax = Math.abs(nm.x), ay = Math.abs(nm.y), az = Math.abs(nm.z);
            let uu, vv;
            if (ay >= ax && ay >= az) { uu = v.x; vv = v.z; }        // 朝上/下的面
            else if (ax >= az) { uu = v.z; vv = v.y; }               // 朝东/西
            else { uu = v.x; vv = v.y; }                             // 朝南/北
            uvs[ui++] = uu * .5; uvs[ui++] = vv * .5;
          }
        }
      }
      const base = vo / 3 - VPER;
      for (let i = 0; i < BI.length; i++) idx[io + i] = BI[i] + base;
      io += BI.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }
  S.boxGeo = boxGeo;

  function frame(x, y, z, ux, uy) {
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(ux, 0, -uy), new THREE.Vector3(0, 1, 0), new THREE.Vector3(uy, 0, ux));
    m.setPosition(x, z, -y);
    return m;
  }
  S.frame = frame;

  const D = () => window.BIM.detail;

  function makeMats() {
    const mk = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .92, metalness: 0 }, o || {}));
    const m = {
      slab: mk(COL.slab), wallExt: mk(COL.wallExt), wallInt: mk(COL.wallInt),
      col: mk(COL.col, { roughness: .85 }), beam: mk(COL.beam), door: mk(COL.door, { roughness: .7 }),
      glass: new THREE.MeshStandardMaterial({ color: COL.glass, transparent: true, opacity: .55, roughness: .1, metalness: .2 }),
      duct: mk(COL.duct, { roughness: .45, metalness: .3 })
    };
    // 真实感材质（贴图 / 金属度 / 吊顶 / 家具）由 detail 层覆盖同名键
    const d = D();
    if (d && d.mats) {
      const extra = d.mats();
      Object.keys(extra).forEach(k => { m[k] = extra[k]; });
    }
    Object.values(m).forEach(x => { x.userData.baseOpacity = x.opacity; });
    m.glass.userData.baseOpacity = m.glass.opacity;
    return m;
  }

  const edgeMat = new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: .42 });
  const edgeSoft = new THREE.LineBasicMaterial({ color: COL.edgeSoft, transparent: true, opacity: .38 });

  function addEdges(mesh, geo, mat) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 24), mat || edgeMat);
    mesh.add(e);
    return e;
  }

  /* ---------------- 墙体（含洞口） ---------------- */
  /* clip=[lo,hi] 时只造这一段（沿墙轴的距离）。隔离房间用得上：
     整栋 33 m 一条长墙串着 5 间房，整面留着画面就还是"整层" */
  function wallBoxes(w, clip) {
    const [ax, ay] = w.p1, [bx, by] = w.p2;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    const ops = (w.openings || []).slice().sort((a, b) => a.at - b.at);
    const segs = []; let cur = 0;
    for (const o of ops) {
      const s0 = Math.max(0, o.at - o.w / 2), s1 = Math.min(L, o.at + o.w / 2);
      if (s0 > cur + 1e-6) segs.push([cur, s0, 0, w.h]);
      if (o.h + o.sill < w.h - 1e-6) segs.push([s0, s1, o.sill + o.h, w.h]);
      if (o.sill > 1e-6) segs.push([s0, s1, 0, o.sill]);
      cur = Math.max(cur, s1);
    }
    if (cur < L - 1e-6) segs.push([cur, L, 0, w.h]);
    let use = segs;
    if (clip) {
      use = segs.map(s => [Math.max(s[0], clip[0]), Math.min(s[1], clip[1]), s[2], s[3]]);
    }
    return use.filter(s => s[1] - s[0] > 1e-4 && s[3] - s[2] > 1e-4).map(([s0, s1, z0, z1]) => {
      const mid = (s0 + s1) / 2;
      return {
        size: [s1 - s0, z1 - z0, w.t],
        matrix: frame(ax + ux * mid, ay + uy * mid, w.base + (z0 + z1) / 2, ux, uy)
      };
    });
  }

  /* ---------------- 建楼层 ---------------- */
  function buildFloor(fl) {
    const g = new THREE.Group();
    g.name = 'F' + fl.level;
    g.userData.level = fl.level;
    const mats = makeMats();
    const L = fl.level;

    M.slabs.filter(s => s.floor === L).forEach(s => {
      const geo = new THREE.BoxGeometry(s.x1 - s.x0, s.thk, s.y1 - s.y0);
      const mesh = new THREE.Mesh(geo, mats.slab);
      mesh.position.set((s.x0 + s.x1) / 2, s.top - s.thk / 2, -(s.y0 + s.y1) / 2);
      mesh.userData = { kind: 'slab', data: s, floor: L };
      addEdges(mesh, geo, edgeSoft);
      g.add(mesh); reg.slab.push(mesh);
    });

    M.walls.filter(w => w.floor === L).forEach(w => g.add(buildWallMesh(w, mats)));

    // 柱、梁、窗逐件建：隔离房间时要能一件一件藏，
    // 合并成一个 mesh 的话整层骨架都得留着
    M.columns.filter(c => c.floor === L).forEach(c => {
      const geo = new THREE.BoxGeometry(c.s, c.h, c.s);
      const m = new THREE.Mesh(geo, mats.col);
      m.position.set(c.x, c.z + c.h / 2, -c.y);
      m.userData = { kind: 'column', data: c, floor: L };
      g.add(m); reg.col.push(m);
    });

    M.beams.filter(b => b.floor === L).forEach(b => {
      const [ax, ay, az] = b.a, [bx, by] = b.b;
      const len = Math.hypot(bx - ax, by - ay) || 1e-6;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      const geo = new THREE.BoxGeometry(len, b.h, b.w);
      const m = new THREE.Mesh(geo, mats.beam);
      m.position.set((ax + bx) / 2, az - b.h / 2, -(ay + by) / 2);
      m.rotation.y = Math.atan2(uy, ux);
      m.userData = { kind: 'beam', data: b, floor: L, span: [[ax, ay], [bx, by]] };
      g.add(m); reg.beam.push(m);
    });

    M.windows.filter(d => d.floor === L).forEach(d => {
      const wg = (D() && D().windowMesh) ? D().windowMesh(d, mats) : buildWindowMesh(d, mats);
      wg.name = 'win-' + d.id;
      wg.traverse(o => { if (o.isMesh) reg.window.push(o); });
      g.add(wg);
    });

    M.doors.filter(d => d.floor === L).forEach(d => g.add(buildDoorMesh(d, mats)));

    // 风管逐段建，方便按路由单独高亮
    const ductGroup = new THREE.Group();
    M.ducts.filter(d => d.floor === L).forEach(d => {
      const [ax, ay, az] = d.a, [bx, by] = d.b;
      const len = Math.hypot(bx - ax, by - ay) || 1e-6, ux = (bx - ax) / len, uy = (by - ay) / len;
      // 带法兰 / 支吊架 / 末端风口的真实管段
      const items = (D() && D().ductItems)
        ? D().ductItems(d, M)
        : [{ size: [len, d.h, d.w], matrix: frame((ax + bx) / 2, (ay + by) / 2, az, ux, uy) }];
      const geo = boxGeo(items);
      const dm = new THREE.Mesh(geo, mats.duct);
      dm.userData = { kind: 'duct', data: d, floor: L };
      ductGroup.add(dm);
      ductMeshById[d.id] = dm;
      reg.duct.push(dm);
    });
    if (ductGroup.children.length) { g.add(ductGroup); g.userData.ducts = ductGroup; }
    const own = [];
    M.valves.filter(v => v.floor === L).forEach(v => { const m = buildValveMesh(v); g.add(m); own.push(m); });

    /* 地面面层 / 吊顶 / 家具——让模型看着像真的在用的楼 */
    const deco = { floor: [], ceil: [], furn: [] };
    const dd = D();
    if (dd) {
      M.rooms.filter(r => r.floor === L).forEach(r => {
        const ff = dd.floorFinish(r, mats);
        if (ff) { g.add(ff); deco.floor.push(ff); }
        const ce = dd.ceiling(r, mats, fl);
        if (ce) { g.add(ce); deco.ceil.push(ce); }
        const fu = dd.furniture(r, mats);
        if (fu) { g.add(fu); deco.furn.push(fu); }
      });
      g.userData.deco = deco;
    }

    const labels = [];
    M.rooms.filter(r => r.floor === L && r.zone !== 'corr').forEach(r => {
      const sp = labelSprite(r.num, r.zone === 'core' ? 1.1 : 1.35);
      sp.position.set((r.x0 + r.x1) / 2, r.elev + .5, -(r.y0 + r.y1) / 2);
      sp.visible = false;
      sp.userData.room = r.id;
      g.add(sp); labels.push(sp);
    });
    g.userData.labels = labels;

    scene.add(g);
    return { level: L, g, mats, elev: fl.elev, labels, own };
  }

  function buildWallMesh(w, mats) {
    const boxes = wallBoxes(w);
    const geo = boxGeo(boxes);
    const mesh = new THREE.Mesh(geo, w.kind === 'ext' ? mats.wallExt : mats.wallInt);
    mesh.userData = { kind: 'wall', data: w, floor: w.floor };
    /* 整面拆掉的墙一段都不剩（boxes 为空）—— 这时候不去生成描边：
       EdgesGeometry 对着 0 个顶点算出来的空几何虽然不报错，但会白白挂一个对象，
       而且楼层遍历里还得照顾它。mesh 本身留着（隔离/高亮按 wall.id 索引），只是没图形。 */
    if (boxes.length) addEdges(mesh, geo, edgeMat);
    wallMeshById[w.id] = mesh;
    reg.wall.push(mesh);
    return mesh;
  }

  function buildDoorMesh(d, mats) {
    const [ux, uy] = d.dir;
    const geo = boxGeo([{
      size: [d.w * .94, d.h * .97, Math.max(d.t * .55, .04)],
      matrix: frame(d.pos[0], d.pos[1], d.pos[2] + d.h / 2, ux, uy)
    }]);
    const mesh = new THREE.Mesh(geo, mats.door);
    mesh.userData = { kind: 'door', data: d, floor: d.floor };
    reg.door.push(mesh);
    return mesh;
  }

  /* detail 层没接管时的兜底：一块玻璃 */
  function buildWindowMesh(d, mats) {
    const [ux, uy] = d.dir;
    const geo = boxGeo([{
      size: [d.w * .94, d.h * .94, .04],
      matrix: frame(d.pos[0], d.pos[1], d.pos[2] + (d.sill || 0) + d.h / 2, ux, uy)
    }]);
    const mesh = new THREE.Mesh(geo, mats.glass);
    mesh.userData = { kind: 'window', data: d, floor: d.floor };
    return mesh;
  }

  /* 阀件：顺着管子放阀体 + 两侧法兰 + 阀杆手轮，
     只有一个 mesh（拾取、隔离、高亮都能直接复用），明暗靠顶点色区分 */
  function buildValveMesh(v) {
    let ux = 1, uy = 0, best = 9;
    M.ducts.filter(d => d.floor === v.floor).forEach(d => {
      const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) || 1;
      const cx = (d.b[0] - d.a[0]) / L, cy = (d.b[1] - d.a[1]) / L;
      const px = v.pos[0] - d.a[0], py = v.pos[1] - d.a[1];
      const t = Math.max(0, Math.min(L, px * cx + py * cy));
      const dd = Math.hypot(px - cx * t, py - cy * t);
      if (dd < best) { best = dd; ux = cx; uy = cy; }
    });
    const [vx, vy, vz] = v.pos;
    const items = [
      { size: [.36, .3, .36], matrix: frame(vx, vy, vz, ux, uy), c: [1, 1, 1] },
      { size: [.05, .42, .42], matrix: frame(vx - ux * .195, vy - uy * .195, vz, ux, uy), c: [.78, .82, .86] },
      { size: [.05, .42, .42], matrix: frame(vx + ux * .195, vy + uy * .195, vz, ux, uy), c: [.78, .82, .86] },
      { size: [.07, .2, .07], matrix: frame(vx, vy, vz + .24, ux, uy), c: [.6, .65, .7] },
      { size: [.26, .04, .26], matrix: frame(vx, vy, vz + .35, ux, uy), c: [.7, .74, .78] }
    ];
    const geo = boxGeo(items);
    const m = new THREE.MeshStandardMaterial({
      color: v.open ? COL.valveOpen : COL.valveClosed,
      roughness: .55, metalness: .3, vertexColors: true, envMapIntensity: .6
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.userData = { kind: 'valve', data: v, floor: v.floor };
    v._mesh = mesh; v._mat = m;
    reg.valve.push(mesh);
    return mesh;
  }

  /* ---------------- 文字 ---------------- */
  // 画布宽度按文字长度自适应，长名字不会被切掉；世界高度固定，宽度按比例
  // opt：{ bg, fg, bd } 换底色/字色/描边，净距标注要用它区分"够宽 / 紧 / 卡死"
  function labelSprite(text, w, opt) {
    const o = opt || {};
    const FS = 44, PADX = 24;
    const c = document.createElement('canvas');
    let x = c.getContext('2d');
    const font = '600 ' + FS + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    x.font = font;
    const tw = Math.ceil(x.measureText(text).width);
    c.width = Math.max(104, tw + PADX * 2);
    c.height = 96;
    x = c.getContext('2d');
    const r = 20, ox = 5, oy = 9, pw = c.width - 10, ph = 78;
    x.fillStyle = o.bg || 'rgba(255,255,255,.95)';
    x.beginPath();
    x.moveTo(ox + r, oy); x.lineTo(ox + pw - r, oy); x.quadraticCurveTo(ox + pw, oy, ox + pw, oy + r);
    x.lineTo(ox + pw, oy + ph - r); x.quadraticCurveTo(ox + pw, oy + ph, ox + pw - r, oy + ph);
    x.lineTo(ox + r, oy + ph); x.quadraticCurveTo(ox, oy + ph, ox, oy + ph - r);
    x.lineTo(ox, oy + r); x.quadraticCurveTo(ox, oy, ox + r, oy); x.closePath(); x.fill();
    x.strokeStyle = o.bd || 'rgba(150,168,185,.55)'; x.lineWidth = 2; x.stroke();
    x.fillStyle = o.fg || '#46525f';
    x.font = font;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, c.width / 2, 48);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    // depthTest 默认开着（设备名要能被墙挡），但净距标注必须永远浮在最上面，
    // 不然一面 3.3 m 的墙就把数字全吃了，用户只会看到几条断线
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: o.noDepth ? false : true, depthWrite: false
    }));
    const hh = w / 2, ww = hh * (c.width / c.height);
    sp.scale.set(ww, hh, 1);
    sp.renderOrder = 12;
    sp.userData.fit = ww;                    // 20 m 视距下的世界宽度
    sp.userData.ar = ww / hh;                // 宽高比
    return sp;
  }
  S.labelSprite = labelSprite;

  /* 标签按视距等比缩放，远近都保持同样的可读大小 */
  let labelLive = [];
  const _wp = new THREE.Vector3();
  function scaleLabels() {
    if (!labelLive.length) return;
    labelLive.forEach(sp => {
      sp.getWorldPosition(_wp);
      const d = camera.position.distanceTo(_wp);
      const k = Math.max(.55, Math.min(3.4, d / 20));
      const s = sp.userData.fit * k;
      sp.scale.set(s, s / (sp.userData.ar || 2), 1);
    });
  }

  /* ---------------- 初始化 ---------------- */
  S.init = function (canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    // 电影级色调映射：金属、玻璃、木饰面才有层次，不然全是灰片
    renderer.toneMapping = THREE.ACESFilmicToneMapping != null ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = 0.92;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf2f5f8, 110, 240);

    camera = new THREE.PerspectiveCamera(42, 1, .3, 500);
    camera.position.set(50, 33, 31);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.maxPolarAngle = Math.PI * .495;
    /* 最近能推到 1 m。原来是 6 m —— 那是"只敢从外面看整栋楼"的设定，
       结果想凑近看配电箱上的断路器手柄根本推不进去，镜头被硬顶在 6 m 外，
       箱子在屏幕上只有巴掌大，"哪个开关被拉下来了"完全看不清。 */
    controls.minDistance = 1.0;
    controls.maxDistance = 150;
    controls.target.set(16.5, 9.2, -7.8);

    raycaster = new THREE.Raycaster();
    ptr = new THREE.Vector2();

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa8b7c8, .58));
    [[48, 70, 34, .70], [-40, 34, -40, .24], [12, -30, 12, .12]].forEach(([x, y, z, i]) => {
      const d = new THREE.DirectionalLight(0xffffff, i); d.position.set(x, y, z); scene.add(d);
    });

    // 环境贴图：玻璃和镀锌钢板靠它才有高光，否则金属面永远是平的死灰
    if (D() && D().env) D().env(renderer, scene);

    const gnd = new THREE.Mesh(new THREE.PlaneGeometry(240, 240),
      new THREE.MeshStandardMaterial({ color: 0xd2d9e2, roughness: 1 }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -.4; scene.add(gnd);
    const grid = new THREE.GridHelper(240, 120, 0xd0d9e3, 0xe3e9f0);
    grid.position.y = -.38; grid.material.transparent = true; grid.material.opacity = .5; scene.add(grid);

    M.floors.forEach(fl => floorGroups.push(buildFloor(fl)));
    S.floors = floorGroups;

    roof = (D() && D().roof) ? D().roof(M) : null;
    if (!roof) {
      const rgeo = new THREE.BoxGeometry(33.4, .35, 16.1);
      roof = new THREE.Mesh(rgeo, new THREE.MeshStandardMaterial({
        color: 0xc6ced8, roughness: .95, transparent: true, opacity: .34, depthWrite: false
      }));
      roof.position.set(16.5, M.meta.roof - .17, -7.8);
      roof.renderOrder = 1;
      addEdges(roof, rgeo, edgeMat);
    }
    roof.visible = true;
    scene.add(roof);
    if (D() && D().apply) D().apply();

    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', () => { hideTip(); canvas.style.cursor = 'grab'; });
    loop();
    return S;
  };

  function resize() {
    const c = renderer.domElement;
    const w = c.clientWidth || c.parentElement.clientWidth, h = c.clientHeight || c.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  S.resize = resize;

  function flyTo(p, t, ms) {
    anim = { t0: performance.now(), ms: ms || 620, p0: camera.position.clone(), p1: p.clone(), q0: controls.target.clone(), q1: t.clone() };
  }
  S.flyTo = flyTo;

  const VIEWS = {
    all: { p: new THREE.Vector3(50, 33, 31), t: new THREE.Vector3(16.5, 9.2, -7.8) },
    floor: elev => {
      // 按视口比例自适应取景，保证整层平面都收进画面
      const t = new THREE.Vector3(16.5, elev + .2, -7.8);
      const asp = camera ? (camera.aspect || 1.4) : 1.4;
      const D = 25.5 * Math.max(1, 1.32 / Math.max(asp, .62));
      const dir = new THREE.Vector3(.10, .80, .59).normalize().multiplyScalar(D);
      return { p: t.clone().add(dir), t };
    },
    room: (elev, cx, cy) => ({ p: new THREE.Vector3(cx + 3.6, elev + 14.5, -cy + 10.5), t: new THREE.Vector3(cx, elev + .3, -cy) })
  };

  S.viewAll = function (animate) {
    if (floorOnly) S.isolateFloor(0);       // 回全楼视角 = 不再只看一层
    const v = VIEWS.all;
    if (animate === false) { camera.position.copy(v.p); controls.target.copy(v.t); controls.update(); return; }
    flyTo(v.p, v.t);
  };

  /* ---------------- 楼层聚焦 ----------------
     用户的纠正："查看楼层的时候不要隐藏墙体，只是 50% 半透明墙体，并且把顶梁也 50% 半透明"。
     原来聚焦是把别的楼层直接 visible=false —— 屏幕上整栋楼像被削掉一截，
     上面只剩几根管线在飘，看着像模型坏了。现在改成半透明：
     本层不透明看得清，别的楼层和顶梁留 50% 的体量，眼前还是一栋完整的楼。 */
  let floorOnly = 0;

  /* 楼体透明度统一口径（四档，全在这里算，别在别处再写一份）：
     · 全楼正常              → 全不透明
     · 聚焦某一层（不看管线） → 本层不透明，别层 50% 半透明（保留体量，不隐藏）
     · 看某层管线 / 看分路 / 看回路影响（透视 + 聚焦某层）
                             → **别层整层收起**，只留本层：墙、梁、柱、楼板压到 50%，
                               不压就看不见埋在墙里的暗管
     · 看所有管线（透视 + 全楼）→ 整栋 20% 半透明（楼体还在，不是不显示）
     第三档是用户明确纠正过的："查看单独楼层的管线设置以及分路显示的时候，隐藏其他楼层，
     只有当前楼层的墙体和梁半透明" —— 屏幕上同时挂着五层半透明的楼，
     看某一层墙里的管子和分支走向仍然是糊的。 */
  const ROOF_BASE = .34;

  /* 顶梁（屋顶那层板/梁）可能是单个 Mesh，也可能是 detail 层返回的一整组 ——
     直接写 roof.material 在"组"的情况下会炸（material 是 undefined）。 */
  function roofMats() {
    const out = [];
    if (!roof) return out;
    if (roof.isMesh && roof.material) { (Array.isArray(roof.material) ? roof.material : [roof.material]).forEach(m => out.push(m)); return out; }
    roof.traverse(o => {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => out.push(m));
    });
    return out;
  }
  function setRoofOpacity(v, vis) {
    if (!roof) return;
    roof.visible = vis === undefined ? true : !!vis;
    roofMats().forEach(m => {
      m.opacity = v;
      m.transparent = v < .999;
      m.depthWrite = v > .6;
      m.needsUpdate = true;
    });
  }

  function applyBody() {
    const lv = S.focus || 0;
    /* 「只留这一层」有两种来源，楼体表现不一样，但"别层不画"是同一条：
       · floorOnly（isolateFloor）  → 打通/开门/开窗这些"看清楚这一层"的视图，
                                      透视关着时本层实心、别层收起；
       · 透视 + 聚焦某层             → 看单层管线/分路/回路，本层半透明、别层收起。 */
    const only = floorOnly || 0;
    const hideOthers = !!only || (!!S.xray && lv !== 0);
    const allXray = !!S.xray && lv === 0 && !only;
    const key = only || lv;
    floorGroups.forEach(f => {
      const on = key !== 0 && f.level === key;
      let v, vis;
      if (allXray) { vis = true; v = .2; }
      else if (key === 0) { vis = true; v = 1; }
      else if (hideOthers) { vis = on; v = on ? (S.xray ? .5 : 1) : .5; }
      else { vis = true; v = on ? 1 : .5; }                 // 普通聚焦：别层 50% 保留体量
      f.g.visible = vis;
      setBodyOpacity(f.mats, v);
    });
    /* 顶梁：全楼看管线时 20%；普通聚焦时 50%（整栋楼还在）；
       只留一层时跟着别层一起收起 —— 屋顶不属于当前这一层，留着会糊住整层。 */
    setRoofOpacity(allXray ? .2 : (key === 0 ? ROOF_BASE : .5), !hideOthers);
  }
  S.applyBody = applyBody;

  S.isolateFloor = function (level) {
    floorOnly = level || 0;
    /* 回到"全楼"= 退出打通/开门那种特殊视图，管子的半透明也该跟着恢复 */
    if (!floorOnly && typeof eAlpha === 'number' && eAlpha < 0.99) S.conduitAlpha(1);
    eFloorOnly = floorOnly;                 // 管线只跟楼层有关：看哪层就只画哪层的管
    eApplyVis();
    applyBody();
    if (D() && D().apply) D().apply();
    syncPanels();
  };
  S.floorIsolated = () => floorOnly;

  S.setFocus = function (level, animate) {
    /* 换了一层就不再是"只看原来那层"——这里不主动恢复，交给后面的常规逻辑设显隐 */
    if (floorOnly && level !== floorOnly) floorOnly = 0;
    // 手动切到别的楼层 = 不想只看那一间了，先把隔离解开，否则藏过的东西回不来
    if (S.isoRoom) {
      const ir = M.rooms.find(r => r.id === S.isoRoom);
      if (ir && level !== ir.floor) {
        const was = isoHidden; isoHidden = [];
        was.forEach(o => { o.visible = !(o.userData && o.userData.hidden); });
        isoTemp.forEach(o => { o.traverse(c => { if (c.geometry) c.geometry.dispose(); }); if (o.parent) o.parent.remove(o); });
        isoTemp = [];
        M.walls.forEach(w => { w.isolateHidden = false; });
        Object.keys(wallMeshById).forEach(id => { const m = wallMeshById[id]; if (m) m.visible = true; });
        S.isoRoom = null;
      }
    }
    S.focus = level;
    if (level !== lastFocusLevel) { hideTip(); lastFocusLevel = level; }
    floorGroups.forEach(f => {
      const on = level !== 0 && f.level === level;
      f.labels.forEach(l => l.visible = on && !l.userData.hidden);
      (f.own || []).forEach(m => { m.visible = on && S.ductsOn; });
      if (f.equips) f.equips.forEach(e => { e.visible = on; });
    });
    /* 管线跟楼层走：聚焦 3F 就只画 3F 的管；全楼视角才画全部 */
    eFloorOnly = level || 0;
    eApplyVis();
    applyBody();
    if (D() && D().apply) D().apply();       // 吊顶/家具跟着聚焦一起显隐
    /* 配电箱按楼层跟着走：切到 2F 就只留 2F 那只箱子。
       少了这一步，从 2F 切到 3F 时 2F 的箱子还挂在半空中。 */
    syncPanels();
    labelLive = [];
    floorGroups.forEach(f => {
      const on = level !== 0 && f.level === level;
      if (!on) return;
      f.labels.forEach(l => { if (l.visible) labelLive.push(l); });
      (f.equips || []).forEach(g => g.children.forEach(c => { if (c.isSprite && g.visible) labelLive.push(c); }));
    });
    if (animate !== false) {
      if (level) {
        const f = floorGroups.find(x => x.level === level);
        const v = VIEWS.floor(f.elev);
        flyTo(v.p, v.t);
      } else S.viewAll();
    }
  };

  function setOpacity(mats, v) {
    Object.values(mats).forEach(m => {
      const base = m.userData.baseOpacity == null ? 1 : m.userData.baseOpacity;
      m.opacity = base * v;
      m.transparent = v < .999 || base < 1;
      m.depthWrite = v > .6;
      m.needsUpdate = true;
    });
  }

  /* 只压"楼体"这几样：墙、楼板、梁、柱、门。
     吊顶/家具/风管/玻璃不参与 —— 半透明的物件越多，深度排序和重绘越贵，
     而用户说的"50% 半透明的墙体和顶梁"本来也不包括桌椅吊顶。 */
  const BODY_KEYS = ['wallExt', 'wallInt', 'slab', 'col', 'beam', 'door'];
  function setBodyOpacity(mats, v) {
    BODY_KEYS.forEach(k => {
      const m = mats[k];
      if (!m) return;
      const base = m.userData.baseOpacity == null ? 1 : m.userData.baseOpacity;
      m.opacity = base * v;
      m.transparent = v < .999 || base < 1;
      m.depthWrite = v > .6;
      m.needsUpdate = true;
    });
  }

  S.focusRoom = function (room, animate) {
    S.setFocus(room.floor, false);
    if (animate !== false) S.focusBounds(room.floor, room.x0 - .5, room.y0 - .5, room.x1 + .5, room.y1 + .5);
  };

  /* ---------------- 高亮 ---------------- */
  function disposeHl() {
    if (!hl) return;
    scene.remove(hl);
    hl.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    hl = null;
  }
  S.clearHighlight = disposeHl;

  S.highlightRoom = function (room, color) {
    disposeHl();
    const c = new THREE.Color(color || 0x10a394);
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry((room.x1 - room.x0) * .96, .05, (room.y1 - room.y0) * .96);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .3, depthWrite: false }));
    m.position.set((room.x0 + room.x1) / 2, room.elev + .04, -(room.y0 + room.y1) / 2);
    g.add(m);
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: .95 }));
    line.position.copy(m.position); g.add(line);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 2.4, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .3, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set((room.x0 + room.x1) / 2, room.elev + 1.2, -(room.y0 + room.y1) / 2);
    g.add(beam);
    g.userData = { m, line, beam };
    scene.add(g); hl = g;
  };

  S.highlightWall = function (wall, color) {
    disposeHl();
    const c = new THREE.Color(color || 0x10a394);
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    const geo = boxGeo([{ size: [L, wall.h * .99, wall.t + .05], matrix: frame((ax + bx) / 2, (ay + by) / 2, wall.base + wall.h * .5, ux, uy) }]);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .10, depthWrite: false })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: .85 })));
    scene.add(g); hl = g;
  };

  S.highlightRooms = function (rooms, color) {
    disposeHl();
    if (!rooms || !rooms.length) return;
    const g = new THREE.Group();
    const c = new THREE.Color(color || 0xe08a2b);
    rooms.forEach(r => {
      const geo = new THREE.BoxGeometry((r.x1 - r.x0) * .96, .04, (r.y1 - r.y0) * .96);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .34, depthWrite: false }));
      m.position.set((r.x0 + r.x1) / 2, r.elev + .05, -(r.y0 + r.y1) / 2);
      g.add(m);
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c, opacity: .9, transparent: true }));
      line.position.copy(m.position); g.add(line);
    });
    scene.add(g); hl = g;
  };

  /* ---------------- 路由高亮（一段或多段风管） ---------------- */
  let routeOn = [];
  const routeMat = new THREE.MeshStandardMaterial({ color: 0xff8a1e, roughness: .35, metalness: .1 });
  routeMat.emissive = new THREE.Color(0x7a3b00);
  // 穿过吊顶也能看见的"透视"层
  const routeGhost = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: .5, depthTest: false, depthWrite: false });
  S.clearRoute = function () {
    routeOn.forEach(it => {
      if (it.ghost) { if (it.ghost.parent) it.ghost.parent.remove(it.ghost); }
      else if (it.mesh) it.mesh.material = it.mat;
    });
    routeOn = [];
  };
  /* ids 为空则清除；传 duct id 数组则高亮这些管段 */
  S.highlightRoute = function (ids) {
    S.clearRoute();
    if (!ids || !ids.length) return;
    ids.forEach(id => {
      const mesh = ductMeshById[id];
      if (!mesh) return;
      routeOn.push({ mesh: mesh, mat: mesh.material });
      mesh.material = routeMat;
      if (mesh.parent) {
        const gh = new THREE.Mesh(mesh.geometry, routeGhost);
        gh.position.copy(mesh.position);
        gh.rotation.copy(mesh.rotation);
        gh.scale.copy(mesh.scale);
        gh.renderOrder = 20;
        mesh.parent.add(gh);
        routeOn.push({ ghost: gh });
      }
    });
  };
  S.routeBounds = function (ids) {
    const xs = [], ys = [];
    (ids || []).forEach(id => {
      const d = M.ducts.find(x => x.id === id);
      if (!d) return;
      xs.push(d.a[0], d.b[0]); ys.push(d.a[1], d.b[1]);
    });
    if (!xs.length) return null;
    return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
  };

  /* ---------------- 换模型（导入 IFC 后重建场景） ---------------- */
  S.setModel = function (next) {
    disposeHl(); S.markDoorSpotClear(); S.clearRoute();
    window.BIM_MODEL = next;
    floorGroups.forEach(f => {
      f.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.map) o.material.map.dispose();
      });
      scene.remove(f.g);
    });
    floorGroups = []; labelLive = []; lastFocusLevel = -1;
    Object.keys(reg).forEach(k => { reg[k] = []; });
    wallMeshById = {}; ductMeshById = {};
    if (D() && D().furnRects) D().furnRects = {};      // 换了模型，旧的家具落位表作废
    M = next; S.M = M;
    // 换模型（尤其导入 IFC）后设备库可能被换掉，医院那批型号要补回来
    if (D() && D().mergeLibrary) D().mergeLibrary(M);
    M.floors.forEach(fl => floorGroups.push(buildFloor(fl)));
    S.floors = floorGroups;
    if (roof) {
      scene.remove(roof);
      roof.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    roof = (D() && D().roof) ? D().roof(M) : null;
    if (roof) scene.add(roof);
    S.focus = 0;
    S.setFocus(0, false);
    S.viewAll();
    // 换了模型，墙里那些线管、配电箱全得按新几何重铺一遍
    if (E()) S.rebuildElectric();
  };

  /* ---------------- 设备 ---------------- */
  S.addEquipment = function (eq) {
    const fg = floorGroups.find(f => f.level === eq.floor) || floorGroups[0];
    const g = new THREE.Group();
    const dd = D();
    let parts = [], body = null;

    // 优先用 equip.js 的真实构造（外壳/格栅/风机/接管/控制屏…按材质合并成几片）
    if (dd && dd.equipMesh) {
      const mo = dd.equipMesh(eq);
      if (mo && mo.parts && mo.parts.length) {
        g.add(mo.group);
        parts = mo.parts;
        body = mo.main;
      }
    }
    // 兜底：老的单色盒子（equip.js 没加载或数据异常时也不至于空着）
    if (!parts.length) {
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(eq.color || '#4f7df3'), roughness: .5, metalness: .25 });
      const bodyGeo = new THREE.BoxGeometry(eq.w, eq.h, eq.d);
      body = new THREE.Mesh(bodyGeo, mat);
      body.position.y = eq.h / 2;
      addEdges(body, bodyGeo, new THREE.LineBasicMaterial({ color: 0x2e3a46, transparent: true, opacity: .3 }));
      g.add(body);
      parts = [body];
    }
    parts.forEach(m => { m.userData = { kind: 'equip', data: eq, floor: eq.floor }; });

    // 落地阴影 / 机房设备基础
    const pad = new THREE.Mesh(new THREE.BoxGeometry(eq.w * 1.06, .015, eq.d * 1.06),
      new THREE.MeshBasicMaterial({ color: 0x21313d, transparent: true, opacity: .13, depthWrite: false }));
    pad.position.y = .008;

    const sp = labelSprite(eq.name, 1.75);
    sp.position.y = eq.h + .95;

    g.add(pad, sp);
    g.position.set(eq.x, eq.floorElev, -eq.y);
    // 靠墙放的设备把正面转向房间（不然检修门/控制屏冲着墙）
    if (dd && dd.equipRot) {
      const r = dd.equipRot(eq, M);
      if (r) g.rotation.y = r;
    }
    eq.rotApplied = g.rotation.y;
    g.userData.room = eq.room;
    fg.g.add(g);
    // 设备标签与房间号标签错开：设备所在房间的房间号让位
    const rl = fg.labels.find(l => l.userData.room === eq.room);
    if (rl) { rl.userData.hidden = true; rl.visible = false; }
    fg.equips = fg.equips || [];
    fg.equips.push(g);
    if (S.focus === eq.floor) labelLive.push(sp);
    reg.equip.push.apply(reg.equip, parts);
    eq._obj = g; eq._body = body; eq._parts = parts;
    return g;
  };

  S.removeEquipment = function (eq) {
    const fg = floorGroups.find(f => f.level === eq.floor);
    if (fg && fg.equips) fg.equips = fg.equips.filter(g => g !== eq._obj);
    if (eq._obj) { eq._obj.parent.remove(eq._obj); eq._obj.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    const parts = eq._parts || (eq._body ? [eq._body] : []);
    reg.equip = reg.equip.filter(b => parts.indexOf(b) < 0);
    eq._obj = null; eq._body = null; eq._parts = null;
    if (fg && fg.equips && fg.labels) {
      const still = fg.equips.some(g => g.userData.room === eq.room);
      const rl = fg.labels.find(l => l.userData.room === eq.room);
      if (rl && !still) { rl.userData.hidden = false; rl.visible = S.focus === fg.level; }
    }
  };

  /* ---------------- 门 ---------------- */
  S.addDoorOpening = function (wall, at, w, h) {
    const op = { kind: 'door', at: at, w: w, h: h, sill: 0, name: 'M' + Math.round(w * 1000) + Math.round(h * 100), added: true };
    wall.openings.push(op);
    S.rebuildWall(wall);
    // 同步到全局门记录
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    const d = {
      id: 'D-' + wall.id + '-' + Math.round(at * 100), kind: 'door', floor: wall.floor, wall: wall.id,
      name: op.name, pos: [ax + ux * at, ay + uy * at, wall.base], w: w, h: h, sill: 0,
      rooms: wall.rooms.slice(), dir: [ux, uy], t: wall.t, added: true
    };
    M.doors.push(d);
    op.ref = d.id;                 // 反查：改这扇门时 C.door 要跳过它自己
    const fg = floorGroups.find(f => f.level === wall.floor);
    const mesh = buildDoorMesh(d, fg.mats);
    fg.g.add(mesh);
    d._mesh = mesh;
    return d;
  };

  /* ---------------- 空间打穿（没有门扇的大洞口） ----------------
     复用墙上的洞口机制：洞口做到指定高度后，wallBoxes() 自然只留下两侧墙垛和
     上方过梁，不用真把墙"切成两段"。切段会牵动所有按 wall.id 索引的东西
     （高亮、隔离、碰撞、开洞校核），得不偿失。 */
  S.addPassage = function (wall, at, w, h, opt) {
    h = h == null ? 2.2 : h;
    const op = {
      kind: 'passage', at: at, w: w, h: h, sill: 0,
      name: 'P' + Math.round(w * 1000) + Math.round(h * 100), added: true
    };
    wall.openings.push(op);
    S.rebuildWall(wall);
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const p = {
      id: 'P-' + wall.id + '-' + Math.round(at * 100), kind: 'passage', floor: wall.floor,
      wall: wall.id, name: op.name, pos: [ax + ux * at, ay + uy * at, wall.base],
      w: w, h: h, sill: 0, rooms: wall.rooms.slice(), dir: [ux, uy], t: wall.t, added: true,
      to: (opt && opt.to) || null, demolish: !!(opt && opt.demolish),
      /* 只记"这两间"（不是 wall.rooms）。一面长墙常常串着五六间房，
         拿 wall.rooms 去做"打通后连成一片"的判断，会把整排房都并进同一块板里。 */
      from: (opt && opt.from) || null,
      /* 整面拆掉的墙要留个记号：楼板校核靠它判断"这两间已经是一块板了" */
      merged: !!(opt && opt.demolish)
    };
    M.passages = M.passages || [];
    M.passages.push(p);
    op.ref = p.id;
    return p;
  };

  S.removePassage = function (p) {
    if (!p) return false;
    const wall = M.walls.find(w => w.id === p.wall);
    if (!wall) return false;
    const at = (p.pos[0] - wall.p1[0]) * p.dir[0] + (p.pos[1] - wall.p1[1]) * p.dir[1];
    const i = wall.openings.findIndex(o => o.kind === 'passage' && Math.abs(o.at - at) < 0.06 && Math.abs(o.w - p.w) < 0.05);
    if (i < 0) return false;
    wall.openings.splice(i, 1);
    S.rebuildWall(wall);
    M.passages = (M.passages || []).filter(x => x !== p);
    return true;
  };

  /* ---------------- 窗：开 / 拆 / 改 ---------------- */
  S.addWindowOpening = function (wall, at, w, h, sill) {
    sill = sill == null ? 0.9 : sill;
    const op = {
      kind: 'window', at: at, w: w, h: h, sill: sill,
      name: 'C' + Math.round(w * 1000) + Math.round((sill + h) * 100), added: true
    };
    wall.openings.push(op);
    S.rebuildWall(wall);
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    const d = {
      id: 'C-' + wall.id + '-' + Math.round(at * 100), kind: 'window', floor: wall.floor, wall: wall.id,
      name: op.name, pos: [ax + ux * at, ay + uy * at, wall.base], w: w, h: h, sill: sill,
      rooms: wall.rooms.slice(), dir: [ux, uy], t: wall.t, added: true
    };
    M.windows.push(d);
    op.ref = d.id;
    const fg = floorGroups.find(f => f.level === wall.floor);
    const wg = (D() && D().windowMesh) ? D().windowMesh(d, fg.mats) : buildWindowMesh(d, fg.mats);
    wg.name = 'win-' + d.id;
    wg.traverse(o => { if (o.isMesh) reg.window.push(o); });
    fg.g.add(wg);
    return d;
  };

  S.windowAt = function (d, wall) {
    wall = wall || M.walls.find(w => w.id === d.wall);
    if (!wall) return null;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    return (d.pos[0] - ax) * ux + (d.pos[1] - ay) * uy;
  };

  S.removeWindow = function (d) {
    if (!d) return false;
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) return false;
    const at = S.windowAt(d, wall);
    const i = wall.openings.findIndex(o => o.kind === 'window' && Math.abs(o.at - at) < 0.06 && Math.abs(o.w - d.w) < 0.05);
    if (i < 0) return false;
    wall.openings.splice(i, 1);
    S.rebuildWall(wall);
    if (d._mesh) {
      const fg = floorGroups.find(f => f.level === wall.floor);
      const g = d._mesh;
      if (g.parent) g.parent.remove(g);
      g.traverse(o => {
        if (o.isMesh) {
          reg.window = reg.window.filter(x => x !== o);
          if (o.geometry) o.geometry.dispose();
        }
      });
      d._mesh = null;
    }
    M.windows = M.windows.filter(x => x !== d);
    return true;
  };

  S.replaceWindow = function (d, opt) {
    const wall0 = M.walls.find(w => w.id === d.wall);
    if (!wall0) return null;
    const at0 = S.windowAt(d, wall0);
    const wall = (opt && opt.wall) || wall0;
    const at = (opt && opt.at != null) ? opt.at : at0;
    const w = (opt && opt.w) || d.w;
    const h = (opt && opt.h) || d.h;
    const sill = (opt && opt.sill != null) ? opt.sill : d.sill;
    const keepRoom = d.room;
    if (!S.removeWindow(d)) return null;
    const nd = S.addWindowOpening(wall, at, w, h, sill);
    if (nd && keepRoom) nd.room = keepRoom;
    return nd;
  };

  /* ---------------- 展示层开关 ---------------- */
  S.setCeiling = function (on) { if (D() && D().setCeiling) D().setCeiling(on); };
  S.setFurniture = function (on) { if (D() && D().setFurniture) D().setFurniture(on); };
  S.setFlow = function (on) { if (D() && D().setFlow) D().setFlow(on); };

  S.rebuildWall = function (wall) {
    const old = wallMeshById[wall.id];
    const fg = floorGroups.find(f => f.level === wall.floor);
    const mesh = buildWallMesh(wall, fg.mats);
    fg.g.add(mesh);
    wallMeshById[wall.id] = mesh;          // 换过墙就得更新索引，否则"只显示这间"会藏错对象
    if (old) {
      fg.g.remove(old);
      old.geometry.dispose();
      reg.wall = reg.wall.filter(m => m !== old);
    }
  };

  /* 门在墙上的位置参数（沿墙长度方向，从 p1 起算） */
  S.doorAt = function (d, wall) {
    wall = wall || M.walls.find(w => w.id === d.wall);
    if (!wall) return null;
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    return (d.pos[0] - ax) * ux + (d.pos[1] - ay) * uy;
  };

  S.wallLen = function (wall) {
    return Math.hypot(wall.p2[0] - wall.p1[0], wall.p2[1] - wall.p1[1]) || 1;
  };

  /* 沿墙单位向量：门"往左/往右挪"要投影到这个方向上 */
  S.wallAxis = function (wall) {
    const L = S.wallLen(wall);
    return { x: (wall.p2[0] - wall.p1[0]) / L, y: (wall.p2[1] - wall.p1[1]) / L, L: L };
  };

  /* 删掉一扇（自己开的）门：墙体洞口一起拆掉，墙按原来的样子重建 */
  S.removeDoor = function (d) {
    if (!d) return false;
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) return false;
    const at = S.doorAt(d, wall);
    const i = wall.openings.findIndex(o => o.kind === 'door' && Math.abs(o.at - at) < 0.06 && Math.abs(o.w - d.w) < 0.05);
    if (i < 0) return false;
    wall.openings.splice(i, 1);
    S.rebuildWall(wall);
    if (d._mesh) {
      const fg = floorGroups.find(f => f.level === wall.floor);
      if (fg && d._mesh.parent) fg.g.remove(d._mesh);
      d._mesh.traverse && d._mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      d._mesh = null;
    }
    M.doors = M.doors.filter(x => x !== d);
    return true;
  };

  /* 改组 / 改宽 / 换墙：本质是拆了按新参数重开，保证洞口、门扇、全局记录一致 */
  S.replaceDoor = function (d, opt) {
    const wall0 = M.walls.find(w => w.id === d.wall);
    if (!wall0) return null;
    const at0 = S.doorAt(d, wall0);
    const wall = (opt && opt.wall) || wall0;
    const at = (opt && opt.at != null) ? opt.at : at0;
    const w = (opt && opt.w) || d.w;
    const h = (opt && opt.h) || d.h;
    const keepRoom = d.room;          // 记住"当初是为哪间房开的"，长墙上尤其重要
    if (!S.removeDoor(d)) return null;
    const nd = S.addDoorOpening(wall, at, w, h);
    if (nd && keepRoom) nd.room = keepRoom;
    return nd;
  };

  /* ---------------- 视图：聚焦 / 隔离 / 不打断用户的视角 ----------------
     用户转过相机以后不能再硬拉回去，所以先判断"目标是不是已经在画面里"，
     在画面里就只调高亮和显隐；不在才动相机，而且保持原来的观察方向。 */
  /* 目标是不是"看得清"：四个角都在画面里，而且占屏够大。
     只看"在不在画面里"是不够的——从全楼视角看，房间确实在画面里，但只有指甲盖大，
     用户会觉得"根本没聚焦"。所以再加一条：投影面积至少占屏 minArea（默认 0）。 */
  S.inView = function (floor, x0, y0, x1, y1, pad, minArea) {
    const f = floorGroups.find(q => q.level === floor);
    if (!f || !camera || !renderer) return true;
    const r = renderer.domElement.getBoundingClientRect();
    const p = pad == null ? 0.06 : pad;
    let inside = true, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]].forEach(([x, y]) => {
      const v = new THREE.Vector3(x, f.elev + .4, -y).project(camera);
      const sx = (v.x * .5 + .5), sy = (-v.y * .5 + .5);
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      if (sx < p || sx > 1 - p || sy < p || sy > 1 - p || v.z > 1) inside = false;
    });
    if (!inside) return false;
    const need = minArea == null ? 0 : minArea;
    if (need && (maxX - minX) * (maxY - minY) < need) return false;
    return true;
  };

  S.frameBounds = function (floor, x0, y0, x1, y1, keepAngle, minPitch) {
    const f = floorGroups.find(q => q.level === floor);
    if (!f || !camera) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const w = Math.max(x1 - x0, 5), d = Math.max(y1 - y0, 5);
    const asp = camera.aspect || 1.4, fov = camera.fov * Math.PI / 180;
    const need = Math.max(w / Math.max(asp, .62), d * 1.35) * 1.15;
    const D = Math.min(95, Math.max(11, need / (2 * Math.tan(fov / 2)) * 1.2));
    const t = new THREE.Vector3(cx, f.elev + .5, -cy);
    // 俯角下限：贴地看只会看见近处那面墙，看不见房间里面。
    // 只看一间时要更高一些——墙 3.3 m 高，俯角 35° 时墙后 4.7 m 都还是盲区，
    // 贴着墙放的设备正好躲在里头，用户会说"我放的东西呢"
    const MINP = minPitch == null ? .58 : minPitch;
    let dir;
    if (keepAngle) {
      dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(.12, .82, .57);
      dir.normalize();
      if (dir.y < MINP) { dir.y = MINP; dir.normalize(); }
    } else {
      dir = new THREE.Vector3(.12, Math.max(.82, MINP), .57).normalize();
    }
    flyTo(t.clone().add(dir.multiplyScalar(D)), t, 620);
  };

  /* ---------------- 通用构件定位（模型树点节点走这条） ----------------
     reg 里每片 mesh 都挂着 userData.data，按 data 身份找回网格 → 算世界包围盒 →
     画一个呼吸的定位框 + 把相机推过去。墙/门/窗/风管/阀/柱/梁/设备/楼板一套走完，
     不用为每种构件单写高亮，也不会跟已有的 isolate / highlight 打架。 */
  const THING_REG = {
    slab: 'slab', wall: 'wall', door: 'door', window: 'window',
    duct: 'duct', valve: 'valve', equip: 'equip', column: 'col', beam: 'beam'
  };
  function thingMeshes(kind, data) {
    const arr = reg[THING_REG[kind] || kind] || [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i].userData;
      if (u && u.data === data) out.push(arr[i]);
    }
    return out;
  }
  S.thingMeshes = thingMeshes;

  S.boundsOfThing = function (kind, data) {
    const ms = thingMeshes(kind, data);
    if (!ms.length) return null;
    const box = new THREE.Box3();
    ms.forEach(m => {
      m.updateWorldMatrix(true, false);
      box.expandByObject(m);
    });
    if (box.isEmpty()) return null;
    return { x0: box.min.x, x1: box.max.x, y0: -box.max.z, y1: -box.min.z, z0: box.min.y, z1: box.max.y };
  };

  /* 一批包围盒 → 一个高亮组（半透明体 + 描边） */
  function hlGroup(boxes, color) {
    const c = new THREE.Color(color === undefined ? 0x10a394 : color);
    const g = new THREE.Group();
    const fillMat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .13, depthWrite: false });
    // 描边不吃深度：被设备挡住的那一处也能看见框，不然"撞到哪儿"永远看不见
    const lineMat = new THREE.LineBasicMaterial({
      color: c, transparent: true, opacity: .9, depthTest: false, depthWrite: false
    });
    boxes.forEach(b => {
      const size = new THREE.Vector3(), ctr = new THREE.Vector3();
      b.box.getSize(size); b.box.getCenter(ctr);
      size.x = Math.max(size.x, .12); size.y = Math.max(size.y, .12); size.z = Math.max(size.z, .12);
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const fill = new THREE.Mesh(geo, fillMat);
      fill.position.copy(ctr); g.add(fill);
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat);
      line.position.copy(ctr); g.add(line);
    });
    g.userData = { unit: 0 };
    scene.add(g); hl = g;
    return g;
  }

  S.markThing = function (kind, data, color) {
    disposeHl();
    const ms = thingMeshes(kind, data);
    if (!ms.length) return null;
    const box = new THREE.Box3();
    ms.forEach(m => { m.updateWorldMatrix(true, false); box.expandByObject(m); });
    if (box.isEmpty()) return null;
    const g = hlGroup([{ box: box }], color);
    return { box: box, group: g };
  };

  /* 一组构件一起描红（碰撞时把撞到的柱/管/门/家具全框出来）。
     items 支持两种：{kind,data} 从 reg 里找网格；{box:{x0,x1,y0,y1,z0,z1}} 直接给 BIM 包围盒
     （家具是合并 mesh，量不出单件，只能靠家具落位表给出矩形）。 */
  S.markConflicts = function (items, color) {
    disposeHl();
    const boxes = [];
    (items || []).forEach(it => {
      if (!it) return;
      if (it.box) {
        const r = it.box;
        boxes.push({
          box: new THREE.Box3(
            new THREE.Vector3(r.x0, r.z0 == null ? r.y0 : r.z0, -r.y1),
            new THREE.Vector3(r.x1, r.z1 == null ? r.y1 : r.z1, -r.y0)
          )
        });
        return;
      }
      if (!it.kind || !it.data) return;
      const ms = thingMeshes(it.kind, it.data);
      if (!ms.length) return;
      const box = new THREE.Box3();
      ms.forEach(m => { m.updateWorldMatrix(true, false); box.expandByObject(m); });
      if (!box.isEmpty()) boxes.push({ box: box });
    });
    return boxes.length ? hlGroup(boxes, color) : null;
  };

  S.markThings = function (list, color) {
    disposeHl();
    const boxes = [];
    (list || []).forEach(it => {
      if (!it || !it.kind || !it.data) return;
      const ms = thingMeshes(it.kind, it.data);
      if (!ms.length) return;
      const box = new THREE.Box3();
      ms.forEach(m => { m.updateWorldMatrix(true, false); box.expandByObject(m); });
      if (!box.isEmpty()) boxes.push({ box: box });
    });
    return boxes.length ? hlGroup(boxes, color) : null;
  };

  /* 定位到单个构件：高亮 + 收楼层 + 推相机。keepAngle 保留当前视角方向。 */
  S.focusThing = function (kind, data, opt) {
    const o = opt || {};
    const b = S.markThing(kind, data, o.color);
    if (!b) return false;
    const floor = (data && data.floor) || S.focus || 0;
    if (o.floor !== false && floor && S.focus !== floor) S.setFocus(floor, false);
    const pad = o.pad == null ? .9 : o.pad;
    S.frameBounds(floor, b.box.min.x - pad, -b.box.max.z - pad, b.box.max.x + pad, -b.box.min.z + pad,
      o.keepAngle !== false, o.minPitch);
    return true;
  };

  /* 只看这一间：别的层整个藏掉；同层只留这间房的墙、门、楼板，
     别的房间的管道段、阀门、房间名也一起清掉——只藏墙的话，门板会悬在半空、
     一截截风管还插在画面里，看着就是"没清干净" */
  const ptInRoom = (room, p, tol) => {
    if (!p) return false;
    const t = tol == null ? .06 : tol;
    return p[0] >= room.x0 - t && p[0] <= room.x1 + t &&
           p[1] >= room.y0 - t && p[1] <= room.y1 + t;
  };
  // 风管一段可能横跨好几间，端点都落在外面时再看中点/四分点，沾到一点就留
  const ductTouches = (room, d) => {
    if (ptInRoom(room, d.a) || ptInRoom(room, d.b)) return true;
    const mid = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
    const q1 = [(d.a[0] + mid[0]) / 2, (d.a[1] + mid[1]) / 2];
    const q3 = [(mid[0] + d.b[0]) / 2, (mid[1] + d.b[1]) / 2];
    return ptInRoom(room, mid) || ptInRoom(room, q1) || ptInRoom(room, q3);
  };
  const slabTouches = (room, s) => {
    if (!s) return false;
    const ox = Math.min(room.x1, s.x1) - Math.max(room.x0, s.x0);
    const oy = Math.min(room.y1, s.y1) - Math.max(room.y0, s.y0);
    if (ox <= 0 || oy <= 0) return false;
    const ar = Math.max(1e-6, (room.x1 - room.x0) * (room.y1 - room.y0));
    const cover = ox * oy / ar;             // 盖住这间房多少
    return cover > .35;
  };
  S.isolateRoom = function (room, on) {
    const dropTemp = () => {
      isoTemp.forEach(o => {
        o.traverse(c => { if (c.geometry) c.geometry.dispose(); });
        if (o.parent) o.parent.remove(o);
      });
      isoTemp = [];
    };
    if (!on || !room) {
      isoHidden.forEach(o => { o.visible = !(o.userData && o.userData.hidden); });
      isoHidden = [];
      M.walls.forEach(w => { w.isolateHidden = false; });
      Object.keys(wallMeshById).forEach(id => { const m = wallMeshById[id]; if (m) m.visible = true; });
      floorGroups.forEach(f => (f.equips || []).forEach(g => { g.visible = true; }));
      dropTemp();
      S.isoRoom = null;
      S.setFocus(0);
      S.setDuctsVisible(S.ductsOn);
      if (D() && D().apply) D().apply();
      return;
    }
    S.isoRoom = room.id;
    S.setFocus(room.floor, false);
    dropTemp();
    isoHidden = [];
    const hideIf = o => { if (o && o.visible) { o.visible = false; isoHidden.push(o); } };
    // 房间在某面墙上的投影区间（沿墙轴的距离）
    const spanOnWall = (w) => {
      const [ax, ay] = w.p1, [bx, by] = w.p2;
      const L = Math.hypot(bx - ax, by - ay) || 1e-6, ux = (bx - ax) / L, uy = (by - ay) / L;
      let lo = Infinity, hi = -Infinity;
      [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]].forEach(([x, y]) => {
        const t = (x - ax) * ux + (y - ay) * uy;
        lo = Math.min(lo, t); hi = Math.max(hi, t);
      });
      return [Math.max(0, lo - .02), Math.min(L, hi + .02), L];
    };
    floorGroups.forEach(f => {
      if (f.level !== room.floor) { f.g.visible = false; return; }
      f.g.visible = true;
      const ofKind = k => { const a = []; f.g.traverse(o => { if (o.userData && o.userData.kind === k) a.push(o); }); return a; };
      ofKind('slab').forEach(m => { if (!slabTouches(room, m.userData.data)) hideIf(m); });
      // 墙：留围出这间房的（含与隔壁共享的那面）。
      // 一面 33 m 的长墙串着 5 间房，整面留着画面还是"整层"，
      // 所以超范围的就造一段"房间这一截"顶上，原墙藏掉。
      Object.keys(wallMeshById).forEach(id => {
        const w = M.walls.find(x => x.id === id);
        const keep = !!w && (w.rooms || []).indexOf(room.id) >= 0;
        if (w) w.isolateHidden = !keep;
        const m = wallMeshById[id];
        if (!m) return;
        if (!keep) { hideIf(m); return; }
        const [lo, hi, L] = spanOnWall(w);
        if (hi - lo >= L - .08) { m.visible = true; return; }   // 本来就在房间范围内
        hideIf(m);
        const geo = boxGeo(wallBoxes(w, [lo, hi]));
        const seg = new THREE.Mesh(geo, w.kind === 'ext' ? f.mats.wallExt : f.mats.wallInt);
        seg.userData = { kind: 'wallseg', data: w, floor: w.floor };
        addEdges(seg, geo, edgeMat);
        f.g.add(seg); isoTemp.push(seg);
      });
      // 门：开在这间房的墙上才留。不能只看 d.rooms —— 那是跟着整面长墙继承的，
      // 33 m 一条墙串 5 间房，5 个门会全算进来，得看门本身站在哪儿
      ofKind('door').forEach(m => {
        const d = m.userData.data || {};
        if (ptInRoom(room, d.pos, .35)) m.visible = true; else hideIf(m);
      });
      // 窗：同上
      ofKind('window').forEach(m => {
        const d = m.userData.data || {};
        if (ptInRoom(room, d.pos, .35)) m.visible = true; else hideIf(m);
      });
      // 柱：柱心落在这间房（含角上那根）
      ofKind('column').forEach(m => {
        const c = m.userData.data || {};
        if (ptInRoom(room, [c.x, c.y], .45)) m.visible = true; else hideIf(m);
      });
      // 梁：压在这间房顶上那一段，超长就裁一段出来
      ofKind('beam').forEach(m => {
        const d = m.userData.data || {};
        const [ax, ay] = d.a, [bx, by] = d.b;
        const len = Math.hypot(bx - ax, by - ay) || 1e-6;
        const ux = (bx - ax) / len, uy = (by - ay) / len;
        // 先看它是不是压在房间头顶上：沿 x 的梁比 y，沿 y 的梁比 x，
        // 不然隔着好几间的梁也会因为"投影有重叠"被留下
        const alongX = Math.abs(ux) >= Math.abs(uy);
        const perp = alongX ? ay : ax;
        const pmin = alongX ? room.y0 : room.x0, pmax = alongX ? room.y1 : room.x1;
        if (perp < pmin - .45 || perp > pmax + .45) { hideIf(m); return; }
        let lo = Infinity, hi = -Infinity;
        [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]].forEach(([x, y]) => {
          const t = (x - ax) * ux + (y - ay) * uy;
          lo = Math.min(lo, t); hi = Math.max(hi, t);
        });
        lo = Math.max(0, lo - .02); hi = Math.min(len, hi + .02);
        if (hi - lo <= .02) { hideIf(m); return; }
        if (hi - lo >= len - .08) { m.visible = true; return; }
        hideIf(m);
        const geo = new THREE.BoxGeometry(hi - lo, d.h, d.w);
        const seg = new THREE.Mesh(geo, m.material);
        seg.position.set(ax + ux * (lo + hi) / 2, d.a[2] - d.h / 2, -(ay + uy * (lo + hi) / 2));
        seg.rotation.y = Math.atan2(uy, ux);
        seg.userData = { kind: 'beamseg', data: d, floor: d.floor };
        f.g.add(seg); isoTemp.push(seg);
      });
      // 风管段
      ofKind('duct').forEach(m => {
        const d = m.userData.data || {};
        if (ductTouches(room, d)) { if (S.ductsOn) m.visible = true; } else hideIf(m);
      });
      // 阀门
      ofKind('valve').forEach(m => {
        const v = m.userData.data || {};
        if (v.room === room.id) { if (S.ductsOn) m.visible = true; } else hideIf(m);
      });
      // 房间名：只留这间的（被设备占掉的保持不显示）
      f.labels.forEach(l => {
        if (l.userData.room === room.id) { l.visible = !l.userData.hidden; }
        else hideIf(l);
      });
      // 设备
      (f.equips || []).forEach(g => {
        if (g.userData.room === room.id) g.visible = true; else hideIf(g);
      });
    });
    // 吊顶 / 家具 / 地面面层：只留这一间的
    if (D() && D().apply) D().apply();
  };

  /* 现在的观察方向（给人看的，也给大模型判断"往左是哪边"） */
  S.viewInfo = function () {
    const ax = S.viewAxes();
    const nm = v => (v.y > .42 ? '北' : v.y < -.42 ? '南' : v.x > 0 ? '东' : '西');
    return {
      floor: S.focus || 0,
      xray: !!S.xray,
      looking: nm(ax.fwd),          // 镜头朝着哪
      rightIs: nm(ax.right),        // 屏幕右边是哪
      axes: ax
    };
  };

  /* ---------------- 阀件 ---------------- */
  S.setValve = function (v, open) {
    v.open = open;
    if (v._mat) v._mat.color.set(open ? COL.valveOpen : COL.valveClosed);
    if (D() && D().touch) D().touch();          // 阀一动，流向箭头要重算
  };

  S.ductsOn = true;

  /* 用射线与该房间各面墙求交，取最近的墙和沿墙位置（比直接取命中点稳，斜视角也不偏） */
  const _pl = new THREE.Plane(), _hitP = new THREE.Vector3();
  S.pickWallOfRoom = function (room, ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ptr.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ptr, camera);
    let best = null;
    Object.keys(room.sides || {}).forEach(k => {
      const wid = room.sides[k];
      const w = M.walls.find(x => x.id === wid);
      if (!w) return;
      const [ax, ay] = w.p1, [bx, by] = w.p2;
      const L = Math.hypot(bx - ax, by - ay);
      if (L < .1) return;
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      _pl.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(uy, 0, ux).normalize(),
        new THREE.Vector3(ax, w.base + w.h / 2, -ay)
      );
      if (!raycaster.ray.intersectPlane(_pl, _hitP)) return;
      const at = (_hitP.x - ax) * ux + (-_hitP.z - ay) * uy;
      const hgt = _hitP.y - w.base;
      if (at < 0.02 || at > L - 0.02 || hgt < 0 || hgt > w.h + .2) return;
      const d = raycaster.ray.origin.distanceTo(_hitP);
      if (!best || d < best.d) best = { wall: w, at: at, d: d, side: k };
    });
    return best;
  };

  S.setDuctsVisible = function (on) {
    S.ductsOn = on;
    floorGroups.forEach(f => {
      if (f.g.userData.ducts) f.g.userData.ducts.visible = on;
      // 阀门跟 setFocus 保持一致：只有聚焦到某一层才显示，全楼视角下藏起来
      (f.own || []).forEach(m => { m.visible = on && S.focus !== 0 && f.level === S.focus; });
    });
    // 隔离状态下切管线：刚才被清掉的别的房间的管道别再冒出来
    if (S.isoRoom) {
      const r = M.rooms.find(x => x.id === S.isoRoom);
      if (r) S.isolateRoom(r, true);
    }
    if (D() && D().apply) D().apply();
  };

  /* ---------------- 拾取 ---------------- */
  let downPos = null, downT = 0, hoverT = 0;
  function onDown(e) { downPos = { x: e.clientX, y: e.clientY }; downT = performance.now(); hideTip(); }

  function onUp(e) {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5 || performance.now() - downT > 900;
    downPos = null;
    if (moved) return;
    const hits = raycastAll(e);
    if (S.onPick) S.onPick(hits[0] || null, hits, e);
  }

  function raycastAll(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ptr, camera);
    const raw = raycaster.intersectObjects(pickables(), false);
    const out = [];
    for (const h of raw) {
      const ud = h.object.userData;
      if (!ud || !ud.kind) continue;
      out.push({ kind: ud.kind, data: ud.data, obj: h.object, x: h.point.x, y: -h.point.z, z: h.point.y });
      if (out.length >= 8) break;
    }
    return out;
  }
  S.raycastAll = raycastAll;

  function onFloor(o) { return !S.focus || o.userData.floor === S.focus; }
  function visible(o) { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } return true; }

  function pickables() {
    const map = { place: reg.slab, door: reg.wall, window: reg.wall, valve: reg.valve, equip: reg.equip };
    const list = map[S.mode] || reg.slab.concat(reg.wall, reg.door, reg.window, reg.equip, reg.valve, reg.duct);
    return list.filter(m => visible(m) && onFloor(m));
  }

  function onMove(e) {
    const now = performance.now();
    if (now - hoverT < 60) return;
    hoverT = now;
    const hit = raycastAll(e)[0] || null;
    if (hit) {
      renderer.domElement.style.cursor = 'pointer';
      showTip(e, tipText(hit));
    } else {
      renderer.domElement.style.cursor = (S.mode === 'place' || S.mode === 'door') ? 'crosshair' : 'grab';
      hideTip();
    }
  }

  function tipText(hit) {
    const d = hit.data;
    if (hit.kind === 'slab') return d.room + ' 楼板';
    if (hit.kind === 'wall') return d.name;
    if (hit.kind === 'door') return d.name;
    if (hit.kind === 'window') return (d.name || '窗') + ' · ' + (d.w || 0).toFixed(2) + '×' + (d.h || 0).toFixed(2) + ' m' + (d.sill ? ' 台高 ' + d.sill.toFixed(2) : '');
    if (hit.kind === 'valve') return d.name;
    if (hit.kind === 'equip') return d.name;
    if (hit.kind === 'duct') return d.name || '风管';
    return '';
  }

  function showTip(e, t) {
    const el = document.getElementById('tip'); if (!el) return;
    el.textContent = t; el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px';
    el.classList.add('show');
  }
  function hideTip() { const el = document.getElementById('tip'); if (el) el.classList.remove('show'); }
  S.hideTip = hideTip;

  /* ---------------- 循环 ---------------- */
  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now();
    if (anim) {
      const k = Math.min(1, (t - anim.t0) / anim.ms);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(anim.p0, anim.p1, e);
      controls.target.lerpVectors(anim.q0, anim.q1, e);
      if (k >= 1) anim = null;
    }
    if (hl && hl.userData.m) {
      const s = .5 + .5 * Math.sin(t / 420);
      hl.userData.m.material.opacity = .16 + .18 * s;
      hl.userData.line.material.opacity = .6 + .4 * s;
      hl.userData.beam.material.opacity = .14 + .16 * s;
    }
    controls.update();
    scaleLabels();
    tickFlow(t);
    if (D() && D().update) D().update(t, camera);
    renderer.render(scene, camera);
  }


  /* ---------------- 透视 / 门位标记 ---------------- */
  S.xray = false;
  /* 看管线时把楼体压透明。具体压成多少由 applyBody 统一算：
     全楼视角看所有管线 → 整栋 20%；聚焦某层看管线 → 本层 0.42、别层 50%。 */
  S.setXray = function (on) {
    S.xray = on;
    applyBody();
  };

  let doorMark = null;
  S.markDoorSpotClear = function () {
    if (doorMark) { scene.remove(doorMark); doorMark.traverse(o => { if (o.geometry) o.geometry.dispose(); }); doorMark = null; }
  };
  S.markDoorSpot = function (wall, at, w, h, ok) {
    S.markDoorSpotClear();
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    const c = new THREE.Color(ok ? 0x10a394 : 0xdd534f);
    const geo = boxGeo([{ size: [w, h * .98, wall.t + .07], matrix: frame(ax + ux * at, ay + uy * at, wall.base + h * .49, ux, uy) }]);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: ok ? .12 : .34, depthWrite: false })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c })));
    scene.add(g); doorMark = g;
  };

  /* ---------------- 四周净距的虚框标注 ----------------
     问"这台设备旁边还有多少空间"时，在楼板上画出四块虚框色带：
     设备轮廓（蓝虚线）+ 四条从设备边铺到墙的余量带（带宽就是净距）+
     带中间标米数、正面标检修面。哪边宽哪边窄、差多少米，一眼看出来。 */
  let clrGroup = null;
  S.clearClearance = function () {
    if (!clrGroup) return;
    scene.remove(clrGroup);
    clrGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    clrGroup = null;
  };

  S.showClearance = function (room, eq, cl) {
    S.clearClearance();
    if (!room || !eq || !cl) return null;
    const Y = (room.elev || 0) + 0.06;
    const P = (bx, by) => new THREE.Vector3(bx, Y, -by);
    const g = new THREE.Group();

    const C_OK = 0x10a394, C_TIGHT = 0xdd9a2c, C_BAD = 0xdd534f;
    const colorOf = v => (v < 0.3 ? C_BAD : (v < 0.7 ? C_TIGHT : C_OK));
    const R = cl.rect;

    // 标签尺寸跟着房间走：6 m 的小房间用 1.25，30 m 的大开间得放大到 2.2，
    // 否则镜头拉到能看全房间的距离时，数字就成了一粒灰
    const span = Math.max(room.x1 - room.x0, room.y1 - room.y0, 4);
    const LW = Math.min(2.2, Math.max(1.05, span * 0.19));

    // depthTest 关掉：标注永远浮在楼板上面，不会被设备和家具挡住
    const dash = (pts, color, op) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({
        color: color, dashSize: 0.14, gapSize: 0.10,
        transparent: true, opacity: op == null ? 0.95 : op, depthTest: false, depthWrite: false
      });
      const l = new THREE.Line(geo, mat);
      l.computeLineDistances();
      l.renderOrder = 9;
      l.userData.dash = true;      // 统计用：不然 ArrowHelper 自带的线也算进虚线里
      return l;
    };
    // 半透明色带：这一侧的"余量"整块铺在地面上，比一条线更像"范围"
    const band = (x0, y0, x1, y1, color, op) => {
      const w = Math.max(x1 - x0, 0.001), d = Math.max(y1 - y0, 0.001);
      const geo = new THREE.PlaneGeometry(w, d);
      const mat = new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: op, depthTest: false, depthWrite: false, side: THREE.DoubleSide
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x0 + x1) / 2, Y - 0.01, -(y0 + y1) / 2);
      m.renderOrder = 6;
      m.userData.band = true;      // 统计用：不然 ArrowHelper 里的锥体也被算成色带
      return m;
    };

    // 1) 设备轮廓：所有距离都从这里量起
    g.add(dash([P(R.x0, R.y0), P(R.x1, R.y0), P(R.x1, R.y1), P(R.x0, R.y1), P(R.x0, R.y0)], 0x2f6df6, 0.95));

    // 2) 四条余量带：从设备边一直铺到对应的墙，带的宽度就是净距
    const sides = [
      { key: 'west',  v: cl.west.v,  cn: '左侧', box: [room.x0, R.y0, R.x0, R.y1], mid: [(room.x0 + R.x0) / 2, (R.y0 + R.y1) / 2] },
      { key: 'east',  v: cl.east.v,  cn: '右侧', box: [R.x1, R.y0, room.x1, R.y1], mid: [(R.x1 + room.x1) / 2, (R.y0 + R.y1) / 2] },
      { key: 'south', v: cl.south.v, cn: '南侧', box: [R.x0, room.y0, R.x1, R.y0], mid: [(R.x0 + R.x1) / 2, (room.y0 + R.y0) / 2] },
      { key: 'north', v: cl.north.v, cn: '北侧', box: [R.x0, R.y1, R.x1, room.y1], mid: [(R.x0 + R.x1) / 2, (R.y1 + room.y1) / 2] }
    ];
    sides.forEach(s => {
      const v = Math.max(0, s.v);
      const col = colorOf(v);
      const b = s.box;
      if (v > 0.04) {
        g.add(band(b[0], b[1], b[2], b[3], col, v < 0.3 ? 0.30 : (v < 0.7 ? 0.24 : 0.18)));   // 越窄越显眼
        g.add(dash([P(b[0], b[1]), P(b[2], b[1]), P(b[2], b[3]), P(b[0], b[3]), P(b[0], b[1])], col, 0.92));
      }
      // 数值标签。检修面那一侧直接标在同一个标签上——
      // 单独再画一个"检修面 x.xx m"会正好压在这条标签上，读出来是两个数叠在一起
      const isFace = s.key === cl.face;
      const txt = v < 0.05 ? '贴死' : ((isFace ? '检修面 ' : '') + v.toFixed(2) + ' m');
      const sp = labelSprite(txt, isFace ? LW * 1.12 : LW, {
        noDepth: true,
        bg: v < 0.05 ? 'rgba(221,83,79,.96)' : (v < 0.7 ? 'rgba(255,246,230,.97)' : 'rgba(240,252,250,.97)'),
        fg: v < 0.05 ? '#ffffff' : (v < 0.7 ? '#a86412' : '#0b7d72'),
        bd: isFace ? 'rgba(47,109,246,.85)' : (v < 0.05 ? 'rgba(255,255,255,.45)' : (v < 0.7 ? 'rgba(221,154,44,.75)' : 'rgba(16,163,148,.6)'))
      });
      sp.position.set(s.mid[0], Y + LW * 0.40, -s.mid[1]);
      sp.renderOrder = 13;
      g.add(sp);
      sp.userData.side = s.cn + (isFace ? '·检修面' : '');
    });

    // 3) 正面箭头：检修面朝哪边，就指哪边——那一边才需要留够空间
    const fc = { west: [-1, 0], east: [1, 0], south: [0, -1], north: [0, 1] }[cl.face] || [0, 1];
    const midX = (R.x0 + R.x1) / 2, midY = (R.y0 + R.y1) / 2;
    const halfW = Math.abs(fc[0]) > 0 ? (R.x1 - R.x0) / 2 : (R.y1 - R.y0) / 2;
    const sx = midX + fc[0] * halfW, sy = midY + fc[1] * halfW;
    const len = Math.max(LW * 0.8, Math.min(cl.faceV * 0.85, 1.6));
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(fc[0], 0, -fc[1]).normalize(),
      new THREE.Vector3(sx, Y + 0.03, -sy),
      len, 0x2f6df6, 0.22, 0.13
    );
    arrow.renderOrder = 10;
    g.add(arrow);

    scene.add(g);
    clrGroup = g;
    return g;
  };

  /* 当前标注里到底画了什么（自检/调试用，也给验收脚本数数） */
  S.clearanceInfo = function () {
    if (!clrGroup) return null;
    let lines = 0, sprites = 0, arrows = 0, bands = 0;
    clrGroup.traverse(o => {
      if (o.type === 'ArrowHelper') arrows++;
      else if (o.isSprite) sprites++;
      else if (o.isLine && o.userData.dash) lines++;
      else if (o.isMesh && o.userData.band) bands++;
    });
    return { lines: lines, sprites: sprites, arrows: arrows, bands: bands, children: clrGroup.children.length };
  };

  /* 每个净距标签在屏幕上实际占多少像素（验收/调试用）：
     世界尺寸对，"看起来"也可能小得读不出来——只有换成像素才是用户真实的观感 */
  S.clearanceScreen = function () {
    if (!clrGroup || !camera || !renderer) return null;
    const h = renderer.domElement.clientHeight || 0;
    const out = [];
    clrGroup.traverse(o => {
      if (!o.isSprite) return;
      const a = o.position.clone(); a.y -= o.scale.y / 2; a.project(camera);
      const b = o.position.clone(); b.y += o.scale.y / 2; b.project(camera);
      out.push({ side: o.userData.side || '', px: Math.round(Math.abs(b.y - a.y) * h / 2) });
    });
    return out;
  };

  S.focusAt = function (floor, x, y) {
    S.setFocus(floor, false);
    const f = floorGroups.find(q => q.level === floor);
    if (!f) return;
    flyTo(new THREE.Vector3(x + 8, f.elev + 14, -y + 11), new THREE.Vector3(x, f.elev + .6, -y), 700);
  };

  /* 把镜头放到房间内侧，正对这面墙看门 */
  S.focusDoor = function (wall, at, room) {
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const px = ax + ux * at, py = ay + uy * at;
    if (!room) { S.focusAt(wall.floor, px, py); return; }
    let nx = -uy, ny = ux;
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    if ((cx - px) * nx + (cy - py) * ny < 0) { nx = -nx; ny = -ny; }
    // 沿法向往房间内侧能走多远
    const cs = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]];
    const depth = Math.max.apply(null, cs.map(([x, y]) => (x - px) * nx + (y - py) * ny));
    const dist = Math.max(5.6, Math.min(7.6, depth * 0.72));
    const t = new THREE.Vector3(px, wall.base + 1.2, -py);
    const p = new THREE.Vector3(px + nx * dist, wall.base + 3.0, -(py + ny * dist));
    flyTo(p, t, 680);
  };

  /* 按一块区域（若干房间）自动取景，保证被高亮的房间全在画面里 */
  S.focusBounds = function (floor, x0, y0, x1, y1, animate) {
    S.setFocus(floor, false);
    const f = floorGroups.find(q => q.level === floor);
    if (!f) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const w = Math.max(x1 - x0, 8), d = Math.max(y1 - y0, 8);
    const asp = camera.aspect || 1.4;
    const fov = camera.fov * Math.PI / 180;
    const need = Math.max(w / Math.max(asp, .62), d * 1.45) * 1.12;
    const D = Math.min(80, Math.max(15, need / (2 * Math.tan(fov / 2)) * 1.15));
    const t = new THREE.Vector3(cx, f.elev + .55, -cy);
    const p = t.clone().add(new THREE.Vector3(.12, .82, .57).normalize().multiplyScalar(D));
    if (animate === false) { camera.position.copy(p); controls.target.copy(t); controls.update(); }
    else flyTo(p, t, 720);
  };


  /* ================= 电气层：墙内线管 / 配电箱 / 分路高亮 =================
     平常藏起来。要看的时候一定是"墙体半透明 + 线管发亮"这套组合，
     否则线管埋在墙里根本看不见——这也是用户说"要半透明楼体才看得到电路"的原因。
     线管按分路（回路）分组建 mesh：15 条分路就是 15 个 mesh，
     高亮一条、压暗其他都在材质层面做，不改几何。 */
  const E = () => window.BIM.elec;
  let eRoot = null, ePanels = null, eHitG = null, eIsoG = null;
  let eByCirc = {};                 // circId -> { mat, ghost }
  let eOn = false;
  /* 管线的可见性只由两件事决定：看哪一层（eFloorOnly，0=全部）和在看哪一路（eSoloCid）。
     以前只看"电气层开没开"，切到 3F 时 1~5 层的管子照样全画出来，
     叠在一起根本分不清哪根是本层的 —— 用户的原话是"管线只跟楼层有关"。 */
  let eFloorOnly = 0, eSoloCid = null;

  function eApplyVis() {
    if (!eRoot) return;
    eRoot.visible = eOn && !eIsoG;          // 有隔离组时，整批让位
    const D = E() && E().data;
    Object.keys(eByCirc).forEach(id => {
      const it = eByCirc[id];
      const circ = D ? (D.circuits.find(c => c.id === id) || {}) : {};
      const okFloor = !eFloorOnly || circ.floor === eFloorOnly;
      const okSolo = !eSoloCid || id === eSoloCid;
      it.mesh.visible = okFloor && okSolo;
      if (it.glow) it.glow.visible = !!(eSoloCid && okSolo && okFloor);
    });
  }
  S.conduitFloor = () => eFloorOnly;

  /* 调试/自动化用：当前墙体与管线的呈现统计（回归脚本靠它断言，
     免得去翻 three.js 内部状态） */
  S.bodyVis = function () {
    const out = { focus: S.focus || 0, xray: !!S.xray, roof: null, floors: {} };
    floorGroups.forEach(f => {
      const m = f.mats.wallExt;
      out.floors[f.level] = { visible: f.g.visible, opacity: +(m.opacity || 1).toFixed(3), beam: +(f.mats.beam.opacity || 1).toFixed(3) };
    });
    if (roof) {
      const ms = roofMats();
      const op = ms.length ? Math.min.apply(null, ms.map(m => m.opacity)) : null;
      out.roof = { visible: roof.visible, opacity: op == null ? null : +op.toFixed(3), parts: ms.length };
    }
    return out;
  };
  S.conduitVis = function () {
    const D = E() && E().data;
    const out = { on: eOn, floor: eFloorOnly, solo: eSoloCid, root: !!(eRoot && eRoot.visible), byFloor: {}, shown: 0, total: 0 };
    Object.keys(eByCirc).forEach(id => {
      const it = eByCirc[id];
      const circ = D ? (D.circuits.find(c => c.id === id) || {}) : {};
      const k = circ.floor || 0;
      if (!out.byFloor[k]) out.byFloor[k] = { all: 0, on: 0 };
      out.byFloor[k].all++; out.total++;
      if (it.mesh.visible) { out.byFloor[k].on++; out.shown++; }
    });
    return out;
  };

  S.elecOn = () => eOn;
  const EC = () => (E() ? E().COLOR : {
    light: 0xf0b429, light2: 0xd08b0e, socket: 0x3b9ae1, socket2: 0x2168ab,
    power: 0xd8544f, power2: 0xa03229, reroute: 0x17a673, hit: 0xff3b30, off: 0x8a929b
  });
  /* 一条回路的本色。同类拆成 1/2 两条以后，颜色不能再只看 kind —
     只看 kind 的话照明1 和照明2 是同一个色，走廊里并排跑完全分不出来。 */
  const circColor = circ => {
    if (!circ) return EC().off;
    if (E() && E().colorOf) return E().colorOf(circ);
    /* 兜底不能写回 circColor(circ) —— 那是自己调自己，一路栈溢出 */
    return EC()[circ.kind] || EC().light;
  };

  function eDispose(g) {
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose && o.userData.ownMat) o.material.dispose();
    });
  }

  /* 这段线管"往哪边是顺电流"，给流动条纹定方向。
     跟 S.flux 当年判光点方向用的是同一个办法：不排拓扑，用**距配电箱的平面距离**
     判上游——离箱子近的那头是上游。竖直段没有平面位移，改看标高：
     主干立管由下往上送电，墙内下引由上往下落到房间。
     返回 { ax, flip }：ax 说这段管沿盒子的哪个局部轴长，flip=+1 表示该轴正向即顺电流。 */
  function flowAxis(c) {
    const D = E() && E().data;
    const panel = D ? ((D.panels || []).find(p => p.floor === c.floor) || null) : null;
    const src = panel ? { x: panel.x, y: panel.y } : null;
    const near = p => (src ? Math.hypot(p.x - src.x, p.y - src.y) : 0);
    if (c.vert) {
      const up = (c.layer === 'trunk' || c.layer === 'feed');
      return { ax: 'y', flip: up ? 1 : -1 };
    }
    if (c.free && c.p1 && c.p2) {
      /* 自由段：盒子长边是局部 Y，四元数把 +Y 转到 p1→p2 方向 */
      if (!src) return { ax: 'y', flip: 1 };
      return { ax: 'y', flip: near({ x: c.p1[0], y: c.p1[1] }) <= near({ x: c.p2[0], y: c.p2[1] }) ? 1 : -1 };
    }
    /* 墙内横段：盒子长边是局部 X，正向 = at0 → at1 */
    const wall = c.wall ? M.walls.find(w => w.id === c.wall) : null;
    if (!wall || !src) return { ax: 'x', flip: 1 };
    const a = E().axis(wall);
    const p0 = { x: a.ax + a.ux * c.at0, y: a.ay + a.uy * c.at0 };
    const p1 = { x: a.ax + a.ux * c.at1, y: a.ay + a.uy * c.at1 };
    return { ax: 'x', flip: near(p0) <= near(p1) ? 1 : -1 };
  }

  /* 一根线管 → 一个盒子的变换（size + matrix）。
     所有"把线管画出来"的地方都走这里，别各写一份 —— 以前 eBuild / markConduits
     各写一套几何，加了新的线管类型（自由段、墙内下引）就得改两处，容易漏。
     opt.grow   截面放大倍数（冲突标记要把管子"罩"粗一点才醒目）
     opt.through 进深要穿出墙面（红色标记要能透过半透明墙看到）
     opt.pipe   要挂流动条纹 → 顺手把"沿管子走向"的 UV 也带上 */
  function eItemOf(c, opt) {
    if (!c) return null;
    opt = opt || {};
    const g = opt.grow || 1;
    const uvp = opt.pipe ? flowAxis(c) : null;
    const el = ((M.floors.find(f => f.level === c.floor) || {}).elev) || 0;
    /* 自由段：没有墙可依附（层进线这种明敷桥架），只给两端点，按两点连线建盒子 */
    if (c.free && c.p1 && c.p2) {
      const a = new THREE.Vector3(c.p1[0], el + c.p1[2], -c.p1[1]);
      const b = new THREE.Vector3(c.p2[0], el + c.p2[2], -c.p2[1]);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1e-3) return null;
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(.5);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      return {
        size: [c.s * g, len, c.d * g],
        matrix: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)),
        uvp: uvp
      };
    }
    /* 竖直段：主干立管、墙内下引 */
    if (c.vert) {
      return { size: [c.s * g, c.z1 - c.z0, c.d * g], matrix: frame(c.x, c.y, el + (c.z0 + c.z1) / 2, 1, 0), uvp: uvp };
    }
    const wall = c.wall ? M.walls.find(w => w.id === c.wall) : null;
    if (!wall) return null;
    const a = E().axis(wall);
    const len = c.at1 - c.at0;
    if (len < 0.02) return null;
    const mx = a.ax + a.ux * (c.at0 + len / 2), my = a.ay + a.uy * (c.at0 + len / 2);
    let dep = Math.min(c.d, wall.t * .8) * g;
    if (opt.through) dep = Math.max(dep, wall.t * 1.15);
    return { size: [len, c.s * g, dep], matrix: frame(mx, my, wall.base + c.z, a.ux, a.uy), uvp: uvp };
  }

  /* 接头 / 弯头：数据层（elec ⑦）已经算好每个接头的位置和尺寸，
     这里只负责把它画成一个方头。放在同一批 mesh 里，跟着分路一起显隐高亮。
     颜色用顶点色压暗一档：管身和管件同色的话，接头在图上就是个"凸一点"，认不出来；
     深一档之后一眼能看出"这里有个管件把两段接上了"。 */
  const JT_SHADE = 0.62;
  function eJointItem(j) {
    if (!j) return null;
    const el = ((M.floors.find(f => f.level === j.floor) || {}).elev) || 0;
    const r = j.r || 0.12;
    return {
      size: [r, r, Math.min(r, j.d || r)],
      matrix: frame(j.x, j.y, el + j.z, 1, 0),
      c: [JT_SHADE, JT_SHADE, JT_SHADE]
    };
  }

  /* 按分路分批：一条分路一个 mesh，高亮/隔离都在材质层做，不改几何。
     withJoints=true 时把接头一起并进这条分路（只有"全楼看管"时才要，
     隔离碰撞管线时不该把这一路所有接头都翻出来）。
     grow>1 把截面整体画粗 —— 看"整条路线走到哪几间房"时楼层拉得很远，
     原尺寸的管子在屏幕上就 1 个像素，看不清。 */
  function eBatch(list, withJoints, grow) {
    const D = E() && E().data;
    const per = {};
    if (!D) return per;
    /* pipe:true —— 每段管都带上"沿管子走向"的 UV，材质才能在上面跑流动条纹 */
    const opt = { grow: grow || 1, pipe: true };
    (list || []).forEach(c => {
      if (!D.circuits.some(x => x.id === c.circuit)) return;
      if (cOff.layer[c.layer]) return;                 // 图层开关：这一层管子被关掉
      if (cOff.kind[c.kind]) return;                   // 按分路种类关（照明/插座/动力）
      const it = eItemOf(c, opt);
      if (!it) return;
      /* 开了接头就必须给每个方块都带上顶点色：boxGeo 只要有一个方块带 c
         就会给整批建 color 属性，没给的按 [1,1,1] 补齐 —— 与其依赖这个兜底，
         不如这里显式写上，省得哪天材质开了 vertexColors 却没属性、整批变黑。 */
      if (withJoints) it.c = [1, 1, 1];
      (per[c.circuit] = per[c.circuit] || []).push(it);
    });
    if (withJoints) {
      (D.joints || []).forEach(j => {
        if (!per[j.circuit]) return;          // 这条分路不在本次范围内就别画
        /* 接头只在"交汇的那几层都关了"时才一起收起来：
           三通一头在走廊干线、一头在墙内下引，关掉其中一层时三通还得留着 */
        if (j.layers && j.layers.length && j.layers.every(l => cOff.layer[l])) return;
        const it = eJointItem(j);
        if (it) per[j.circuit].push(it);
      });
    }
    return per;
  }

  /* ---------------- 管线图层开关 ----------------
     功能区那个「管线」按钮悬停出来的那一排开关就落到这里：
       cOff.layer —— 主干立管 / 层进线 / 箱到桥架 / 走廊干线 / 墙内下引 / 房间支线
       cOff.kind  —— 照明 / 插座 / 动力
     一改就整体重建线管几何（几百个盒子而已，重建比逐 mesh 改 visible 还简单），
     因为一条分路的网格是按"分路"合的批，图层混在同一个 mesh 里，
     只改 mesh.visible 根本分不出层。 */
  const cOff = { layer: {}, kind: {} };
  S.conduitFilter = function (f) {
    if (f) {
      if (f.layer) { cOff.layer = {}; Object.keys(f.layer).forEach(k => { if (!f.layer[k]) cOff.layer[k] = 1; }); }
      if (f.kind) { cOff.kind = {}; Object.keys(f.kind).forEach(k => { if (!f.kind[k]) cOff.kind[k] = 1; }); }
    }
    return { layer: Object.assign({}, cOff.layer), kind: Object.assign({}, cOff.kind) };
  };
  S.conduitLayers = function () {
    const D = E() && E().data;
    const out = { layer: {}, kind: {} };
    ((D && D.conduits) || []).forEach(c => {
      out.layer[c.layer] = (out.layer[c.layer] || 0) + 1;
      out.kind[c.kind] = (out.kind[c.kind] || 0) + 1;
    });
    return out;
  };
  /* 开关一变就重建：只有 eOn 时才动，别在"看管线"关着的时候白建一遍 */
  S.rebuildConduitFilter = function () {
    if (!eOn) return;
    eBuild();
    if (eIsoG) { const g = eIsoG.userData; g && (g.stale = true); }
  };

  /* 按分路建一批盒子 */
  function eBuild() {
    eDispose(eRoot); eRoot = null; eByCirc = {};
    eDispose(eIsoG); eIsoG = null;          // 隔离组里放的是旧线管对象，重建后必须扔
    if (!E() || !E().data) return;
    const D = E().data;
    const root = new THREE.Group();
    root.name = 'elec';
    const per = eBatch(D.conduits || [], true);
    Object.keys(per).forEach(cid => {
      const circ = D.circuits.find(x => x.id === cid);
      const col = new THREE.Color(circColor(circ));
      const mat = new THREE.MeshStandardMaterial({
        color: col, emissive: col.clone().multiplyScalar(.45), emissiveIntensity: 1,
        roughness: .42, metalness: .3, transparent: true, opacity: .95,
        vertexColors: true          // 接头块靠顶点色压暗，管身仍是回路本色
      });
      mat.userData.baseOpacity = 1;
      const mesh = new THREE.Mesh(boxGeo(per[cid]), mat);
      mesh.userData = { kind: 'conduit', circ: cid, floor: circ.floor };
      mesh.renderOrder = 2;
      root.add(mesh);
      // 穿透显示层：墙不透明时也能看见这条分路走到哪
      const gm = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: .0, depthTest: false, depthWrite: false
      });
      gm.userData.ownMat = true;
      const glow = new THREE.Mesh(boxGeo(per[cid].map(it => ({
        size: [it.size[0] * 1.6, it.size[1] * 1.6, it.size[2] * 1.6], matrix: it.matrix
      }))), gm);
      glow.renderOrder = 6;
      glow.visible = false;
      root.add(glow);
      eByCirc[cid] = { mat: mat, glow: glow, mesh: mesh };
    });
    root.visible = eOn;
    scene.add(root);
    eRoot = root;
    eApplyVis();
  }
  S.rebuildElec = eBuild;

  /* 配电箱：真实一点的柜体——箱体、箱门、断路器排、电能表、指示灯、铭牌。
     注意 frame() 的三根轴：x=沿墙、y=竖直、z=墙法向（进深），
     所以 size 一律按 [沿墙, 竖直, 进深] 写，别按设备的 [宽,高,深] 习惯来。 */
  function ePanelMesh(p) {
    const room = M.rooms.find(r => r.id === p.room);
    const wall = p.wall ? M.walls.find(w => w.id === p.wall) : null;
    /* ★ 这里踩过一个坑：原来写 (p.dir[0]) || 1，而南北向墙的 dir 是 [0,1]，
       0 被 || 当成"没值"兜底成 1 → 基向量变成 (1,0,-1) 的 45° 对角，
       箱子被整个拉斜。凡是取分量，不能用 || 兜底，只能判 undefined。 */
    const dv = (Array.isArray(p.dir) && p.dir.length === 2) ? p.dir : [1, 0];
    const ux = dv[0], uy = dv[1];
    /* 墙面法向：数据层已经算好并存在 panel.n（指向房间内侧），这里直接用。
       以前是渲染时按 panel.dir 现推，推反了箱子就朝墙里翻 —— 表现出来就是
       "控制箱斜着放 / 悬空没贴墙"。方向只在数据层算一次，渲染只负责画。 */
    let nx, ny;
    if (p.n) {
      nx = p.n[0]; ny = p.n[1];
    } else {
      nx = -uy; ny = ux;
      if (room) {
        const cx = (room.x0 + room.x1) / 2 - p.x, cy = (room.y0 + room.y1) / 2 - p.y;
        if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      }
    }
    const tw = wall ? wall.t : (p.t || 0.2);
    /* 箱子背面正好压在墙面上：中心离墙中心线 = 半墙厚 + 半箱深，不留缝也不埋进去 */
    const off = tw / 2 + p.d / 2;
    const px = p.x + nx * off, py = p.y + ny * off;
    const el = ((M.floors.find(f => f.level === p.floor) || {}).elev) || 0;
    const Y = el + p.z;
    const W = p.w, H = p.h, Dp = p.d;
    const F = Dp / 2;                                     // 朝房间那一面
    // 沿墙偏 dw、竖直偏 dz、法向偏 df 的一个点
    const at = (dw, dz, df) => [px + ux * dw + nx * df, py + uy * dw + ny * df, Y + dz];
    const it = [];
    /* 挂板：紧贴墙面的一块薄钢板。有这个，"箱子挂在墙上"才看得出来，
       不然箱体像个盒子浮在半空。 */
    const backOff = tw / 2 + 0.007;
    it.push({
      size: [W + .08, H + .08, .014],
      matrix: frame(p.x + nx * backOff, p.y + ny * backOff, Y, ux, uy),
      c: [.40, .44, .48]
    });
    it.push({ size: [W, H, Dp], matrix: frame(px, py, Y, ux, uy), c: [.86, .89, .92] });
    it.push({ size: [W * .86, H * .88, .016], matrix: frame(...at(0, 0, F + .008), ux, uy), c: [.95, .96, .97] });   // 箱门

    /* ---- 断路器排：一个总开关 + 本层三路分路 ----
       手柄位置本身就表达通断：合闸时手柄在上、指示灯绿；断开时手柄落到下面、
       手柄和指示灯都变红。说"关掉 2 楼第一回路"，用户要能在箱子上一眼看到
       就是从左数第一个手柄被拉下来了 —— 光在回复里写字不够。

       ★ 总开关和三个分路是两层控制，读的字段也不同：
         总开关 = panel.mainOn，一拉整层三路全停；
         分路   = circuit.on，只管自己那一路。
       总开关断开时，三个分路手柄照样停在合位（现场就是这样，没人会去拨它们），
       只是灯灭 —— 所以要多一档"手柄合着但没电"的暗色，
       否则屏幕上看起来像三路都被拔了闸，跟真实操作对不上。 */
    const ED = (E() && E().data) || { circuits: [] };
    const circs = (p.circuits || []).map(id => (ED.circuits || []).find(c => c.id === id)).filter(Boolean);
    const mainOn = p.mainOn !== false;
    /* 颜色要够沉：箱门是接近纯白的，手柄再浅就糊成一片，三态分不出来 */
    const H_ON = [.19, .23, .28], H_OFF = [.82, .16, .12], H_NA = [.46, .49, .53], H_DEAD = [.62, .44, .22];
    const L_G = [.10, .90, .40], L_R = [.98, .22, .14], L_NA = [.30, .31, .33], L_DEAD = [.95, .66, .10];

    /* 导轨 */
    it.push({ size: [W * .84, .012, .012], matrix: frame(...at(0, -.055, F + .018), ux, uy), c: [.62, .66, .70] });

    /* 两组的边框：左边"管整层"一只，右边"各管一路"六只。
       光靠位置和一条细挡板区分不够，远看还是一排开关；
       各圈一个凹槽（先画外框、再画壳体，壳体盖住中间只剩边），分组一眼就出来。 */
    const G_FRAME = [.44, .48, .52];
    it.push({ size: [.150, .262, .020], matrix: frame(...at(-W * .30, .030, F + .012), ux, uy), c: G_FRAME });

    /* 六路分路的排布由电路条数决定，不写死三个位置 ——
       以后再加回路（照明3 之类）不用回来改渲染。 */
    const N = Math.max(1, circs.length || (p.circuits || []).length || 6);
    const x0 = -W * .158, x1 = W * .42;
    const dws = [];
    for (let i = 0; i < N; i++) dws.push(N > 1 ? x0 + (x1 - x0) * i / (N - 1) : (x0 + x1) / 2);
    const grpC = (x0 + x1) / 2, grpW = (x1 - x0) + .082;
    it.push({ size: [grpW, .262, .020], matrix: frame(...at(grpC, .030, F + .012), ux, uy), c: G_FRAME });

    /* 总开关：位置固定在最左边，手柄只认 mainOn */
    const mw = -W * .30;
    it.push({ size: [.105, .225, .030], matrix: frame(...at(mw, .030, F + .022), ux, uy), c: [.86, .89, .92] });
    it.push({ size: [.062, .066, .038], matrix: frame(...at(mw, mainOn ? .090 : -.030, F + .036), ux, uy), c: mainOn ? H_ON : H_OFF });
    it.push({ size: [.030, .030, .024], matrix: frame(...at(mw, .178, F + .022), ux, uy), c: mainOn ? L_G : L_R });

    /* 分组挡板：左边这只"管全层"，右边六只"各管一路"，中间隔开一条。
       位置取两个边框之间的空档，别压在框沿上，否则两块连成一片反而更糊。 */
    it.push({
      size: [.016, .240, .028],
      matrix: frame(...at(((-W * .30 + .075) + (grpC - grpW / 2)) / 2, .030, F + .020), ux, uy),
      c: [.26, .29, .33]
    });

    /* 六路分路，从左到右 = 第 1…6 回路（照明1/照明2/插座1/插座2/动力1/动力2） */
    dws.forEach((dw, i) => {
      const c = circs[i];
      const has = !!c;
      const on = has ? c.on !== false : true;              // 手柄位置：只看分路自己
      const live = has ? (mainOn && on) : false;           // 实际带电：还要过总开关
      const hc = !has ? H_NA : (live ? H_ON : (on ? H_DEAD : H_OFF));
      const lc = !has ? L_NA : (live ? L_G : (on ? L_DEAD : L_R));
      /* 壳体窄一档：六只挤在一排，太宽会互相顶住 */
      it.push({ size: [.072, .200, .028], matrix: frame(...at(dw, .030, F + .020), ux, uy), c: has ? [.90, .92, .94] : [.85, .87, .90] });
      it.push({ size: [.048, .060, .038], matrix: frame(...at(dw, on ? .090 : -.030, F + .034), ux, uy), c: hc });
      it.push({ size: [.026, .026, .024], matrix: frame(...at(dw, .178, F + .020), ux, uy), c: lc });
      /* 类别色标：手柄下面一小块，六只开关一眼分出哪只是照明、哪只是插座、哪只是动力 */
      if (has && c.color != null) {
        const col = new THREE.Color(c.color);
        it.push({
          size: [.040, .014, .022],
          matrix: frame(...at(dw, -.082, F + .020), ux, uy),
          c: [col.r, col.g, col.b]
        });
      }
    });

    /* 底排：电能表 / 铭牌 / 电源指示灯 */
    it.push({ size: [.16, .11, .022], matrix: frame(...at(-W * .26, -H * .26, F + .020), ux, uy), c: [.08, .12, .16] });   // 电能表
    it.push({ size: [.026, .026, .022], matrix: frame(...at(W * .30, -H * .24, F + .020), ux, uy), c: [.18, .9, .5] });    // 电源灯
    it.push({ size: [.22, .05, .018], matrix: frame(...at(0, -H * .38, F + .020), ux, uy), c: [.55, .6, .66] });          // 铭牌
    const geo = boxGeo(it);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: .42, metalness: .45, vertexColors: true, envMapIntensity: .9
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { kind: 'panel', data: p, floor: p.floor };
    return mesh;
  }

  function ePanelBuild() {
    eDispose(ePanels); ePanels = null;
    if (!E() || !E().data) return;
    const g = new THREE.Group();
    g.name = 'panels';
    (E().data.panels || []).forEach(p => {
      try { g.add(ePanelMesh(p)); } catch (e) { }
    });
    /* 配电箱是真实装在墙上的设备，不是"电气视图的附属物"：
       平时看楼层就该看得见（用户原话："这个控制器日常其他功能在查看楼层的时候不要隐藏"）。
       只跟随楼层聚焦显隐，不跟电气层开关走。 */
    g.visible = true;
    scene.add(g); ePanels = g;
    syncPanels();
  }
  S.rebuildPanels = ePanelBuild;

  /* 配电箱跟着楼层聚焦走：全楼视图（focus=0）全显示，看某一层只显示那一层的。
     它挂在 scene 上、不进 floorGroups，所以要自己按层过滤，否则隔着楼板也能看见别的层的箱子。 */
  function syncPanels() {
    if (!ePanels) return;
    const lv = S.focus || 0;
    ePanels.children.forEach(m => {
      const f = m.userData && m.userData.floor;
      m.visible = lv === 0 || f === lv;
    });
    ePanels.visible = true;
  }
  S.syncPanels = syncPanels;

  /* 重画配电箱：断路器的通断状态改了以后必须重新生成几何
     —— 手柄位置是烘进顶点里的，只改材质是动不了的。 */
  S.refreshPanels = function (floor) {
    if (!E() || !E().data) return;
    if (!ePanels) { ePanelBuild(); return; }
    (E().data.panels || []).forEach(p => {
      if (floor != null && p.floor !== floor) return;
      const old = ePanels.children.find(m => m.userData && m.userData.data && m.userData.data.id === p.id);
      if (old) {
        ePanels.remove(old);
        if (old.geometry) old.geometry.dispose();
        if (old.material) old.material.dispose();
      }
      try { ePanels.add(ePanelMesh(p)); } catch (e) { }
    });
    syncPanels();
  };

  /* 把镜头放到这一层配电箱跟前站定。
     "关掉 2 楼第一回路"的第一步就是这一下：先让人看见箱子、看见那排开关，
     再说哪一路被拉下来了，比直接给一段文字清楚得多。 */
  S.focusPanel = function (floor) {
    const D = E() && E().data;
    if (!D) return null;
    const p = (D.panels || []).find(x => x.floor === floor) || (D.panels || [])[0];
    if (!p) return null;
    S.showConduits(true);
    S.setXray(false);                       // 箱子是实体，这里不要透视，看清手柄
    S.setFocus(p.floor, false);
    const el = ((M.floors.find(f => f.level === p.floor) || {}).elev) || 0;
    const n = (Array.isArray(p.n) && p.n.length === 2) ? p.n : [1, 0];
    /* 1.8 m 太贴脸：整屏只剩箱门，看不出这是装在墙上的一台柜子。
       2.9 m 能把箱体轮廓、挂板和它所在的那面墙一起框进来，
       手柄仍然看得清（0.9 m 高的箱子约占画面 1/3）。 */
    const d = 2.9;
    const t = new THREE.Vector3(p.x, el + p.z + 0.05, -p.y);
    const c = new THREE.Vector3(p.x + n[0] * d, el + p.z + 0.55, -(p.y + n[1] * d));
    flyTo(c, t, 780);
    return p;
  };

  /* 只看这一路的完整路由：主干立管 → 层进线 → 配电箱 → 本回路的干线和支线。
     其它回路整条不画。用户点「查看回路影响」要的就是这一屏：
     电从楼上竖井下来，进箱子，沿走廊跑一圈，再分进哪几间房。 */
  S.circuitRoute = function (circ, rooms) {
    const D = E() && E().data;
    if (!D || !circ) return null;
    S.showConduits(true);
    S.setXray(true);
    S.clearConduitMarks();
    /* 主干立管只取"本层那一段"。整栋楼的主干是 TR-1F…TR-5F 五段首尾相接的，
       原来把 layer==='trunk' 全放进来，屏幕上就是一根从一层通到五层的长杆，
       焦点又被压在 2F，看起来像"电从天上掉下来"，看不出这一段到底接的是谁。
       用户的原话是"问相关问题的时候主干管也只展示当前楼层的"。 */
    const list = (D.conduits || []).filter(c =>
      c.circuit === circ.id ||
      ((c.layer === 'trunk' || c.layer === 'feed') && c.floor === circ.floor));
    /* 管子粗细、接头必须跟"查看所有分路"时**一模一样**：
       以前这里 grow:3 把管径放粗三倍、又不带接头（eBatch 的第二参是 false），
       同一个回路在两个视图里粗细不一样，用户一眼就看出"这不是同一根管子"。
       现在统一 grow:1 + 带接头，只靠材质的自发光和绿色地面来突出这一路。 */
    S.isolateConduits(list, { grow: 1, joints: true });
    /* 光点改成贴在管身上的流动条纹了（见 S.flux），从电闸一路跑到房间 */
    S.flux(list, { floor: circ.floor });
    if (rooms && rooms.length) S.highlightRooms(rooms, 0x17a673); else disposeHl();
    S.setFocus(circ.floor, true);
    S.isolateFloor(circ.floor);         // 只留这一层：别层的管线一根都不许露面
    return list;
  };

  /* ---------------- 电流流向：贴在管子表面的流动条纹 ----------------
     "从电闸到房间"这件事光画管子看不出来 —— 线在墙里绕一圈，用户不知道电往哪边走。
     早先是往空中撒一串发光小点（Sprite）沿管子跑。问题很明显：光点是**飘在空间里**的，
     关掉透视、或者镜头一转，就成了一屋子乱飞的白点，跟管子对不上，也不像"电在管子里流"。
     用户的原话是"需要在对应的管子模型上附着流向材质特效"。
     所以改成：在**线管自己的材质**上加一层流动条纹（emissiveMap，黑底亮条），
     每帧只推纹理 offset —— 条纹表面沿管子走，视觉上就是电在管子里流动。
     方向靠 UV 定（见 flowAxis / boxGeo 的 it.uvp）：u 沿管走向、按 flip 定正负，
     所以同一批 mesh 里每段管各流各的方向，共用一张贴图、一个 offset 就够。 */
  const FLOW_PERIOD = 0.42;         // 一个条纹周期的长度（米）
  const FLOW_SPEED = 0.75;          // 条纹沿线速度（m/s）
  let flowTex = null, flowCircs = {}, flowCount = 0, flowPrev = 0;

  function flowTexture() {
    if (flowTex) return flowTex;
    const W = 256, H = 8, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    /* 一束"彗星"式条纹：暗底（留一点底光，管子不至于黑掉）→ 亮头 → 长尾。
       黑底是关键：emissiveMap 是乘上去的，黑就是"这儿没电光"，管子保持本色。 */
    const lg = g.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0.00, '#0a0a0a');
    lg.addColorStop(0.10, '#3a3a3a');
    lg.addColorStop(0.26, '#ffffff');
    lg.addColorStop(0.34, '#c8c8c8');
    lg.addColorStop(0.52, '#2e2e2e');
    lg.addColorStop(0.72, '#101010');
    lg.addColorStop(1.00, '#0a0a0a');
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    const t = new THREE.CanvasTexture(cv);
    /* u 的单位是米（见 boxGeo），所以 repeat = 1/周期 就把条纹铺成"每 0.42 m 一道" */
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1 / FLOW_PERIOD, 1);
    t.offset.set(0, 0);
    t.anisotropy = 4;
    flowTex = t;
    return t;
  }

  /* 给一条分路的 mesh 开/关流动条纹。只动材质，不重建几何。 */
  function setMeshFlow(mesh, on) {
    const m = mesh && mesh.material;
    if (!m) return false;
    const has = !!m.emissiveMap;
    if (on && !has) {
      m.emissiveMap = flowTexture();
      m.needsUpdate = true;
      return true;
    }
    if (!on && has) {
      m.emissiveMap = null;
      m.needsUpdate = true;
    }
    return false;
  }

  /* 按当前"哪些分路要展示流向"重刷一遍材质。
     eRoot（全楼管线）和 eIsoG（隔离出来的那几根）都要刷 —— 看回路时画的是后者，
     只刷前者的话用户看到的还是没条纹的管子。
     ★ 这里**不按 live 过滤**：用户刚把某一路断开时要看的正是"这一路管到哪几间"，
     那一根管子已经变灰了，但它是这一屏的主角，条纹照样要跑；
     条纹说的是"这一路电的走向"，灰不灰说的是"现在有没有电"，两件事。 */
  function applyFlow() {
    const D = E() && E().data;
    let n = 0;
    if (!D) return 0;
    const walk = g => {
      if (!g) return;
      g.children.forEach(mesh => {
        const cid = mesh.userData && mesh.userData.circ;
        if (!cid || !mesh.isMesh) return;
        const on = !!flowCircs[cid];
        setMeshFlow(mesh, on);
        if (on) n++;
      });
    };
    walk(eRoot); walk(eIsoG);
    flowCount = n;
    return n;
  }
  S.applyFlow = applyFlow;

  /* list: 参与流动的线管数组（分路 id 从这里取）；opt.floor 目前只用于兼容老调用 */
  S.flux = function (list, opt) {
    flowCircs = {};
    (list || []).forEach(c => { if (c && c.circuit) flowCircs[c.circuit] = true; });
    const n = applyFlow();
    flowPrev = 0;
    return { segments: (list || []).length, meshes: n, mode: 'material' };
  };
  S.fluxOff = function () {
    flowCircs = {};
    applyFlow();
  };

  /* 每帧推进会：offset 减 = 条纹朝 u 正方向走，而 u 正方向就是"顺电流"。
     只有真的有管子在流、而且材质还挂着贴图时才推，平时不动省 GPU。 */
  function tickFlow(t) {
    if (!flowCount || !flowTex) { flowPrev = 0; return; }
    const prev = flowPrev || t;
    const dt = Math.min(0.12, Math.max(0, (t - prev) / 1000));
    flowPrev = t;
    flowTex.offset.x -= dt * FLOW_SPEED / FLOW_PERIOD;
  }


  /* 显示/隐藏墙内线管。开的时候自动把楼体压成半透明，不然什么都看不见。
     ★ 管线只跟楼层有关：打开时跟着当前聚焦层过滤，全楼视角才画全部。 */
  S.showConduits = function (on) {
    eOn = !!on;
    if (eOn && !eRoot) eBuild();
    if (eOn && !ePanels) ePanelBuild();
    if (eOn) {
      /* 从"只看那一路"（隔离组）切回"看这层的管线"时，隔离组必须收掉 ——
         不然屏幕还停在那一根管子上，用户以为"看管线"根本没反应。 */
      S.clearIsolate();
      eFloorOnly = S.focus || floorOnly || 0;
    }
    eApplyVis();
    /* 配电箱不跟电气层开关走 —— 它是真装在墙上的设备，关掉"看管线"也得留着。
       这里只按当前楼层重算显隐。 */
    syncPanels();
    if (!eOn) { S.clearIsolate(); S.showCircuit(null); S.fluxOff(); }
    if (eOn && !S.xray) S.setXray(true);
  };

  /* 只显示这几根线管：其它分路整体隐藏，命中的管子按本体颜色单独画出来。
     碰撞检查、查某面墙里埋了什么，都用它 ——
     现场就是这样：墙里挡路的就那几根，别的管线全都跑来抢视线没有意义。

     opt.grow   截面放大倍数，默认 1（**默认必须跟 eBuild 一致**，不然同一根管
                在两种视图里粗细不同）；只有冲突标记这种"要罩粗才醒目"的场合才传 >1。
     opt.joints 把接头/弯头一并画出来。看整条回路走向时要 true ——
                少了接头，管子看着就是一根根悬空的棍子，跟"查看所有分路"对不上。 */
  S.isolateConduits = function (list, opt) {
    if (eIsoG) { eDispose(eIsoG); eIsoG = null; }
    const D = E() && E().data;
    if (!D) return;
    const grow = (opt && opt.grow) || 1;
    const joints = !!(opt && opt.joints);
    if (eRoot) eRoot.visible = false;              // 先把整批藏起来
    if (!list || !list.length) return;
    const per = eBatch(list, joints, grow);
    const g = new THREE.Group();
    g.name = 'elec-iso';
    Object.keys(per).forEach(cid => {
      const circ = D.circuits.find(x => x.id === cid) || {};
      const col = new THREE.Color(circColor(circ));
      const mat = new THREE.MeshStandardMaterial({
        color: col, emissive: col.clone().multiplyScalar(.85), emissiveIntensity: 2.4,
        roughness: .4, metalness: .3, transparent: true, opacity: 1,
        vertexColors: joints              // 接头靠顶点色压暗一档，跟 eBuild 同一个规矩
      });
      mat.userData.ownMat = true;
      const mesh = new THREE.Mesh(boxGeo(per[cid]), mat);
      /* userData.circ 必须带上：流动条纹是按"这条分路带不带电、要不要流"挂的，
         少了这个字段，隔离出来的管子永远挂不上材质（屏幕上就是"看不见电在走"）。 */
      mesh.userData = { kind: 'conduit', circ: cid, floor: circ.floor };
      mesh.renderOrder = 3;
      g.add(mesh);
    });
    if (!g.children.length) { if (eRoot && eOn) eRoot.visible = true; return; }
    /* 自检用：这一批是按什么口径画的（grow / 有没有接头 / 共几个方头）。
       回归脚本靠它断言"看回路影响"与"看所有分路"的管径一致。 */
    let boxes = 0;
    g.children.forEach(m => { if (m.geometry && m.geometry.attributes.position) boxes += m.geometry.attributes.position.count / 24; });
    g.userData = { grow: grow, joints: joints, boxes: boxes, circs: Object.keys(per) };
    scene.add(g); eIsoG = g;
    applyFlow();                       // 新画出来的这批管也要按当前"谁在流"挂上条纹
  };
  S.clearIsolate = function () {
    if (eIsoG) { eDispose(eIsoG); eIsoG = null; }
    /* 从"打通时的半透明管子"切回普通视图，透明度得跟着回来，
       否则整层电线一直是灰扑扑的，看着像断了电 */
    if (typeof eAlpha === 'number' && eAlpha < 0.99) S.conduitAlpha(1);
    eApplyVis();
  };
  S.hasIsolate = () => !!eIsoG;

  /* 自检用：全楼那批管每条分路几个方头，以及当前隔离组是按什么口径画的。
     "看回路影响"和"看所有分路"的管径必须一样，回归脚本就靠 grow/joints 这两项断言。 */
  S.conduitStat = function () {
    const out = { floor: eFloorOnly, solo: eSoloCid, byCirc: {}, iso: null };
    Object.keys(eByCirc).forEach(id => {
      const g = eByCirc[id].mesh.geometry;
      out.byCirc[id] = (g && g.attributes.position) ? g.attributes.position.count / 24 : 0;
    });
    if (eIsoG) {
      const u = eIsoG.userData || {};
      const m = eIsoG.children[0];
      out.iso = {
        grow: u.grow == null ? 1 : u.grow, joints: !!u.joints, boxes: u.boxes || 0,
        circs: u.circs || [], meshes: eIsoG.children.length,
        shaded: !!(m && m.geometry && m.geometry.attributes.color)   // 有没有接头用的顶点色
      };
    }
    return out;
  };

  /* 只看一条分路：它自己发亮 + 穿透显示，别的分路**整条隐藏**。
     以前是把别的压到 0.07 透明度，屏幕上还是一堆管子在眼前晃；
     用户要的是"就这一条"，所以直接不画。 */
  S.showCircuit = function (cid) {
    S.clearIsolate();
    const D = E() && E().data;
    if (!D) return;
    eSoloCid = cid || null;
    Object.keys(eByCirc).forEach(id => {
      const it = eByCirc[id];
      const on = !cid || id === cid;
      const circ = D.circuits.find(c => c.id === id) || {};
      const live = cid ? on : (circ.on !== false);
      it.mat.opacity = 1;
      it.mat.transparent = true;
      it.mat.depthWrite = true;
      it.mat.emissiveIntensity = cid && on ? 2.1 : 1;
      it.mat.color.setHex(live ? (circColor(circ)) : EC().off);
      it.mat.emissive.setHex(live ? (circColor(circ)) : 0x000000);
      it.mat.emissive.multiplyScalar(cid && on ? .8 : .45);
      it.mat.needsUpdate = true;
      if (it.glow) it.glow.material.opacity = cid && on ? .30 : 0;
    });
    eApplyVis();          // 显隐统一由这里定：看哪一层 + 看哪一路
  };

  /* 断电的分路在图上变灰：不切断也能看出"这几间现在是没电的"。
     判的是 live（有没有电），不是 on（手柄位置）——
     总开关一断，六只手柄都还合着，可这一层确实一点电都没有。 */
  S.syncCircuitPower = function () {
    const D = E() && E().data;
    if (!D) return;
    Object.keys(eByCirc).forEach(id => {
      const it = eByCirc[id];
      const circ = D.circuits.find(c => c.id === id) || {};
      if (circ.live === false || circ.on === false) {
        it.mat.color.setHex(EC().off);
        it.mat.emissive.setHex(0x000000);
        it.mesh.userData.off = true;
      } else {
        it.mat.color.setHex(circColor(circ));
        it.mat.emissive.setHex(circColor(circ)).multiplyScalar(.45);
        it.mesh.userData.off = false;
      }
      it.mat.needsUpdate = true;
    });
    /* 通了电才有条纹、断开就没条纹 —— 这正是"断电"最直观的那一眼。
       放在这里而不是各调用点：任何改分路状态的地方最后都会过这一道。 */
    applyFlow();
  };

  /* 冲突线管：亮红罩一层，并且穿透墙体显示（就是"把冲突的管线位置指出来"） */
  S.markConduits = function (list, color) {
    if (eHitG) { eDispose(eHitG); eHitG = null; }
    if (!list || !list.length) return;
    const c = new THREE.Color(color || EC().hit);
    const it = [];
    list.forEach(k => {
      const one = eItemOf(k, { grow: 2.4, through: true });   // 罩粗一圈、穿出墙面
      if (one) it.push(one);
    });
    if (!it.length) return;
    const g = new THREE.Group();
    const geo = boxGeo(it);
    const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .55, depthTest: false, depthWrite: false });
    m.userData.ownMat = true;
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 8;
    g.add(mesh);
    const lm = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .9, depthTest: false });
    lm.userData.ownMat = true;
    const ls = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lm);
    ls.renderOrder = 9;
    g.add(ls);
    scene.add(g); eHitG = g;
  };
  S.clearConduitMarks = function () {
    if (eHitG) { eDispose(eHitG); eHitG = null; }
    S.clearReroute();
    S.clearIsolate();
  };

  /* 让整批线管半透明：打通/拆墙的时候，用户要的是"看得见哪几根要改道"，
     而不是只留那几根、其它全消失 —— 只留几根时根本判断不出这堵墙在电气系统里的位置。
     a=1 恢复原样；a<1 时同时把穿透光罩关掉（半透明的管子再罩一层会糊成一片）。 */
  let eAlpha = 1;
  S.conduitAlpha = function (a) {
    eAlpha = (a == null ? 1 : Math.max(0.12, Math.min(1, a)));
    Object.keys(eByCirc).forEach(id => {
      const it = eByCirc[id];
      it.mat.transparent = true;
      it.mat.opacity = eAlpha;
      it.mat.depthWrite = eAlpha > 0.9;
      it.mat.needsUpdate = true;
      if (it.glow && eAlpha < 0.95) it.glow.material.opacity = 0;
    });
    if (eIsoG) eIsoG.children.forEach(m => {
      if (m.material) { m.material.transparent = true; m.material.opacity = eAlpha; m.material.needsUpdate = true; }
    });
    return eAlpha;
  };
  S.conduitAlphaValue = () => eAlpha;
  S.conduitsOn = () => eOn;

  /* 改线后的新走向：沿墙面画一条折线，穿透显示。
     一次可能改好几根管，所以都挂到同一个组里，别互相顶掉。

     ★ 这里修过一个"改线根本看不见"的 bug：elec.planReroute 返回的 wall 字段是
       墙体**对象**，而这里原来写的是 M.walls.find(w => w.id === r.wall) ——
       拿字符串去比对象，永远查不到，函数直接 return null，绿色改线一次都没画出来过。
       现在两种都给：先按对象用，再按 id 查。 */
  let eReRoot = null;
  S.clearReroute = function () {
    if (eReRoot) { eDispose(eReRoot); eReRoot = null; }
  };
  S.showReroute = function (r, color) {
    if (!r) return null;
    let wall = null;
    if (r.wall && typeof r.wall === 'object' && r.wall.id) wall = r.wall;
    else if (r.wall) wall = M.walls.find(w => w.id === r.wall) || null;
    if (!wall && r.c) wall = M.walls.find(w => w.id === r.c.wall) || null;
    if (!wall || !r.pts || !r.pts.length) return null;

    const a = E().axis(wall);
    /* 改线的管子粗细跟**真管子**一个量级（用户："开门涉及到的管线也要对应减小直径"）。
       以前固定 0.10 m，比真管子粗两三倍，屏幕上像一根水管横穿墙里。
       留 1.4 倍和下限 0.04 只是为了在整层视角下还看得见，不是另一套管径。 */
    const sec = (r.c && r.c.s) || 0.04;
    const TH = Math.max(0.04, Math.min(0.08, sec * 1.4));
    const it = [];
    const ptAt = p => ({ x: a.ax + a.ux * p.at, y: a.ay + a.uy * p.at, z: wall.base + p.z });

    for (let i = 0; i < r.pts.length - 1; i++) {
      const p = r.pts[i], q = r.pts[i + 1];
      const dx = (q.at - p.at), dz = (q.z - p.z);
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const midAt = (p.at + q.at) / 2, midZ = (p.z + q.z) / 2;
      const mx = a.ax + a.ux * midAt, my = a.ay + a.uy * midAt;
      const ang = Math.atan2(dz, dx);
      const m = frame(mx, my, wall.base + midZ, a.ux, a.uy);
      m.multiply(new THREE.Matrix4().makeRotationZ(ang));
      it.push({ size: [len, TH, Math.max(TH, Math.min(wall.t * 1.2, TH * 1.8))], matrix: m });
    }
    /* 每个转折点放一个弯头：改线路径是"上翻—横穿—落回"，两个直角。
       只在本该拐弯的点上放（首尾和一条直线上的中间点都不放），
       否则看着像管子上长了一串疙瘩。 */
    r.pts.forEach((p, i) => {
      if (i === 0 || i === r.pts.length - 1) return;
      const a0 = r.pts[i - 1], b0 = r.pts[i + 1];
      const cross = (p.at - a0.at) * (b0.z - p.z) - (p.z - a0.z) * (b0.at - p.at);
      if (Math.abs(cross) < 1e-6) return;                 // 共线，不是弯
      const w = ptAt(p);
      const k = TH * 1.9;
      it.push({ size: [k, k, Math.max(TH, Math.min(wall.t * 1.25, TH * 1.9))], matrix: frame(w.x, w.y, w.z, 1, 0) });
    });
    if (!it.length) return null;

    const c = new THREE.Color(color || EC().reroute);
    const geo = boxGeo(it);
    const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .96, depthTest: false, depthWrite: false });
    mat.userData.ownMat = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    /* 白描边：纯色块在明亮的墙面上会糊掉，勾一圈线才看得出"这是一条规划好的路线" */
    const lm = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .85, depthTest: false });
    lm.userData.ownMat = true;
    const ls = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lm);
    ls.renderOrder = 11;
    if (!eReRoot) { eReRoot = new THREE.Group(); eReRoot.name = 'reroutes'; scene.add(eReRoot); }
    const g = new THREE.Group();
    /* 自检用：这条改线画出来多粗、一共几个方头（管身 + 弯头）。
       回归要断言"改线管径跟真管子同量级、转角有弯头"。 */
    g.userData = { th: TH, sec: sec, boxes: it.length, pts: r.pts.length };
    g.add(mesh); g.add(ls);
    eReRoot.add(g);
    return g;
  };

  /* 单面墙临时半透明（开洞前看墙里有什么），可批量 */
  const ghosted = [];
  S.ghostWall = function (wall, on) {
    const mesh = wallMeshById[wall.id];
    if (!mesh) return;
    if (on) {
      if (mesh.userData.solidMat) return;
      mesh.userData.solidMat = mesh.material;
      const m = mesh.material.clone();
      m.transparent = true; m.opacity = .14; m.depthWrite = false;
      m.side = THREE.DoubleSide;
      mesh.material = m;
      ghosted.push(wall.id);
    } else {
      if (!mesh.userData.solidMat) return;
      const m = mesh.material;
      mesh.material = mesh.userData.solidMat;
      delete mesh.userData.solidMat;
      if (m && m.dispose) m.dispose();
      const i = ghosted.indexOf(wall.id);
      if (i >= 0) ghosted.splice(i, 1);
    }
  };
  S.ghostWalls = function (walls, on) { (walls || []).forEach(w => S.ghostWall(w, on)); };
  S.clearGhostWalls = function () {
    ghosted.slice().forEach(id => {
      const w = M.walls.find(x => x.id === id);
      if (w) S.ghostWall(w, false);
    });
  };

  /* 分路模式：一进来就把"半透明楼体 + 这条分路 + 关联房间"摆好
     —— 用户要的效果是：楼壳子变淡，能看明白电从哪儿来、走到哪几间 */
  S.circuitView = function (circ, rooms) {
    if (!E() || !E().data) return;
    S.setFocus(circ ? circ.floor : 0, false);
    S.showConduits(true);
    S.setXray(true);
    S.showCircuit(circ ? circ.id : null);
    S.syncCircuitPower();
    if (rooms && rooms.length) S.highlightRooms(rooms, 0x17a673);
    else disposeHl();
  };
  S.circuitViewOff = function () {
    S.showCircuit(null);
    S.showConduits(false);
    S.setXray(false);
    S.clearConduitMarks();
    S.clearGhostWalls();
    disposeHl();
  };

  /* 电气相关的东西在换模型时全部重建 */
  S.rebuildElectric = function () {
    if (!E()) return;
    if (window.BIM_MODEL) E().rebuild ? E().rebuild() : E().build();
    eBuild(); ePanelBuild();
  };

  /* ---------------- 调试 / 投影 ---------------- */
  S.camera = () => camera;
  S.controls = () => controls;
  S.root = () => scene;              // 场景根，排查"某个组到底在哪儿"时要用
  S.project = function (x, y, z) {
    const v = new THREE.Vector3(x, z, -y).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height };
  };
  S.setCam = function (px, py, pz, tx, ty, tz) {
    anim = null;                 // 掐掉正在跑的镜头缓动，否则下一帧就被它拉回去
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
  };
  /* 用户此刻看到的"左右/前后"，换算成 BIM 平面坐标（x 东、y 北）
     这样"往左挪一点"才符合肉眼直觉，而不是写死 -x */
  S.viewAxes = function () {
    const f = new THREE.Vector3();
    camera.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
    r.normalize();
    // three(x, y, z) → BIM(x, -z)
    return { right: { x: r.x, y: -r.z }, fwd: { x: f.x, y: -f.z } };
  };

  /* 兜底自检：把"移动前/移动后"投到屏幕上，看是不是真的往用户说的那个方向走了。
     相机转过来以后万一哪一步符号搞反，这里能把它掰回来（返回 -1 表示要反向）。 */
  S.screenSign = function (dir, room, v) {
    if (!camera || !renderer || !room || !v) return 1;
    let p0, p1;
    try {
      const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2, y = room.elev + .5;
      p0 = S.project(cx, y, cy);
      p1 = S.project(cx + v.x * 0.9, y, cy + v.y * 0.9);
    } catch (e) { return 1; }
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const T = 2;                     // 2 像素以内当看不清，不改
    if (dir === 'left' && dx > T) return -1;
    if (dir === 'right' && dx < -T) return -1;
    if ((dir === 'front' || dir === 'up') && dy > T) return -1;
    if ((dir === 'back' || dir === 'down') && dy < -T) return -1;
    return 1;
  };

  S.reg = reg;
  S.root = () => scene;
  /* 镜头现状：自动化校验"镜头到底站到哪了"用（以前只能靠截图目测） */
  S.camPos = () => ({
    p: camera.position.toArray(), t: controls.target.toArray(),
    dist: camera.position.distanceTo(controls.target)
  });
  S.getRoom = id => M.rooms.find(r => r.id === id);
  S.M = M;
  S.floorOf = lv => floorGroups.find(f => f.level === lv);
})();
