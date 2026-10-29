/* AIbim 管线路由引擎
   不靠预置的树，直接按风管几何建图：
   - 管段之间端点相接就算连通
   - 阀件挂到最近的一段风管上
   - 房间挂到从它上方穿过的管段上
   于是"关掉某个阀 → 沿管子往下走能走到哪些房间"可以从几何算出来，
   每间房还能给出具体经过的那几段管，点一下就能高亮。
*/
(function () {
  window.BIM = window.BIM || {};
  const R = (window.BIM.routes = {});

  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const TOUCH = 0.55;      // 端点相接判定的容差 m

  function ptSegDist(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    const L2 = vx * vx + vy * vy + vz * vz || 1e-9;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy + (p[2] - a[2]) * vz) / L2;
    t = Math.max(0, Math.min(1, t));
    return dist3(p, [a[0] + vx * t, a[1] + vy * t, a[2] + vz * t]);
  }

  function rectOfDuct(d, g) {
    const pad = (g == null ? 0.15 : g);
    return {
      x0: Math.min(d.a[0], d.b[0]) - d.w / 2 - pad, x1: Math.max(d.a[0], d.b[0]) + d.w / 2 + pad,
      y0: Math.min(d.a[1], d.b[1]) - d.w / 2 - pad, y1: Math.max(d.a[1], d.b[1]) + d.w / 2 + pad
    };
  }
  const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  /* 建索引：管段图 + 阀→管 + 房间→管 */
  R.prepare = function (M) {
    const idx = { adj: {}, valveDuct: {}, ductValve: {}, roomDucts: {}, ductRooms: {}, floors: {} };
    const ducts = M.ducts || [];

    ducts.forEach(d => { idx.adj[d.id] = []; });

    for (let i = 0; i < ducts.length; i++) {
      const d1 = ducts[i];
      if (d1.floor) (idx.floors[d1.floor] = idx.floors[d1.floor] || []).push(d1.id);
      for (let j = i + 1; j < ducts.length; j++) {
        const d2 = ducts[j];
        if (d1.floor !== d2.floor) continue;
        const ends1 = [d1.a, d1.b], ends2 = [d2.a, d2.b];
        let touch = false;
        for (const p of ends1) for (const q of ends2) if (dist3(p, q) < TOUCH) touch = true;
        if (!touch) {
          // 一段的端点落在另一段身上（T 接）
          const mid2 = [(d2.a[0] + d2.b[0]) / 2, (d2.a[1] + d2.b[1]) / 2, (d2.a[2] + d2.b[2]) / 2];
          if (ends1.some(p => ptSegDist(p, d2.a, d2.b) < TOUCH)) touch = true;
          else if (ends2.some(p => ptSegDist(p, d1.a, d1.b) < TOUCH)) touch = true;
          else if (ptSegDist(mid2, d1.a, d1.b) < TOUCH) touch = true;
        }
        if (touch) { idx.adj[d1.id].push(d2.id); idx.adj[d2.id].push(d1.id); }
      }
    }

    // 阀 → 最近管段（2 m 以内）
    (M.valves || []).forEach(v => {
      let best = null;
      ducts.filter(d => d.floor === v.floor).forEach(d => {
        const dd = ptSegDist(v.pos, d.a, d.b);
        if (dd < 2.2 && (!best || dd < best.d)) best = { id: d.id, d: dd };
      });
      if (best) {
        idx.valveDuct[v.id] = best.id;
        (idx.ductValve[best.id] = idx.ductValve[best.id] || []).push(v.id);
      }
    });

    // 房间 → 从它上方穿过的管段
    (M.rooms || []).forEach(r => {
      const rr = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
      const list = [];
      ducts.filter(d => d.floor === r.floor && d.a[2] > r.elev + 0.4).forEach(d => {
        if (overlap(rr, rectOfDuct(d))) {
          list.push(d.id);
          (idx.ductRooms[d.id] = idx.ductRooms[d.id] || []).push(r.id);
        }
      });
      idx.roomDucts[r.id] = list;
    });

    M._routes = idx;
    return idx;
  };

  R.index = function (M) { return M._routes || R.prepare(M); };

  /* 从某段管出发的最短路径树 */
  function bfs(idx, startId) {
    const prev = {}, dist = {};
    if (!startId || !idx.adj[startId]) return { prev, dist };
    dist[startId] = 0;
    const q = [startId];
    while (q.length) {
      const u = q.shift();
      (idx.adj[u] || []).forEach(w => {
        if (dist[w] != null) return;
        dist[w] = dist[u] + 1;
        prev[w] = u;
        q.push(w);
      });
    }
    return { prev, dist };
  }

  function trace(prev, id) {
    const out = [];
    let cur = id, guard = 0;
    while (cur != null && guard++ < 400) { out.unshift(cur); cur = prev[cur]; }
    return out;
  }

  /* 到某个房间的路由（管段 id 序列） */
  R.pathToRoom = function (M, valve, roomId) {
    const idx = R.index(M);
    const start = idx.valveDuct[valve.id];
    if (!start) return null;
    const targets = idx.roomDucts[roomId] || [];
    if (!targets.length) return null;
    const { prev, dist } = bfs(idx, start);
    let best = null;
    targets.forEach(t => {
      if (dist[t] == null) return;
      if (!best || dist[t] < dist[best]) best = t;
    });
    if (!best) return null;
    return trace(prev, best);
  };

  /* 给 imported 模型补出阀门层级：按"离总管多远"定上下游 */
  R.buildTree = function (M) {
    const idx = R.index(M);
    if ((M.valves || []).some(v => v.parent)) return false;
    if (!(M.valves || []).length || !(M.ducts || []).length) return false;

    (M.floors || []).forEach(fl => {
      const ducts = (M.ducts || []).filter(d => d.floor === fl.level);
      if (!ducts.length) return;
      // 总管：连接数最多的一段
      let root = null, best = -1;
      ducts.forEach(d => { const deg = (idx.adj[d.id] || []).length; if (deg > best) { best = deg; root = d.id; } });
      const dist = bfs(idx, root).dist;

      const vs = (M.valves || []).filter(v => v.floor === fl.level && idx.valveDuct[v.id]);
      vs.forEach(v => {
        const dd = dist[idx.valveDuct[v.id]];
        v._dist = dd == null ? 9999 : dd;
      });
      vs.sort((a, b) => a._dist - b._dist);
      if (!vs.length) return;

      vs[0].parent = null;
      vs[0].kind = 'main';
      for (let i = 1; i < vs.length; i++) {
        let par = null;
        for (let j = i - 1; j >= 0; j--) if (vs[j]._dist < vs[i]._dist) { par = vs[j]; break; }
        vs[i].parent = (par || vs[0]).id;
        vs[i].kind = 'room';
      }
      // 每间房归给"沿管子最近"的那个阀，一个房间只归一处
      vs.forEach(v => {
        v.serves = [];
        v._bfs = bfs(idx, idx.valveDuct[v.id]).dist;
      });
      (M.rooms || []).filter(r => r.floor === fl.level).forEach(r => {
        const rds = idx.roomDucts[r.id] || [];
        if (!rds.length) return;
        let best = null, bd = 1e9;
        vs.forEach(v => {
          rds.forEach(t => {
            const x = v._bfs[t];
            if (x != null && x < bd) { bd = x; best = v; }
          });
        });
        if (best) best.serves.push(r.id);
      });
      vs.forEach(v => { delete v._bfs; delete v._dist; });
    });
    return true;
  };

  /* 几何可达：从阀所在管出发，沿风管走，遇到别的阀就停
     返回 { rooms, paths:[{ids, rooms:[roomId]}] } */
  R.geoReach = function (M, valve) {
    const idx = R.index(M);
    const start = idx.valveDuct[valve.id];
    if (!start) return { rooms: [], paths: [] };
    const seen = {}, prev = {}, q = [start];
    seen[start] = true;
    const hitDucts = [];
    while (q.length) {
      const u = q.shift();
      hitDucts.push(u);
      (idx.adj[u] || []).forEach(w => {
        if (seen[w]) return;
        // 别的阀门挂在这段管上 → 这是下游边界，不再往那边走
        const blockers = (idx.ductValve[w] || []).filter(id => id !== valve.id);
        if (blockers.length) return;
        seen[w] = true; prev[w] = u;
        q.push(w);
      });
    }
    const roomIds = [];
    hitDucts.forEach(d => (idx.ductRooms[d] || []).forEach(rid => { if (roomIds.indexOf(rid) < 0) roomIds.push(rid); }));

    // 按"走到房间的路径"分组，同一路径的房间并成一档
    const groups = {};
    roomIds.forEach(rid => {
      const targets = (idx.roomDucts[rid] || []).filter(t => seen[t]);
      if (!targets.length) return;
      // 取最近的挂接管段
      let best = targets[0], bl = 1e9;
      targets.forEach(t => { const p = trace(prev, t); if (p.length < bl) { bl = p.length; best = t; } });
      const ids = trace(prev, best);
      const key = ids.join('>');
      if (!groups[key]) groups[key] = { ids: ids, rooms: [] };
      groups[key].rooms.push(rid);
    });

    const rooms = roomIds.map(id => M.rooms.find(r => r.id === id)).filter(Boolean);
    const paths = Object.keys(groups).map(k => groups[k]);
    return { rooms: rooms, paths: paths };
  };

  /* 给一批管段算包围盒（用于自动取景） */
  R.bounds = function (M, ids) {
    const xs = [], ys = [];
    (ids || []).forEach(id => {
      const d = (M.ducts || []).find(x => x.id === id);
      if (!d) return;
      xs.push(d.a[0], d.b[0]); ys.push(d.a[1], d.b[1]);
    });
    if (!xs.length) return null;
    return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
  };
})();
