/* AIbim IFC 读取器
   只依赖 IFC 文件本身，不联网：
   1) 扫 STEP 实体（ISO-10303-21）
   2) 沿 IfcObjectPlacement 叠出世界矩阵
   3) 从 IfcExtrudedAreaSolid / IfcFacetedBrep 取几何，算出每个构件的包围盒
   4) 归到楼层，映射成系统内部的模型结构（房间/墙/板/柱/梁/门/窗/风管/阀）
   导入后的碰撞判断、开洞判断、楼板校核全部按这份真实几何算，不再是固定场景。
*/
(function () {
  window.BIM = window.BIM || {};
  const P = (window.BIM.ifc = {});

  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const IDENT = () => new THREE.Matrix4();

  /* ---------------- STEP 扫描 ---------------- */
  function splitArgs(s) {
    const out = [];
    let depth = 0, q = false, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        cur += c;
        if (c === "'") { if (s[i + 1] === "'") { cur += s[++i]; } else q = false; }
        continue;
      }
      if (c === "'") { q = true; cur += c; continue; }
      if (c === '(') { depth++; cur += c; continue; }
      if (c === ')') { depth--; cur += c; continue; }
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function pv(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (s[0] === '#') return { r: +s.slice(1) };
    if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
    if (s[0] === '(') return splitArgs(s.slice(1, -1)).map(pv);
    if (s === '$' || s === '*') return null;
    if (s[0] === '.' && s[s.length - 1] === '.') return s.slice(1, -1);
    const m = s.match(/^[A-Z][A-Z0-9_]*\s*\(([\s\S]*)\)$/);
    if (m) return pv(m[1]);
    const f = parseFloat(s);
    return isNaN(f) ? s : f;
  }

  function scan(txt) {
    const out = {};
    const n = txt.length;
    let i = 0;
    while (i < n) {
      const h = txt.indexOf('#', i);
      if (h < 0) break;
      let j = h + 1, num = '';
      while (j < n && txt[j] >= '0' && txt[j] <= '9') { num += txt[j]; j++; }
      if (!num) { i = h + 1; continue; }
      while (j < n && /\s/.test(txt[j])) j++;
      if (txt[j] !== '=') { i = j; continue; }
      j++;
      while (j < n && /\s/.test(txt[j])) j++;
      let k = j, type = '';
      while (k < n && /[A-Za-z0-9_]/.test(txt[k])) { type += txt[k]; k++; }
      while (k < n && /\s/.test(txt[k])) k++;
      if (txt[k] !== '(') { i = k; continue; }
      let depth = 0, q = false, e = k;
      for (; e < n; e++) {
        const c = txt[e];
        if (q) { if (c === "'") { if (txt[e + 1] === "'") e++; else q = false; } continue; }
        if (c === "'") { q = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { e++; break; } }
      }
      out[num] = { type: type.toUpperCase(), args: splitArgs(txt.slice(k + 1, e - 1)).map(pv) };
      i = e;
    }
    return out;
  }

  /* ---------------- 变换 ---------------- */
  const norm3 = v => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

  P.parse = function (text) {
    if (!text || text.indexOf('ISO-10303-21') < 0) throw new Error('这不是 IFC 文件');
    if (text.length > 60 * 1024 * 1024) throw new Error('文件太大（超过 60 MB）');
    const E = scan(text);
    const get = id => (id && E[id]) || null;
    const ref = v => (v && v.r) || null;

    const pt3 = v => {
      if (!v) return [0, 0, 0];
      const x = v[0] || 0, y = v[1] || 0, z = v[2] || 0;
      return [x, y, z];
    };

    // 单位
    let LEN = 1;
    Object.keys(E).forEach(id => {
      const e = E[id];
      if (e.type === 'IFCSIUNIT' && String(e.args[1]) === 'LENGTHUNIT') {
        const pre = e.args[2];
        LEN = pre === 'MILLI' ? 0.001 : pre === 'CENTI' ? 0.01 : 1;
      }
      if (e.type === 'IFCCONVERSIONBASEDUNIT' && String(e.args[1]) === 'LENGTHUNIT') {
        const mu = get(ref(e.args[3]));
        const f = mu && mu.type === 'IFCMEASUREWITHUNIT' ? +mu.args[0] : 1;
        LEN = isFinite(f) ? f : 1;
      }
    });

    const mAxis = id => {
      const e = get(id);
      if (!e) return IDENT();
      if (e.type === 'IFCAXIS2PLACEMENT2D') {
        const loc = pt3(get(ref(e.args[0])) && get(ref(e.args[0])).args[0]);
        const rd = get(ref(e.args[1]));
        const xa = rd ? norm3([rd.args[0][0] || 1, rd.args[0][1] || 0, 0]) : [1, 0, 0];
        const ya = cross3([0, 0, 1], xa);
        return new THREE.Matrix4().makeBasis(V3(xa[0], xa[1], 0), V3(ya[0], ya[1], 0), V3(0, 0, 1))
          .setPosition(loc[0], loc[1], 0);
      }
      const locE = get(ref(e.args[0]));
      const loc = locE && locE.type === 'IFCCARTESIANPOINT' ? pt3(locE.args[0]) : [0, 0, 0];
      const axE = get(ref(e.args[1]));
      const rdE = get(ref(e.args[2]));
      const Z = axE && axE.type === 'IFCDIRECTION' ? norm3(pt3(axE.args[0])) : [0, 0, 1];
      let X = rdE && rdE.type === 'IFCDIRECTION' ? norm3(pt3(rdE.args[0])) : [1, 0, 0];
      X = sub3(X, mul3(Z, dot3(X, Z)));
      if (Math.hypot(X[0], X[1], X[2]) < 1e-6) X = Math.abs(Z[0]) < .9 ? [1, 0, 0] : [0, 1, 0];
      X = norm3(X);
      const Y = norm3(cross3(Z, X));
      return new THREE.Matrix4().makeBasis(V3(X[0], X[1], X[2]), V3(Y[0], Y[1], Y[2]), V3(Z[0], Z[1], Z[2]))
        .setPosition(loc[0], loc[1], loc[2]);
    };

    const pcache = {};
    const placement = id => {
      if (!id) return IDENT();
      if (pcache[id]) return pcache[id];
      const e = get(id);
      let m = IDENT();
      if (!e) m = IDENT();
      else if (e.type === 'IFCLOCALPLACEMENT') {
        const par = placement(ref(e.args[0]));
        m = par.clone().multiply(mAxis(ref(e.args[1])));
      } else m = mAxis(id);
      pcache[id] = m;
      return m;
    };

    /* ---------------- 轮廓 ---------------- */
    function profilePts(pid) {
      const e = get(pid);
      if (!e) return null;
      const t = e.type;
      if (t === 'IFCRECTANGLEPROFILEDEF' || t === 'IFCROUNDEDRECTANGLEPROFILEDEF') {
        const xd = +e.args[3] || 1, yd = +e.args[4] || 1;
        const m = mAxis(ref(e.args[2]));
        const half = [[-xd / 2, -yd / 2], [xd / 2, -yd / 2], [xd / 2, yd / 2], [-xd / 2, yd / 2]];
        return half.map(([x, y]) => V3(x, y, 0).applyMatrix4(m).toArray());
      }
      if (t === 'IFCCIRCLEPROFILEDEF' || t === 'IFCCIRCLEHOLLOWPROFILEDEF') {
        const r = +e.args[3] || 0.5;
        const m = mAxis(ref(e.args[2]));
        const out = [];
        for (let i = 0; i < 12; i++) {
          const a = i / 12 * Math.PI * 2;
          out.push(V3(Math.cos(a) * r, Math.sin(a) * r, 0).applyMatrix4(m).toArray());
        }
        return out;
      }
      if (t === 'IFCISHAPEPROFILEDEF' || t === 'IFCTSHAPEPROFILEDEF' || t === 'IFCLSHAPEPROFILEDEF') {
        const w = +e.args[3] || 0.2, d = +e.args[4] || 0.2;
        const m = mAxis(ref(e.args[2]));
        return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
          .map(([x, y]) => V3(x, y, 0).applyMatrix4(m).toArray());
      }
      // 任意闭合轮廓 / 带洞轮廓
      const curveId = ref(e.args[2]);
      const c = get(curveId);
      if (!c) return null;
      if (c.type === 'IFCPOLYLINE') {
        const out = [];
        (c.args[0] || []).forEach(p => {
          const pe = get(ref(p));
          if (pe && pe.type === 'IFCCARTESIANPOINT') out.push(pt3(pe.args[0]));
        });
        return out.length ? out : null;
      }
      if (c.type === 'IFCINDEXEDPOLYCURVE') {
        const pl = get(ref(c.args[0]));
        if (!pl) return null;
        const pts = (pl.args[0] || []).map(p => [p[0] || 0, p[1] || 0, 0]);
        return pts.length ? pts : null;
      }
      if (c.type === 'IFCCOMPOSITECURVE') {
        const out = [];
        (c.args[0] || []).forEach(seg => {
          const s = get(ref(seg));
          if (!s) return;
          if (s.type === 'IFCPOLYLINE') (s.args[0] || []).forEach(p => {
            const pe = get(ref(p));
            if (pe) out.push(pt3(pe.args[0]));
          });
          if (s.type === 'IFCINDEXEDPOLYCURVE') {
            const pl = get(ref(s.args[0]));
            if (pl) (pl.args[0] || []).forEach(p => out.push([p[0] || 0, p[1] || 0, 0]));
          }
        });
        return out.length ? out : null;
      }
      return null;
    }

    function solidPts(s) {
      if (s.type === 'IFCEXTRUDEDAREASOLID' || s.type === 'IFCEXTRUDEDAREASOLIDTAPERED') {
        const pts = profilePts(ref(s.args[0]));
        if (!pts || !pts.length) return null;
        const pm = mAxis(ref(s.args[1]));
        const dE = get(ref(s.args[2]));
        const d = dE && dE.type === 'IFCDIRECTION' ? norm3(pt3(dE.args[0])) : [0, 0, 1];
        const dep = +s.args[3] || 0;
        const out = [];
        pts.forEach(p => {
          // ExtrudedDirection 是在 Position 的局部坐标系里给的
          const b = [p[0], p[1], p[2] || 0];
          const t = [b[0] + d[0] * dep, b[1] + d[1] * dep, b[2] + d[2] * dep];
          [b, t].forEach(q => {
            const v = V3(q[0], q[1], q[2]).applyMatrix4(pm);
            out.push([v.x, v.y, v.z]);
          });
        });
        return out;
      }
      if (s.type === 'IFCFACETEDBREP' || s.type === 'IFCAMANNESHBREP' || s.type === 'IFCFACETEDBREPWITHVOIDS') {
        const out = [];
        const shell = get(ref(s.args[0]));
        if (!shell) return null;
        (shell.args[0] || []).forEach(fid => {
          const f = get(ref(fid));
          if (!f) return;
          (f.args[0] || []).forEach(bid => {
            const b = get(ref(bid));
            if (!b) return;
            const loop = get(ref(b.args[0]));
            if (!loop) return;
            (loop.args[0] || []).forEach(pid2 => {
              const p = get(ref(pid2));
              if (p && p.type === 'IFCCARTESIANPOINT') out.push(pt3(p.args[0]));
            });
          });
        });
        return out.length ? out : null;
      }
      return null;
    }

    function collect(id, out) {
      const e = get(id);
      if (!e) return;
      if (e.type === 'IFCPRODUCTDEFINITIONSHAPE') { (e.args[2] || []).forEach(r => collect(ref(r), out)); return; }
      if (e.type === 'IFCSHAPEREPRESENTATION') {
        if (e.args[2] && String(e.args[2]).toUpperCase() === 'AXIS') return;
        (e.args[3] || []).forEach(it => collect(ref(it), out));
        return;
      }
      if (e.type === 'IFCBOOLEANCLIPPINGRESULT' || e.type === 'IFCBOOLEANRESULT') { collect(ref(e.args[0]), out); return; }
      if (/^IFC(EXTRUDEDAREASOLID|FACETEDBREP|FACETEDBREPWITHVOIDS|AMANNESHBREP)/.test(e.type)) out.push(e);
    }

    /* 构件包围盒（世界坐标，米） */
    function bbox(e) {
      const solids = [];
      collect(ref(e.args[6]), solids);
      if (!solids.length) return null;
      const wp = placement(ref(e.args[5]));
      let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
      let any = false;
      solids.forEach(s => {
        const pts = solidPts(s);
        if (!pts) return;
        pts.forEach(p => {
          const q = V3(p[0] * LEN, p[1] * LEN, p[2] * LEN).applyMatrix4(wp);
          any = true;
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
          if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
          if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
        });
      });
      if (!any) return null;
      // IFC 的 (X 东, Y 北, Z 上) 与系统内部坐标一致，直接用
      return { x0, y0: Math.min(y0, y1), x1, y1: Math.max(y0, y1), z0, z1 };
    }

    /* ---------------- 楼层 ---------------- */
    const storeys = [];
    Object.keys(E).forEach(id => {
      const e = E[id];
      if (e.type !== 'IFCBUILDINGSTOREY') return;
      const elev = (+e.args[9] || 0) * LEN;
      storeys.push({ id: +id, name: e.args[2] || '楼层', elev: elev });
    });
    storeys.sort((a, b) => a.elev - b.elev);
    if (!storeys.length) storeys.push({ id: 0, name: '1F', elev: 0 });
    const levelOfStorey = {};
    storeys.forEach((s, i) => { s.level = i + 1; levelOfStorey[s.id] = s.level; });
    const floorElev = {};
    storeys.forEach(s => { floorElev[s.level] = s.elev; });

    // 构件归属楼层
    const storeyOf = {};
    Object.keys(E).forEach(id => {
      const e = E[id];
      if (e.type !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE') return;
      const sid = ref(e.args[5]);
      const lv = levelOfStorey[sid];
      if (!lv) return;
      (e.args[4] || []).forEach(r => { storeyOf[ref(r)] = lv; });
    });

    const guessLevel = z => {
      let best = 1;
      storeys.forEach(s => { if (z >= s.elev - 0.6) best = s.level; });
      return best;
    };

    /* ---------------- 属性集 ---------------- */
    const props = {};
    Object.keys(E).forEach(id => {
      const e = E[id];
      if (e.type !== 'IFCRELDEFINESBYPROPERTIES') return;
      const ps = get(ref(e.args[5]));
      if (!ps) return;
      const bag = {};
      (ps.args[4] || []).forEach(pvId => {
        const p = get(ref(pvId));
        if (!p) return;
        const nm = p.args[0], val = p.args[2];
        bag[nm] = val;
      });
      (e.args[4] || []).forEach(o => { props[ref(o)] = Object.assign(props[ref(o)] || {}, bag); });
    });

    /* ---------------- 汇总构件 ---------------- */
    const KIND = {
      IFCSLAB: 'slab', IFCWALL: 'wall', IFCWALLSTANDARDCASE: 'wall', IFCWALLELEMENTEDCASE: 'wall',
      IFCCOLUMN: 'column', IFCBEAM: 'beam', IFCDOOR: 'door', IFCWINDOW: 'window', IFCSPACE: 'space',
      IFCDUCTSEGMENT: 'duct', IFCFLOWSEGMENT: 'duct', IFCVALVE: 'valve', IFCPIPESEGMENT: 'duct'
    };

    const buckets = { slab: [], wall: [], column: [], beam: [], door: [], window: [], space: [], duct: [], valve: [] };
    Object.keys(E).forEach(id => {
      const e = E[id];
      const k = KIND[e.type];
      if (!k) return;
      const bb = bbox(e);
      if (!bb) return;
      const lv = storeyOf[+id] || guessLevel((bb.z0 + bb.z1) / 2);
      buckets[k].push({ id: +id, e, bb, level: lv, pset: props[+id] || {} });
    });

    const nameOf = it => (it.e.args[2] || '') + '';
    const count = Object.keys(buckets).reduce((s, k) => s + buckets[k].length, 0);
    if (!count) throw new Error('IFC 里没有读到可用的建筑构件');

    /* ---------------- 房间 ---------------- */
    const SLAB_DEF = { thk: 0.18, dia: 12, sp: 150, cover: 20, fc: 14.3, ft: 1.43, fy: 360, grade: 'C30', steel: 'HRB400', asx: 754, asy: 754 };
    const LIVE = [
      [/机房|设备间|配电|水泵/, 7.0], [/档案|资料|储藏|库房/, 5.0],
      [/实验|试验/, 4.0], [/会议|洽谈/, 2.5], [/走廊|过道/, 2.5],
      [/楼梯|前室|电梯/, 3.5], [/办公|研发|工位/, 2.0], [/卫生间|洗手|厕所/, 2.0]
    ];
    const liveOf = use => { for (const [re, v] of LIVE) if (re.test(use)) return v; return 2.0; };

    const floors = storeys.map(s => {
      const next = storeys.find(x => x.level === s.level + 1);
      return { level: s.level, name: s.name, elev: s.elev, height: next ? +(next.elev - s.elev).toFixed(2) : 4.2 };
    });

    // 板厚：按覆盖最多的小板反推
    const slabsRaw = buckets.slab.map(s => {
      const bb = s.bb;
      return { bb, thk: Math.min(0.6, Math.max(0.08, bb.z1 - bb.z0)), ps: s.pset };
    });

    const rooms = [];
    const usedNum = {};
    const spaces = buckets.space.slice().sort((a, b) => (a.level - b.level) || (a.bb.y0 - b.bb.y0) || (a.bb.x0 - b.bb.x0));
    spaces.forEach((s, i) => {
      const bb = s.bb;
      if (bb.x1 - bb.x0 < 0.6 || bb.y1 - bb.y0 < 0.6) return;
      const ps = s.pset;
      let num = String(ps['房间编号'] || ps['Number'] || ps['number'] || '').trim();
      if (!num) {
        const m = nameOf(s).match(/(\d{3,4})/);
        num = m ? m[1] : String(s.level * 100 + (i + 1));
      }
      if (usedNum[num]) num = num + '-' + (i + 1);
      usedNum[num] = true;
      const use = String(s.e.args[7] || ps['Category'] || ps['空间用途'] || '房间');
      const live = ps['楼面活荷载标准值'] != null ? +ps['楼面活荷载标准值'] : liveOf(use);
      let thk = SLAB_DEF.thk, grade = 'C30';
      let best = 0;
      slabsRaw.forEach(sl => {
        const ov = Math.max(0, Math.min(bb.x1, sl.bb.x1) - Math.max(bb.x0, sl.bb.x0)) *
          Math.max(0, Math.min(bb.y1, sl.bb.y1) - Math.max(bb.y0, sl.bb.y0));
        if (ov > best) { best = ov; thk = sl.thk; grade = String(sl.ps['混凝土强度等级'] || 'C30'); }
      });
      thk = Math.round(thk * 1000) / 1000;
      rooms.push({
        id: num, floor: s.level, num: num, name: (nameOf(s) || (num + ' 房间')),
        use: use, live: live,
        x0: +bb.x0.toFixed(3), y0: +bb.y0.toFixed(3), x1: +bb.x1.toFixed(3), y1: +bb.y1.toFixed(3),
        area: +((bb.x1 - bb.x0) * (bb.y1 - bb.y0)).toFixed(2),
        zone: /走廊|过道|corridor/i.test(use + nameOf(s)) ? 'corr' : 'room',
        elev: floorElev[s.level] != null ? floorElev[s.level] : +bb.z0.toFixed(3),
        slab: Object.assign({}, SLAB_DEF, { thk: thk, grade: grade }),
        sides: {}
      });
    });

    /* ---------------- 墙 + 洞口 ---------------- */
    const walls = [];
    buckets.wall.forEach((w, i) => {
      const bb = w.bb;
      const dx = bb.x1 - bb.x0, dy = bb.y1 - bb.y0;
      const alongX = dx >= dy;
      const t = alongX ? dy : dx;
      if (t < 0.03 || (alongX ? dx : dy) < 0.2) return;
      walls.push({
        id: 'W-' + w.level + '-' + (i + 1), floor: w.level, kind: 'int',
        p1: alongX ? [+bb.x0.toFixed(3), +((bb.y0 + bb.y1) / 2).toFixed(3)] : [+((bb.x0 + bb.x1) / 2).toFixed(3), +bb.y0.toFixed(3)],
        p2: alongX ? [+bb.x1.toFixed(3), +((bb.y0 + bb.y1) / 2).toFixed(3)] : [+((bb.x0 + bb.x1) / 2).toFixed(3), +bb.y1.toFixed(3)],
        t: +Math.max(0.06, t).toFixed(3), h: +(bb.z1 - bb.z0).toFixed(3),
        base: +bb.z0.toFixed(3), rooms: [], openings: [],
        name: nameOf(w) || '墙 ' + (i + 1), _bb: bb
      });
    });

    /* ---------------- 门窗 ---------------- */
    const doors = [], windows = [];
    const mkOpening = (o, kind) => {
      const bb = o.bb;
      const dx = bb.x1 - bb.x0, dy = bb.y1 - bb.y0;
      const alongX = dx >= dy;
      const wide = Math.max(dx, dy);
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      let w = wide, h = bb.z1 - bb.z0;
      const e = o.e;
      // IFC4: IFCDOOR(Tag, OverallHeight, OverallWidth, ...)
      const oh = +e.args[8], ow = +e.args[9];
      if (ow > 0) w = ow * LEN;
      if (oh > 0) h = oh * LEN;
      if (w < 0.2) w = wide;
      if (h < 0.5) h = bb.z1 - bb.z0;
      // 找宿主墙
      let host = null, best = 1e9, at = 0;
      walls.filter(w2 => w2.floor === o.level).forEach(w2 => {
        const [ax, ay] = w2.p1, [bx, by] = w2.p2;
        const L = Math.hypot(bx - ax, by - ay) || 1;
        const ux = (bx - ax) / L, uy = (by - ay) / L;
        const px = (cx - ax) * uy - (cy - ay) * ux;          // 垂直距离
        const s = (cx - ax) * ux + (cy - ay) * uy;            // 沿墙位置
        const dd = Math.abs(px);
        if (dd < w2.t / 2 + 0.45 && s > -0.6 && s < L + 0.6 && dd < best) { best = dd; host = w2; at = Math.max(0, Math.min(L, s)); }
      });
      const base = host ? host.base : bb.z0;
      const sill = kind === 'window' ? Math.max(0, +(bb.z0 - base).toFixed(3)) : 0;
      const d = {
        id: 'D' + (kind === 'door' ? 'D' : 'C') + '-' + o.id, kind: kind, floor: o.level,
        wall: host ? host.id : '', name: nameOf(o) || (kind === 'door' ? '门' : '窗'),
        pos: [+cx.toFixed(3), +cy.toFixed(3), +(base + sill).toFixed(3)],
        w: +w.toFixed(3), h: +h.toFixed(3), sill: sill,
        rooms: host ? host.rooms : [], dir: alongX ? [1, 0] : [0, 1],
        t: host ? host.t : 0.2, host: host
      };
      if (host) host.openings.push({ kind: kind, at: at, w: w, h: h, sill: sill, name: d.name });
      (kind === 'door' ? doors : windows).push(d);
    };
    buckets.door.forEach(o => mkOpening(o, 'door'));
    buckets.window.forEach(o => mkOpening(o, 'window'));

    /* ---------------- 柱 / 梁 ---------------- */
    const columns = [], beams = [];
    buckets.column.forEach((c, i) => {
      const bb = c.bb;
      columns.push({
        id: 'C-' + c.id, floor: c.level,
        x: +((bb.x0 + bb.x1) / 2).toFixed(3), y: +((bb.y0 + bb.y1) / 2).toFixed(3), z: +bb.z0.toFixed(3),
        s: +Math.max(0.2, Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0)).toFixed(3), h: +(bb.z1 - bb.z0).toFixed(3)
      });
    });
    buckets.beam.forEach((b, i) => {
      const bb = b.bb;
      const alongX = (bb.x1 - bb.x0) >= (bb.y1 - bb.y0);
      const w = alongX ? (bb.y1 - bb.y0) : (bb.x1 - bb.x0);
      const h = bb.z1 - bb.z0;
      beams.push({
        id: 'B-' + b.id, floor: b.level, axis: alongX ? 'x' : 'y',
        a: [alongX ? bb.x0 : (bb.x0 + bb.x1) / 2, alongX ? (bb.y0 + bb.y1) / 2 : bb.y0, bb.z1],
        b: [alongX ? bb.x1 : (bb.x0 + bb.x1) / 2, alongX ? (bb.y0 + bb.y1) / 2 : bb.y1, bb.z1],
        w: +Math.max(0.15, w).toFixed(3), h: +Math.max(0.2, h).toFixed(3)
      });
    });

    /* ---------------- 风管 / 阀 ---------------- */
    const ducts = [], valves = [];
    buckets.duct.forEach((d, i) => {
      const bb = d.bb;
      const dx = bb.x1 - bb.x0, dy = bb.y1 - bb.y0, dz = bb.z1 - bb.z0;
      let a, b, w, h;
      const zc = (bb.z0 + bb.z1) / 2;
      if (dz >= dx && dz >= dy) {
        // 竖管
        a = [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, bb.z0];
        b = [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, bb.z1];
        w = Math.max(0.15, Math.min(dx, dy)); h = w;
      } else if (dx >= dy) {
        a = [bb.x0, (bb.y0 + bb.y1) / 2, zc]; b = [bb.x1, (bb.y0 + bb.y1) / 2, zc];
        w = Math.max(0.15, dy); h = Math.max(0.15, dz);
      } else {
        a = [(bb.x0 + bb.x1) / 2, bb.y0, zc]; b = [(bb.x0 + bb.x1) / 2, bb.y1, zc];
        w = Math.max(0.15, dx); h = Math.max(0.15, dz);
      }
      ducts.push({
        id: 'DU-' + (d.level) + '-' + (i + 1), floor: d.level,
        a: a.map(v => +v.toFixed(3)), b: b.map(v => +v.toFixed(3)),
        w: +w.toFixed(3), h: +h.toFixed(3), name: nameOf(d)
      });
    });
    buckets.valve.forEach((v, i) => {
      const bb = v.bb;
      const ps = v.pset;
      valves.push({
        id: 'V' + v.id, floor: v.level,
        name: nameOf(v) || ps['阀门编号'] || ('阀 ' + (i + 1)),
        room: '', pos: [+((bb.x0 + bb.x1) / 2).toFixed(3), +((bb.y0 + bb.y1) / 2).toFixed(3), +((bb.z0 + bb.z1) / 2).toFixed(3)],
        parent: null, serves: [], kind: 'room', open: true
      });
    });

    /* ---------------- 房间 ↔ 墙 / 阀 ---------------- */
    const nearEdge = (v, e) => Math.abs(v - e) < 0.42;
    rooms.forEach(r => {
      walls.filter(w => w.floor === r.floor).forEach(w => {
        const [ax, ay] = w.p1, [bx, by] = w.p2;
        const vertical = Math.abs(bx - ax) < 1e-6;
        const side = vertical
          ? (nearEdge(ax, r.x0) ? 'west' : nearEdge(ax, r.x1) ? 'east' : null)
          : (nearEdge(ay, r.y0) ? 'south' : nearEdge(ay, r.y1) ? 'north' : null);
        if (!side) return;
        const lo = vertical ? Math.min(ay, by) : Math.min(ax, bx);
        const hi = vertical ? Math.max(ay, by) : Math.max(ax, bx);
        const rlo = vertical ? r.y0 : r.x0, rhi = vertical ? r.y1 : r.x1;
        if (Math.min(hi, rhi) - Math.max(lo, rlo) < 0.4) return;
        if (!r.sides[side]) r.sides[side] = w.id;
        if (w.rooms.indexOf(r.id) < 0) w.rooms.push(r.id);
      });
    });
    // 门/窗跟着墙拿到房间
    doors.concat(windows).forEach(d => {
      const w = walls.find(x => x.id === d.wall);
      if (w) d.rooms = w.rooms.slice();
    });
    // 阀件归到它所在/最近的房间
    valves.forEach(v => {
      const hit = rooms.filter(r => r.floor === v.floor &&
        v.pos[0] > r.x0 && v.pos[0] < r.x1 && v.pos[1] > r.y0 && v.pos[1] < r.y1);
      if (hit.length) v.room = hit[0].id;
      else {
        let best = null, bd = 1e9;
        rooms.filter(r => r.floor === v.floor).forEach(r => {
          const dd = Math.hypot(v.pos[0] - (r.x0 + r.x1) / 2, v.pos[1] - (r.y0 + r.y1) / 2);
          if (dd < bd) { bd = dd; best = r; }
        });
        if (best) v.room = best.id;
      }
    });

    /* ---------------- 编号 / meta ---------------- */
    rooms.forEach(r => { r.name = r.name || (r.num + ' 房间'); });
    const sortedRooms = rooms.slice().sort((a, b) => (a.floor - b.floor) || (a.num < b.num ? -1 : 1));
    const maxZ = Math.max.apply(null, [0].concat(columns.map(c => c.z + c.h), ducts.map(d => Math.max(d.a[2], d.b[2]))));
    const xs = [], ys = [];
    rooms.forEach(r => { xs.push(r.x0, r.x1); ys.push(r.y0, r.y1); });
    const area = rooms.reduce((s, r) => s + r.area, 0);

    let built = '';
    Object.keys(E).forEach(id => {
      if (E[id].type === 'IFCBUILDING') built = E[id].args[2] || built;
    });

    const lib = (window.BIM_MODEL && window.BIM_MODEL.equipmentLibrary) || [];
    const model = {
      meta: {
        name: built || '导入模型', subtitle: '用户上传 IFC · ' + floors.length + ' 层 · ' + sortedRooms.length + ' 个房间',
        system: 'AIbim 运维系统', floors: floors.length,
        roof: +(maxZ || 4.2).toFixed(2), area: +area.toFixed(1),
        standards: ['GB 50009-2012', 'GB 50010-2010', 'GB 50068-2018', 'GB 50292-2015'],
        span: { x: [Math.min.apply(null, xs) || 0, Math.max.apply(null, xs) || 33], y: [Math.min.apply(null, ys) || 0, Math.max.apply(null, ys) || 15] },
        note: '由上传的 IFC 解析生成 · 板上配筋按默认值估算',
        source: 'ifc', w: (Math.max.apply(null, xs) || 33), d: (Math.max.apply(null, ys) || 15.6)
      },
      floors, rooms: sortedRooms, walls, slabs: [], columns, beams, doors, windows, ducts, valves,
      equipmentLibrary: JSON.parse(JSON.stringify(lib.length ? lib : [{
        id: 'EQ-01', name: '空气压缩机', weight: 1800, w: 2.0, d: 1.2, h: 1.6, shape: 'box', color: '#4f7df3', note: '含减振底座'
      }])),
      materials: []
    };

    // 每间房一块板
    sortedRooms.forEach(r => {
      model.slabs.push({
        id: 'S-' + r.id, floor: r.floor, room: r.id,
        x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
        top: r.elev, thk: r.slab.thk, slab: r.slab
      });
    });

    return model;
  };
})();
