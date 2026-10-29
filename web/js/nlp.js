/* AIbim 自然语言解析 —— 不依赖固定句式，按要素抽取 */
(function () {
  window.BIM = window.BIM || {};
  const N = (window.BIM.nlp = {});
  let M = window.BIM_MODEL;
  /* 导入 IFC 后换模型 */
  N.setModel = function (m) { M = m; };

  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 首: 1 };

  const ALIAS = {
    '空压机': '空气压缩机', '压缩机': '空气压缩机', '气泵': '空气压缩机', '空压': '空气压缩机',
    'ups': 'UPS 电源柜', '电源柜': 'UPS 电源柜', '电池柜': 'UPS 电源柜',
    '精密空调': '精密空调机组', '空调机组': '精密空调机组', '空调': '精密空调机组',
    '水泵': '消防水泵机组', '泵组': '消防水泵机组', '消防泵': '消防水泵机组',
    '机柜': '服务器机柜', '服务器': '服务器机柜',
    '文件柜': '文件柜组', '档案柜': '文件柜组',
    '实验台': '实验台', '试验台': '实验台',
    '离心机': '医用离心机', '脱水机': '医用离心机',
    '新风': '新风机组', '新风机组': '新风机组',
    '发电机': '柴油发电机组', '柴发': '柴油发电机组', '柴油机': '柴油发电机组'
  };

  const SIDE = { 西: 'west', 东: 'east', 上: 'north', 下: 'south', 北: 'north', 南: 'south' };
  // 相对屏幕的方向：由 app 层用相机换算成具体墙面
  const SIDE_REL = { 左: 'left', 右: 'right', 前: 'front', 后: 'back' };
  N.SIDE_CN = { west: '西', east: '东', south: '南', north: '北' };

  function norm(s) {
    return (s || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[，。？！、；：]/g, ',')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /* 中文数字/口语尺寸 → 阿拉伯数字：一米二 → 1.2米，两米 → 2米 */
  function cn2num(s) {
    const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    return s
      .replace(/([零一二两三四五六七八九])米([一二三四五六七八九])/g, (m, a, b) => D[a] + '.' + D[b] + '米')
      .replace(/([零一二两三四五六七八九])米/g, (m, a) => D[a] + '米')
      .replace(/十米/g, '10米')
      .replace(/([零一二两三四五六七八九])公分/g, (m, a) => D[a] + '0公分')
      .replace(/零点([一二三四五六七八九])/g, (m, a) => '0.' + D[a]);
  }

  function findFloor(t) {
    let m = t.match(/(\d+)\s*(?:楼|层|f)/);
    if (m) return +m[1];
    m = t.match(/([一二三四五六七八九十])\s*(?:楼|层)/);
    if (m) return CN[m[1]];
    return null;
  }

  function findRoom(t, floor) {
    let m = t.match(/(\d{3,4})\s*(?:室|房间|号)/);
    if (m) return +m[1];
    m = t.match(/(?:楼|层)\s*(\d{3,4})/);
    if (m) return +m[1];
    const all = (t.match(/\d{3,4}/g) || []).map(Number).filter(n => n >= 101 && n <= 599);
    if (all.length) return all[0];
    if (floor) {
      m = t.match(/(\d{1,2})\s*(?:号|室)/);
      if (m && +m[1] < 100) return floor * 100 + +m[1];
    }
    return null;
  }

  function findDevice(t) {
    const lib = M.equipmentLibrary;
    // 全名优先
    for (const e of lib) {
      if (t.indexOf(e.name.toLowerCase().replace(/\s/g, '')) >= 0 || t.indexOf(e.name) >= 0) return e;
    }
    const keys = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (t.indexOf(k) >= 0) return lib.find(e => e.name === ALIAS[k]) || null;
    }
    return null;
  }

  function findWeight(t) {
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:吨|t)/);
    if (m) return Math.round(+m[1] * 1000);
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:公斤|kg|千克)/);
    if (m) return Math.round(+m[1]);
    return null;
  }

  function findSide(t) {
    // 左/右/前/后 是"屏幕方向"，得由调用方按当前相机换算成墙面；
    // 直接写死成西/东的话，用户把镜头转过去再说话就全反了
    for (const k of ['左边', '左侧', '左', '右边', '右侧', '右',
      '前面', '前边', '对面', '后面', '后边', '背后',
      '西边', '西侧', '西', '东边', '东侧', '东',
      '上边', '北边', '北侧', '北', '下边', '南边', '南侧', '南']) {
      if (t.indexOf(k) < 0) continue;
      if (SIDE[k[0]]) return { side: SIDE[k[0]], rel: null };
      if (SIDE_REL[k[0]]) return { side: null, rel: SIDE_REL[k[0]] };
    }
    return null;
  }

  function findWidth(t) {
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m|公分|cm)?\s*宽/);
    if (m) return m2(+m[1], /公分|cm/.test(m[0]));
    m = t.match(/宽\s*(?:度)?\s*(?:为|是|大约|大概)?\s*(\d+(?:\.\d+)?)\s*(公分|cm)?/);
    if (m) return m2(+m[1], !!m[2]);
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)?\s*[x×*]\s*(\d+(?:\.\d+)?)/);
    if (m) return +m[1];
    if (/双开|对开/.test(t)) return 1.6;
    if (/子母门/.test(t)) return 1.2;
    if (/单开/.test(t)) return 1.0;
    // 只说了「一个 1.2 米的门」
    if (/门/.test(t)) {
      m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)(?!\s*(?:高|宽))/);
      if (m) return +m[1];
      m = t.match(/(\d{2,3})\s*(?:公分|cm)/);
      if (m) return +m[1] / 100;
    }
    return null;
  }

  function findHeight(t) {
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m|公分|cm)?\s*高/);
    if (m) return m2(+m[1], /公分|cm/.test(m[0]));
    m = t.match(/高\s*(?:度)?\s*(?:为|是|大约|大概)?\s*(\d+(?:\.\d+)?)\s*(公分|cm)?/);
    if (m) return m2(+m[1], !!m[2]);
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)?\s*[x×*]\s*(\d+(?:\.\d+)?)/);
    if (m) return +m[2];
    if (/门/.test(t)) {
      m = t.match(/(\d{3,4})\s*(?:公分|cm)/);
      if (m && +m[1] >= 180) return +m[1] / 100;
    }
    return null;
  }
  function m2(v, isCm) { return isCm ? v / 100 : v; }

  /* ---------------- 窗 ---------------- */
  /* "靠窗/临窗"是方位偏好，不是要开窗，先把它剥掉再判断意图 */
  function stripWinPref(t) {
    return t.replace(/靠窗|临窗|窗边|窗侧|窗户那侧|靠窗户|挨着窗|朝窗/g, '');
  }
  function hasWin(t) {
    if (/窗洞/.test(t)) return true;
    if (!/窗/.test(t)) return false;
    // 落地窗 / 飘窗 这类"窗型"本身就说明要开窗
    if (/落地窗|飘窗|落地的窗|百叶窗|天窗/.test(t)) return true;
    // 开/加/装/做/留 在前，或带尺寸
    if (/(开|加|装|做|打|留|设|新开|再来|来)[一1两2几]?[个道扇]?(大)?(落地窗|飘窗|窗|窗户|窗口)/.test(t)) return true;
    if (/(窗|窗户|窗口)[^,]{0,4}(开|加|装|做|留)/.test(t)) return true;
    if (/窗/.test(t) && /(米|公分|cm|毫米|宽|高)/.test(t)) return true;
    return false;
  }
  N.hasWin = hasWin;

  /* 挪动已有的窗，不是新开一扇：
     "把窗往上挪""窗台抬高一点""这扇窗往左移半米"。
     判据是——提到了窗 + 带位移/升降动词，且没有"开/加/装/做"这类新开动作。 */
  const WIN_UP = /往上|向上|上移|升高|抬高|提高|调高|挪高|再高|高一点|高一些|高些|高点儿|抬一点|提一点/;
  const WIN_DOWN = /往下|向下|下移|降低|压低|调低|挪低|再低|低一点|低一些|低些|低点儿|降一点|沉一点/;
  function hasWinMove(t) {
    if (!/窗/.test(t)) return false;
    if (/拆|封|删掉|去掉|不要了/.test(t)) return false;         // 那是拆窗
    // 明确在说"开一扇"就不算挪
    if (/(开|加|装|做|打|留|设|新开|再来|来)[一1两2几]?[个道扇]?(大)?(落地窗|飘窗|窗|窗户|窗口)/.test(t)) return false;
    if (/(窗|窗户|窗口)[^,]{0,4}(开|加|装|做|留)/.test(t)) return false;
    if (WIN_UP.test(t) || WIN_DOWN.test(t)) return true;
    return /(挪|移|滑|动一下|调一下|换个位置)/.test(t) && /(窗|窗户|窗口)/.test(t);
  }
  N.hasWinMove = hasWinMove;
  N.WIN_UP = WIN_UP;
  N.WIN_DOWN = WIN_DOWN;

  function winSize(t) {
    const out = { w: null, h: null, sill: null };
    const num = s => +s;
    // 窗台高
    let m = t.match(/窗台(?:高|高度)?\s*(?:是|为|大概|大约|做到)?\s*(\d+(?:\.\d+)?)\s*(公分|cm|厘米|毫米|mm|米|m)?/);
    if (m) out.sill = /公分|cm|厘米/.test(m[2] || '') ? num(m[1]) / 100 : /毫米|mm/.test(m[2] || '') ? num(m[1]) / 1000 : num(m[1]);
    if (out.sill == null) {
      m = t.match(/(?:离地|离楼板|台高)\s*(\d+(?:\.\d+)?)\s*(公分|cm|厘米|毫米|mm|米|m)?/);
      if (m) out.sill = /公分|cm|厘米/.test(m[2] || '') ? num(m[1]) / 100 : /毫米|mm/.test(m[2] || '') ? num(m[1]) / 1000 : num(m[1]);
    }
    // 宽×高
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)?\s*[x×*]\s*(\d+(?:\.\d+)?)/);
    if (m) { out.w = num(m[1]); out.h = num(m[2]); }
    if (out.w == null) {
      m = t.match(/(\d+(?:\.\d+)?)\s*(公分|cm|厘米)?\s*(?:米|m)?\s*宽/);
      if (m) out.w = m[2] ? num(m[1]) / 100 : num(m[1]);
    }
    if (out.h == null) {
      m = t.match(/(\d+(?:\.\d+)?)\s*(公分|cm|厘米)?\s*(?:米|m)?\s*高/);
      if (m) out.h = m[2] ? num(m[1]) / 100 : num(m[1]);
    }
    // 只有一个数：当宽度
    if (out.w == null) {
      m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m)(?!\s*(?:高|宽|台))/);
      if (m) out.w = num(m[1]);
      if (out.w == null) {
        m = t.match(/(\d{2,3})\s*(?:公分|cm|厘米)/);
        if (m) out.w = num(m[1]) / 100;
      }
    }
    return out;
  }
  N.winSize = winSize;

  /* 方位/摆放偏好 */
  const PREF = [
    [/靠走廊|靠过道|临走廊|朝走廊|走廊那侧|过道那侧/, 'corridor'],
    [/靠门口|靠门|门旁|门边|门口附近/, 'door'],
    [/靠窗|窗边|临窗|窗户那侧/, 'window'],
    [/靠角|墙角|角落|拐角/, 'corner'],
    [/靠柱|柱边|柱子旁|柱子边/, 'column'],
    [/靠梁|梁边|梁下|梁底/, 'beam'],
    [/靠里|里面|内侧|往里|最里面|深处|靠后/, 'inner'],
    [/居中|中间|正中|中央|屋子中心/, 'center'],
    [/靠墙|贴墙|靠边|沿墙/, 'wall']
  ];
  N.PREF_CN = {
    corridor: '靠走廊', door: '靠门口', window: '靠窗', corner: '靠墙角',
    column: '靠柱', beam: '靠梁', inner: '靠里', center: '居中', wall: '靠墙'
  };
  function findPref(t) {
    for (const [re, k] of PREF) if (re.test(t)) return k;
    return null;
  }
  N.findPref = findPref;
  N.findWidth = findWidth;      // 给"门加宽到 1.5 米"这类改尺寸用
  N.findHeight = findHeight;
  N.findDevice = findDevice;    // 给"换成 XX"这类替换用
  /* 方位归一化：大模型有可能直接回中文（"靠里"），也可能是英文键（inner），统一成键 */
  const PREF_ALIAS = {
    inner: 'inner', 靠里: 'inner', 里侧: 'inner', 里面: 'inner', 内侧: 'inner', 深处: 'inner', inside: 'inner',
    wall: 'wall', 靠墙: 'wall', 贴墙: 'wall', 靠边: 'wall', 沿墙: 'wall', 墙边: 'wall',
    window: 'window', 靠窗: 'window', 窗边: 'window', 临窗: 'window',
    door: 'door', 靠门: 'door', 靠门口: 'door', 门边: 'door', 门口: 'door',
    corner: 'corner', 靠角: 'corner', 墙角: 'corner', 靠墙角: 'corner', 角落: 'corner',
    column: 'column', 靠柱: 'column', 柱边: 'column',
    beam: 'beam', 靠梁: 'beam', 梁下: 'beam',
    corridor: 'corridor', 靠走廊: 'corridor', 靠过道: 'corridor', 走廊: 'corridor',
    center: 'center', 居中: 'center', 中间: 'center', 正中: 'center', 中央: 'center'
  };
  function prefKey(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    if (PREF_ALIAS[s]) return PREF_ALIAS[s];
    // 不用精确词表时，再过一遍关键词（"放在靠近里的位置"这种）
    const k = findPref(s);
    return k || null;
  }
  N.prefKey = prefKey;

  /* 相对方向：往左 / 往里 / 往北 */
  const DIRS = [
    [/往左|向左|左边|左侧|左移|左一点|往旁边|侧一点/, 'left'],
    [/往右|向右|右边|右侧|右移|右一点/, 'right'],
    [/往前|向前|前边|前移|前一点|向前挪/, 'front'],
    [/往后|向后|后边|后移|退后|后一点|退一点/, 'back'],
    [/往里|向里|向内|里面.?挪|深度方向/, 'in'],
    [/往外|向外|外侧|外面.?挪/, 'out'],
    [/往东|向东|朝东|东边移/, 'east'],
    [/往南|向南|朝南|南边移/, 'south'],
    [/往西|向西|朝西|西边移/, 'west'],
    [/往北|向北|朝北|北边移/, 'north']
  ];
  N.DIR_CN = {
    left: '左边', right: '右边', front: '前面', back: '后面', up: '上', down: '下',
    in: '往里', out: '往外', east: '东', south: '南', west: '西', north: '北'
  };
  function findDir(t) {
    for (const [re, k] of DIRS) if (re.test(t)) return k;
    return null;
  }
  N.findDir = findDir;

  /* 挪多远：一点 ≈ 0.3 米，半米、1.5 米、50 公分都认 */
  function findDist(t) {
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:米|m|公尺)/);
    if (m) return Math.min(8, Math.max(0.1, +m[1]));
    m = t.match(/(\d{2,3})\s*(?:公分|cm|厘米)/);
    if (m) return Math.min(8, Math.max(0.1, +m[1] / 100));
    if (/一点点|一点点儿|稍微挪/.test(t)) return 0.15;
    if (/一点半/.test(t)) return 0.45;
    if (/两?步|一截/.test(t)) return 0.8;
    if (/一点|一些|小移|挪一下|移一下|动一下/.test(t)) return 0.3;
    if (/半米/.test(t)) return 0.5;
    return null;
  }
  N.findDist = findDist;

  N.resolveRoom = function (floor, num) {
    if (num == null && floor == null) return { room: null };
    if (num != null) {
      if (floor != null) {
        let r = M.rooms.find(x => x.floor === floor && x.num === String(num));
        if (r) return { room: r };
        // 房号本身在全楼唯一时以房号为准：用户把"5 楼 505"说成"2 楼 505"，
        // 该去的是 505 而不是猜成 205。楼层说错了按房号纠正，别把设备放到别人房间。
        r = M.rooms.find(x => x.num === String(num));
        if (r) return { room: r, floorFix: r.floor !== floor, said: num };
        const last2 = String(num).padStart(3, '0').slice(-2);
        r = M.rooms.find(x => x.floor === floor && x.num === String(floor) + last2);
        if (r) return { room: r, guess: true, said: num };
        return { room: null, floor, num };
      }
      let r = M.rooms.find(x => x.num === String(num));
      if (r) return { room: r };
      // 由房号首位推断楼层
      const f = +String(num)[0];
      if (f >= 1 && f <= 5) {
        r = M.rooms.find(x => x.floor === f && x.num === String(num));
        if (r) return { room: r };
      }
      return { room: null, num };
    }
    return { room: null, floor };
  };

  /* ---------------- 语音同音字纠正 ----------------
     本机 vosk 小模型（42MB）会把"往左"听成"王座"、"风机盘管"听成"风其盘管"，
     这些词在运维口令里高频出现，听错一个整句就废了。这里按字面纠回来，
     打字输入不受影响（没人会把"王座"当别的意思）。
     另外把"一零一""三百零二"这种口语房间号转成数字。 */
  const ASR_FIX = [
    [/王座|往座|望座|网座|往作|网做|往昨/g, '往左'],
    [/网友|往友|网右|往又/g, '往右'],
    [/网综|网总|网宗|往总|网中|往中|网宗|往宗|往中着/g, '往东'],
    // 小模型常把"往东"吞成"中"：「把空调中挪半米」。只在"设备 + 中 + 挪/移"里改，
    // 免得把"往中间挪"这种正经说法也改坏
    [/往中(?=挪|移|走|点)/g, '往东'],
    [/(空调|机组|设备|空压机|它|这台|那台|刚才那台)中(?=挪|移|走)/g, '$1往东'],
    [/网难|网男|往难/g, '往南'],
    [/网北|往被|网被/g, '往北'],
    [/往里座|往里面走|往里坐/g, '往里'],
    [/往外座|网外/g, '往外'],
    // "挪"是运维口令里最常出现的动词，也最容易被听成同韵母的别的字：
    // 「往左檬一点」「往右蒙一点」。按后面的量词/方向词判断，不误伤"柠檬"这类词
    [/[檬蒙萌朦猛梦](?=一点|一些|一下|半米|一米|两米|米|过去|到|走|挪|移)/g, '挪'],
    [/(往[左右前后里外东南西北])[檬蒙萌朦猛梦]/g, '$1挪'],
    [/(设备|机组|空调|机柜|它|这个|这台)[檬蒙]/g, '$1挪'],
    [/俩台|两太|两台个/g, '两台'],
    [/风其|风奇|风齐|风起盘/g, '风机'],
    [/盘馆|盘观|盘官|盘灌/g, '盘管'],
    [/阀们|伐门|法门|阀mon/g, '阀门'],
    // "泵"是个冷字，各个引擎都会往常见的同音字上靠：「消防水浦」
    [/水浦|水铺|水仆|水普|水瀑|水埔/g, '水泵'],
    [/空掉|空条|空调机组|空调机/g, '空调'],
    [/靠抢|靠腔|靠墙边|考墙/g, '靠墙'],
    [/靠里坐|靠里厢/g, '靠里'],
    [/楼板板|楼版/g, '楼板'],
    [/一零一/g, '101'], [/一零二/g, '102'], [/一零三/g, '103'], [/一零四/g, '104'],
    [/二零一/g, '201'], [/二零二/g, '202'], [/二零三/g, '203'], [/二零四/g, '204'],
    [/三零一/g, '301'], [/三零二/g, '302'], [/三零三/g, '303'], [/三零四/g, '304'],
    [/四零一/g, '401'], [/四零二/g, '402'], [/四零三/g, '403'], [/四零四/g, '404']
  ];

  const CN_D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cnNum(s) {
    if (!/[百十]/.test(s)) {
      let d = '';
      for (const c of s) d += (CN_D[c] === undefined ? '' : CN_D[c]);
      return d ? +d : null;
    }
    let total = 0, cur = 0;
    for (const c of s) {
      if (c === '百') { total += (cur || 1) * 100; cur = 0; }
      else if (c === '十') { total += (cur || 1) * 10; cur = 0; }
      else if (CN_D[c] !== undefined) cur = CN_D[c];
    }
    return total + cur;
  }

  N.asrFix = function (s) {
    let t = String(s || '');
    if (!t) return t;
    for (const [re, to] of ASR_FIX) t = t.replace(re, to);
    // "左挪一点""左移" 漏了"往"字 → 补上（前面已经有"往"就不动）
    t = t.replace(/(^|[^往])([左右前后里外东南西北])(?=挪|移|走)/g, (m, p, d) => p + '往' + d);
    // 三百零二房间 / 二零一室 / 三零二号 → 数字
    t = t.replace(/([零一二两三四五六七八九十百]{2,6})(?=\s*(?:房间|室|号|房))/g, (m) => {
      const n = cnNum(m);
      return n == null ? m : String(n);
    });
    return t;
  };

  N.parse = function (raw) {
    const t = cn2num(norm(N.asrFix(raw)));
    const out = { raw: raw, intent: 'unknown', floor: null, roomNum: null };

    // 房间/楼层
    out.floor = findFloor(t);
    const rn = findRoom(t, out.floor);
    if (rn != null) {
      out.roomNum = rn;
      const r = N.resolveRoom(out.floor, rn);
      if (r.room) { out.room = r.room; out.floor = r.room.floor; out.guess = !!r.guess; out.said = r.said; out.floorFix = !!r.floorFix; }
    }
    // 特殊空间：只有没点名房间号时，"走廊/楼梯"才指这层的那一间
    // （"306 靠走廊的墙" 说的是方位，不是要把 306 换成走廊）
    if (!out.room) {
      if (/走廊|过道/.test(t) && out.floor) out.room = M.rooms.find(r => r.zone === 'corr' && r.floor === out.floor);
      if (/楼梯/.test(t) && out.floor) out.room = M.rooms.find(r => r.zone === 'core' && r.floor === out.floor);
    }

    // 意图（先剥掉"阀门"再判断门，避免误判）
    const tNoValve = t.replace(/阀门/g, '阀');
    const tNoWinPref = stripWinPref(tNoValve);
    const hasValve = /阀|管网|管路|管线|风管|通风|新风|送风|影响|波及|关掉|关闭|停掉/.test(t);
    const hasDoor = (/门|洞口/.test(tNoValve) && /开|打|凿|加|装|做|洞|留|放|位置|设/.test(tNoValve)) || /开洞|门洞|打洞/.test(tNoValve);
    const hasWindow = hasWin(tNoWinPref);
    const winMove = hasWinMove(tNoWinPref);        // 挪已有的窗（不是新开一扇）
    const hasPlace = /放|摆|安装|搬|移动|移到|搁|布置|安置|放到|装到/.test(t);
    // 问"旁边还有多少空间 / 离墙多远 / 够不够检修" → 量设备四周净距（并在模型上画虚框）
    // 注意别和"往旁边挪"抢：那是 move，已经在 hasMove 里判过了
    const hasClear = !/往.{0,3}(旁边|边上)/.test(t) && (
      /(旁边|周围|四周|边上|周边|附近|两侧|里侧|外侧|墙角).{0,8}(空间|多少|多大|多宽|多长|余量|净距|距离|够不)/.test(t)
      || /净距|检修(空间|距离|间距)|离(墙|柱|设备|柜子|墙边).{0,6}(多远|多少|几米|距离)/.test(t)
      || /(够不够|够不|能不能).{0,6}(检修|过人|走人|搬进来|进去)/.test(t)
      || /(旁边|周围|四周).{0,4}(还有|留|剩).{0,4}(多少|几米|多宽)/.test(t)
    );
    // 只是挪一下（不说"放到哪"）：往左一点 / 挪到墙角 / 移一下
    const hasMove = /挪|移动|移一下|移过去|挪过去|搬一下|往.{0,3}(左|右|前|后|里|外|东|南|西|北)|换个位置|换个地方/.test(t)
      && !/放到|摆到|装到|安装到|摆到/.test(t);

    if (winMove) out.intent = 'winmove';           // 挪窗优先于开窗：句子里已经带位移动作了
    else if (hasMove && !hasDoor && !hasWindow) out.intent = 'move';
    else if (hasWindow) out.intent = 'window';
    else if (hasValve && !hasDoor) out.intent = 'valve';
    else if (hasDoor) out.intent = 'door';
    else if (hasClear) out.intent = 'clearance';
    else if (hasPlace) out.intent = 'place';
    else if (/属性|信息|参数|详情|资料|这是啥|这是什么/.test(t)) out.intent = 'info';
    else if (/复位|全览|整体|全楼|总览|回到|鸟瞰/.test(t)) out.intent = 'view';
    else if (/帮助|能做什么|怎么用|会什么/.test(t)) out.intent = 'help';

    if (out.intent === 'window') {
      applySide(out, findSide(t));
      // "靠窗"对设备是方位，对窗本身就是"优先临窗那面"，所以从原句里取
      out.pref = findPref(t);
      const ws = winSize(t);
      out.width = ws.w ? clampN(ws.w, .5, 6) : 1.5;
      out.winH = ws.h ? clampN(ws.h, .5, 3.2) : 1.5;
      out.sill = ws.sill != null ? clampN(ws.sill, .2, 1.8) : .9;
      out.winKind = /落地/.test(t) ? 'floor' : (/飘窗/.test(t) ? 'bay' : 'normal');
      if (out.winKind === 'floor') { out.sill = 0.12; out.winH = Math.min(2.6, out.winH < 1.6 ? 2.4 : out.winH); }
    }

    if (out.intent === 'move') {
      out.dir = findDir(t);
      out.dist = findDist(t);
      out.pref = findPref(t.replace(/往(里|外)/g, ''));   // "往里挪"是方向，"靠里"才是方位
    }

    if (out.intent === 'winmove') {
      // 上下 = 抬降窗台；左右/前后 = 沿墙滑；"墙中间" = 滑到本段中点。
      // 方向词都按当前镜头换算，换算交给执行层（dirVec → S.viewAxes）
      out.dir = /墙中间|墙中心|居中|正中间/.test(t) ? 'center'
        : (WIN_UP.test(t) ? 'up' : (WIN_DOWN.test(t) ? 'down' : findDir(t)));
      out.dist = findDist(t);
    }

    if (out.intent === 'valve') {
      out.valveAction = /打开|开启|恢复|开阀/.test(t) && !/关闭|关掉|关上|断开|停掉/.test(t) ? 'open' : 'close';
    }
    if (out.intent === 'door') {
      applySide(out, findSide(t));
      out.pref = findPref(t);
      out.width = findWidth(t) || 1.0;
      out.doorH = findHeight(t) || 2.1;
      if (out.width) out.width = Math.min(3.0, Math.max(0.5, out.width));
      if (out.doorH) out.doorH = Math.min(4.0, Math.max(1.5, out.doorH));
    }
    if (out.intent === 'place') {
      const d = findDevice(t);
      if (d) out.device = d;
      const wgt = findWeight(t);
      if (wgt) out.weight = wgt;
      applySide(out, findSide(t));
      out.pref = findPref(t);
    }
    if (out.intent === 'info') applySide(out, findSide(t));
    return out;
  };

  /* findSide 给的是 {side, rel}：rel 交给 app 层按相机换算成墙面 */
  function applySide(out, sd) {
    if (!sd) return;
    if (sd.side) out.side = sd.side;
    if (sd.rel) out.sideRel = sd.rel;
  }

  /* 语音播报前去掉符号 */
  N.speakable = function (s) {
    return String(s).replace(/[（）()「」【】“”"']/g, '').replace(/[、，]/g, '，').replace(/\s+/g, ' ').trim();
  };
})();
