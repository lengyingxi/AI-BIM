/* AIbim 真实感增强层
   —— 程序化材质（不依赖任何外部贴图，断网可用）
   —— 吊顶 / 灯具 / 地面面层 / 家具陈设
   —— 屋面（屋面板 + 女儿墙 + 屋面设备）
   —— 管线附件（法兰、支吊架、末端风口）
   —— 风管流向（沿管流动的箭头，阀门关闭即断流）
   由 scene.js 在建模时调用；所有图形都挂在楼层组下，跟着聚焦/隔离一起走。 */
(function () {
  window.BIM = window.BIM || {};
  const D = (window.BIM.detail = {});
  const S = () => window.BIM.scene;

  D.on = { ceil: true, furn: true, flow: false };

  /* ================= 程序化贴图 ================= */
  const TEX = {};
  const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

  function mkTex(key, size, draw) {
    if (TEX[key]) return TEX[key];
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    draw(x, size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    TEX[key] = t;
    return t;
  }

  function grain(x, s, amp) {
    const img = x.getImageData(0, 0, s, s), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - .5) * amp;
      d[i] = clamp255(d[i] + n); d[i + 1] = clamp255(d[i + 1] + n); d[i + 2] = clamp255(d[i + 2] + n);
    }
    x.putImageData(img, 0, 0);
  }

  function speckle(x, s, n, color) {
    x.fillStyle = color;
    for (let i = 0; i < n; i++) {
      x.globalAlpha = .06 + Math.random() * .16;
      const r = .5 + Math.random() * 1.6;
      x.beginPath(); x.arc(Math.random() * s, Math.random() * s, r, 0, 6.2832); x.fill();
    }
    x.globalAlpha = 1;
  }

  /* 内墙乳胶漆：近白 + 极细颗粒 + 一点云斑，避免大面死平 */
  const texPaint = () => mkTex('paint', 256, (x, s) => {
    x.fillStyle = '#eef1f5'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 7; i++) {
      const g = x.createRadialGradient(Math.random() * s, Math.random() * s, 4, Math.random() * s, Math.random() * s, s * .5);
      g.addColorStop(0, 'rgba(255,255,255,.20)'); g.addColorStop(1, 'rgba(210,220,230,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
    }
    grain(x, s, 9);
  });

  /* 混凝土/清水混凝土：偏灰、颗粒更粗、有针孔 */
  const texConc = () => mkTex('conc', 256, (x, s) => {
    x.fillStyle = '#c7d0da'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 5; i++) {
      const g = x.createRadialGradient(Math.random() * s, Math.random() * s, 2, Math.random() * s, Math.random() * s, s * .55);
      g.addColorStop(0, 'rgba(160,175,190,.16)'); g.addColorStop(1, 'rgba(200,210,220,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
    }
    grain(x, s, 24);
    speckle(x, s, 260, '#8f9dad');
  });

  /* 木饰面/木门：竖向木纹 */
  const texWood = () => mkTex('wood', 256, (x, s) => {
    x.fillStyle = '#a97a4e'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      x.strokeStyle = 'rgba(' + (90 + Math.random() * 60 | 0) + ',' + (58 + Math.random() * 40 | 0) + ',30,' + (.06 + Math.random() * .16).toFixed(2) + ')';
      x.lineWidth = .6 + Math.random() * 1.8;
      const px = Math.random() * s;
      x.beginPath(); x.moveTo(px, 0);
      x.bezierCurveTo(px + (Math.random() - .5) * 14, s * .35, px + (Math.random() - .5) * 14, s * .7, px + (Math.random() - .5) * 8, s);
      x.stroke();
    }
    grain(x, s, 10);
  });

  /* 镀锌钢板：横向拉丝 */
  const texGalv = () => mkTex('galv', 256, (x, s) => {
    x.fillStyle = '#b9c4cf'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 420; i++) {
      x.strokeStyle = 'rgba(255,255,255,' + (Math.random() * .12).toFixed(2) + ')';
      x.lineWidth = .5 + Math.random();
      const y = Math.random() * s;
      x.beginPath(); x.moveTo(0, y); x.lineTo(s, y); x.stroke();
    }
    grain(x, s, 8);
  });

  /* 满铺地毯：密点 */
  const texCarpet = () => mkTex('carpet', 128, (x, s) => {
    x.fillStyle = '#a7b0ba'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 5200; i++) {
      x.fillStyle = Math.random() > .5 ? 'rgba(255,255,255,.16)' : 'rgba(90,102,116,.16)';
      x.fillRect(Math.random() * s, Math.random() * s, 1, 1);
    }
  });

  /* 地砖：4×4 格，带缝 */
  const texTile = () => mkTex('tile', 256, (x, s) => {
    x.fillStyle = '#dfe4e9'; x.fillRect(0, 0, s, s);
    grain(x, s, 10);
    x.strokeStyle = 'rgba(150,162,175,.75)'; x.lineWidth = 2;
    const n = 4, st = s / n;
    for (let i = 0; i <= n; i++) {
      x.beginPath(); x.moveTo(i * st, 0); x.lineTo(i * st, s); x.stroke();
      x.beginPath(); x.moveTo(0, i * st); x.lineTo(s, i * st); x.stroke();
    }
  });

  /* 矿棉板吊顶：2×2 块 + 龙骨 + 针孔（一格 600 mm） */
  const texCeil = () => mkTex('ceilTile', 256, (x, s) => {
    x.fillStyle = '#f4f6f8'; x.fillRect(0, 0, s, s);
    grain(x, s, 8);
    for (let i = 0; i < 1500; i++) {
      x.fillStyle = 'rgba(190,198,206,.5)';
      x.fillRect(Math.random() * s, Math.random() * s, 1, 1);
    }
    x.strokeStyle = 'rgba(176,186,196,.95)'; x.lineWidth = 5;
    x.strokeRect(2.5, 2.5, s - 5, s - 5);
    x.beginPath(); x.moveTo(s / 2, 0); x.lineTo(s / 2, s); x.stroke();
    x.beginPath(); x.moveTo(0, s / 2); x.lineTo(s, s / 2); x.stroke();
  });

  /* 屋面卷材：深灰 + 砂粒 */
  const texRoof = () => mkTex('roof', 256, (x, s) => {
    x.fillStyle = '#8f979f'; x.fillRect(0, 0, s, s);
    grain(x, s, 26);
    speckle(x, s, 700, '#6c757e');
  });

  /* 家具木纹（浅色枫木桌面） */
  const texMaple = () => mkTex('maple', 256, (x, s) => {
    x.fillStyle = '#d8c6a8'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      x.strokeStyle = 'rgba(150,124,90,' + (.04 + Math.random() * .1).toFixed(2) + ')';
      x.lineWidth = .8 + Math.random() * 1.6;
      const y = Math.random() * s;
      x.beginPath(); x.moveTo(0, y);
      x.bezierCurveTo(s * .35, y + (Math.random() - .5) * 8, s * .7, y + (Math.random() - .5) * 8, s, y);
      x.stroke();
    }
    grain(x, s, 8);
  });

  /* 贴图平铺：盒子面 UV 是 0~1，不设 repeat 的话一张 256 的噪点会被拉成
     33 米长的条纹（看起来像墙在流眼泪）。这里按用途给不同平铺次数。 */
  function rep(t, rx, ry) {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    return c;
  }

  /* ================= 材质 ================= */
  // envMapIntensity 压低：环境贴图只用来出高光，不参与"照亮"，
  // 否则整体被白环境拉亮，墙、管、地面全糊成一片浅灰
  const std = (o) => new THREE.MeshStandardMaterial(Object.assign({
    roughness: .9, metalness: 0, envMapIntensity: .45
  }, o));

  /* 每层一套（scene.js 的 makeMats 会并进去），隔离/淡出时统一调透明度 */
  D.mats = function () {
    const m = {
      wallExt: std({ color: 0xc4cfda, map: rep(texConc(), 6, 4), roughness: .93 }),
      wallInt: std({ color: 0xe6ebf0, map: rep(texPaint(), 7, 4), roughness: .95 }),
      slab: std({ color: 0xb9c3ce, map: rep(texConc(), 8, 8), roughness: .95 }),
      col: std({ color: 0xb5bfca, map: rep(texConc(), 2, 2), roughness: .9 }),
      beam: std({ color: 0xbdc7d2, map: rep(texConc(), 4, 1), roughness: .9 }),
      door: std({ color: 0xa9764a, map: rep(texWood(), 1, 2), roughness: .62, metalness: .05 }),
      duct: std({ color: 0x7d8894, map: texGalv(), roughness: .38, metalness: .55, envMapIntensity: .8, vertexColors: true }),

      ceil: new THREE.MeshStandardMaterial({
        color: 0xf7f8fa, map: texCeil(), roughness: .94, metalness: 0,
        side: THREE.DoubleSide, envMapIntensity: .3
      }),
      lamp: new THREE.MeshStandardMaterial({
        color: 0xfdfdfd, roughness: .5, metalness: 0,
        emissive: new THREE.Color(0xfff0d2), emissiveIntensity: 1.1
      }),
      carpet: std({ color: 0x87919d, map: rep(texCarpet(), 16, 16), roughness: 1, envMapIntensity: .2 }),
      tile: std({ color: 0xcdd6de, map: texTile(), roughness: .5, metalness: .04 }),

      deskWood: std({ color: 0xe8dcc6, map: rep(texMaple(), 2, 1), roughness: .55, metalness: .04 }),
      deskMetal: std({ color: 0x4b5561, roughness: .42, metalness: .68 }),
      fab: std({ color: 0x4f5966, roughness: .97, envMapIntensity: .2 }),
      screen: std({ color: 0x1b2229, roughness: .18, metalness: .45 }),
      white: std({ color: 0xe9edf1, roughness: .38, metalness: .1 }),
      pot: std({ color: 0x8d959e, roughness: .8 }),
      leaf: std({ color: 0x3e7046, roughness: .95 }),

      winFrame: std({ color: 0x8e99a4, roughness: .3, metalness: .85, envMapIntensity: .9 }),
      roof: std({ color: 0x8b939b, map: rep(texRoof(), 10, 10), roughness: .97 }),
      parapet: std({ color: 0xc8d1da, map: rep(texConc(), 6, 1), roughness: .9 }),

      glass: new THREE.MeshPhysicalMaterial({
        color: 0xd6ecff, transparent: true, opacity: .3, roughness: .05, metalness: .05,
        envMapIntensity: 1.5, clearcoat: .9, clearcoatRoughness: .08, side: THREE.DoubleSide
      })
    };
    Object.keys(m).forEach(k => { m[k].userData.baseOpacity = m[k].opacity; });
    return m;
  };

  /* ================= 环境贴图（金属/玻璃的反射来源） ================= */
  D.env = function (renderer, scene) {
    if (!renderer || !THREE.PMREMGenerator || scene.environment) return null;
    try {
      const pm = new THREE.PMREMGenerator(renderer);
      const s = new THREE.Scene();
      const c = document.createElement('canvas'); c.width = 8; c.height = 256;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#dbe8f6'); g.addColorStop(.44, '#f1f4f8');
      g.addColorStop(.56, '#c4cdd7'); g.addColorStop(1, '#7f8b97');
      x.fillStyle = g; x.fillRect(0, 0, 8, 256);
      const tex = new THREE.CanvasTexture(c);
      const sky = new THREE.Mesh(new THREE.SphereGeometry(60, 24, 16),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
      s.add(sky);
      // 几片"窗光"，让玻璃和镀锌钢板有方向性高光
      const lit = new THREE.MeshBasicMaterial({ color: 0xffffff });
      [[0, 20, -56, 46, 30], [0, 32, 56, 46, 22], [-56, 15, 0, 34, 26], [56, 15, 0, 34, 26]].forEach(a => {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(a[3], a[4]), lit);
        p.position.set(a[0], a[1], a[2]);
        p.lookAt(0, 10, 0);
        s.add(p);
      });
      const rt = pm.fromScene(s, .02);
      pm.dispose();
      s.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      sky.material.map.dispose(); sky.material.dispose();
      scene.environment = rt.texture;
      return rt.texture;
    } catch (e) {
      console.warn('环境贴图没做成，用普通光照', e);
      return null;
    }
  };

  /* ================= 几何合并工具 ================= */
  function baseNi(g) {
    if (!g.userData._ni) g.userData._ni = g.index ? g.toNonIndexed() : g.clone();
    return g.userData._ni;
  }
  function mergeParts(parts) {
    if (!parts.length) return null;
    const gs = parts.map(p => {
      const g = baseNi(p.g).clone();
      g.applyMatrix4(p.m);
      return g;
    });
    let n = 0;
    gs.forEach(g => { n += g.attributes.position.count; });
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    gs.forEach(g => {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.computeBoundingSphere();
    return out;
  }

  const BOX = new THREE.BoxGeometry(1, 1, 1);
  function boxM(sx, sy, sz, x, y, z, rot) {
    const m = new THREE.Matrix4();
    if (rot) m.makeRotationY(rot);
    m.scale(new THREE.Vector3(sx, sy, sz));
    m.setPosition(x, y, z);
    return { g: BOX, m: m };
  }
  const CYLS = {};
  function cylM(r, h, x, y, z, seg) {
    const k = r.toFixed(3) + '_' + h.toFixed(3) + '_' + (seg || 12);
    const g = CYLS[k] || (CYLS[k] = new THREE.CylinderGeometry(r, r, h, seg || 12));
    return { g: g, m: new THREE.Matrix4().makeTranslation(x, y, z) };
  }

  /* 世界坐标（BIM x,y,z）→ three */
  const P = (x, y, z) => new THREE.Matrix4().makeTranslation(x, z, -y);

  /* ================= 地面面层 ================= */
  D.floorFinish = function (room, mats) {
    const w = room.x1 - room.x0 - .08, d = room.y1 - room.y0 - .08;
    if (w <= 0 || d <= 0) return null;
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / .6, pos.getZ(i) / .6);
    const soft = room.zone === 'corr' || room.use === '茶水间' || room.use === '空调机房' || room.use === '档案室';
    const m = new THREE.Mesh(geo, soft ? mats.tile : mats.carpet);
    m.position.set((room.x0 + room.x1) / 2, room.elev + .012, -(room.y0 + room.y1) / 2);
    m.userData = { kind: 'floorfin', room: room.id, floor: room.floor };
    return m;
  };

  /* ================= 吊顶 + 灯盘 ================= */
  D.ceiling = function (room, mats, fl) {
    if (room.use === '空调机房' || room.zone === 'core') return null;   // 机房要检修，不做吊顶
    const w = room.x1 - room.x0 - .12, d = room.y1 - room.y0 - .12;
    if (w < 1 || d < 1) return null;
    const z = room.elev + (fl.height - 1.05);
    const g = new THREE.Group();
    g.userData = { kind: 'ceil', room: room.id, floor: room.floor };

    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / .6, pos.getZ(i) / .6);
    const p = new THREE.Mesh(geo, mats.ceil);
    p.position.set((room.x0 + room.x1) / 2, z, -(room.y0 + room.y1) / 2);
    p.userData = { kind: 'ceil', room: room.id, floor: room.floor };
    g.add(p);

    // 灯盘：按开间排，600×1200
    const items = [];
    const nx = Math.max(1, Math.round(w / 3.0)), ny = Math.max(1, Math.round(d / 3.0));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const x = room.x0 + .06 + w * (i + .5) / nx;
        const y = room.y0 + .06 + d * (j + .5) / ny;
        items.push(boxM(w / nx > 2.6 ? 1.2 : .6, .035, .6, x, z - .045, -y));
      }
    }
    if (items.length) {
      const lg = mergeParts(items);
      const lm = new THREE.Mesh(lg, mats.lamp);
      lm.userData = { kind: 'ceil', room: room.id, floor: room.floor };
      g.add(lm);
    }
    return g;
  };

  /* ================= 家具陈设 ================= */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rotPt = (ox, oy, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [ox * c - oy * s, ox * s + oy * c];
  };

  function buildRoom(room, mats) {
    const E = room.elev;
    const B = { deskWood: [], deskMetal: [], fab: [], screen: [], white: [], pot: [], leaf: [] };
    /* 家具落位（x,y,w,d,rot）——碰撞校核要用的"真尺寸"，
       合并成 mesh 之后包围盒只剩整间房，量不出单件，所以要在摆的时候记下来 */
    const KEEP = [];
    function mark(label, x, y, w, d, rot, h) {
      KEEP.push({ label: label, x: x, y: y, w: w, d: d, rot: rot || 0, h: h || 1 });
    }
    function put(b, x, y, z, sx, sy, sz, rot) { B[b].push(boxM(sx, sy, sz, x, z, -y, rot || 0)); }
    function putC(b, r, h, x, y, z) { B[b].push(cylM(r, h, x, z, -y, 14)); }

    /* ---- 单件：工位 ---- */
    function desk(x, y, rot) {
      put('deskWood', x, y, E + .74, 1.5, .04, .72, rot);
      [-1, 1].forEach(sx => [-1, 1].forEach(sy => {
        const p = rotPt(sx * .68, sy * .3, rot);
        put('deskMetal', x + p[0], y + p[1], E + .36, .045, .72, .045, rot);
      }));
      // 显示器 + 键盘
      const mp = rotPt(0, -.2, rot);
      put('screen', x + mp[0], y + mp[1], E + 1.03, .56, .33, .025, rot);
      put('deskMetal', x + mp[0], y + mp[1], E + .83, .16, .18, .16, rot);
      const kp = rotPt(0, .12, rot);
      put('deskMetal', x + kp[0], y + kp[1], E + .765, .34, .02, .12, rot);
      mark('工位', x, y, 1.5, .72, rot, .75);
    }
    function chair(x, y, rot) {
      put('fab', x, y, E + .45, .46, .07, .46, rot);
      const bp = rotPt(0, -.21, rot);
      put('fab', x + bp[0], y + bp[1], E + .74, .44, .5, .06, rot);
      put('deskMetal', x, y, E + .22, .07, .4, .07, rot);
      for (let i = 0; i < 4; i++) {
        const a = rot + i * Math.PI / 2 + Math.PI / 4;
        put('deskMetal', x + Math.cos(a) * .2, y + Math.sin(a) * .2, E + .05, .34, .04, .05, a);
      }
      mark('椅子', x, y, .5, .5, rot, .95);
    }
    function plant(x, y) {
      putC('pot', .17, .34, x, y, E + .17);
      put('leaf', x, y, E + .62, .5, .5, .5, .4);
      put('leaf', x + .1, y - .08, E + .82, .34, .34, .34, .9);
      mark('绿植', x, y, .52, .52, 0, 1.15);
    }
    function cabinet(x, y, w, d, h, rot) {
      put('deskWood', x, y, E + h / 2, w, h, d, rot);
      mark('柜子', x, y, w, d, rot, h);
    }
    function sofa(x, y, w, rot) {
      put('fab', x, y, E + .4, w, .3, .82, rot);
      const bp = rotPt(0, -.32, rot);
      put('fab', x + bp[0], y + bp[1], E + .68, w, .55, .18, rot);
      [-1, 1].forEach(s => {
        const sp = rotPt(s * (w / 2 - .09), 0, rot);
        put('fab', x + sp[0], y + sp[1], E + .55, .18, .3, .82, rot);
      });
      mark('沙发', x, y, w, .85, rot, .78);
    }

    const W = room.x1 - room.x0, Dp = room.y1 - room.y0;
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    const R = mulberry(hash(room.num));
    const use = room.use;

    if (use === '开放办公区' || use === '办公室') {
      const m = use === '办公室' ? 1.0 : .8;
      const ax0 = room.x0 + m, ax1 = room.x1 - m, ay0 = room.y0 + m, ay1 = room.y1 - m;
      const cols = Math.max(1, Math.floor((ax1 - ax0) / 2.05));
      const rows = Math.max(1, Math.floor((ay1 - ay0) / 2.15));
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = ax0 + (ax1 - ax0) * (i + .5) / cols;
          const y = ay0 + (ay1 - ay0) * (j + .5) / rows;
          desk(x, y, 0);
          chair(x, y - 1.0, 0);
        }
      }
      if (use === '办公室') cabinet(room.x0 + .45, cy + 1.2, .42, 1.2, 1.9, Math.PI / 2);
      plant(room.x1 - .55, room.y1 - .55);
    } else if (use === '会议室') {
      const tw = Math.min(2.6, W * .48), td = Math.min(1.2, Dp * .3);
      put('deskWood', cx, cy, E + .74, tw, .05, td, 0);
      mark('会议桌', cx, cy, tw, td, 0, .75);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
        put('deskMetal', cx + sx * (tw / 2 - .25), cy + sy * (td / 2 - .25), E + .36, .06, .72, .06, 0);
      });
      const n = Math.max(2, Math.floor(tw / .8));
      for (let i = 0; i < n; i++) {
        const x = cx - tw / 2 + tw * (i + .5) / n;
        chair(x, cy - td / 2 - .42, 0);
        chair(x, cy + td / 2 + .42, Math.PI);
      }
      chair(cx - tw / 2 - .42, cy, Math.PI / 2);
      chair(cx + tw / 2 + .42, cy, -Math.PI / 2);
      plant(room.x0 + .5, room.y1 - .5);
      // 会议屏
      put('screen', cx, room.y1 - .22, E + 1.45, 1.5, .85, .06, 0);
    } else if (use === '洽谈室') {
      putC('deskWood', .55, .05, cx, cy, E + .74);
      putC('deskMetal', .07, .72, cx, cy, E + .36);
      mark('洽谈桌', cx, cy, 1.12, 1.12, 0, .76);
      for (let i = 0; i < 3; i++) {
        const a = i * 2.094 + .4;
        chair(cx + Math.cos(a) * 1.05, cy + Math.sin(a) * 1.05, a + Math.PI / 2);
      }
      plant(room.x0 + .45, room.y0 + .45);
    } else if (use === '茶水间') {
      const lx = room.x0 + .35;
      put('deskWood', lx, cy, E + .86, .6, .05, Math.min(2.4, Dp - .6), 0);
      put('deskMetal', lx, cy, E + .42, .5, .8, Math.min(2.2, Dp - .9), 0);
      put('deskWood', lx - .1, cy, E + 1.85, .35, .7, Math.min(2.2, Dp - 1.0), 0);
      mark('茶水台', lx, cy, .6, Math.min(2.4, Dp - .6), 0, .9);
      put('white', room.x1 - .45, room.y0 + .55, E + .9, .65, 1.8, .6, 0);
      mark('冰箱', room.x1 - .45, room.y0 + .55, .65, .6, 0, 1.8);
      put('white', room.x1 - .4, room.y1 - .5, E + .52, .34, 1.05, .38, 0);
      putC('white', .16, .3, room.x1 - .4, room.y1 - .5, E + 1.15);
    } else if (use === '档案室') {
      const rowsN = Math.max(1, Math.floor((Dp - .8) / 1.7));
      const sw = Math.min(W - 1.0, 4.6);
      for (let i = 0; i < rowsN; i++) {
        const y = room.y0 + .6 + (Dp - 1.2) * (i + .5) / rowsN;
        // 五层隔板 + 两侧立柱，别做成一个大方块
        for (let k = 0; k < 5; k++) put('deskMetal', cx, y, E + .28 + k * .42, sw, .035, .5, 0);
        [-1, 1].forEach(s => put('deskMetal', cx + s * (sw / 2 - .04), y, E + 1.02, .07, 2.02, .52, 0));
        mark('档案架', cx, y, sw, .54, 0, 2.05);
        // 档案盒
        for (let k = 0; k < 5; k++) {
          const n = Math.floor(sw / .38);
          for (let j = 0; j < n; j++) {
            if (R() < .22) continue;
            put('white', cx - sw / 2 + .19 + j * .38, y, E + .28 + k * .42 + .16, .3, .3, .42, 0);
          }
        }
      }
    } else if (use === '值班室') {
      desk(room.x0 + 1.1, room.y0 + 1.0, 0);
      chair(room.x0 + 1.1, room.y0 + .1, 0);
      sofa(room.x1 - 1.7, room.y1 - .6, 1.9, 0);
      cabinet(room.x0 + .45, room.y1 - .8, .42, .9, 1.8, Math.PI / 2);
      plant(room.x1 - .5, room.y0 + .5);
    } else if (room.zone === 'corr') {
      // 走廊：绿植 + 消火栓箱
      const n = Math.max(2, Math.floor(W / 7));
      for (let i = 0; i < n; i++) {
        const x = room.x0 + W * (i + .5) / n;
        plant(x, room.y0 + (i % 2 ? .45 : Dp - .45));
      }
      put('white', room.x0 + 2.2, room.y0 + .18, E + 1.1, 1.1, .7, .18, 0);
      mark('消火栓箱', room.x0 + 2.2, room.y0 + .18, 1.1, .2, 0, 1.45);
      put('white', room.x0 + .18, room.y1 - .18, E + .6, .1, .06, .1, 0);
    } else if (use === '空调机房') {
      // 机房：基础墩 + 排水沟盖板。设备本来就摆这儿，基础墩不算障碍
      put('deskMetal', cx - 1.4, cy, E + .1, 1.0, .2, 3.0, 0);
      put('deskMetal', cx + 1.4, cy, E + .1, 1.0, .2, 3.0, 0);
    }
    // 随机给一点"生活痕迹"：杯子、纸箱
    if (use === '开放办公区' || use === '办公室') {
      const n = 2 + Math.floor(R() * 3);
      for (let i = 0; i < n; i++) {
        putC('white', .045, .11, room.x0 + .6 + R() * (W - 1.2), room.y0 + .6 + R() * (Dp - 1.2), E + .78);
      }
    }

    // 记下这间房的家具落位，设备碰撞校核要用（重建家具时整体覆盖，不会越积越多）
    D.furnRects[room.id] = KEEP;

    const g = new THREE.Group();
    g.userData = { kind: 'furn', room: room.id, floor: room.floor };
    const MAP = {
      deskWood: mats.deskWood, deskMetal: mats.deskMetal, fab: mats.fab,
      screen: mats.screen, white: mats.white, pot: mats.pot, leaf: mats.leaf
    };
    Object.keys(B).forEach(k => {
      if (!B[k].length) return;
      const geo = mergeParts(B[k]);
      if (!geo) return;
      const m = new THREE.Mesh(geo, MAP[k]);
      m.userData = { kind: 'furn', room: room.id, floor: room.floor };
      g.add(m);
    });
    return g.children.length ? g : null;
  }

  D.furniture = buildRoom;
  /* 每间房的家具落位表：roomId → [{label,x,y,w,d,rot,h}]
     设备放置的碰撞校核会读它（calc.C.obstruct 第 7 条） */
  D.furnRects = {};

  /* ================= 管线附件（法兰 / 支吊架 / 末端风口） ================= */
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function ptSeg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    const L2 = vx * vx + vy * vy + vz * vz || 1e-9;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy + (p[2] - a[2]) * vz) / L2;
    t = Math.max(0, Math.min(1, t));
    return dist3(p, [a[0] + vx * t, a[1] + vy * t, a[2] + vz * t]);
  }
  const termCache = {};
  function terminals(M, floor) {
    if (termCache[floor]) return termCache[floor];
    const ds = M.ducts.filter(d => d.floor === floor);
    const res = {};
    ds.forEach(d => {
      const ends = [];
      [d.a, d.b].forEach(p => {
        const touch = ds.some(o => o !== d && (dist3(p, o.a) < .5 || dist3(p, o.b) < .5 || ptSeg(p, o.a, o.b) < .5));
        ends.push(!touch);
      });
      res[d.id] = ends;
    });
    return (termCache[floor] = res);
  }
  D.terminals = terminals;

  /* 返回喂给 scene.boxGeo 的条目：主体 + 法兰 + 吊架 + 风口
     c 是顶点色：法兰略暗、吊杆更暗、风口最深，靠明暗把"一段一段的钢板管"读出来 */
  D.ductItems = function (d, M) {
    const [ax, ay, az] = d.a, [bx, by] = d.b;
    const len = Math.hypot(bx - ax, by - ay) || 1e-6;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const nx = uy, ny = -ux;                 // 侧向
    const items = [];
    const fr = (x, y, z) => S().frame(x, y, z, ux, uy);
    const C_FL = [.80, .83, .87], C_SUP = [.52, .55, .60], C_GRILL = [.62, .66, .71];

    items.push({ uv: true, size: [len, Math.max(.06, d.h - .04), Math.max(.06, d.w - .04)], matrix: fr((ax + bx) / 2, (ay + by) / 2, az) });

    // 法兰：两端 + 每 3 m 一道
    const fl = t => items.push({
      size: [.085, d.h + .06, d.w + .06], c: C_FL,
      matrix: fr(ax + ux * t, ay + uy * t, az)
    });
    fl(.06); fl(len - .06);
    const stepF = len > 24 ? 3.6 : 3.0;
    for (let t = stepF; t < len - .3; t += stepF) fl(t);

    // 支吊架：横担 + 两根吊杆吊到楼板底
    const flv = (M.floors || []).find(f => f.level === d.floor);
    const topZ = flv ? flv.elev + flv.height - .32 : az + d.h / 2 + 1.0;
    const stepS = len > 24 ? 4.2 : 3.4;
    for (let t = stepS * .55; t < len - .4; t += stepS) {
      const px = ax + ux * t, py = ay + uy * t;
      items.push({ size: [.05, .05, d.w + .34], c: C_SUP, matrix: fr(px, py, az - d.h / 2 - .03) });
      [1, -1].forEach(s => {
        const hx = px + nx * (d.w / 2 + .14) * s, hy = py + ny * (d.w / 2 + .14) * s;
        const bot = az - d.h / 2 - .02;
        const hh = Math.max(.12, topZ - bot);
        items.push({ size: [.026, hh, .026], c: C_SUP, matrix: fr(hx, hy, bot + hh / 2) });
      });
    }

    // 末端风口（散流器）
    const term = terminals(M, d.floor)[d.id] || [false, false];
    term.forEach((isEnd, i) => {
      if (!isEnd || len < .7) return;
      const sg = i === 0 ? 1 : -1;
      const ex = i === 0 ? ax : bx, ey = i === 0 ? ay : by;
      const px = ex + ux * .34 * sg, py = ey + uy * .34 * sg;
      items.push({ size: [.52, .035, .52], c: C_GRILL, matrix: fr(px, py, az - d.h / 2 - .02) });
      items.push({ size: [.09, .07, .52], c: C_GRILL, matrix: fr(px, py, az - d.h / 2 + .02) });
      items.push({ size: [.52, .07, .09], c: C_GRILL, matrix: fr(px, py, az - d.h / 2 + .02) });
    });
    return items;
  };

  /* ================= 窗（框 + 中梃 + 玻璃 + 窗台） ================= */
  D.windowMesh = function (d, mats) {
    const [ux, uy] = d.dir;
    const t = Math.max(.08, d.t || .25);
    const M = S();
    const boxes = [];
    const zc = d.pos[2] + d.sill + d.h / 2;
    const P = (x, y, z) => M.frame(x, y, z, ux, uy);
    const bar = .055;
    // 上下横框
    boxes.push({ size: [d.w, bar, t * .9], matrix: P(d.pos[0], d.pos[1], d.pos[2] + d.sill + bar / 2) });
    boxes.push({ size: [d.w, bar, t * .9], matrix: P(d.pos[0], d.pos[1], d.pos[2] + d.sill + d.h - bar / 2) });
    // 左右竖框
    boxes.push({ size: [bar, d.h, t * .9], matrix: P(d.pos[0] - ux * (d.w / 2 - bar / 2), d.pos[1] - uy * (d.w / 2 - bar / 2), zc) });
    boxes.push({ size: [bar, d.h, t * .9], matrix: P(d.pos[0] + ux * (d.w / 2 - bar / 2), d.pos[1] + uy * (d.w / 2 - bar / 2), zc) });
    // 中梃（宽窗分三格）
    const n = d.w > 2.4 ? 3 : d.w > 1.4 ? 2 : 1;
    for (let i = 1; i < n; i++) {
      const off = -d.w / 2 + d.w * i / n;
      boxes.push({ size: [bar * .8, d.h, t * .8], matrix: P(d.pos[0] + ux * off, d.pos[1] + uy * off, zc) });
    }
    // 窗台板
    boxes.push({ size: [d.w + .14, .05, t + .16], matrix: P(d.pos[0], d.pos[1], d.pos[2] + d.sill - .02) });

    const g = new THREE.Group();
    const fg = S().boxGeo(boxes);
    const frame = new THREE.Mesh(fg, mats.winFrame);
    frame.userData = { kind: 'window', data: d, floor: d.floor };
    g.add(frame);

    const gg = S().boxGeo([{ size: [d.w - .1, d.h - .1, .025], matrix: P(d.pos[0], d.pos[1], zc) }]);
    const glass = new THREE.Mesh(gg, mats.glass);
    glass.userData = { kind: 'window', data: d, floor: d.floor };
    g.add(glass);
    g.userData = { kind: 'window', data: d, floor: d.floor };
    d._mesh = g; d._glass = glass;
    return g;
  };

  /* ================= 屋面 ================= */
  D.roof = function (M) {
    const sp = (M.meta.span || { x: [0, 33], y: [0, 15.6] });
    const W = sp.x[sp.x.length - 1], Dp = sp.y[sp.y.length - 1];
    const Z = M.meta.roof;
    const mats = {
      roof: std({ color: 0x9aa2aa, map: texRoof(), roughness: .97 }),
      concrete: std({ color: 0xd3dae2, map: texConc(), roughness: .9 }),
      metal: std({ color: 0x8f9aa6, roughness: .42, metalness: .7 }),
      dark: std({ color: 0x5b6672, roughness: .6, metalness: .3 })
    };
    const parts = { roof: [], concrete: [], metal: [], dark: [] };
    const B = (b, sx, sy, sz, x, y, z) => parts[b].push(boxM(sx, sy, sz, x, z, -y));
    const C = (b, r, h, x, y, z) => parts[b].push(cylM(r, h, x, z, -y, 18));

    // 屋面板 + 保温防水层
    B('concrete', W + .2, .34, Dp + .2, W / 2, Dp / 2, Z - .17);
    B('roof', W + .06, .08, Dp + .06, W / 2, Dp / 2, Z + .02);
    // 女儿墙 + 压顶
    const pw = .24, ph = 1.05;
    [[W / 2, .12, W, pw], [W / 2, Dp - .12, W, pw], [.12, Dp / 2, pw, Dp], [W - .12, Dp / 2, pw, Dp]].forEach(a => {
      B('concrete', a[2], ph, a[3], a[0], a[1], Z + ph / 2);
      B('roof', a[2] + .1, .07, a[3] + .1, a[0], a[1], Z + ph + .03);
    });
    // 屋面设备：两台冷却塔 + 排风立管 + 检修爬梯
    [[W * .3, Dp * .58], [W * .62, Dp * .58]].forEach(([x, y], i) => {
      B('concrete', 2.7, .3, 2.7, x, y, Z + .15);
      B('metal', 2.3, 1.5, 2.3, x, y, Z + 1.05);
      B('dark', 2.34, .18, 2.34, x, y, Z + .48);
      C('metal', .92, .16, x, y, Z + 1.88);
      C('dark', .78, .06, x, y, Z + 1.98);
    });
    for (let i = 0; i < 4; i++) {
      const x = W * .18 + i * 1.6, y = Dp * .2;
      C('metal', .2, 1.5, x, y, Z + .75);
      C('dark', .28, .12, x, y, Z + 1.55);
    }
    // 爬梯
    for (let i = 0; i < 8; i++) B('metal', .05, .05, .5, W - .6, Dp * .5 - .0, Z + 1.3 + i * .3);
    B('metal', .05, 2.5, .05, W - .6, Dp * .5 - .22, Z + 1.5);
    B('metal', .05, 2.5, .05, W - .6, Dp * .5 + .22, Z + 1.5);

    const g = new THREE.Group();
    g.name = 'roof';
    const MM = { roof: mats.roof, concrete: mats.concrete, metal: mats.metal, dark: mats.dark };
    Object.keys(parts).forEach(k => {
      if (!parts[k].length) return;
      const geo = mergeParts(parts[k]);
      const m = new THREE.Mesh(geo, MM[k]);
      m.userData = { kind: 'roof' };
      g.add(m);
    });
    g.userData = { kind: 'roof' };
    return g;
  };

  /* 吊顶按俯角淡出（俯视看平面、平视看室内）
     阈值给得低一点：默认的"单层视角"俯角约 40°，那个角度必须已经收干净，
     否则从上面根本看不见房间里和吊顶上头的风管 */
  function pitchFactor(cam) {
    const v = new THREE.Vector3();
    cam.getWorldDirection(v);
    const p = Math.asin(Math.min(1, Math.abs(v.y)));
    const LO = .26, HI = .60;               // 15° ~ 34°
    if (p <= LO) return 1;
    if (p >= HI) return .04;
    return 1 - .96 * (p - LO) / (HI - LO);
  }

  D.apply = function () {
    const s = S();
    (s.floors || []).forEach(fg => {
      const u = (fg.g.userData && fg.g.userData.deco) || {};
      const live = s.focus === 0 || fg.level === s.focus;
      const iso = s.isoRoom;
      const ok = r => (!iso || r === iso);
      (u.ceil || []).forEach(g => { g.visible = live && D.on.ceil && ok(g.userData.room); });
      (u.furn || []).forEach(g => { g.visible = live && D.on.furn && ok(g.userData.room); });
      (u.floor || []).forEach(g => { g.visible = live && ok(g.userData.room); });
    });
  };

  D.setCeiling = function (on) { D.on.ceil = on; D.apply(); };
  D.setFurniture = function (on) { D.on.furn = on; D.apply(); };

  /* ================= 流向 ================= */
  let flowGroup = null, flowLevel = -1, flowData = null, flowDirty = true;

  /* 阀开合 / 管段增删以后调一下，下一帧重建箭头 */
  D.touch = function () { flowDirty = true; };

  function flowInfo(M, floor) {
    const R = window.BIM.routes;
    if (!R) return [];
    const idx = R.index(M);
    const ds = M.ducts.filter(d => d.floor === floor);
    if (!ds.length) return [];
    // 总管：连接最多的一段
    let root = ds[0], best = -1;
    ds.forEach(d => { const deg = (idx.adj[d.id] || []).length; if (deg > best) { best = deg; root = d; } });

    // 每段挂着的阀（判断断流）
    const vclosed = id => (idx.ductValve[id] || []).some(vid => {
      const v = (M.valves || []).find(x => x.id === vid);
      return v && !v.open;
    });

    const dist = {}, parent = {}, flowOn = {}, q = [root.id];
    dist[root.id] = 0; flowOn[root.id] = true;
    while (q.length) {
      const u = q.shift();
      (idx.adj[u] || []).forEach(w => {
        if (dist[w] != null) return;
        dist[w] = dist[u] + 1;
        parent[w] = u;
        // 阀关在这一段上，只断它下游；但要继续往下走，
        // 否则阀后的管段根本没被访问到，会被当成"通着"
        flowOn[w] = flowOn[u] !== false && !vclosed(u);
        q.push(w);
      });
    }

    const mid = d => [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
    return ds.map(d => {
      const pd = parent[d.id] ? ds.find(x => x.id === parent[d.id]) : null;
      let from, to;
      if (pd) {
        const pm = mid(pd);
        const da = Math.hypot(d.a[0] - pm[0], d.a[1] - pm[1]);
        const db = Math.hypot(d.b[0] - pm[0], d.b[1] - pm[1]);
        if (da <= db) { from = d.a; to = d.b; } else { from = d.b; to = d.a; }
      } else { from = d.a; to = d.b; }
      const dx = to[0] - from[0], dy = to[1] - from[1];
      const len = Math.hypot(dx, dy) || 1e-6;
      return {
        id: d.id, d: d, from: from, dir: [dx / len, dy / len], len: len,
        // 阀装在这一段上，这段自己也不通；下游在 BFS 里已经一并标掉了
        on: flowOn[d.id] !== false && !vclosed(d.id),
        // 箭头骑在管顶：贴管底会被管身挡住，俯视一眼全是风管
        z: Math.max(d.a[2], d.b[2]) + d.h / 2 + .05
      };
    });
  }

  function dropFlow() {
    if (flowGroup) {
      if (flowGroup.parent) flowGroup.parent.remove(flowGroup);
      flowGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      flowGroup = null;
    }
    flowLevel = -1; flowData = null;
  }

  const FLC = { live: 0x0fb5e0, dead: 0xc0392b };

  function buildFlow(s) {
    const lv = s.focus;
    if (!lv) { dropFlow(); return; }
    const M = s.M || window.BIM_MODEL;
    const list = flowInfo(M, lv).filter(f => f.len > .5);
    if (!list.length) { dropFlow(); return; }
    dropFlow();

    const arrows = [];
    list.forEach(f => {
      const n = Math.max(1, Math.round(f.len / 1.5));
      for (let i = 0; i < n; i++) arrows.push({ f: f, phase: f.len * i / n });
    });
    // 亮 / 断流 分两个 InstancedMesh，各用固定颜色（不用 instanceColor，稳）
    const live = arrows.filter(a => a.f.on), dead = arrows.filter(a => !a.f.on);
    // 平躺在管顶的箭头：俯视一眼就是流向，不是一堆小方块
    const shp = new THREE.Shape();
    shp.moveTo(-.30, .21); shp.lineTo(.02, 0); shp.lineTo(-.30, -.21); shp.lineTo(-.15, 0);
    shp.closePath();
    const geo = new THREE.ShapeGeometry(shp);
    geo.rotateX(-Math.PI / 2);                // 落到水平面，+X 是流向

    const g = new THREE.Group();
    g.name = 'flow';
    g.renderOrder = 9;
    [['live', live], ['dead', dead]].forEach(([k, arr]) => {
      if (!arr.length) return;
      const mat = new THREE.MeshBasicMaterial({ color: FLC[k], side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      mesh.userData.flowKind = k;
      g.add(mesh);
    });
    flowGroup = g; flowLevel = lv;
    flowData = { list: list, arrows: arrows, live: live, dead: dead };
    const fg = (s.floors || []).find(f => f.level === lv);
    (fg ? fg.g : s.root()).add(g);
  }

  const _o = new THREE.Object3D();
  const _dir3 = new THREE.Vector3(), _fwd = new THREE.Vector3(1, 0, 0);   // 箭头几何体朝 +X

  function tickFlow(t) {
    if (!flowGroup || !flowData) return;
    const v = 1.15;                            // m/s
    const mLive = flowGroup.children.find(c => c.userData.flowKind === 'live');
    const mDead = flowGroup.children.find(c => c.userData.flowKind === 'dead');
    const L = [], Dd = [];
    flowData.arrows.forEach(a => { (a.f.on ? L : Dd).push(a); });
    const put = (mesh, idx, a) => {
      const f = a.f;
      const s = f.on ? ((a.phase + t * .001 * v) % f.len) : a.phase;
      _o.position.set(f.from[0] + f.dir[0] * s, f.z, -(f.from[1] + f.dir[1] * s));
      _dir3.set(f.dir[0], 0, -f.dir[1]);
      _o.quaternion.setFromUnitVectors(_fwd, _dir3);
      _o.scale.set(1, 1, 1);
      _o.updateMatrix();
      mesh.setMatrixAt(idx, _o.matrix);
    };
    if (mLive && mLive.isInstancedMesh) { L.forEach((a, i) => put(mLive, i, a)); mLive.instanceMatrix.needsUpdate = true; }
    if (mDead && mDead.isInstancedMesh) { Dd.forEach((a, i) => put(mDead, i, a)); mDead.instanceMatrix.needsUpdate = true; }
  }

  D.setFlow = function (on) {
    D.on.flow = on;
    if (!on) { dropFlow(); if (D.onChange) D.onChange(); return; }
    // 风管在吊顶上面，开流向就得先把吊顶收起来，否则一根都看不见
    if (D.on.ceil) {
      D.on.ceil = false;
      if (D.notify) D.notify('吊顶先收起来，风管在它上头', 'ceil');
    }
    buildFlow(S());
    flowDirty = false;
    D.apply();
    if (D.onChange) D.onChange();
  };

  /* ================= 每帧 ================= */
  let lastT = 0;
  D.update = function (t, cam) {
    const dt = lastT ? Math.min(.1, (t - lastT) / 1000) : 0;
    lastT = t;
    const s = S();
    if (!s) return;

    // 吊顶透明度：俯视时收起来，平视时是实顶
    const f = pitchFactor(cam);
    (s.floors || []).forEach(fg => {
      const m = fg.mats && fg.mats.ceil;
      if (!m) return;
      const lv = s.focus === 0 ? 1 : (fg.level === s.focus ? 1 : .07);
      const op = Math.max(.04, f * lv);
      if (Math.abs(m.opacity - op) > .005) {
        m.opacity = op;
        const tr = op < .97;
        if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
        m.depthWrite = !tr;
      }
    });

    if (D.on.flow) {
      if (flowLevel !== s.focus || flowDirty) { buildFlow(s); flowDirty = false; }
      tickFlow(t);
    }
  };

  D.flowState = function () {
    // 阀刚动过、还没来得及等到下一帧，就现场重算一遍，别给旧快照
    const s = S();
    if (D.on.flow && s && (flowDirty || flowLevel !== s.focus)) {
      buildFlow(s);
      flowDirty = false;
    }
    if (!flowData) return null;
    return {
      level: flowLevel,
      count: flowData.list.length,
      blocked: flowData.list.filter(f => !f.on).map(f => f.id)
    };
  };
  D.flowInfo = flowInfo;

  /* 给 equip.js 用的建模小工具（同一套合并/材质规范，避免两套写法） */
  D.util = { std: std, boxM: boxM, cylM: cylM, mergeParts: mergeParts, P: P, texGalv: texGalv, texPaint: texPaint };
})();
