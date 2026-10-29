/* AIbim 对话智能体
   两层：
   1) 上下文记忆（mem）—— 记住这一轮在说哪层、哪间房、哪台设备、刚才放了什么
   2) 规划器（planner）——
      · 接了大模型：把"多轮上下文 + 场景清单"喂给模型，让它输出结构化步骤（含任务拆解）
      · 没接大模型：本地规则规划器，同样吃 mem，能做省略补全、指代消解、多步拆分
   两条路产出同一种 plan，执行器一模一样，所以断网/无 Key 时演示不会瘫。
*/
(function () {
  window.BIM = window.BIM || {};
  const A = (window.BIM.agent = {});

  /* ---------------- 配置（大模型） ---------------- */
  const LS = 'aibim.llm.v1';

  /* 地址补全：贴完整 URL、少写 /v1、带引号空格、结尾多斜杠，都归一化
     以 / 开头表示走同源转发（例如 /llm/v1），不做任何协议补全 */
  function normEndpoint(ep) {
    let u = String(ep || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (!u) return '';
    if (u.charAt(0) === '/') {
      return ('/' + u.replace(/^\/+/, '')).replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    }
    if (!/^https?:\/\//i.test(u)) {
      // 本机服务常见不带协议
      u = (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u) ? 'http://' : 'https://') + u;
    }
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/chat\/completions$/i, '');   // 有人直接贴了接口全地址
    return u;
  }
  const isRel = ep => String(ep || '').trim().charAt(0) === '/';

  A.cfg = { endpoint: '', model: '', key: '', on: false, timeout: 12000 };
  try { Object.assign(A.cfg, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { }
  A.cfg.endpoint = normEndpoint(A.cfg.endpoint);
  A.cfg.model = String(A.cfg.model || '').trim();
  A.cfg.key = String(A.cfg.key || '').trim();
  A.saveCfg = function (patch) {
    Object.assign(A.cfg, patch || {});
    A.cfg.endpoint = normEndpoint(A.cfg.endpoint);
    A.cfg.model = String(A.cfg.model || '').trim();
    A.cfg.key = String(A.cfg.key || '').trim();
    // 同源转发时 Key 通常在服务器上，页面这一格可以留空
    A.cfg.on = !!(A.cfg.endpoint && A.cfg.model && (A.cfg.key || isRel(A.cfg.endpoint)));
    try { localStorage.setItem(LS, JSON.stringify({ endpoint: A.cfg.endpoint, model: A.cfg.model, key: A.cfg.key, timeout: A.cfg.timeout })); } catch (e) { }
    return A.cfg;
  };
  A.cfg.on = !!(A.cfg.endpoint && A.cfg.model && (A.cfg.key || isRel(A.cfg.endpoint)));
  /* 用户自己动过这一页没有（含主动清空）：动过就不再被自动接管 */
  A.touched = function () {
    try { return localStorage.getItem(LS) !== null; } catch (e) { return false; }
  };
  A.normEndpoint = normEndpoint;
  A.isRel = isRel;
  A.isAzure = function (u) { return /openai\.azure\.com/i.test(String(u || A.cfg.endpoint || '')); };
  A.urlOf = function () {
    const raw = String(A.cfg.endpoint || '').trim();
    if (isRel(raw)) return normEndpoint(raw) + '/chat/completions';   // 同源转发
    if (A.isAzure(raw)) {
      // Azure：地址自带 deployments/... 和 api-version，原样拼，别再套 /v1
      let u = raw.replace(/\/+$/, '');
      if (!/\/chat\/completions/i.test(u)) u += '/chat/completions';
      if (!/api-version=/i.test(u)) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'api-version=2024-06-01';
      return u;
    }
    return normEndpoint(raw) + '/chat/completions';
  };

  /* ---------------- 上下文记忆 ---------------- */
  A.mem = {
    turns: [],          // [{role:'user'|'ai', text}]
    ctx: { floor: null, room: null, device: null, pref: null, side: null },
    lastPlaced: null,   // 最近一次放下的设备（eq 对象）
    placed: [],         // 本轮会话放过的设备
    lastDoor: null,
    lastValve: null,
    lastResult: null    // 最近一次结构校核结果
  };
  A.resetMem = function () {
    A.mem.turns = []; A.mem.ctx = { floor: null, room: null, device: null, pref: null, side: null };
    A.mem.lastPlaced = null; A.mem.placed = []; A.mem.lastDoor = null; A.mem.lastValve = null; A.mem.lastResult = null;
  };
  function remember(role, text) {
    A.mem.turns.push({ role: role, text: String(text).slice(0, 200) });
    if (A.mem.turns.length > 16) A.mem.turns.splice(0, A.mem.turns.length - 16);
  }
  A.remember = remember;

  function model() { return window.BIM_MODEL; }
  function roomByNum(num, floor) {
    const M = model();
    const s = String(num || '').trim();
    if (!s) return null;
    let r = M.rooms.find(x => x.num === s && (floor == null || x.floor === floor));
    if (r) return r;
    r = M.rooms.find(x => x.num === s);
    if (r) return r;
    // 只说了 02 / 2 号 → 按当前楼层补
    const f = floor != null ? floor : A.mem.ctx.floor;
    if (f != null && /^\d{1,2}$/.test(s)) {
      r = M.rooms.find(x => x.floor === f && x.num === String(f) + String(s).padStart(2, '0'));
    }
    return r || null;
  }
  A.roomByNum = roomByNum;

  function deviceByName(name) {
    const lib = model().equipmentLibrary || [];
    const s = String(name || '').trim();
    if (!s) return null;
    const exact = lib.find(e => e.name === s);
    if (exact) return exact;
    const part = lib.find(e => e.name.indexOf(s) >= 0 || s.indexOf(e.name) >= 0);
    if (part) return part;
    // 逐字重合：用户说「水冷机组」，库里叫「风冷冷水机组」，按重合度挑最像的那台
    // （够不像就返回 null，让页面弹出设备清单让用户自己选，不乱猜）
    let best = null, bs = 0;
    const chars = new Set(s.split(''));
    lib.forEach(e => {
      let hit = 0;
      e.name.split('').forEach(c => { if (chars.has(c)) hit++; });
      const cover = hit / Math.max(2, s.length);        // 用户说的字覆盖了多少
      const share = hit / Math.max(2, e.name.length);   // 占库名多少
      if (cover >= 0.6 && share >= 0.4 && cover + share > bs) { bs = cover + share; best = e; }
    });
    return best;
  }
  A.deviceByName = deviceByName;
  A.fillStep = function (st) { return fill(st); };      // 给工具层用

  /* 指代/省略补全：把这一步缺的槽位用上下文填上 */
  function fill(step) {
    const m = A.mem;
    if (!step) return step;
    const t = step.text || '';
    const REF_ROOM = /这个房间|这间房|这一间|这里|该房间|同一间|还是这间|它那间/;
    const REF_DEV = /这个设备|这台设备|这台|该设备|它|刚刚那台|刚才那台|同一台/;

    if (step.room) {
      const r = roomByNum(step.room, step.floor);
      if (r) { step.roomRef = r; step.floor = r.floor; }
    } else if (REF_ROOM.test(t) && m.ctx.room) {
      step.roomRef = m.ctx.room; step.floor = m.ctx.room.floor;
    } else if (!step.room && step.act === 'place' && m.ctx.room && /再放|再摆|继续放|再来一台|还要放/.test(t)) {
      step.roomRef = m.ctx.room; step.floor = m.ctx.room.floor;
    }

    if (!step.device && (REF_DEV.test(t) || step.act === 'place' && /再放|再来一台|还要放|再摆/.test(t))) {
      step.device = m.ctx.device || (m.lastPlaced && m.lastPlaced.name) || null;
    }
    if (!step.device && step.act === 'place' && m.ctx.device && !step.explicitDevice) {
      step.device = m.ctx.device;
    }
    // 切视角/纯提问/列清单不继承楼层，否则"回到全楼""列一下设备"会被带偏
    const NO_FLOOR = /^(view|ask|showall|devices|doors|scene)$/;
    if (!NO_FLOOR.test(step.act)) {
      if (step.floor == null && step.roomRef) step.floor = step.roomRef.floor;
      if (step.floor == null && m.ctx.floor) step.floor = m.ctx.floor;
    }
    // 方位统一成键：模型可能给"靠里"，本地规则给的是 inner
    const N = window.BIM.nlp;
    if (step.pref && N.prefKey) step.pref = N.prefKey(step.pref);
    // 「再放一台」沿用刚才的方位偏好
    if (step.cont && !step.pref && m.ctx.pref) step.pref = m.ctx.pref;
    if (!step.pref && !step.dir && t && N.findPref) {
      const pf = N.findPref(t);
      if (pf) step.pref = pf;
    }
    // 挪设备时把方向/距离补上（模型只给了"往左"没给多远）
    if (step.act === 'move' && t) {
      if (!step.dir && N.findDir) step.dir = N.findDir(t);
      if (!step.dist && N.findDist) step.dist = N.findDist(t);
      if (step.dir && step.pref === 'inner') step.pref = null;   // "往里挪"是方向不是方位
    }
    // 挪门：沿墙方向 + 距离
    if (step.act === 'doormove' && t) {
      if (!step.along && N.findDir) step.along = N.findDir(t);
      if (!step.dist && N.findDist) step.dist = N.findDist(t);
      if (/中间|正中|居中/.test(t)) step.along = 'center';
    }
    // 改尺寸：把"1.5 米""2 米高"这类数字抠出来
    if ((step.act === 'doorsize' || step.act === 'resize') && t) {
      const nums = (t.match(/(\d+(?:\.\d+)?)\s*(?:米|m|公分)/gi) || [])
        .map(s => parseFloat(s.replace(/[^\d.]/g, ''))).filter(n => n > 0 && n < 12);
      if (!step.width && nums.length) step.width = nums[0];
      if (!step.height && nums.length > 1 && /高|矮/.test(t)) step.height = nums[1];
      if (!step.weight) {
        const w = t.match(/(\d+(?:\.\d+)?)\s*(?:吨|t)\b/i);
        if (w) step.weight = Math.round(parseFloat(w[1]) * 1000);   // 内部统一按 kg
      }
      if (/小一点|小点|缩小|紧凑/.test(t) && !step.width) { step.width = 0.8; step.depth = 0.7; }
      if (/大一点|大点|加宽|放宽/.test(t) && !step.width) step.width = 1.8;
    }
    return step;
  }

  /* 大模型回来的 ctx 也写进记忆，下一句就能接着用 */
  function mergeCtx(c) {
    if (!c) return;
    const m = A.mem;
    if (c.floor != null && c.floor !== '') m.ctx.floor = +c.floor || m.ctx.floor;
    if (c.room) {
      const r = roomByNum(c.room, m.ctx.floor);
      if (r) { m.ctx.room = r; m.ctx.floor = r.floor; }
    }
    if (c.device) { const d = deviceByName(c.device); m.ctx.device = d ? d.name : c.device; }
    if (c.pref) m.ctx.pref = c.pref;
  }

  /* 把步骤压成一句话记进对话，给下一轮当上下文 */
  function describe(plan) {
    const bits = (plan.steps || []).filter(s => s.act !== 'unknown').map(s => {
      const room = s.roomRef ? s.roomRef.num : (s.room || '');
      if (s.act === 'place') return '放了' + (s.device || '设备') + '到' + room;
      if (s.act === 'door') return '在' + room + '开了门';
      if (s.act === 'window') return '在' + room + '开了窗';
      if (s.act === 'valve') return (s.action === 'open' ? '开了' : '关了') + room + '的阀';
      if (s.act === 'move') {
        const d = window.BIM.nlp.DIR_CN[s.dir] || '';
        return '挪了设备' + (d ? '往' + d : (s.pref ? '到' + (window.BIM.nlp.PREF_CN[s.pref] || s.pref) : ''));
      }
      if (s.act === 'remove') return '撤了' + (s.all ? room + '的设备' : '设备');
      if (s.act === 'replace') return '把' + (s.target || '设备') + '换成了' + (s.device || '别的设备');
      if (s.act === 'resize') return '改了设备尺寸';
      if (s.act === 'dooroff') return '拆了一扇门';
      if (s.act === 'doormove') return '把门挪了位置';
      if (s.act === 'doorsize') return '改了门的大小';
      if (s.act === 'doorinfo') return '查了门的信息';
      if (s.act === 'doors') return '列了' + room + '的门';
      if (s.act === 'windowoff') return '封了一扇窗';
      if (s.act === 'wins') return '列了' + room + '的窗';
      if (s.act === 'wininfo') return '查了窗的信息';
      if (s.act === 'devices') return '列了设备';
      if (s.act === 'suggest') return '给了几个可选位置';
      if (s.act === 'focus') return '聚焦到' + (room || (s.floor ? s.floor + '楼' : '目标'));
      if (s.act === 'showall') return '恢复了全楼视图';
      if (s.act === 'undo') return '撤回了上一步';
      if (s.act === 'view') return '切视角到' + (s.floor ? s.floor + '楼' : '全楼');
      return s.act;
    });
    return bits.join('，') || '（只回答，没动模型）';
  }

  /* ---------------- 本地规划器 ---------------- */
  const SIDE_CN = { west: '西', east: '东', south: '南', north: '北' };
  const PREF_TXT = /靠走廊|靠门|靠窗|靠角|靠柱|靠梁|靠里|居中|中间|靠墙|最里面|里面|墙角/;

  function splitSteps(t) {
    // 只有"然后/接着/之后/，再"这种真正的先后关系才拆，避免把"再放一台"拆坏
    const parts = t.split(/然后|接着|之后|随后|，再|,再|；再/).map(s => s.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [t];
  }

  function localPlan(text) {
    const M = model(), C = window.BIM.calc, N = window.BIM.nlp;
    const steps = [];
    const parts = splitSteps(text);

    parts.forEach((part, idx) => {
      const p = N.parse(part);
      let act = null;

      // 先认"问余量"这类提问，别被"放"这个字带去做放置
      if (/还能放|能放几台|还能摆|余量|剩下多少|承重够不够|放得下几台|还能加/.test(part)) {
        steps.push({ act: 'ask', kind: 'capacity', text: part });
        return;
      }

      /* ---- 撤回 / 视图（放在最前，别被"撤掉/显示"这些字带歪） ---- */
      if (/撤回|撤销|反悔|刚才那步|上一步不要|弄错了/.test(part)) {
        steps.push({ act: 'undo', text: part });
        return;
      }
      if (/回到全楼|全部显示|都显示|显示全部|别藏|不用隔离|取消隔离/.test(part)) {
        steps.push({ act: 'showall', text: part });
        return;
      }
      if (/(只看|只显示|聚焦|单独看|挡住|藏起来|隔离)/.test(part) && (p.room || A.mem.ctx.room)) {
        steps.push({
          act: 'focus', text: part, room: p.room ? p.room.num : null, floor: p.floor || null,
          only: !/不要藏|别藏|不隔离|不用隔离/.test(part)
        });
        return;
      }
      if (/放了什么|有哪些设备|列.{0,3}设备|设备清单|一共几台|都放了/.test(part)) {
        steps.push({ act: 'devices', text: part, room: p.room ? p.room.num : null, floor: p.floor || null });
        return;
      }
      if (/放哪|怎么放|放得合适|帮我选.{0,4}位|位置建议|你看放|不太对|不合适|位置好一点/.test(part)) {
        steps.push({
          act: 'suggest', text: part, room: p.room ? p.room.num : null,
          device: p.device ? p.device.name : null
        });
        return;
      }

      /* ---- 窗：拆 / 列 / 查（排在开窗之前，别把"拆窗"当成开窗） ---- */
      if (/窗/.test(part) && !/阀/.test(part) &&
          !/开窗|开个窗|开一个窗|加个窗|加一扇窗|装个窗|新开窗|来扇窗|留个窗|窗洞/.test(part)) {
        if (/拆|封|去掉|不要|取消|删/.test(part)) {
          steps.push({ act: 'windowoff', text: part, room: p.room ? p.room.num : null, floor: p.floor || null });
          return;
        }
        if (/几扇|几樘|几个窗|列.{0,3}窗|有哪些窗|窗户清单|都有什么窗|哪些窗户/.test(part)) {
          steps.push({ act: 'wins', text: part, room: p.room ? p.room.num : null, floor: p.floor || null });
          return;
        }
        if (/这?个?窗.{0,4}(哪|多宽|多高|在哪|怎么样|信息)|查.{0,3}窗|窗户信息/.test(part)) {
          steps.push({ act: 'wininfo', text: part, room: p.room ? p.room.num : null });
          return;
        }
      }

      /* ---- 门：拆 / 挪 / 改 / 查（必须排在"删掉/撤掉"和 door 之前） ---- */
      if (/门/.test(part) && !/阀/.test(part) && !/开门|新开|开个|开一个|加个门|加一个门|门洞/.test(part)) {
        if (/拆|封起|不要这个门|撤了?这?个门|取消这个门|不要这个/.test(part)) {
          steps.push({ act: 'dooroff', text: part, room: p.room ? p.room.num : null });
          return;
        }
        if (/加宽|放宽|门.{0,6}宽|门.{0,4}高|矮一点|矮点|高一点/.test(part)) {
          steps.push({
            act: 'doorsize', text: part, room: p.room ? p.room.num : null,
            width: /加宽|放宽|门.{0,6}宽/.test(part) ? N.findWidth(part) : null,
            height: /门.{0,4}高|矮|高一点/.test(part) ? N.findHeight(part) : null
          });
          return;
        }
        if (/挪|移|换个?位置|中间|正中|居中|往左|往右|往东|往南|往西|往北|往前|往后/.test(part)) {
          steps.push({
            act: 'doormove', text: part, room: p.room ? p.room.num : null,
            along: /中间|正中|居中/.test(part) ? 'center' : N.findDir(part),
            dist: N.findDist(part)
          });
          return;
        }
        if (/几扇|列.{0,3}门|有哪些门|都有什么门|几个门/.test(part)) {
          steps.push({ act: 'doors', text: part, room: p.room ? p.room.num : null, floor: p.floor || null });
          return;
        }
        if (/这?个?门.{0,4}(哪|多宽|多高|在哪|怎么样)|门的信息|查.{0,3}门/.test(part)) {
          steps.push({ act: 'doorinfo', text: part, room: p.room ? p.room.num : null });
          return;
        }
      }

      /* ---- 设备：换 / 改 ---- */
      // "把 A 换成 B"：A 是被换的，B 是新型号，别把 A 当成目标
      const mSwap = part.match(/(?:换成|替换成|改装成|改成|换成是)([^，。；、]*)/);
      if (mSwap) {
        const tail = mSwap[1] || '';
        const toDev = N.findDevice ? N.findDevice(tail) : null;
        const fromDev = N.findDevice ? N.findDevice(part.slice(0, part.indexOf(mSwap[0]))) : null;
        steps.push({
          act: 'replace', text: part,
          device: toDev ? toDev.name : (p.device ? p.device.name : null),
          target: fromDev ? fromDev.name : null
        });
        return;
      }
      if (/改小|改大|缩小|加大|调小|调大|尺寸|按.{0,4}吨|大一点|小一点/.test(part) && !/门/.test(part)) {
        steps.push({ act: 'resize', text: part });
        return;
      }

      // 删掉 / 拿掉
      if (/删掉|删除|拿掉|撤掉|移走|清掉/.test(part) && (/设备|机柜|空压|泵|它/.test(part) || A.mem.lastPlaced)) {
        steps.push({ act: 'remove', text: part });
        return;
      }
      // 挪一下（不重新算承重，只移动）
      if (p.intent === 'move' && !/放到|摆到|装到/.test(part)) {
        steps.push({
          act: 'move', text: part,
          dir: p.dir || null, dist: p.dist || null,
          pref: p.pref || null,
          room: p.room ? p.room.num : null
        });
        return;
      }

      if (p.intent === 'valve') act = 'valve';
      else if (p.intent === 'window') act = 'window';
      else if (p.intent === 'door') act = 'door';
      else if (p.intent === 'place') act = 'place';
      else if (p.intent === 'view') act = 'view';
      else if (p.intent === 'info') act = 'info';

      if (act === 'valve') {
        steps.push({
          act: 'valve', text: part,
          room: p.room ? p.room.num : (A.mem.ctx.room ? A.mem.ctx.room.num : null),
          action: p.valveAction || 'close',
          valve: p.room && !p.room.zone ? null : null
        });
        return;
      }
      if (act === 'window') {
        steps.push({
          act: 'window', text: part,
          room: p.room ? p.room.num : (A.mem.ctx.room ? A.mem.ctx.room.num : null),
          side: p.side || null, sideRel: p.sideRel || null,
          width: p.width || 1.5, height: p.winH || 1.5,
          sill: p.sill == null ? .9 : p.sill, pref: p.pref || null
        });
        return;
      }
      if (act === 'door') {
        steps.push({
          act: 'door', text: part,
          room: p.room ? p.room.num : (A.mem.ctx.room ? A.mem.ctx.room.num : null),
          side: p.side || null, sideRel: p.sideRel || null,
          width: p.width || 1.0, height: p.doorH || 2.1, pref: p.pref || null
        });
        return;
      }
      if (act === 'place') {
        // 台数
        let count = 1;
        const mCnt = part.match(/(\d+|[一二两三四五])\s*台/);
        if (mCnt) {
          const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
          count = CN[mCnt[1]] || parseInt(mCnt[1], 10) || 1;
        }
        steps.push({
          act: 'place', text: part, count: Math.min(count, 4),
          device: p.device ? p.device.name : null,
          explicitDevice: !!p.device,
          weight: p.weight || null,
          room: p.room ? p.room.num : null,
          pref: p.pref || null,
          side: p.side || null, sideRel: p.sideRel || null,
          // "再放一台"这种承接句：接着上文自动落位，不再要用户点
          cont: !p.room && /再放|继续放|再来一台|还要放|再摆|再多放/.test(part)
        });
        return;
      }
      if (act === 'view') { steps.push({ act: 'view', floor: p.floor || 0, text: part }); return; }
      if (act === 'info') { steps.push({ act: 'info', text: part }); return; }

      // 问数量 / 问余量
      if (/还能放|能放几台|还能摆|余量|剩下多少|承重够不够|放得下几台/.test(part)) {
        steps.push({ act: 'ask', kind: 'capacity', text: part });
        return;
      }
      if (/拆|不能|为什么|怎么|是什么|在哪|多少/.test(part)) { steps.push({ act: 'ask', text: part }); return; }
      steps.push({ act: 'unknown', text: part });
    });

    // 补全 + 合并同类（同一动作相邻重复的不合，保留顺序）
    const out = steps.map(s => fill(s));
    // 一句"再放一台"里 parts 只有一段，count 已经处理
    return { steps: out, source: 'local' };
  }

  /* ---------------- 大模型 ---------------- */
  function sceneDigest() {
    const M = model(), m = A.mem;
    const floors = M.floors.map(f => 'F' + f.level).join(' ');
    const rooms = M.rooms.filter(r => r.zone !== 'corr')
      .map(r => r.num + (r.use ? r.use.slice(0, 4) : '')).join(' ');
    const lib = (M.equipmentLibrary || []).map(e => e.name + (e.weight / 1000).toFixed(1) + 't').join('、');
    const placed = m.placed.map(e => e.name + '@' + e.room + '(' + e.x.toFixed(1) + ',' + e.y.toFixed(1) + ')').join('；');
    return [
      '楼层: ' + floors,
      '房间: ' + rooms,
      '设备库: ' + lib,
      '当前上下文: ' + JSON.stringify({
        floor: m.ctx.floor, room: m.ctx.room ? m.ctx.room.num : null,
        device: m.ctx.device || null, pref: m.ctx.pref || null
      }),
      placed ? '已放设备: ' + placed : '已放设备: 无',
      m.lastValve ? '最近操作阀: ' + m.lastValve.name : '',
      m.lastDoor ? '最近开的门: ' + m.lastDoor.room.num + ' ' + (SIDE_CN[m.lastDoor.side] || '') + '墙 ' + m.lastDoor.w + 'm' : ''
    ].filter(Boolean).join('\n');
  }

  const SYS = [
    '你是 AIbim 运维系统的语音助理，帮用户在这个三维 BIM 模型里放设备、开门、查阀门影响。',
    '把用户这句话拆成可执行步骤，只输出 JSON，不要解释。',
    '格式：{"reply":"给用户的一句话","steps":[{"act":"..."}],"ctx":{"floor":1,"room":"202","device":"空气压缩机"}}',
    'act 取值：',
    'place: {"act":"place","device":"设备名","room":"房号","pref":"靠走廊|靠门|靠窗|靠角|靠柱|靠梁|靠里|居中|靠墙","count":1}',
    'door: {"act":"door","room":"房号","side":"west|east|south|north|left|right|front|back","width":1.0,"height":2.1,"pref":"靠走廊"}   // 用户说的是左/右/前/后就原样写 left/right/front/back，系统按当前镜头换算成墙',
    'window: {"act":"window","room":"房号","side":"west|east|south|north|left|right|front|back","width":1.5,"height":1.5,"sill":0.9}   // 开窗；sill 是窗台高，落地窗给 0.1',
    'valve: {"act":"valve","room":"房号","action":"open|close"}',
    'move: {"act":"move","pref":"靠里","room":"203"}   // 把刚放的设备挪一下；写了 room 就是搬到那间',
    'remove: {"act":"remove"}             // 撤掉刚放的设备',
    'view: {"act":"view","floor":0}       // 0=全楼',
    'info: {"act":"info"}',
    'ask: {"act":"ask"}                   // 只是提问，不操作模型',
    '规则：',
    '1. 用户省略了房间/设备时，从"当前上下文"和"已放设备"里继承，不要反问。',
    '2. 一句话里有多个动作就拆成多步，按先后顺序输出。',
    '3. 用户说"再放一台/继续放"沿用上一步的设备和房间，count 照用户说。',
    '4. reply 要口语、简短（<=30字），不要出现 JSON、参数、模型、系统 这类词。',
    '5. 房号必须是场景清单里存在的；不确定就用上下文里的。',
    '6. 设备名对不上时，挑清单里最接近的那台（例："水冷机组"→"风冷冷水机组"），不要反问、不要说没有。'
  ].join('\n');

  /* ---------------- 网络：一次请求 + 自动纠正 + 人话报错 ---------------- */
  function netHint(e) {
    if (e && e.name === 'AbortError') return '等太久没回，把超时调大或检查网络';
    if (typeof location !== 'undefined' && location.protocol === 'file:')
      return '页面是双击打开的（file://），跨域会被拦，改用本地服务器打开';
    return '多半是跨域被拦或地址写错；用 tools/serve.py 启动页面、地址填 /llm/v1 可绕开';
  }

  function hintFor(status, bodyText) {
    const b = String(bodyText || '');
    const az = A.isAzure();
    // 相对地址却拿到 404/405 + HTML，说明当前是普通静态服务器，没有转发能力
    if (A.isRel(A.cfg.endpoint) && (status === 404 || status === 405) && /<html|<!DOCTYPE/i.test(b))
      return '这个地址要靠本地转发：用 python tools/serve.py 启动页面（普通 http.server 不会转发 /llm）';
    if (/response_format|json_object|json mode|json 模式/i.test(b)) return '这个模型不支持强制 JSON 输出，已自动换成普通输出重试';
    if (status === 401) return az
      ? 'Azure 认不过（401）：检查 Key 是不是这个资源的，以及地址里的部署名对不对'
      : 'Key 认不过（401）：Key 写错、过期，或复制时带了空格引号';
    if (status === 403) return 'Key 没权限（403）：这个 Key 没开通该模型，或需要企业认证';
    if (status === 404) return az
      ? '地址不对（404）：Azure 要填 https://资源名.openai.azure.com/openai/deployments/部署名/chat/completions?api-version=2024-06-01'
      : '地址不对（404）：一般要写到 /v1 结尾，例如 https://api.deepseek.com/v1，不要写到 /chat/completions';
    if (status === 429) return '被限流或余额不足（429）：等一会儿，或检查账户余额';
    if (status === 400 || status === 422) {
      if (/DeploymentNotFound|deployment/i.test(b)) return '找不到这个部署（400）：模型名要填 Azure 上的部署名';
      if (/model/i.test(b)) return '模型名不对（400）：这个服务下没有这个名字的模型';
      return '请求被拒（400）：多半是模型名或参数不被支持，看下面返回原文';
    }
    if (status >= 500) return '对方服务端出错（' + status + '），稍后重试';
    return '';
  }

  /* 取正文：兼容 chat/completions、responses 风格、纯文本 */
  function pickMessage(txt) {
    const s = String(txt || '');
    let j = null;
    try { j = JSON.parse(s); } catch (e) { }
    const ch0 = j && j.choices && j.choices[0];
    return ch0 && ch0.message ? ch0.message : null;
  }
  function pickContent(txt) {
    const s = String(txt || '');
    let j = null;
    try { j = JSON.parse(s); } catch (e) { }
    if (!j) return s.trim() ? s : null;            // 非 JSON 但有内容 → 当纯文本
    if (j.error) return null;
    const ch = j.choices && j.choices[0];
    if (ch) {
      const c = ch.message && ch.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(p => p.text || '').join('');
      if (typeof ch.text === 'string') return ch.text;
    }
    if (typeof j.output_text === 'string') return j.output_text;
    return null;
  }

  async function once(url, body, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 12000);
    // Azure 认 api-key 头，其余服务用 Bearer；同源转发时页面可以不带 Key
    const headers = { 'Content-Type': 'application/json' };
    if (A.isAzure(url)) headers['api-key'] = A.cfg.key;
    else if (A.cfg.key) headers.Authorization = 'Bearer ' + A.cfg.key;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      let text = '';
      try { text = await res.text(); } catch (e) { }
      return { ok: res.ok, status: res.status, text: text };
    } catch (e) {
      clearTimeout(timer);
      return { net: e || { name: 'Error' } };
    }
  }

  /* 同一个 plan 两种写法都能跑：JSON 模式不行就去掉，max_tokens 不行就换名，少了 /v1 就补上 */
  async function post(messages, opt) {
    opt = opt || {};
    let url = A.urlOf();
    const body = { model: A.cfg.model, temperature: 0.2, messages: messages };
    if (opt.tools && opt.tools.length) {
      body.tools = opt.tools;
      body.tool_choice = opt.toolChoice || 'auto';
      body.parallel_tool_calls = true;
    } else if (opt.json !== false) {
      body.response_format = { type: 'json_object' };
    }
    // 默认不要思维链：推理型模型（qwen3-max 这类）光想就要十几秒到两分钟
    if (opt.think !== true) body.enable_thinking = false;
    body.max_tokens = opt.maxTokens || 600;

    const t0 = Date.now();
    let note = '', last = null, tries = 0;

    while (tries < 3) {
      tries++;
      last = await once(url, body, opt.timeout || A.cfg.timeout || 12000);
      if (last.net) break;
      if (last.ok) {
        const raw = pickContent(last.text);
        const msg = pickMessage(last.text);
        const tcs = (msg && msg.tool_calls) || [];
        if (raw != null || tcs.length) {
          return { ok: true, raw: raw, msg: msg, calls: tcs, url: url, ms: Date.now() - t0, tries: tries, note: note, status: 200 };
        }
        last.hint = '回来的内容里取不到正文，可能模型名不对';
        break;
      }
      const low = String(last.text || '');
      // 404 且地址没写到 /v1 → 自动补一层再试（这是最容易被忽略的写法问题）
      if (last.status === 404 && !A.isAzure() && !A.isRel(A.cfg.endpoint)) {
        const base = normEndpoint(A.cfg.endpoint);
        if (!/\/v\d+$/i.test(base)) {
          A.cfg.endpoint = base + '/v1';
          try { localStorage.setItem(LS, JSON.stringify({ endpoint: A.cfg.endpoint, model: A.cfg.model, key: A.cfg.key, timeout: A.cfg.timeout })); } catch (e) { }
          url = A.cfg.endpoint + '/chat/completions';
          note = '地址自动补了 /v1';
          continue;
        }
      }
      if (last.status === 400 || last.status === 422) {
        // 多轮循环里不再降级：中途把 tools 抽掉会让模型以为工具没了
        if (opt.strictTools) break;
        if (body.parallel_tool_calls !== undefined && /parallel_tool_calls/i.test(low)) {
          delete body.parallel_tool_calls; note = '这个服务不认并行工具调用，已去掉'; continue;
        }
        if (body.tools && body.tool_choice === 'required' && /tool_choice|required/i.test(low)) {
          body.tool_choice = 'auto'; note = '这个服务不支持强制工具调用，改成自动'; continue;
        }
        if (body.tools && /tool|function|tools are not supported|tool_choice/i.test(low)) {
          opt.tools = null; delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls;
          if (opt.json !== false) body.response_format = { type: 'json_object' };
          note = '这个模型不认 tools，改用结构化步骤'; continue;
        }
        if (body.enable_thinking !== undefined && /enable_thinking|thinking|unrecognized|unknown|not supported|extra|invalid/i.test(low)) {
          delete body.enable_thinking; note = '这个服务不认 enable_thinking，已去掉'; continue;
        }
        if (body.response_format && /response_format|json_object|json mode|json 模式/i.test(low)) {
          delete body.response_format; note = '模型不支持强制 JSON，已改普通输出'; continue;
        }
        if (body.max_tokens != null && /max_tokens/i.test(low)) {
          body.max_completion_tokens = body.max_tokens; delete body.max_tokens; note = '改用 max_completion_tokens'; continue;
        }
        if (body.temperature != null && /temperature/i.test(low)) {
          delete body.temperature; note = '去掉 temperature 参数'; continue;
        }
      }
      break;
    }

    if (last && last.net) {
      const h = netHint(last.net);
      return {
        ok: false, url: url, tries: tries, ms: Date.now() - t0, net: true,
        err: '连不上服务器', hint: h,
        body: String((last.net && last.net.message) || '')
      };
    }
    const status = last ? last.status : 0;
    const hint = (last && last.hint) || hintFor(status, last && last.text);
    return {
      ok: false, url: url, tries: tries, ms: Date.now() - t0, status: status,
      err: 'HTTP ' + status + (hint ? ' · ' + hint : ''), hint: hint,
      body: String(last && last.text || '').slice(0, 400), note: note
    };
  }

  /* 对话消息：系统提示 + 最近几轮 + 这句 */
  function buildMsgs(text, sys) {
    const msgs = [{ role: 'system', content: (sys || SYS) + '\n\n【场景】\n' + sceneDigest() }];
    const hist = A.mem.turns.slice(-8);
    // plan() 已经把这句话写进 turns 了，这里去掉尾巴上那条同样的，否则模型会看到两遍
    if (hist.length && hist[hist.length - 1].role === 'user' && hist[hist.length - 1].text === text) hist.pop();
    hist.forEach(t => msgs.push({ role: t.role === 'ai' ? 'assistant' : 'user', content: t.text }));
    msgs.push({ role: 'user', content: text });
    return msgs;
  }

  /* ---------------- 工具调用（MCP 风格） ----------------
     让模型直接选工具、填参数，比让它手写一段 JSON 步骤稳得多：
     工具名不会写错，参数有 schema 约束，也就不会出现"听懂了但没执行"。 */
  const TOOL_SYS_HEAD = [
    '你是 AIbim 运维系统的现场助手，在一个三维 BIM 模型上帮用户干活。',
    '凡是能操作模型的（放/删/改/换/挪设备、开门/改门/挪门/拆门、切视角、聚焦、关阀门、撤回），必须调用对应工具，不要只回文字。',
    '能一次调多个就并行调；用户说了房间号就用他的，没说就沿用上下文。',
    '不能操作的问题（解释、建议、为什么）直接用一句口语回答，不要再调工具。',
    '回答用中文，简短，不要提工具名、参数、JSON。',
    '设备名对不上时选最接近的那台（"水冷机组"→"风冷冷水机组"），不要反问。',
    '【放还是搬】"把空压机放到 203"=新放一台（place_equipment）；"把这个/它/刚才那台放到 203"=搬走已有那台（move_equipment）。结果差一台设备，别混。',
    '【多轮】工具调完会立刻把执行结果回给你（ok/安全系数/两侧余量/候选位置都在里面）。',
    '每拿到一次结果就判断一次：成了就收尾；没成（ok 为 false 或结果里说放不下、撞了、搬不进来）就换方案再调一次——',
    '例如换房间、换方位、把设备改小、拓门、先挪走挡道的。最多 4 轮，别原地重试同一个调用。',
    '【收尾】最后一次不要再调工具，用一两句口语把"改了什么、结果怎样（真实数字）、还有什么要注意"讲完。'
  ].join('\n');

  /* 工具的用法说明放在 mcp.js 里，和 schema 一起维护；这里拼进去 */
  function toolSys() {
    const g = window.BIM.mcp && window.BIM.mcp.guide;
    return g ? TOOL_SYS_HEAD + '\n' + g : TOOL_SYS_HEAD;
  }

  function parseArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    const j = parseJSON(String(raw));
    return j && typeof j === 'object' ? j : {};
  }

  /* 工具名 → 内部步骤（后面的执行还是走同一套 io，不另起一套逻辑）
     注意单位：工具里 weight 是"吨"，内部一律换成 kg */
  const kg = v => (v == null || v === '' ? null : Math.round(+v * 1000));
  const TOOL2STEP = {
    place_equipment: a => ({
      act: 'place', device: a.device || a.name || null, room: a.room || null, floor: a.floor || null,
      count: a.count || 1, pref: a.pref || null, weight: kg(a.weight), near: a.near || null,
      side: a.side || null
    }),
    remove_equipment: a => ({
      act: 'remove', target: a.target || null, room: a.room || null, all: !!a.all
    }),
    move_equipment: a => ({
      act: 'move', target: a.target || null, room: a.room || null, floor: a.floor || null,
      dir: a.direction || null, dist: a.distance || null, pref: a.pref || null
    }),
    replace_equipment: a => ({
      act: 'replace', device: a.device || null, target: a.target || null, weight: kg(a.weight)
    }),
    resize_equipment: a => ({
      act: 'resize', target: a.target || null, width: a.width || null, depth: a.depth || null,
      height: a.height || null, weight: kg(a.weight)
    }),
    query_equipment: a => ({ act: 'info', target: a.target || null }),
    query_clearance: a => ({ act: 'clearance', target: a.target || null, room: a.room || null, show: a.show !== false }),
    find_rooms_for_equipment: a => ({
      act: 'findroom', device: a.device || null, floor: a.floor || null, want: a.count || 3
    }),
    list_devices: a => ({ act: 'devices', room: a.room || null, floor: a.floor || null }),
    suggest_positions: a => ({
      act: 'suggest', device: a.device || null, room: a.room || null, floor: a.floor || null,
      want: a.count || 3, apply: a.apply !== false
    }),
    show_properties: () => ({ act: 'info' }),
    query_capacity: () => ({ act: 'ask', kind: 'capacity' }),

    open_door: a => ({
      act: 'door', room: a.room || null, floor: a.floor || null, side: a.side || null,
      width: a.width || null, height: a.height || null, pref: a.pref || null
    }),
    open_window: a => ({
      act: 'window', room: a.room || null, floor: a.floor || null, side: a.side || null,
      width: a.width || 1.5, height: a.height || 1.5, sill: a.sill == null ? .9 : a.sill, pref: a.pref || null
    }),
    remove_window: a => ({ act: 'windowoff', window: a.window || null, room: a.room || null, floor: a.floor || null }),
    move_window: a => ({
      act: 'winmove', window: a.window || null, room: a.room || null, floor: a.floor || null,
      dir: a.direction || null, dist: a.distance != null ? Math.abs(+a.distance) : null
    }),
    remove_door: a => ({
      act: 'dooroff', door: a.door || null, room: a.room || null, floor: a.floor || null, side: a.side || null
    }),
    move_door: a => ({
      act: 'doormove', door: a.door || null, along: a.along || null, dist: a.distance || null,
      side: a.side || null, room: a.room || null, floor: a.floor || null
    }),
    resize_door: a => ({
      act: 'doorsize', door: a.door || null, width: a.width || null, height: a.height || null,
      room: a.room || null, floor: a.floor || null
    }),
    query_door: a => ({ act: 'doorinfo', door: a.door || null, room: a.room || null }),
    list_doors: a => ({ act: 'doors', room: a.room || null, floor: a.floor || null }),

    focus_view: a => ({
      act: 'focus', room: a.room || null, floor: a.floor || null, device: a.device || null,
      only: a.only_this !== false
    }),
    show_all: () => ({ act: 'showall' }),
    set_view: a => ({ act: 'view', floor: a.floor == null ? 0 : a.floor }),
    list_scene: a => ({ act: 'scene', what: a.what || 'all' }),
    toggle_valve: a => ({
      act: 'valve', room: a.room || null, floor: a.floor || null, valve: a.valve || null,
      action: a.action === 'open' ? 'open' : 'close'
    }),
    query_impact: a => ({ act: 'impact', room: a.room || null, valve: a.valve || null }),
    undo_last: () => ({ act: 'undo' })
  };
  A.toolToStep = TOOL2STEP;      // 给 Agent 循环用：每次工具调用顺手记一笔内部步骤

  /* 这句是不是"要动手"的话：要动手就逼模型调工具，别让它嘴上说做了 */
  const ACTY = /开|关|放|摆|挪|移|搬|撤|删|改|换|替换|加宽|加高|调小|调大|缩小|扩大|聚焦|只显示|隐藏|切到|看看|显示|查一下|列出|加上|去掉|撤回|撤销/;
  const ASKY = /为什么|怎么|能不能|可不可以|行不行|吗|？|\?|多少|几台|什么|在哪|解释|建议|应该|是不是/;
  function looksAction(text) { return ACTY.test(text) && !ASKY.test(text); }

  async function askTools(text) {
    const T = window.BIM.mcp;
    if (!T || !T.tools) return { ok: false, err: '工具层没加载' };
    const msgs = buildMsgs(text, toolSys());
    const want = looksAction(text);
    const r = await post(msgs, {
      tools: T.tools, toolChoice: want ? 'required' : 'auto', json: false,
      maxTokens: 600, think: false, timeout: Math.max(A.cfg.timeout || 0, 60000)
    });
    A.diag = {
      at: Date.now(), ok: r.ok, url: r.url, status: r.status, ms: r.ms,
      err: r.err || '', hint: r.hint || '', body: r.body || '', note: r.note || '',
      mode: 'tools'
    };
    if (!r.ok) return { ok: false, err: r.err, hint: r.hint };

    const calls = (r.calls || []).map(tc => {
      const fn = tc.function || tc;
      return { id: tc.id || '', name: fn.name || fn.tool || '', args: parseArgs(fn.arguments || fn.args) };
    }).filter(c => c.name);

    // 该动手却没调工具：这句回复不可信，交给本地规则兜底
    // （除非它是老网关回的 JSON 步骤，那种还是能用的）
    const reply = String(r.raw || '').trim();
    const jReply = parseJSON(reply);
    const legacyOk = !!(jReply && jReply.steps && jReply.steps.length);
    const weak = want && !calls.length && !legacyOk;
    return { ok: true, calls: calls, reply: reply, weak: weak, note: r.note || '' };
  }

  /* ---------------- 多轮工具调用（Agent 循环） ----------------
     以前一次请求只够"听懂一句、挑一个工具"，模型根本看不到执行结果，
     于是"搬不进去就换台小的""先试试不行再说"这类要求全部落空，
     表现就是：模型像没执行一样反问用户。
     现在改成：模型调工具 → 真执行 → 结果回灌 → 模型判断 → 继续或收尾。 */
  A.MAX_ROUNDS = 4;
  A.MAX_CALLS = 8;

  function briefOut(T, out) {
    if (out && T && T.brief) return T.brief(out);
    try { return JSON.stringify(out || {}).slice(0, 600); } catch (e) { return '{"ok":false}'; }
  }

  A.loop = async function (text, exec) {
    const T = window.BIM.mcp;
    if (!T || !T.tools) return { ok: false, err: '工具层没加载' };
    if (typeof exec !== 'function') return { ok: false, err: '没有执行器' };

    const msgs = buildMsgs(text, toolSys());
    const trace = [];
    const want = looksAction(text);
    let calls = 0;

    for (let round = 0; round < A.MAX_ROUNDS; round++) {
      const first = round === 0;
      const r = await post(msgs, {
        tools: T.tools,
        // 第一轮是明确的动手指令就逼它调工具；之后交给模型自己判断该不该收尾
        toolChoice: first ? (want ? 'required' : 'auto') : 'auto',
        json: false, maxTokens: 700, think: false, strictTools: !first,
        timeout: Math.max(A.cfg.timeout || 0, 60000)
      });
      A.diag = {
        at: Date.now(), ok: r.ok, url: r.url, status: r.status, ms: r.ms,
        err: r.err || '', hint: r.hint || '', body: r.body || '', note: r.note || '',
        mode: 'loop', round: round + 1, calls: calls
      };
      if (!r.ok) return { ok: false, err: r.err, hint: r.hint, trace: trace, calls: calls };

      const tcs = (r.calls || []).filter(tc => (tc.function || tc).name);
      if (!tcs.length) {
        return { ok: true, reply: String(r.raw || '').trim(), trace: trace, calls: calls, rounds: round + 1 };
      }

      // 模型这一轮的 tool_calls 必须原样回填，后面才接得上 tool 结果
      msgs.push({
        role: 'assistant',
        content: String(r.raw || ''),
        tool_calls: tcs.map((tc, i) => {
          const fn = tc.function || tc;
          return {
            id: tc.id || ('call_' + calls + '_' + i),
            type: 'function',
            function: {
              name: fn.name,
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
            }
          };
        })
      });

      for (let i = 0; i < tcs.length; i++) {
        const fn = tcs[i].function || tcs[i];
        const name = fn.name;
        const args = parseArgs(fn.arguments != null ? fn.arguments : fn.args);
        const id = tcs[i].id || ('call_' + calls + '_' + i);
        if (calls >= A.MAX_CALLS) {
          msgs.push({ role: 'tool', tool_call_id: id, name: name, content: '{"ok":false,"say":"操作次数到上限了，先停在这里"}' });
          continue;
        }
        calls++;
        let out;
        try { out = await exec(name, args); }
        catch (e) { out = { ok: false, say: '执行出错了：' + (e && e.message ? e.message : e) }; }
        out = out || {};
        trace.push({ name: name, args: args, ok: out.ok !== false, say: String(out.say || '').slice(0, 240) });
        msgs.push({ role: 'tool', tool_call_id: id, name: name, content: briefOut(T, out) });
      }
    }

    // 轮数用完：把工具收走逼它总结，免得卡在"再调一次"里空转
    const fin = await post(msgs, { tools: T.tools, toolChoice: 'none', json: false, maxTokens: 400, think: false, strictTools: true });
    return {
      ok: true, reply: fin.ok ? String(fin.raw || '').trim() : '', trace: trace,
      calls: calls, rounds: A.MAX_ROUNDS, truncated: true
    };
  };

  async function askLLM(text, opt) {
    opt = opt || {};
    const msgs = buildMsgs(text);

    // 规划这一步要的是结构化结果，不是长篇推理：关掉思维链能快一个数量级
    const r = await post(msgs, { json: opt.json !== false, maxTokens: 600, think: false, timeout: Math.max(A.cfg.timeout || 0, 60000) });
    A.diag = {
      at: Date.now(), ok: r.ok, url: r.url, status: r.status, ms: r.ms,
      err: r.err || '', hint: r.hint || '', body: r.body || '', note: r.note || ''
    };
    if (!r.ok) return { ok: false, err: r.err, hint: r.hint };
    const j = parseJSON(r.raw);
    if (!j && !opt.retry) {
      // 有的服务在 JSON 模式下回一堆前言，去掉强制 JSON 再来一次
      const again = await askLLM(text, { json: false, retry: true });
      if (again.ok) return again;
    }
    if (!j) {
      A.diag.err = '模型没按约定回 JSON';
      A.diag.body = String(r.raw).slice(0, 200);
      return { ok: false, err: '模型没按约定回 JSON', hint: '模型太小或没听懂格式要求，换个模型试试' };
    }
    return { ok: true, plan: j };
  }

  /* 拉服务上的模型列表：模型名填错是第二常见的连不上原因 */
  A.models = async function () {
    if (!A.cfg.endpoint) return { ok: false, err: '先填接口地址' };
    if (A.isAzure()) return { ok: false, err: 'Azure 直接用部署名，没有模型列表' };
    const base = normEndpoint(A.cfg.endpoint);
    const url = base + '/models';
    const headers = {};
    if (A.isAzure(url)) headers['api-key'] = A.cfg.key;
    else if (A.cfg.key) headers.Authorization = 'Bearer ' + A.cfg.key;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(A.cfg.timeout || 12000, 10000));
    try {
      const res = await fetch(url, { headers: headers, signal: ctrl.signal });
      clearTimeout(timer);
      const txt = await res.text();
      if (!res.ok) return { ok: false, err: 'HTTP ' + res.status + ' ' + (hintFor(res.status, txt) || ''), body: txt.slice(0, 200) };
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { }
      const arr = (j && (j.data || j.models || j.result)) || [];
      const list = arr.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
      if (!list.length) return { ok: false, err: '没取到模型列表（服务可能没开放 /models）', body: txt.slice(0, 200) };
      return { ok: true, list: list.sort(), url: url };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, err: netHint(e), url: url };
    }
  };

  /* 设置面板里的「测试连接」 */
  A.test = async function () {
    const miss = [];
    if (!String(A.cfg.endpoint || '').trim()) miss.push('地址');
    if (!String(A.cfg.model || '').trim()) miss.push('模型');
    // 同源转发时 Key 在服务端，页面可以不填
    if (!A.isRel(A.cfg.endpoint) && !String(A.cfg.key || '').trim()) miss.push('Key');
    if (miss.length) {
      A.diag = { at: Date.now(), ok: false, err: '还差：' + miss.join('、') };
      return { ok: false, err: '还差：' + miss.join('、'), hint: '' };
    }
    const r = await post([{ role: 'user', content: '只回四个字：连接正常' }], { json: false, maxTokens: 32, timeout: Math.min(A.cfg.timeout || 12000, 10000) });
    A.diag = {
      at: Date.now(), ok: r.ok, url: r.url, status: r.status, ms: r.ms,
      err: r.err || '', hint: r.hint || '', body: r.body || '', note: r.note || ''
    };
    if (r.ok) {
      A.diag.reply = String(r.raw || '').slice(0, 80);
      A.llmState = { ok: true, msg: '大模型', at: Date.now() };
      return { ok: true, ms: r.ms, msg: '通了，' + r.ms + ' ms' + (r.note ? '（' + r.note + '）' : ''), reply: A.diag.reply };
    }
    A.llmState = { ok: false, msg: r.err || '没通', hint: r.hint || '', at: Date.now() };
    return { ok: false, err: r.err, hint: r.hint, url: r.url, status: r.status, body: r.body };
  };

  function parseJSON(s) {
    if (!s) return null;
    const t = String(s).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { }
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { } }
    return null;
  }

  /* ---------------- 对外：规划 ---------------- */
  A.llmState = { ok: null, msg: '', at: 0 };
  A.diag = null;        // 最近一次请求的诊断：{ok,url,status,ms,err,hint,body}

  /* 一段 JSON 步骤 → 内部步骤（老网关 / 模型自己写 JSON 时用） */
  function stepsFromJson(j, text) {
    if (!j || !j.steps || !j.steps.length) return null;
    const cont = /再放|继续放|再来一台|还要放|再摆|再多放/.test(text);
    const steps = j.steps.map(s => {
      if (!s.text) s.text = text;                    // 让补全能看见原话
      if (s.act === 'place' && cont && !s.room) s.cont = true;
      return fill(s);
    }).filter(Boolean);
    mergeCtx(j.ctx);
    return { steps: steps, reply: j.reply || '', ctx: j.ctx || null, source: 'llm' };
  }

  /* 工具调用 → 内部步骤 */
  function stepsFromCalls(calls, text) {
    const cont = /再放|继续放|再来一台|还要放|再摆|再多放/.test(text);
    const steps = [];
    const T = window.BIM.mcp;
    calls.forEach(c => {
      const f = TOOL2STEP[c.name];
      if (!f) return;
      const st = f(c.args || {});
      st.text = text;
      st.tool = c.name;
      if (st.act === 'place' && cont && !st.room) st.cont = true;
      const filled = fill(st);
      steps.push(filled);
      // 记一笔，诊断面板和自动化测试都能看见"模型到底调了什么"
      if (T && T.log) {
        T.log.push({ name: c.name, args: c.args || {}, ok: null, src: 'llm', step: filled });
        if (T.log.length > 20) T.log.shift();
      }
    });
    return steps;
  }

  A.plan = async function (text) {
    remember('user', text);
    let plan = null;
    if (A.cfg.on) {
      // ① 先走工具调用：模型选工具、填参数，比让它手写 JSON 稳
      const t = await askTools(text);
      if (t.ok) {
        A.llmState = { ok: true, msg: '大模型', at: Date.now() };
        if (t.calls && t.calls.length) {
          const steps = stepsFromCalls(t.calls, text);
          if (steps.length) {
            plan = { steps: steps, reply: t.reply, source: 'llm', tools: t.calls.map(c => c.name) };
          }
        }
        if (!plan && t.reply && !t.weak) {
          // 只回了文字：可能是老网关不认 tools 而回了 JSON 步骤，也可能真是句解释
          const j = parseJSON(t.reply);
          const legacy = stepsFromJson(j, text);
          if (legacy) plan = legacy;
          else plan = { steps: [{ act: 'ask', text: text }], reply: t.reply, source: 'llm' };
        }
      } else {
        A.llmState = { ok: false, msg: t.err || '未返回', hint: t.hint || '', at: Date.now() };
      }
      // ② 工具这条路没结果（连接挂了/空回复），退回归结构化步骤
      if (!plan && t.ok && !t.weak) {
        const r = await askLLM(text);
        if (r.ok) {
          const legacy = stepsFromJson(r.plan, text);
          if (legacy) plan = legacy;
        }
      }
    }
    if (!plan) {
      const lp = localPlan(text);
      lp.reply = '';
      lp.source = 'local';
      plan = lp;
    }
    remember('ai', plan.reply || describe(plan));
    return plan;
  };

  /* 只看本地规划（绕过大模型）：调试和验收入口 */
  A.local = function (text) {
    const lp = localPlan(String(text || ''));
    lp.source = 'local';
    return lp;
  };

  /* 给界面显示的"现在在说什么" */
  A.ctxLine = function () {
    const c = A.mem.ctx;
    const bits = [];
    if (c.room) bits.push(c.room.floor + '楼 ' + c.room.num);
    else if (c.floor) bits.push(c.floor + '楼');
    if (c.device) bits.push(c.device);
    if (c.pref && window.BIM.nlp.PREF_CN[c.pref]) bits.push(window.BIM.nlp.PREF_CN[c.pref]);
    if (!bits.length && A.mem.lastPlaced) bits.push(A.mem.lastPlaced.name);
    return bits.join(' · ');
  };

  /* ---------------- 对外：执行 ---------------- */
  /* io: { place(step)->Promise, door, valve, move, remove, view, info, ask } */
  A.exec = async function (plan, io) {
    const out = { done: 0, fails: [] };
    for (const step of plan.steps) {
      if (step.act === 'unknown') {
        out.fails.push(step.text);
        continue;
      }
      const fn = io[step.act];
      if (!fn) { out.fails.push(step.act); continue; }
      try {
        const r = await fn(step, plan);
        if (r === false) out.fails.push(step.act);
        else out.done++;
      } catch (e) {
        out.fails.push(step.act + ':' + (e && e.message));
      }
    }
    return out;
  };

  /* 把执行结果写回上下文 */
  A.commit = function (step, extra) {
    const m = A.mem;
    if (step.act === 'place' && extra && extra.room) {
      m.ctx.room = extra.room;
      m.ctx.floor = extra.room.floor;
      const dn = (extra && extra.device) || step.device;
      if (dn) m.ctx.device = dn;
      if (extra.eq) {
        m.lastPlaced = extra.eq;
        if (m.placed.indexOf(extra.eq) < 0) m.placed.push(extra.eq);
        if (m.placed.length > 12) m.placed.shift();
      }
      if (extra.result) m.lastResult = extra.result;
    }
    if (step.act === 'door' && extra && extra.room) {
      m.ctx.room = extra.room; m.ctx.floor = extra.room.floor;
      m.lastDoor = { room: extra.room, side: extra.side || step.side, w: step.width, h: step.height };
    }
    if (step.act === 'valve') {
      if (extra && extra.valve) { m.lastValve = extra.valve; if (extra.room) { m.ctx.room = extra.room; m.ctx.floor = extra.room.floor; } }
    }
    if (step.pref) m.ctx.pref = step.pref;
    if (step.floor) m.ctx.floor = step.floor;
  };

  /* 供 UI 显示"现在是靠模型还是靠本地规则" */
  A.status = function () {
    if (!A.cfg.on) return { k: 'local', t: '本地理解' };
    if (A.llmState.ok === true) return { k: 'llm', t: '大模型' };
    if (A.llmState.ok === false) return { k: 'bad', t: '大模型离线 · 本地兜底' };
    return { k: 'llm', t: '大模型' };
  };
})();
