/* AIbim 设备实体模型
   —— 按真实构造拆零件建模（底座/机箱/格栅/检修门/风机/盘管/接管/控制屏…）
   —— 每个设备按材质合并成 4~6 个 mesh（外壳/深色件/金属/铜管/屏幕/指示灯），
      不逐个零件建 mesh，几十台设备也不会掉帧
   —— 坐标系：局部 x = 宽(eq.w)，z = 深(eq.d)，y = 从地面往上 0~eq.h
      由 scene.js 把整组放到 (x, 楼层标高, -y)，正面朝局部 +z
   —— 层次约定（正面 z = d/2，记为 F）：
      机体壳  F-.02 … F-.01      门板/面板  F-.012 … F+.008
      门上的细节（把手/屏/灯）要放到 F+.008 以外，否则会被门板挡住
      格栅凹底 F-.02，叶片 F-.005                                     */
(function () {
  const D = (window.BIM.detail = window.BIM.detail || {});
  const U = () => D.util;
  const THREE = window.THREE;

  /* ---------------- 配色 ----------------
     【机身/裙边】按型号给一套工业漆（真实设备的常见色），
     再把设备自己的 color 混进去 25%，这样界面选的颜色仍有辨识度，
     但不会出现 3.4 t 的机组全身荧光蓝那种塑料感。 */
  const PAINT = {
    'EQ-01': ['#8f9aa5', '#4b5560'],   // 空气压缩机：机灰
    'EQ-02': ['#5b6470', '#333b45'],   // UPS：深灰
    'EQ-03': ['#dde2e6', '#8b98a4'],   // 精密空调：白
    'EQ-04': ['#a8433a', '#7c2f28'],   // 消防泵：消防红
    'EQ-05': ['#39424c', '#20262d'],   // 服务器机柜：黑灰
    'EQ-06': ['#c2c8ce', '#8a929b'],   // 文件柜：浅灰
    'EQ-07': ['#e3e7ea', '#8a929b'],   // 实验台：白
    'EQ-08': ['#e8ecef', '#98a2ac'],   // 离心机：白
    'EQ-09': ['#b6bec6', '#7b838b'],   // 新风机组：镀锌
    'EQ-10': ['#4d5661', '#2e3640'],   // 柴发：深灰
    'EQ-11': ['#c6cdd4', '#78828b'],   // 风冷冷水：浅灰
    'EQ-12': ['#9aa3ac', '#5c656e']    // 干式变压器：灰
  };

  /* ---------------- 材质（按 型号+主色 缓存） ---------------- */
  const CACHE = {};
  function matsFor(color, lib) {
    const key = String(color || '#4f7df3') + '|' + (lib || '');
    if (CACHE[key]) return CACHE[key];
    const std = U().std;
    const pick = new THREE.Color(color || '#4f7df3');
    const pa = PAINT[lib];
    let shell, trim;
    if (pa) {
      shell = new THREE.Color(pa[0]).lerp(pick, .18);
      trim = new THREE.Color(pa[1]).lerp(pick, .12);
    } else {
      const hsl = {};
      pick.getHSL(hsl);
      shell = new THREE.Color().setHSL(hsl.h, Math.min(hsl.s * .4, .13), .74);
      trim = new THREE.Color().setHSL(hsl.h, Math.min(hsl.s * .8, .28), .42);
    }
    // 柜体深色的型号，机身深就不要再压深裙边，反而要提亮一点做层次
    const darkBody = (lib === 'EQ-05' || lib === 'EQ-02' || lib === 'EQ-10');
    const m = {
      shell: std({ color: shell, roughness: .46, metalness: .28, envMapIntensity: .72 }),
      trim: std({ color: trim, roughness: .5, metalness: .4, envMapIntensity: .68 }),
      dark: std({ color: 0x242b33, roughness: .78, metalness: .18 }),
      steel: std({ color: 0x46505c, roughness: .44, metalness: .72, envMapIntensity: .85 }),  // 电机/槽钢件
      metal: std({ color: darkBody ? 0xb0bac4 : 0xa8b2bc, roughness: .28, metalness: .85, envMapIntensity: 1.05 }),
      copper: std({ color: 0xa8662a, roughness: .34, metalness: .88 }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x0a141c, roughness: .12, metalness: .4,
        emissive: new THREE.Color(0x0d3a4a), emissiveIntensity: .55, envMapIntensity: 1.3
      }),
      lamp: new THREE.MeshStandardMaterial({
        color: 0x0d1a14, emissive: new THREE.Color(0x3fe08f), emissiveIntensity: 1.2
      }),
      warn: new THREE.MeshStandardMaterial({
        color: 0x241409, emissive: new THREE.Color(0xff7a28), emissiveIntensity: 1.0
      })
    };
    CACHE[key] = m;
    return m;
  }

  /* ---------------- 几何小工具（局部坐标） ---------------- */
  const _Rx = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const _Rz = new THREE.Matrix4().makeRotationZ(Math.PI / 2);

  const CGEO = {};
  const UNIT = new THREE.BoxGeometry(1, 1, 1);
  function cyl(r, h, x, y, z, axis, seg) {
    const k = r.toFixed(3) + '_' + h.toFixed(3) + '_' + (seg || 12);
    const g = CGEO[k] || (CGEO[k] = new THREE.CylinderGeometry(r, r, h, seg || 12));
    let m;
    if (axis === 'x') m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(_Rz);
    else if (axis === 'z') m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(_Rx);
    else m = new THREE.Matrix4().makeTranslation(x, y, z);
    return { g: g, m: m };
  }
  // 任意轴旋转的盒子（风机叶片、斜置板用）
  function boxR(sx, sy, sz, x, y, z, rx, ry, rz) {
    const e = new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)
    );
    return { g: UNIT, m: m };
  }

  /* 收集器：按材质归档零件 */
  function bag() {
    const B = { shell: [], trim: [], dark: [], metal: [], steel: [], copper: [], glass: [], lamp: [], warn: [] };
    const self = {
      B: B,
      b(bk, sx, sy, sz, x, y, z, ry) { B[bk].push(U().boxM(sx, sy, sz, x, y, z, ry || 0)); },
      r(bk, sx, sy, sz, x, y, z, rx, ry, rz) { B[bk].push(boxR(sx, sy, sz, x, y, z, rx, ry, rz)); },
      c(bk, r, h, x, y, z, axis, seg) { B[bk].push(cyl(r, h, x, y, z, axis, seg)); },
      // 贴在 +z 正面的一块板（z 是板中心所在的面）
      plate(bk, w, h, x, y, F, t) { B[bk].push(U().boxM(w, h, t || .02, x, y, F - .002, 0)); },
      // 正面的矩形边框（4 条）
      frame(bk, w, h, x, y, F, f, t) {
        f = f || .03; t = t || .03;
        B[bk].push(U().boxM(w + f * 2, f, t, x, y + h / 2 + f / 2, F, 0));
        B[bk].push(U().boxM(w + f * 2, f, t, x, y - h / 2 - f / 2, F, 0));
        B[bk].push(U().boxM(f, h, t, x - w / 2 - f / 2, y, F, 0));
        B[bk].push(U().boxM(f, h, t, x + w / 2 + f / 2, y, F, 0));
      },
      /* 通用百叶格栅：任意朝向的面，横向叶片（间距自动按高度算，密一点才像格栅）
         face: 'pz' 正面 / 'nz' 背面 / 'px' 右侧 / 'nx' 左侧
         w 沿面宽方向（pz/nz 是 x，px/nx 是 z），h 是高度，c* 是面中心 */
      louver(face, w, h, cx, cy, cz, slat, frameBk, pitch) {
        const zf = (face === 'pz' || face === 'nz');
        const sg = (face === 'pz' || face === 'px') ? 1 : -1;
        const n = Math.max(4, Math.round(h / (pitch || .095)));
        const gap = h / n, t = Math.min(gap * .55, .024);
        if (zf) B.dark.push(U().boxM(w, h, .012, cx, cy, cz - sg * .018, 0));
        else B.dark.push(U().boxM(.012, h, w, cx - sg * .018, cy, cz, 0));
        for (let i = 0; i < n; i++) {
          const yy = cy - h / 2 + gap * (i + .5);
          if (zf) this.r(slat, w * .995, t, .02, cx, yy, cz - sg * .004, -sg * .5, 0, 0);
          else this.r(slat, .02, t, w * .995, cx - sg * .004, yy, cz, 0, 0, sg * .5);
        }
        if (frameBk) {
          const f = .026, tt = .032;
          if (zf) {
            this.b(frameBk, w + f * 2, f, tt, cx, cy + h / 2 + f / 2, cz);
            this.b(frameBk, w + f * 2, f, tt, cx, cy - h / 2 - f / 2, cz);
            this.b(frameBk, f, h, tt, cx - w / 2 - f / 2, cy, cz);
            this.b(frameBk, f, h, tt, cx + w / 2 + f / 2, cy, cz);
          } else {
            this.b(frameBk, tt, f, w + f * 2, cx, cy + h / 2 + f / 2, cz);
            this.b(frameBk, tt, f, w + f * 2, cx, cy - h / 2 - f / 2, cz);
            this.b(frameBk, tt, h, f, cx, cy, cz - w / 2 - f / 2);
            this.b(frameBk, tt, h, f, cx, cy, cz + w / 2 + f / 2);
          }
        }
      },
      // 一排指示灯
      leds(n, x, y, z, gap) {
        for (let i = 0; i < n; i++) {
          B[i % 3 === 2 ? 'warn' : 'lamp'].push(U().boxM(.032, .032, .012, x + (i - (n - 1) / 2) * (gap || .07), y, z, 0));
        }
      },
      // 一块控制屏：深色屏 + 金属边框（F 为该面）
      screen(w, h, x, y, F) {
        B.metal.push(U().boxM(w + .05, h + .05, .012, x, y, F + .004, 0));
        B.glass.push(U().boxM(w, h, .014, x, y, F + .014, 0));
      },
      // 管口法兰
      flange(r, x, y, z, axis, bk) { B[bk || 'metal'].push(cyl(r, .035, x, y, z, axis, 14)); },
      // 轴流风机：风筒 + 暗腔 + 轮毂 + 叶片 + 护网（axis 'y' 顶装 / 'z' 侧装）
      fan(r, x, y, z, axis, n) {
        const top = axis === 'y';
        B.trim.push(cyl(r, .12, x, y, z, axis, 22));
        B.dark.push(cyl(r * .94, .04, x, top ? y + .05 : y, top ? z : z + .05, axis, 22));
        B.metal.push(cyl(r * .2, .14, x, y, z, axis, 12));
        for (let i = 0; i < (n || 4); i++) {
          const a = i * Math.PI * 2 / (n || 4);
          if (top) this.r('metal', r * 1.62, .016, r * .32, x, y + .045, z, 0, a, .18);
          else this.r('metal', r * 1.62, r * .32, .016, x, y, z + .045, a, 0, .18);
        }
        for (let i = -2; i <= 2; i++) {
          if (top) this.b('metal', r * 1.9, .012, .016, x, y + .075, z + i * r * .38);
          else this.b('metal', r * 1.9, .016, .012, x, y + i * r * .38, z + .075);
        }
      }
    };
    return self;
  }

  /* =======================================================================
     各设备构造（key = 设备库型号 id；入口也接受 eq.lib）
     ======================================================================= */
  const BUILD = {};

  /* EQ-01 空气压缩机：减振底座 + 机箱（检修门 + 散热格栅）+ 顶部冷却风机 + 出口管 */
  BUILD['EQ-01'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2, top = h - .2;
    o.b('dark', w, .05, d, 0, .025, 0);                                   // 减振垫
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      o.c('dark', .07, .1, sx * (w / 2 - .2), .1, sz * (d / 2 - .18), 'y', 8);
    });
    o.b('metal', w - .08, .14, d - .08, 0, .14, 0);                       // 槽钢底架
    o.b('shell', w - .16, top - .2, d - .14, 0, .2 + (top - .2) / 2, 0);  // 机箱
    o.b('trim', w - .06, .07, d - .06, 0, top - .03, 0);                  // 压顶
    // 前面：左检修门 + 右散热格栅
    o.plate('shell', w * .42, top - .34, -w * .25, .22 + (top - .34) / 2, F, .022);
    o.frame('trim', w * .42, top - .34, -w * .25, .22 + (top - .34) / 2, F + .012, .022, .026);
    o.b('metal', .035, .22, .05, -w * .07, .24 + (top - .34) / 2, F + .03);
    o.louver('pz', w * .36, top - .4, w * .22, .22 + (top - .4) / 2, F, 'metal', 'trim');
    // 侧面散热格栅
    o.louver('px', d * .44, top - .42, w / 2 - .01, .22 + (top - .42) / 2, 0, 'metal', null);
    // 控制屏 + 指示灯
    o.screen(.24, .16, -w * .25, top - .16, F + .012);
    o.leds(3, -w * .25, top - .32, F + .04, .06);
    // 顶部冷却风机（凸出屋顶，带护网）
    o.fan(.25, w * .1, top + .04, -.02, 'y', 4);
    // 出口铜管：立 + 弯 + 法兰
    o.c('copper', .052, .42, -w * .37, h + .06, -d * .12, 'y', 10);
    o.c('copper', .052, .26, -w * .37, h + .24, -d * .12 + .11, 'z', 10);
    o.flange(.095, -w * .37, h + .3, -d * .12 + .24, 'z');
  };

  /* EQ-02 UPS 电源柜：双门柜体 + 上部显示单元 + 下部进风格栅 + 顶部散热 */
  BUILD['EQ-02'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('trim', w, .09, d, 0, .045, 0);                                  // 踢脚
    o.b('shell', w - .04, h - .16, d - .04, 0, .09 + (h - .16) / 2, 0);  // 柜体
    o.b('trim', w, .06, d, 0, h - .03, 0);                               // 顶盖
    o.b('dark', w * .76, .04, d * .76, 0, h - .065, 0);                  // 顶部散热网
    // 双门：门板 + 门缝 + 门框
    [-1, 1].forEach(s => {
      const dw = w * .44;
      o.plate('shell', dw, h - .46, s * w * .235, .16 + (h - .46) / 2, F, .022);
      o.frame('trim', dw, h - .46, s * w * .235, .16 + (h - .46) / 2, F + .012, .02, .024);
      o.b('metal', .05, .28, .05, s * w * .05, h * .5, F + .035);        // 门把手
    });
    o.b('dark', .014, h - .46, .012, 0, .16 + (h - .46) / 2, F + .014);  // 双门缝
    // 上部显示单元：屏 + 4 灯 + 铭牌
    o.b('trim', w * .94, .2, .026, 0, h - .2, F + .012);
    o.screen(.24, .14, -w * .3, h - .2, F + .026);
    o.leds(4, w * .16, h - .22, F + .034, .07);
    o.b('metal', w * .3, .05, .012, w * .16, h - .14, F + .026);          // 铭牌
    // 下部进风格栅
    o.louver('pz', w * .8, .34, 0, .36, F, 'metal', 'trim', .08);
  };

  /* EQ-03 精密空调：上部送风格栅 + 双检修门 + 下部回风 + 控制屏 + 凝水管 */
  BUILD['EQ-03'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('dark', w, .07, d, 0, .035, 0);
    o.b('shell', w - .04, h - .12, d - .04, 0, .07 + (h - .12) / 2, 0);
    o.b('trim', w, .05, d, 0, h - .025, 0);
    o.b('trim', w * .96, .05, d * .96, 0, .085, 0);                       // 底裙
    o.louver('pz', w * .84, .2, 0, h - .18, F, 'metal', 'trim');           // 上部送风
    [-1, 1].forEach(s => {                                                 // 双检修门
      o.plate('shell', w * .42, h * .34, s * w * .23, h * .55, F, .022);
      o.frame('trim', w * .42, h * .34, s * w * .23, h * .55, F + .012, .02, .024);
      o.b('metal', .035, .26, .05, s * w * .04, h * .55, F + .034);
    });
    o.b('dark', .012, h * .34, .014, 0, h * .55, F + .012);               // 中缝
    o.louver('pz', w * .76, h * .2, 0, h * .2, F, 'metal', 'trim');        // 下部回风
    o.screen(.26, .16, -w * .28, h * .8, F + .002);                        // 控制屏
    o.leds(3, -w * .28, h * .8 - .14, F + .03, .06);
    o.b('trim', w * .3, .05, d * .3, 0, h + .02, -d * .2);                  // 顶部出风法兰
    [w * .3, w * .3 - .1].forEach(x => {                                    // 冷凝水管
      o.c('copper', .038, .26, x, .14, F + .1, 'z', 10);
      o.flange(.075, x, .14, F + .22, 'z');
    });
  };

  /* EQ-04 消防水泵机组：槽钢底座 + 卧式离心泵 + 电机 + 进出水管 + 控制柜 */
  BUILD['EQ-04'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    // 槽钢底座：两根长梁 + 三根横档（平板看着像托盘，不像机组底座）
    const RZ = d * .3;
    [-1, 1].forEach(s => o.b('steel', w, .1, .12, 0, .06, s * RZ));
    [-w * .34, 0, w * .34].forEach(x => o.b('steel', .1, .09, RZ * 2, x, .055, 0));
    o.b('steel', w * .94, .04, d * .82, 0, .11, 0);                        // 台面板
    const yb = .16 + h * .3;
    // 泵：蜗壳（横置圆柱）+ 泵体 + 出口弯头
    o.c('trim', h * .24, .4, -w * .24, yb, 0, 'x', 18);
    o.c('shell', .18, .3, -w * .24, yb, 0, 'x', 18);
    o.b('shell', .22, h * .2, .26, -w * .24, yb + h * .2, 0);              // 出口喇叭
    o.c('trim', h * .1, .12, -w * .24, yb + h * .24, 0, 'y', 14);
    o.flange(h * .13, -w * .24, yb + h * .3, 0, 'y');
    o.c('copper', .09, h * .5, -w * .24, yb + h * .28, 0, 'y', 12);
    o.b('steel', .3, .1, .3, -w * .24, .14, 0);                            // 泵支座
    o.c('dark', .1, .16, -w * .02, yb, 0, 'x', 12);                        // 联轴器护罩
    // 电机（钢件色，和红色泵体分开）+ 散热筋 + 风罩 + 接线盒
    o.c('steel', h * .19, .7, w * .2, yb, 0, 'x', 18);
    for (let i = 0; i < 5; i++) o.c('steel', h * .198, .014, w * .2 - .18 + i * .09, yb, 0, 'x', 18);
    o.b('steel', .18, .15, .18, w * .28, yb + h * .19, 0);                 // 接线盒
    o.c('dark', h * .16, .05, w * .48, yb, 0, 'x', 18);                    // 风罩
    o.c('metal', h * .17, .02, w * .51, yb, 0, 'x', 18);
    o.b('steel', .1, .06, d * .5, w * .18, .14, 0);                        // 电机支脚
    // 进水管 + 出水管
    o.c('copper', .09, h * .42, -w * .24, h * .42, -d * .34, 'y', 12);
    o.flange(.13, -w * .24, h * .62, -d * .34, 'y');
    o.c('copper', .075, .3, -w * .24, yb + h * .06, -d * .34, 'z', 12);
    // 压力表
    o.c('metal', .06, .035, -w * .24, yb + h * .36, -d * .16, 'y', 12);
    o.c('glass', .045, .02, -w * .24, yb + h * .39, -d * .16, 'y', 14);
    // 控制柜（立在机组前右角，正面朝前，别插进电机里）
    const cw = .46, cd = .32, chh = h * .72;
    const cx2 = w * .36, cz2 = d * .26 + cd / 2;
    o.b('shell', cw, chh, cd, cx2, .13 + chh / 2, cz2 - cd / 2);
    o.plate('shell', cw * .9, chh * .88, cx2, .13 + chh / 2, cz2, .022);
    o.frame('trim', cw * .9, chh * .88, cx2, .13 + chh / 2, cz2 + .012, .02, .024);
    o.screen(.22, .15, cx2, .13 + chh * .72, cz2 + .026);
    o.leds(3, cx2, .13 + chh * .55, cz2 + .038, .06);
    o.b('metal', .03, .22, .04, cx2 + cw * .34, .13 + chh * .3, cz2 + .034);
  };

  /* EQ-05 服务器机柜：框架 + 前门框 + U 位服务器 + 顶部风扇 */
  BUILD['EQ-05'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('trim', w, .1, d, 0, .05, 0);                                      // 底座
    o.b('shell', w - .05, h - .12, d - .05, 0, .1 + (h - .12) / 2, 0);     // 柜架
    o.frame('trim', w * .86, h * .84, 0, h * .52, F, .034, .036);           // 前门框
    o.b('dark', w * .84, h * .83, .012, 0, h * .52, F - .05);               // 门内暗腔
    // 9 台服务器：面板 + 硬盘位 + 指示灯
    const top = h * .9, bot = h * .14, n = 9, sh = (top - bot) / n;
    for (let i = 0; i < n; i++) {
      const y = bot + sh * (i + .5);
      o.b('trim', w * .8, sh - .022, .03, 0, y, F - .028);
      o.b('dark', w * .17, sh - .07, .012, w * .28, y, F - .008);           // 硬盘位
      o.b('metal', .014, sh - .07, .012, w * .08, y, F - .008);
      o.b('metal', .014, sh - .07, .012, w * .18, y, F - .008);
      o.leds(2, -w * .32, y + sh * .16, F - .004, .05);
    }
    // 顶部两台风扇 + 顶盖
    o.b('trim', w, .04, d, 0, h - .02, 0);
    [[-w * .2, .085], [w * .2, .085]].forEach(([x, r]) => {
      o.c('dark', r, .03, x, h - .05, 0, 'y', 14);
      o.c('metal', r + .008, .012, x, h - .035, 0, 'y', 14);
    });
    // 两侧走线孔
    [-1, 1].forEach(s => o.b('dark', .02, h * .5, d * .5, s * (w / 2 - .02), h * .55, 0));
  };

  /* EQ-06 文件柜组：三组并柜 × 四抽屉 + 拉手 + 台面 */
  BUILD['EQ-06'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    const cw = w / 3, n = 4, dh = (h - .18) / n;
    for (let i = 0; i < 3; i++) {
      const x = -w / 2 + cw * (i + .5);
      o.b('shell', cw - .02, h - .04, d - .02, x, (h - .04) / 2 + .02, 0);   // 柜体
      o.b('dark', .01, h - .06, .012, x - cw / 2 + .012, (h - .04) / 2, F + .006);
      for (let j = 0; j < n; j++) {
        const y = .1 + dh * (j + .5);
        o.plate('shell', cw - .09, dh - .045, x, y, F, .024);
        o.frame('trim', cw - .09, dh - .045, x, y, F + .012, .016, .02);
        o.b('metal', cw * .34, .026, .03, x, y + dh * .18, F + .018);        // 拉手
      }
    }
    o.b('trim', w, .045, d, 0, h - .022, 0);                                  // 台面
  };

  /* EQ-07 实验台：环氧台面 + 三段柜体 + 试剂架 + 水槽龙头 */
  BUILD['EQ-07'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    const cw = w * .31;
    [-w * .32, 0, w * .32].forEach(x => {
      o.b('shell', cw, h - .1, d - .08, x, (h - .1) / 2 + .02, 0);            // 柜体
      for (let j = 0; j < 2; j++) {
        const cy = .09 + (h - .18) / 4 + (h - .18) / 2 * j;
        o.plate('shell', cw - .05, (h - .18) / 2 - .05, x, cy, F - .028, .022);
        o.frame('trim', cw - .05, (h - .18) / 2 - .05, x, cy, F - .016, .016, .02);
        o.b('metal', cw * .4, .022, .028, x, cy + (h - .18) / 9, F - .004);   // 拉手
      }
      o.b('dark', cw - .05, .012, .01, x, h - .16, F - .03);                  // 柜体上沿缝
    });
    o.b('dark', w, .05, d, 0, h - .025, 0);                                   // 环氧台面
    o.b('trim', w, .07, .04, 0, h - .075, F - .01);                           // 前挡水
    // 试剂架：两立柱 + 两层板 + 试剂瓶
    [-w * .4, w * .4].forEach(x => o.b('metal', .05, h * .74, .05, x, h + h * .37, -d * .28));
    [h + .28, h + .54].forEach((y, k) => {
      o.b('trim', w * .84, .028, d * .34, 0, y, -d * .28);
      o.b('metal', .028, .06, d * .34, -w * .42, y + .04, -d * .28);
      o.b('metal', .028, .06, d * .34, w * .42, y + .04, -d * .28);
      for (let i = 0; i < 5; i++) {
        const bx = -w * .3 + i * w * .15;
        o.c(k ? 'glass' : 'copper', .034, .15, bx, y + .09, -d * .28, 'y', 8);
        o.c('dark', .014, .03, bx, y + .18, -d * .28, 'y', 8);
      }
    });
    // 水槽 + 龙头
    o.b('metal', .44, .05, .34, -w * .34, h - .06, -d * .06);
    o.b('dark', .38, .03, .28, -w * .34, h - .075, -d * .06);
    o.c('metal', .02, .3, -w * .34, h + .14, -d * .22, 'y', 10);
    o.c('metal', .02, .16, -w * .34, h + .28, -d * .22 + .08, 'z', 10);
  };

  /* EQ-08 医用离心机：减振脚 + 机身 + 圆机盖（观察窗）+ 控制面板 + 下部散热 */
  BUILD['EQ-08'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    const R = Math.min(w, d) * .5;
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      o.c('dark', .055, .09, sx * (w / 2 - .11), .045, sz * (d / 2 - .11), 'y', 8);
    });
    o.b('shell', w - .05, h - .24, d - .05, 0, .09 + (h - .24) / 2, 0);
    o.b('trim', w - .03, .04, d - .03, 0, h - .22, 0);                        // 上沿
    // 圆机盖：裙边 + 盖面 + 观察窗 + 中心把手 + 锁扣
    o.c('trim', R * .88, .16, 0, h - .14, 0, 'y', 26);
    o.c('shell', R * .84, .06, 0, h - .03, 0, 'y', 26);
    o.c('glass', R * .5, .03, 0, h + .01, 0, 'y', 26);
    o.c('metal', .07, .04, 0, h + .05, 0, 'y', 14);
    o.b('metal', .22, .03, .05, 0, h + .07, 0);
    o.b('metal', .06, .06, .06, 0, h - .06, R * .8);
    // 前控制面板
    o.b('trim', .4, .24, .022, 0, h * .45, F - .012);
    o.screen(.3, .16, 0, h * .45, F + .002);
    o.leds(3, 0, h * .3, F + .012, .08);
    o.louver('pz', w * .36, .13, 0, h * .17, F - .01, 'metal', null);
  };

  /* EQ-09 新风机组（AHU）：分段箱体 + 双检修门 + 圆形法兰接口 + 凝水盘 */
  BUILD['EQ-09'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('metal', w, .09, d, 0, .045, 0);                                     // 基础
    o.b('shell', w - .04, h - .14, d - .04, 0, .09 + (h - .14) / 2, 0);
    // 三段分缝（立柱压条）
    [-w / 6, w / 6].forEach(x => o.b('trim', .05, h - .16, d + .01, x, .09 + (h - .14) / 2, 0));
    // 前面两樘检修门 + 门框 + 观察窗 + 把手 + 铰链
    [-w / 3, w / 3].forEach(x => {
      o.plate('shell', w / 3 - .14, h * .66, x, h * .5, F, .022);
      o.frame('trim', w / 3 - .14, h * .66, x, h * .5, F + .012, .022, .026);
      o.b('glass', .16, .12, .02, x, h * .5 + h * .2, F + .016);
      o.b('metal', .03, .26, .05, x + w / 6 - .16, h * .5, F + .04);
      o.b('metal', .03, .26, .05, x - w / 6 + .16, h * .5, F + .04);
      [-1, 1].forEach(s => o.b('metal', .04, .1, .03, x - w / 6 + .1, h * .5 + s * h * .26, F + .02));
    });
    o.b('dark', .012, h * .66, .012, 0, h * .5, F + .012);                   // 中缝
    // 两端圆形法兰接口
    o.c('metal', d * .32, .16, w / 2 - .06, h * .66, 0, 'x', 22);
    o.c('dark', d * .28, .05, w / 2 + .02, h * .66, 0, 'x', 22);
    o.c('metal', d * .26, .14, -w / 2 + .05, h * .42, 0, 'x', 22);
    o.c('dark', d * .22, .05, -w / 2 - .01, h * .42, 0, 'x', 22);
    // 凝水盘 + 排水
    o.b('metal', w * .62, .07, d * .84, -w * .1, .13, 0);
    o.c('copper', .035, .2, -w * .1, .1, F + .06, 'z', 8);
    // 吊装耳 + 观察窗 + 压差表
    [-w * .36, w * .36].forEach(x => o.b('metal', .1, .07, d * .9, x, h - .06, 0));
    o.b('glass', .24, .14, .022, -w * .3, h * .84, F - .01);
    o.c('metal', .05, .03, w * .3, h * .84, F, 'z', 14);
  };

  /* EQ-10 柴油发电机组：槽钢底架 + 机身 + 散热器端 + 排烟管 + 控制柜 + 油箱 */
  BUILD['EQ-10'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('metal', w, .14, d * .92, 0, .07, 0);                                // 底架
    o.b('dark', w * .94, .05, d * .86, 0, .15, 0);                           // 减振垫
    // 主机身（左 2/3）
    o.b('shell', w * .62, h - .4, d - .16, -w * .16, .18 + (h - .4) / 2, 0);
    o.b('trim', w * .62, .07, d - .12, -w * .16, h - .12, 0);
    o.plate('shell', w * .34, h - .56, -w * .26, .2 + (h - .56) / 2, F - .06, .022);
    o.frame('trim', w * .34, h - .56, -w * .26, .2 + (h - .56) / 2, F - .048, .02, .024);
    o.b('metal', .035, .24, .05, -w * .1, .22 + (h - .56) / 2, F - .03);
    o.louver('pz', w * .16, h * .3, w * .06, h * .52, F - .06, 'metal', 'trim');
    // 散热器端（右）：大面百叶 + 风扇
    o.b('trim', w * .17, h * .84, d * .94, w * .4, .18 + h * .42, 0);
    o.louver('pz', w * .13, h * .66, w * .4, .18 + h * .42, F + .02, 'metal', null);
    o.c('dark', h * .19, .05, w * .4, .18 + h * .45, -d / 2 + .02, 'z', 20);
    o.c('metal', h * .2, .02, w * .4, .18 + h * .45, -d / 2 + .04, 'z', 20);
    // 排烟管：立 + 弯 + 消声器 + 法兰
    o.c('copper', .07, h * .42, -w * .06, h + .04, -d * .28, 'y', 10);
    o.c('copper', .07, .24, -w * .06, h + .24, -d * .28 + .1, 'z', 10);
    o.b('metal', .16, .16, .16, -w * .06, h + .16, -d * .28);
    o.flange(.11, -w * .06, h + .24, -d * .28 + .22, 'z');
    // 控制柜 + 日用油箱
    o.b('shell', .48, h * .46, .28, w * .1, .18 + h * .23, F - .22);
    o.screen(.22, .14, w * .1, .18 + h * .3, F - .08);
    o.leds(3, w * .1, .18 + h * .16, F - .07, .06);
    o.b('metal', w * .46, h * .16, d * .26, -w * .18, .26, -d * .3);
    o.c('copper', .03, .3, -w * .06, .26, -d * .16, 'z', 8);
    // 吊耳
    [-w * .3, w * .12].forEach(x => o.b('metal', .08, .16, .08, x, h - .04, 0));
  };

  /* EQ-11 风冷冷水机组：矩形箱体 + 四周盘管格栅 + 顶置两台轴流风机 + 水管接口 */
  BUILD['EQ-11'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2, fy = h - .22;      // fy：顶板标高
    o.b('metal', w, .14, d, 0, .07, 0);                                    // 底盘
    o.b('trim', w - .04, .12, d - .04, 0, .17, 0);                         // 底裙
    o.b('shell', w - .02, fy - .2, d - .02, 0, .19 + (fy - .2) / 2, 0);    // 箱体
    // 四面盘管格栅（进风面）
    o.louver('pz', w * .9, fy - .46, 0, .2 + (fy - .2) / 2, F, 'metal', 'trim', .085);
    o.louver('nz', w * .9, fy - .46, 0, .2 + (fy - .2) / 2, -F, 'metal', null, .085);
    o.louver('px', d * .78, fy - .46, w / 2, .2 + (fy - .2) / 2, 0, 'metal', null, .085);
    o.louver('nx', d * .78, fy - .46, -w / 2, .2 + (fy - .2) / 2, 0, 'metal', null, .085);
    // 四角立柱
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      o.b('trim', .07, fy - .18, .07, sx * (w / 2 - .04), .18 + (fy - .18) / 2, sz * (d / 2 - .04));
    });
    // 顶板 + 两台轴流风机（带方形护罩）
    o.b('trim', w, .05, d, 0, fy + .02, 0);
    [-w * .23, w * .23].forEach(x => {
      o.fan(d * .3, x, fy + .12, 0, 'y', 4);
      const R = d * .3 + .03;
      [[0, R], [0, -R]].forEach(([dx, dz]) => o.b('metal', R * 2, .05, .05, x + dx, fy + .07, dz));
      [[R, 0], [-R, 0]].forEach(([dx, dz]) => o.b('metal', .05, .05, R * 2, x + dx, fy + .07, dz));
    });
    // 中间电气控制箱 + 屏
    o.b('shell', w * .2, .34, d * .5, 0, fy + .2, 0);
    o.screen(.24, .15, 0, fy + .22, d * .25 + .002);
    o.leds(3, 0, fy + .12, d * .25 + .012, .06);
    // 水管接口（前后各一对）
    [w * .34, -w * .34].forEach(x => {
      o.c('copper', .062, .22, x, .55, F + .07, 'z', 12);
      o.flange(.1, x, .55, F + .18, 'z');
    });
    [-w * .34, w * .34].forEach(x => o.c('copper', .055, .18, x, .48, -F - .06, 'z', 12));
  };

  /* EQ-12 干式变压器：防护外壳（四面网孔）+ 端子排 + 顶部风道 */
  BUILD['EQ-12'] = (eq, o) => {
    const { w, d, h } = eq, F = d / 2;
    o.b('metal', w, .12, d, 0, .06, 0);                                      // 底座
    o.b('trim', w + .04, .05, d + .04, 0, .12, 0);
    o.b('shell', w - .04, h - .24, d - .04, 0, .14 + (h - .24) / 2, 0);
    // 四面网孔格栅
    o.louver('pz', w * .86, h * .56, 0, h * .5, F, 'metal', 'trim', .08);
    o.louver('nz', w * .86, h * .56, 0, h * .5, -F, 'metal', null, .08);
    o.louver('px', d * .5, h * .5, w / 2, h * .5, 0, 'metal', null, .08);
    o.louver('nx', d * .5, h * .5, -w / 2, h * .5, 0, 'metal', null, .08);
    o.b('trim', w, .06, d, 0, h - .03, 0);                                   // 顶盖
    // 顶部散热风道
    o.b('trim', w * .46, .2, d * .46, 0, h + .07, 0);
    o.b('dark', w * .42, .03, d * .42, 0, h + .18, 0);
    for (let i = 0; i < 3; i++) o.b('metal', w * .42, .012, .03, 0, h + .18, -d * .14 + i * d * .14);
    // 高压/低压端子排（正面下部）
    for (let i = 0; i < 3; i++) {
      o.c('copper', .032, .14, -w * .28 + i * .13, h * .2, F + .03, 'y', 8);
      o.c('metal', .05, .022, -w * .28 + i * .13, h * .13, F + .03, 'y', 10);
    }
    o.plate('shell', w * .3, h * .14, 0, h * .18, F + .01, .022);            // 端子箱盖板
    o.leds(3, 0, h * .36, F + .022, .08);
    o.b('metal', .3, .17, .01, w * .26, h * .3, F + .004);                   // 温度表框
    o.b('glass', .26, .13, .02, w * .26, h * .3, F + .012);
  };

  /* 通用兜底：机箱 + 格栅 + 控制屏（导入的 IFC 里认不出型号时用） */
  function generic(eq, o) {
    const { w, d, h } = eq, F = d / 2;
    const shape = eq.shape || 'box';
    o.b('dark', w, .06, d, 0, .03, 0);
    o.b('shell', w - .06, h - .1, d - .06, 0, .06 + (h - .1) / 2, 0);
    o.b('trim', w, .05, d, 0, h - .025, 0);
    if (shape === 'rack') {
      o.frame('trim', w * .86, h * .78, 0, h * .52, F, .03, .034);
      o.b('dark', w * .84, h * .77, .012, 0, h * .52, F - .04);
      for (let i = 0; i < 5; i++) {
        o.b('trim', w * .8, .11, .03, 0, .32 + i * .2, F - .02);
        o.leds(2, -w * .3, .32 + i * .2, F - .004, .05);
      }
    } else if (shape === 'pump') {
      o.b('metal', w * .9, .1, d * .7, 0, .1, 0);
      o.c('metal', h * .16, w * .38, 0, h * .34, 0, 'x', 16);
      o.c('trim', h * .2, w * .3, -w * .12, h * .34, 0, 'x', 16);
      o.c('copper', .06, .34, w * .3, h * .38, F + .06, 'y', 10);
      o.flange(.1, w * .3, h * .55, F + .06, 'y');
    } else {
      o.louver('pz', w * .38, h * .3, -w * .2, h * .55, F, 'metal', 'trim');
      o.screen(.26, .18, w * .22, h * .6, F);
      o.leds(3, w * .22, h * .48, F + .03, .06);
      o.c('copper', .05, .26, -w * .3, h + .05, -d * .2, 'y', 10);
    }
  }

  /* 型号兜底表：设备实例是 Object.assign({}, 库项, {id:'EQP1'}) 来的，
     库型号 id 有时会被实例 id 盖掉，只留得下名字 —— 按名字也能找回型号 */
  const NAME2LIB = {
    '空气压缩机': 'EQ-01', 'UPS 电源柜': 'EQ-02', 'UPS电源柜': 'EQ-02',
    '精密空调机组': 'EQ-03', '消防水泵机组': 'EQ-04', '服务器机柜': 'EQ-05',
    '文件柜组': 'EQ-06', '实验台': 'EQ-07', '医用离心机': 'EQ-08',
    '新风机组': 'EQ-09', '柴油发电机组': 'EQ-10', '风冷冷水机组': 'EQ-11',
    '干式变压器': 'EQ-12'
  };

  /* =======================================================================
     入口：返回 { group, parts, main }
     ======================================================================= */
  D.equipMesh = function (eq) {
    if (!eq || !(eq.w > 0) || !(eq.h > 0)) return null;
    const lib = eq.lib || (BUILD[eq.id] ? eq.id : null) || NAME2LIB[eq.name] || null;
    const M = matsFor(eq.color, lib);
    const o = bag();
    const build = BUILD[lib] || generic;
    try {
      build(eq, o);
    } catch (e) {
      // 任何一台设备建模出错都不能拖垮整个场景
      console.warn('equip mesh fallback', lib, e && e.message);
      Object.keys(o.B).forEach(k => { o.B[k] = []; });
      generic(eq, o);
    }
    const g = new THREE.Group();
    g.userData = { unit: lib };
    const parts = [];
    let main = null, mainVol = -1;
    Object.keys(o.B).forEach(k => {
      const list = o.B[k];
      if (!list.length) return;
      const geo = U().mergeParts(list);
      if (!geo) return;
      const m = new THREE.Mesh(geo, M[k]);
      m.name = 'eq-' + k;
      g.add(m);
      parts.push(m);
      geo.computeBoundingBox();
      const bb = geo.boundingBox, v = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) * (bb.max.z - bb.min.z);
      if (v > mainVol) { mainVol = v; main = m; }
    });
    if (!parts.length) return null;
    return { group: g, parts: parts, main: main || parts[0] };
  };

  /* ================= 设备正面朝向（自动判断） =================
     局部正面 = +z（见文件头），转到 world 后正面指向 (sinθ, -cosθ)。四条候选：
        rot = π      正面朝北  ← 背靠南墙
        rot = 0      正面朝南  ← 背靠北墙
        rot = π/2    正面朝东  ← 背靠西墙
        rot = -π/2   正面朝西  ← 背靠东墙

     判定顺序（从"最像真的装法"往下退）：
     ① 背面能贴上一面墙（净距 ≤ 0.45 m）→ 背靠墙、正面朝房间。
        净距用**进深 d** 算，因为转正之后进深方向必然垂直于靠的那面墙 ——
        以前用半宽 hw 算，0.6 宽 1.2 深的服务器机柜贴西墙永远判不出来，
        结果机柜横着站、深边戳在房间里。
     ② 四面都不靠墙（房间中间）→ 正面朝这间房的门：
        人从门口进来第一眼应该看到操作面/铭牌，而不是机箱屁股。
     ③ 连门都没有 → 正面朝正面空间最大的那一侧。

     结果写回 eq.rot，落位那一刻就定死；碰撞、描红、挪动全部复用它，
     不会出现"放的时候朝东、算碰撞的时候按朝南算"这种两套账。 */
  const ROT = {
    S: Math.PI, N: 0, W: Math.PI / 2, E: -Math.PI / 2
  };
  const SIDE_KEY = { south: 'S', north: 'N', west: 'W', east: 'E' };
  D.ROT_SIDE = ROT;
  /* 靠某面墙装 → 正面朝对面。两种写法都吃：'south' 和 'S' */
  D.rotOfSide = function (side) {
    if (side == null) return 0;
    const k = SIDE_KEY[side] || side;
    return ROT[k] != null ? ROT[k] : 0;
  };

  /* 门在设备的哪个方向（单位向量），没有门就 null */
  function doorVec(room, eq, M) {
    const ds = (M.doors || []).filter(d => d.floor === room.floor &&
      (d.rooms || []).indexOf(room.id) >= 0 && d.pos);
    if (!ds.length) return null;
    let best = null, bd = 1e9;
    ds.forEach(d => {
      const dd = Math.hypot(d.pos[0] - eq.x, d.pos[1] - eq.y);
      if (dd < bd) { bd = dd; best = d; }
    });
    if (!best || bd < 0.35) return null;       // 就站在门口，方向没意义
    return [(best.pos[0] - eq.x) / bd, (best.pos[1] - eq.y) / bd];
  }

  D.equipRot = function (eq, M) {
    if (eq.rot != null) return eq.rot;
    const room = (M.rooms || []).find(r => r.id === eq.room);
    if (!room || eq.x == null || eq.y == null) return 0;
    const w = eq.w || 0, d = eq.d || 0, hd = d / 2;
    const spanX = room.x1 - room.x0, spanY = room.y1 - room.y0;
    if (!w || !d) return 0;

    // 候选：靠哪面墙 + 屁股贴上去还剩多少（负数=已经压进墙里）
    const cands = [
      { k: 'S', rot: ROT.S, nx: 0, ny: 1, gap: (eq.y - room.y0) - hd, fits: w <= spanX - .24 },
      { k: 'N', rot: ROT.N, nx: 0, ny: -1, gap: (room.y1 - eq.y) - hd, fits: w <= spanX - .24 },
      { k: 'W', rot: ROT.W, nx: 1, ny: 0, gap: (eq.x - room.x0) - hd, fits: w <= spanY - .24 },
      { k: 'E', rot: ROT.E, nx: -1, ny: 0, gap: (room.x1 - eq.x) - hd, fits: w <= spanY - .24 }
    ];
    // ① 贴墙：净距在 [-0.06, 0.45] 之间，且这面墙放得下设备的宽度
    const near = cands.filter(c => c.fits && c.gap >= -0.06 && c.gap <= 0.45)
      .sort((a, b) => a.gap - b.gap);
    if (near.length) {
      const dv = doorVec(room, eq, M);
      // 靠角时两面临墙、净距差不多 → 让正面朝门的那一侧
      if (near.length > 1 && dv && Math.abs(near[0].gap - near[1].gap) < 0.12) {
        const dot = c => c.nx * dv[0] + c.ny * dv[1];
        return (dot(near[1]) > dot(near[0]) + 1e-6 ? near[1] : near[0]).rot;
      }
      return near[0].rot;
    }
    // ② 房间中间 → 朝门
    const dv2 = doorVec(room, eq, M);
    if (dv2) {
      let best = cands[0], bd = -2;
      cands.forEach(c => { const s = c.nx * dv2[0] + c.ny * dv2[1]; if (s > bd) { bd = s; best = c; } });
      return best.rot;
    }
    // ③ 没门 → 正面朝空间大的那一侧
    const free = [
      { rot: ROT.S, v: room.y1 - eq.y },     // 朝北，前面留的是到北墙
      { rot: ROT.N, v: eq.y - room.y0 },
      { rot: ROT.W, v: room.x1 - eq.x },
      { rot: ROT.E, v: eq.x - room.x0 }
    ].sort((a, b) => b.v - a.v);
    return free[0].rot;
  };
})();
