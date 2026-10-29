/* ============================================================================
   模型树 —— 按 BIM（IFC 空间结构）的方式把整栋楼摊开：
     项目 → 楼层 → 房间（空间） → 楼板 / 墙 / 门 / 窗 / 设备
                    └ 结构（柱 / 梁） · 通风空调（风管 / 阀件）
   点「房间」= 定位到那间房并出房间属性；点「构件」= 高亮 + 推相机 + 右侧出属性。
   树是独立面板，不进 pProps/pEquip/pCalc 的互斥组，可以和属性面板一起看。
   ========================================================================== */
(function (window) {
  const T = {};
  let S = null, host = null;
  const st = { root: null, open: {}, q: '', index: {}, cur: null, seq: 0 };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* 小节流：12 个构件类型各给一个 16px 图标，跟工具栏同一套线描风格 */
  const I = {
    model: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
    floor: '<path d="M3 8h18"/><path d="M3 16h18"/><path d="M6 8v8M18 8v8"/>',
    room: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 12h17"/>',
    slab: '<path d="M2.5 15.5 12 11l9.5 4.5L12 20z"/><path d="M2.5 15.5V12L12 7.5 21.5 12v3.5"/>',
    wall: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 6v12M15.5 6v12M3 12h5M8 12h7.5M15.5 12H21"/>',
    door: '<path d="M5 21V4h10v17"/><path d="M15 12h3"/><circle cx="13" cy="12" r=".9" fill="currentColor" stroke="none"/>',
    window: '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M12 4.5v15M3.5 12h17"/>',
    column: '<rect x="7.5" y="3" width="9" height="18" rx=".8"/><path d="M6 3h12M6 21h12"/>',
    beam: '<path d="M3 8h18v4H3z"/><path d="M6 12v8M18 12v8"/>',
    duct: '<path d="M3 8h11a4 4 0 0 1 4 4v7"/><path d="M3 14h6"/><path d="M18 5.5v5"/>',
    valve: '<circle cx="12" cy="12" r="4.2"/><path d="M12 3.5v4.3M12 16.2v4.3M3.5 12h4.3M16.2 12h4.3"/>',
    equip: '<rect x="3" y="7" width="18" height="11" rx="1.5"/><path d="M7 7V5h6v2"/><path d="M7 12h4M7 15h6"/>'
  };
  const svg = k => '<svg viewBox="0 0 24 24">' + (I[k] || I.equip) + '</svg>';

  /* ---------------- 建树 ---------------- */
  function model() { return window.BIM_MODEL; }
  function placed() {
    const a = window.BIM.app;
    return (a && a.state && a.state.placed) ? a.state.placed : [];
  }

  // 窗登记在整面外墙上，rooms 会挂一整排房间；按几何位置归到真正那一间
  function windowRoom(w) {
    const M = model();
    const cands = (w.rooms || []).map(id => M.rooms.find(r => r.id === id)).filter(Boolean);
    if (cands.length <= 1) return cands[0] || null;
    const p = w.pos;
    const inIt = cands.filter(r => p[0] >= r.x0 - .3 && p[0] <= r.x1 + .3 && p[1] >= r.y0 - .3 && p[1] <= r.y1 + .3);
    return inIt[0] || cands[0];
  }

  function ductRooms(id) {
    const R = window.BIM.routes;
    if (!R || !R.index) return [];
    try { return (R.index(model()).ductRooms || {})[id] || []; } catch (e) { return []; }
  }

  /* 门在数据里挂的是"整面墙的房间"（一堵隔墙可能连着好几间），
     直接照 rooms 罗列会让每间房冒出十几个别人的门。这里再按门的位置筛一遍：
     只保留落在这间房范围里的那几樘 —— 同层共用一堵墙的门仍然算两边的（BIM 里就是这样）。 */
  function doorsOfRoom(r) {
    const M = model();
    const own = Object.keys(r.sides || {}).map(k => r.sides[k]);
    return (M.doors || []).filter(d => d.floor === r.floor && own.indexOf(d.wall) >= 0 &&
      d.pos[0] >= r.x0 - .45 && d.pos[0] <= r.x1 + .45 &&
      d.pos[1] >= r.y0 - .45 && d.pos[1] <= r.y1 + .45);
  }

  function leaf(key, kind, data, label, sub, icon) {
    return { key: key, type: 'leaf', kind: kind, data: data, label: label, sub: sub, icon: icon };
  }

  function build() {
    const M = model();
    if (!M) return null;
    st.index = {};
    const reg = (n) => {
      if (n.key) st.index[n.key] = n;
      (n.kids || []).forEach(reg);
      return n;
    };

    const floors = M.floors.slice().sort((a, b) => b.level - a.level).map(fl => {
      const L = fl.level;
      const eqL = placed().filter(e => e.floor === L);

      const rooms = M.rooms.filter(r => r.floor === L)
        .sort((a, b) => String(a.num).localeCompare(String(b.num), 'zh'))
        .map(r => {
          const kids = [];
          const slab = (M.slabs || []).find(s => s.room === r.id);
          if (slab) kids.push(leaf('slab:' + r.id, 'slab', slab, '楼板', (slab.thk * 1000) + ' mm ' + (slab.slab ? slab.slab.grade : ''), 'slab'));

          const walls = [];
          Object.keys(r.sides || {}).forEach(k => {
            const w = M.walls.find(x => x.id === r.sides[k]);
            if (w && walls.indexOf(w) < 0) walls.push(w);
          });
          if (walls.length) kids.push({
            key: 'g:' + r.id + ':wall', type: 'group', label: '墙', cnt: walls.length, icon: 'wall',
            kids: walls.map(w => leaf('wall:' + w.id, 'wall', w,
              w.name, (w.t * 1000) + ' mm · ' + w.h.toFixed(2) + ' m', 'wall'))
          });

          const doors = doorsOfRoom(r);
          if (doors.length) kids.push({
            key: 'g:' + r.id + ':door', type: 'group', label: '门', cnt: doors.length, icon: 'door',
            kids: doors.map(d => leaf('door:' + d.id, 'door', d, d.name,
              d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' m' + (d.added ? ' · 新增' : ''), 'door'))
          });

          const wins = (M.windows || []).filter(w => w.floor === L && (w.rooms || []).indexOf(r.id) >= 0 && windowRoom(w) === r);
          if (wins.length) kids.push({
            key: 'g:' + r.id + ':win', type: 'group', label: '窗', cnt: wins.length, icon: 'window',
            kids: wins.map(w => leaf('window:' + w.id, 'window', w, w.name || '窗',
              (w.w || 0).toFixed(2) + '×' + (w.h || 0).toFixed(2) + ' m · 台高 ' + (w.sill || 0).toFixed(2), 'window'))
          });

          const eqs = eqL.filter(e => e.room === r.id);
          if (eqs.length) kids.push({
            key: 'g:' + r.id + ':eq', type: 'group', label: '设备', cnt: eqs.length, icon: 'equip',
            kids: eqs.map(e => leaf('equip:' + e.id, 'equip', e, e.name,
              (e.weight / 1000).toFixed(2) + ' t · ' + e.id, 'equip'))
          });

          return {
            key: 'room:' + r.id, type: 'room', kind: 'room', data: r,
            label: r.num + ' ' + (r.use || ''), sub: r.area + ' m²',
            icon: r.zone === 'corr' ? 'beam' : 'room', kids: kids, cnt: kids.length
          };
        });

      const spec = M.rooms.filter(r => r.floor === L).map(r => r.id);

      const cols = (M.columns || []).filter(c => c.floor === L);
      const beams = (M.beams || []).filter(b => b.floor === L);
      const struct = [];
      if (cols.length) struct.push({
        key: 'g:f' + L + ':col', type: 'group', label: '框架柱', cnt: cols.length, icon: 'column',
        kids: cols.map(c => leaf('column:' + c.id, 'column', c, c.id, (c.s * 1000).toFixed(0) + '×' + (c.s * 1000).toFixed(0) + ' mm', 'column'))
      });
      if (beams.length) struct.push({
        key: 'g:f' + L + ':beam', type: 'group', label: '框架梁', cnt: beams.length, icon: 'beam',
        kids: beams.map(b => leaf('beam:' + b.id, 'beam', b, b.id, (b.w * 1000).toFixed(0) + '×' + (b.h * 1000).toFixed(0) + ' mm · ' + b.axis.toUpperCase() + ' 向', 'beam'))
      });

      const ducts = (M.ducts || []).filter(d => d.floor === L);
      const valves = (M.valves || []).filter(v => v.floor === L);
      const mep = [];
      if (ducts.length) mep.push({
        key: 'g:f' + L + ':duct', type: 'group', label: '风管', cnt: ducts.length, icon: 'duct',
        kids: ducts.map(d => {
          const rs = ductRooms(d.id).map(id => (M.rooms.find(r => r.id === id) || {}).num).filter(Boolean);
          return leaf('duct:' + d.id, 'duct', d, d.id,
            (d.w * 1000).toFixed(0) + '×' + (d.h * 1000).toFixed(0) + ' mm' + (rs.length ? ' · ' + rs.join('/') : ''), 'duct');
        })
      });
      if (valves.length) mep.push({
        key: 'g:f' + L + ':valve', type: 'group', label: '风阀', cnt: valves.length, icon: 'valve',
        kids: valves.map(v => leaf('valve:' + v.id, 'valve', v, v.name,
          (v.open ? '开启' : '关闭') + ' · ' + ((M.rooms.find(r => r.id === v.room) || {}).num || v.room || ''), 'valve'))
      });

      const kids = [];
      if (rooms.length) kids.push({ key: 'g:f' + L + ':room', type: 'group', label: '房间', cnt: rooms.length, icon: 'room', kids: rooms });
      if (struct.length) kids.push({ key: 'g:f' + L + ':struct', type: 'group', label: '结构构件', cnt: cols.length + beams.length, icon: 'column', kids: struct });
      if (mep.length) kids.push({ key: 'g:f' + L + ':mep', type: 'group', label: '通风空调', cnt: ducts.length + valves.length, icon: 'duct', kids: mep });

      return {
        key: 'f' + L, type: 'floor', kind: 'floor', data: fl,
        label: fl.name || (L + 'F'), sub: '+' + fl.elev.toFixed(2) + ' m · ' + (spec.length) + ' 间',
        icon: 'floor', kids: kids, cnt: spec.length
      };
    });

    const total = ['walls', 'doors', 'windows', 'columns', 'beams', 'ducts', 'valves']
      .reduce((n, k) => n + ((M[k] || []).length), 0) + placed().length;

    return reg({
      key: 'root', type: 'root', label: (M.meta && M.meta.name) || '模型', icon: 'model',
      sub: M.floors.length + ' 层 · ' + total + ' 个构件', kids: floors,
      cnt: total
    });
  }

  /* ---------------- 渲染 ---------------- */
  function nodeRow(n, depth) {
    const hasKids = !!(n.kids && n.kids.length);
    const open = !!st.open[n.key];
    const el = document.createElement('div');
    el.className = 'tn ' + (n.type === 'group' ? 'tn-grp ' : '') + (hasKids ? 'has ' : '') +
      (open ? 'open ' : '') + (st.cur === n.key ? 'cur' : '');
    el.style.paddingLeft = (5 + depth * 11) + 'px';
    el.dataset.key = n.key;
    let html = '<span class="tn-c">' + (hasKids ? '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>' : '') + '</span>';
    html += '<span class="tn-i">' + svg(n.icon) + '</span>';
    html += '<span class="tn-l">' + esc(n.label) + '</span>';
    if (hasKids) html += '<span class="tn-n">' + (n.cnt == null ? n.kids.length : n.cnt) + '</span>';
    else if (n.sub) html += '<span class="tn-s">' + esc(n.sub) + '</span>';
    el.innerHTML = html;
    el.title = (n.label || '') + (n.sub ? ' · ' + n.sub : '');
    el.onclick = (ev) => {
      if (hasKids) {
        st.open[n.key] = !st.open[n.key];
        render();
        // 展开房间就顺手定位过去，省得还要点第二下
        if (n.type !== 'group' && n.type !== 'root') pick(n);
        return;
      }
      pick(n);
    };
    return el;
  }

  function walk(n, depth, out, stop) {
    out.push(nodeRow(n, depth));
    if (stop) return;
    if (st.open[n.key]) (n.kids || []).forEach(k => walk(k, depth + 1, out));
  }

  /* 搜索用的"别名"：用户嘴上说的词往往不是节点标题（说"阀门"不说"4F 新风总阀"） */
  const TAG = {
    slab: '楼板 板 底板', wall: '墙 墙体 隔墙 外墙', door: '门 门洞 门扇',
    window: '窗 窗户 外窗', duct: '风管 管道 管', valve: '阀 阀门 风阀',
    column: '柱 框架柱 柱子', beam: '梁 框架梁', equip: '设备 机组 设施',
    room: '房间 空间 室'
  };

  /* 搜索：拍平成一张结果表，带楼层/房间的面包屑 */
  function flat(n, path, out) {
    (n.kids || []).forEach(k => {
      const p = path.concat([n.label]);
      if (k.type === 'leaf' || k.type === 'room') {
        const use = k.type === 'room' && k.data ? (k.data.use || '') : '';
        const hay = (k.label + ' ' + (k.sub || '') + ' ' + (k.key || '') + ' ' + use + ' ' + (TAG[k.kind] || '')).toLowerCase();
        if (hay.indexOf(st.q) >= 0) out.push({ n: k, path: p });
      }
      flat(k, p, out);
    });
  }

  function render() {
    if (!host) host = $('treeBody');
    if (!host) return;
    const meta = $('treeMeta');
    if (meta) meta.textContent = st.root ? (st.root.cnt + ' 个构件') : '';
    host.innerHTML = '';
    if (!st.root) {
      host.innerHTML = '<div class="tn-empty">模型还没加载</div>';
      return;
    }
    if (st.q) {
      const hits = [];
      flat(st.root, [], hits);
      if (!hits.length) { host.innerHTML = '<div class="tn-empty">没有匹配「' + esc(st.q) + '」的构件</div>'; return; }
      const cap = hits.slice(0, 120);
      cap.forEach(h => {
        const el = nodeRow({ key: h.n.key, type: h.n.type, label: h.n.label, sub: h.n.sub, icon: h.n.icon, kind: h.n.kind, data: h.n.data }, 0);
        const crumb = document.createElement('div');
        crumb.className = 'tn-crumb';
        crumb.textContent = h.path.slice(-2).join(' / ');
        const wrap = document.createElement('div');
        wrap.className = 'tn-hit';
        wrap.appendChild(el); wrap.appendChild(crumb);
        host.appendChild(wrap);
      });
      if (hits.length > cap.length) {
        const more = document.createElement('div');
        more.className = 'tn-empty';
        more.textContent = '还有 ' + (hits.length - cap.length) + ' 条，缩小关键词再看看';
        host.appendChild(more);
      }
      return;
    }
    const frag = document.createDocumentFragment();
    const rows = [];
    walk(st.root, 0, rows);
    rows.forEach(r => frag.appendChild(r));
    host.appendChild(frag);
    if (st.cur) {
      const el = host.querySelector('.tn.cur');
      if (el && el.scrollIntoView) {
        const b = el.getBoundingClientRect(), h = host.getBoundingClientRect();
        if (b.top < h.top || b.bottom > h.bottom) el.scrollIntoView({ block: 'center' });
      }
    }
  }

  /* ---------------- 点节点 ---------------- */
  function pick(n) {
    const S3 = S || (S = window.BIM.scene);
    const app = window.BIM.app || {};
    st.cur = n.key;
    if (n.type === 'root' || n.type === 'floor') {
      const lv = n.type === 'floor' ? n.data.level : 0;
      S3.isolateRoom(null, false);
      S3.clearHighlight();
      S3.clearRoute && S3.clearRoute();
      S3.setFocus(lv);
      if (app.onTreeFloor) app.onTreeFloor(lv);
      render();
      return;
    }
    if (n.type === 'room') {
      const r = n.data;
      S3.isolateRoom(null, false);
      S3.focusRoom(r);
      S3.highlightRoom(r, 0x10a394);
      if (app.onTreePick) app.onTreePick({ kind: 'room', data: r });
      render();
      return;
    }
    // 构件：高亮 + 推相机 + 属性
    const ok = S3.focusThing(n.kind, n.data, { color: 0x10a394 });
    if (!ok) {
      const f = n.data && n.data.floor;
      if (f) S3.focusAt(f, n.data.pos ? n.data.pos[0] : (n.data.x || 0), n.data.pos ? n.data.pos[1] : (n.data.y || 0));
    }
    if (app.onTreePick) app.onTreePick({ kind: n.kind, data: n.data });
    render();
  }

  /* ---------------- 对外 ---------------- */
  T.build = function () { st.root = build(); st.open = st.open || {}; st.open.root = true; return st.root; };
  T.rebuild = function () {
    const keep = st.open;
    st.open = {};
    Object.keys(keep).forEach(k => { if (keep[k]) st.open[k] = true; });
    st.root = build();
    st.open.root = true;
    render();
  };
  T.render = render;
  T.open = function (on) {
    const p = $('pTree');
    if (!p) return;
    p.hidden = on === false ? true : false;
    if (!p.hidden) {
      if (!st.root) T.build();
      render();
      const b = document.querySelector('#toolbar button[data-k="tree"]');
      if (b) b.classList.add('on');
    } else {
      const b = document.querySelector('#toolbar button[data-k="tree"]');
      if (b) b.classList.remove('on');
    }
  };
  T.toggle = function () {
    const p = $('pTree');
    T.open(!!p.hidden);
  };
  T.isOpen = function () { const p = $('pTree'); return !!(p && !p.hidden); };

  /* 三维里点到什么，树上就跟到哪儿（自动展开祖先并高亮） */
  T.reveal = function (kind, data) {
    if (!data) return;
    const key = kind === 'slab'
      ? ('slab:' + (data.room || data.id))
      : (kind + ':' + (data.id != null ? data.id : (data.room || '')));
    const node = st.index[key];
    if (!node) return;
    st.cur = node.key;

    const M = model();
    const L = data.floor || (node.data && node.data.floor) || 0;
    if (!L) return;
    st.open.root = true;
    st.open['f' + L] = true;

    const openRoomOf = rid => {
      if (!rid) return;
      st.open['g:f' + L + ':room'] = true;
      st.open['room:' + rid] = true;
    };

    if (kind === 'equip') {
      openRoomOf(data.room);
      st.open['g:' + data.room + ':eq'] = true;
    } else if (kind === 'valve') {
      st.open['g:f' + L + ':mep'] = true;
      st.open['g:f' + L + ':valve'] = true;
      openRoomOf(data.room);
    } else if (kind === 'duct') {
      st.open['g:f' + L + ':mep'] = true;
      st.open['g:f' + L + ':duct'] = true;
      ductRooms(data.id).forEach(openRoomOf);
    } else if (kind === 'slab') {
      openRoomOf(data.room);
    } else if (kind === 'wall' || kind === 'door' || kind === 'window') {
      const w = kind === 'wall' ? M.walls.find(x => x.id === data.id) : null;
      let rids = (data.rooms || []).slice();
      if (kind === 'window') {
        const wr = windowRoom(data);
        rids = wr ? [wr.id] : rids;
      }
      if (w) {
        // 墙登记在多个房间上，优先挑一面属于它、且同层的房间
        const own = M.rooms.filter(r => r.floor === L && Object.keys(r.sides || {}).some(k2 => r.sides[k2] === w.id));
        if (own.length) rids = own.map(r => r.id);
      }
      rids.forEach(rid => {
        openRoomOf(rid);
        const gk = kind === 'wall' ? 'wall' : (kind === 'door' ? 'door' : 'win');
        st.open['g:' + rid + ':' + gk] = true;
      });
    } else if (kind === 'column' || kind === 'beam') {
      st.open['g:f' + L + ':struct'] = true;
      st.open['g:f' + L + (kind === 'column' ? ':col' : ':beam')] = true;
    }
    if (T.isOpen()) render();
  };

  T.setQuery = function (q) { st.q = String(q || '').trim().toLowerCase(); render(); };
  /* 外部（切了楼层 / 复位 / 看阀门影响）改当前节点，只更新高亮，不触发视角动作 */
  T.setCurrent = function (key) {
    if (!key || st.cur === key) return;
    st.cur = key;
    // 切到某一层就把那层摊开，否则高亮的那一行藏在折叠里，等于没提示
    if (/^f\d+$/.test(key)) { st.open.root = true; st.open[key] = true; }
    if (T.isOpen()) render();
  };
  T.cur = () => st.cur;
  T.root = () => st.root;
  T.state = st;

  window.BIM = window.BIM || {};
  window.BIM.tree = T;
})(window);
