/* AIbim 运维系统 —— 交互主控 */
(function () {
  let M = window.BIM_MODEL;
  const S = window.BIM.scene;
  const C = window.BIM.calc;
  const N = window.BIM.nlp;
  const RT = () => window.BIM.routes;

  const $ = id => document.getElementById(id);
  const chat = $('chat');

  const ST = {
    mode: 'idle', pending: null, device: null, placed: [],
    last: null, sound: false, ducts: true, xray: false, focus: 0, equipId: 1, quiet: false, sel: null,
    flowOn: false,       // 流向是否正在展示（只在看阀门影响时亮）
    doorAsked: {},       // 哪几间房已经问过「要不要拓门」，别一台一台重复问
    lastUndone: null     // 刚撤掉的那扇门（墙上位置 + 尺寸），"再点回来"时按它开回去
  };
  /* 已放设备要能被计算层读到：拆墙打通以后，隔壁那台设备也压在同一块板上，
     楼板校核必须把联通块里的设备一起叠加（calc.js 的 C.check 会从这里取）。 */
  window.BIM = window.BIM || {};
  window.BIM.state = ST;

  /* 模型树是"场景的一份视图"：设备增删改之后重建一次，树上马上能看见 */
  function refreshTree() {
    const T = window.BIM.tree;
    if (T && T.rebuild) T.rebuild();
  }

  /* 把碰撞清单里的东西统一描红：构件去 reg 里找网格，家具用落位矩形 */
  function markClash(ob) {
    if (!ob || !ob.hits || !ob.hits.length) return false;
    return !!S.markConflicts(ob.hits.map(h => (h.kind === 'box' ? { box: h.box } : { kind: h.kind, data: h.data })), 0xdd534f);
  }

  /* 同房间、同楼层的已有设备。打通以后"同一间"要按连通大板算 ——
     合并空间上带着 ids（板上有哪几间）时，把那几台设备都算进来。 */
  function othersIn(room) {
    const ids = (room && room.ids) || (room ? [room.id] : []);
    return ST.placed.filter(e => ids.indexOf(e.room) >= 0 && e.floor === room.floor);
  }

  /* 打通以后的"房间"：两块小板已经被中间那道墙连成一块大板，放设备时
     可用的范围、默认的位置都该按合并后的板算，而不是还缩在原来那一间里。
     用户原话："打通房间的时候如果后面在打通的房间内放置设备，应该默认放到两个打通的房间中间"。 */
  function spaceOf(room) {
    const pl = (window.BIM.calc && room) ? window.BIM.calc.plateOf(room) : null;
    if (!pl || !pl.merged) return { space: room, plate: null };
    const sp = Object.assign({}, room, {
      x0: pl.x0, x1: pl.x1, y0: pl.y0, y1: pl.y1,
      ids: pl.ids.slice(), plate: pl, merged: true
    });
    return { space: sp, plate: pl };
  }
  /* 合并空间里的一个点属于哪一间真房间（落位要记在真房间上，不能记在合成房间上） */
  function roomAt(space, x, y) {
    if (!space || !space.merged) return space;
    const rs = (space.plate && space.plate.rooms) || [];
    return rs.find(r => x >= r.x0 - 0.25 && x <= r.x1 + 0.25 && y >= r.y0 - 0.25 && y <= r.y1 + 0.25) || space;
  }
  /* 自检用：把"打通后这块板 + 当前视角方向 → 落位点"这条链拆开给回归脚本看。
     只读，不改场景 —— 回归要断言"说了左边就落左边"，不能只看截图。 */
  window.BIM.placeDbg = {
    space: room => spaceOf(room).space,
    seed: (room, side, rel) => seedForSide(room, side, rel),
    spot: (room, dev, pref, side, rel) => {
      const sp = spaceOf(room).space;
      const seed = seedForSide(sp, side, rel);
      const r = bestSpotFor(sp, dev, pref, seed, !!seed);
      return {
        seed: seed, merged: !!sp.merged,
        spot: r ? { x: +r.x.toFixed(2), y: +r.y.toFixed(2), exact: r.exact, pass: r.ob ? !!r.ob.pass : null } : null
      };
    }
  };

  /* 自检用（门窗）：把"用户点在哪 → 洞口怎么定 → 撤门退回什么"这条链拆给回归看。
     openAt 走的是和鼠标点选完全同一套 holeDecision（noMove=true，点了就不许自己挪），
     只是省掉了射线求交那一步 —— 回归里没法真的去点像素。 */
  window.BIM.doorDbg = {
    last: () => (ST.lastDoor && ST.lastDoor.d) || null,
    undo: d => undoDoor(d || (ST.lastDoor && ST.lastDoor.d), true),
    /* 红色标记到底画的是"整根管"还是"洞口两侧的断头" —— 回归要能量出来，
       光看截图数不出来（这也是上一轮"看着还是没修好"的坑）。 */
    stubs: (wall, hits, hole) => cutStubs(wall, hits, hole),
    openAt: (room, side, at, w, h) => {
      if (!room) return null;
      const wall = M.walls.find(x => x.id === (room.sides || {})[side]);
      if (!wall) return { ok: false, why: '没有这面墙' };
      if (wall.kind === 'ext') return { ok: false, why: '外墙不开门', ext: true };
      const W = w || 1.0, H = h || 2.1;
      const eqs = ST.placed.filter(e => e.floor === wall.floor);
      const dec = holeDecision(wall, { at: at, w: W, h: H, sill: 0, room: room, equipments: eqs, kind: 'door', noMove: true });
      if (!dec.ok) return { ok: false, why: dec.why, blocks: (dec.blocks || []).map(b => b.t) };
      const ids = [];
      const n = dec.needReroute ? applyReroutes(dec, ids) : 0;
      const d = S.addDoorOpening(wall, dec.at, W, H);
      d.room = room.id;
      if (ids.length) d._reroutes = ids;
      syncElecAfterDoor();
      ST.lastDoor = { wall: wall, at: dec.at, w: W, d: d, chk: dec.chk, room: room };
      /* 和鼠标点选完全一样地摆出那一屏（红断头 / 绿改线 / 半透明墙），
         否则回归里看到的画面和用户看到的不一样。 */
      if ((dec.hits && dec.hits.length) || dec.moved) showHoleConflict(wall, dec.hits, dec.reroutes);
      return { ok: true, id: d.id, code: d.code, at: +dec.at.toFixed(2), rerouted: n, moved: !!dec.moved };
    }
  };

  /* ---------------- 消息 ---------------- */
  function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
    // 气泡有入场动画/图片异步高度，稍后再兜一次
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
    clearTimeout(scrollBottom._t);
    scrollBottom._t = setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 160);
  }

  let lastSay = '';        // 最后一条 AI 原话，多步任务收敛时补一次播报
  let lastHtml = '', sayBuf = [];
  let lastData = null;     // 结构化结果（工具层回给大模型用）
  let loopQuiet = false;   // Agent 循环执行中：工具产生的中间话先攒着，最后统一说
  let toolSteps = [];      // 这一轮模型实际调了哪几个工具（诊断/回归用）
  /* ST.mute：执行工具链时先把要说的话攒起来，最后一句话统一说，避免一句指令冒两三条回复 */
  function ai(text, html, speak) {
    lastSay = text.replace(/<[^>]+>/g, '');
    lastHtml = html || '';
    if (ST.mute) { if (lastSay) sayBuf.push(lastSay); return null; }
    const d = document.createElement('div');
    d.className = 'msg ai';
    d.innerHTML = '<div class="av">AI</div><div class="body"><p>' + text + '</p>' + (html || '') + '</div>';
    chat.appendChild(d);
    scrollBottom();
    paintCtx();
    if (ST.sound && speak !== false && !ST.quiet) TTS.say(lastSay);
    return d;
  }
  function me(text) {
    const d = document.createElement('div');
    d.className = 'msg me';
    d.innerHTML = '<div class="body"><p>' + esc(text) + '</p></div>';
    chat.appendChild(d);
    scrollBottom();
  }
  function sys(text) {
    const d = document.createElement('div');
    d.className = 'msg sys';
    d.innerHTML = '<span>' + esc(text) + '</span>';
    chat.appendChild(d);
    scrollBottom();
  }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  let chipQ = [];       // 执行期间攒下的选择卡，等最终回复出来再一起弹
  function chips(list) {
    if (!list || !list.length) return;
    if (ST.mute) { chipQ.push(list); return; }   // 执行中先排着，别插在半截话里
    const w = document.createElement('div');
    w.className = 'chips';
    list.forEach(c => {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.onclick = () => { c.fn(); };
      w.appendChild(b);
    });
    chat.appendChild(w);
    scrollBottom();
  }
  function flushChips() {
    const q = chipQ; chipQ = [];
    q.forEach(l => chips(l));
  }

  function toast(txt, ms) {
    const t = $('toast');
    t.textContent = txt;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  /* ---------------- 语音 ---------------- */
  const TTS = {
    // 默认不播报：播报期间要把麦克风闭住（不然会把 AI 自己的声音当成用户说话），
    // 一段长回复念十几秒，用户就得干等十几秒才能说下一句。默认关掉，需要时点顶栏那个喇叭。
    on: false, voice: null,
    init() {
      if (!window.speechSynthesis) return;
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find(v => /zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Huihui|Yaoyao|Tingting|female/i.test(v.name))
          || vs.find(v => /zh/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    },
    say(text) {
      if (!this.on || !window.speechSynthesis) return;
      try {
        speechSynthesis.cancel();
        // 播报时先收麦，免得把 AI 自己的声音再收进去
        const wasLive = listening;
        if (wasLive) { hush = true; try { rec && rec.stop(); } catch (e) { } }
        // 播报期间的闭麦时长要卡死上限：原来按字数算能到 12 秒，
        // 一句话说完麦克风半天不回魂，用户会以为语音坏了。
        ttsUntil = Date.now() + Math.min(6000, 1400 + text.length * 130);
        const u = new SpeechSynthesisUtterance(N.speakable(text).slice(0, 120));
        u.lang = 'zh-CN'; u.rate = 1.06; u.pitch = 1.02;
        if (this.voice) u.voice = this.voice;
        const back = () => {
          hush = false;
          hushUntil = Date.now() + 250;      // 播报有回声尾，稍等一下再收
          if (wasLive && listening && rec) { try { rec.start(); } catch (e) { } }
        };
        u.onend = back; u.onerror = back;
        speechSynthesis.speak(u);
        if (wasLive) setTimeout(back, Math.min(5000, 1800 + text.length * 140));
      } catch (e) { }
    },
    stop() { if (window.speechSynthesis) speechSynthesis.cancel(); }
  };

  /* ---------------- 语音识别：授权一次，之后免打扰 ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false, hush = false;
  let micState = 'unknown';        // granted | denied | prompt | unsupported
  const LS_MIC = 'aibim.mic.v1';
  const micPref = { auto: true, deniedHint: false };
  try { Object.assign(micPref, JSON.parse(localStorage.getItem(LS_MIC) || '{}')); } catch (e) { }
  const saveMicPref = () => { try { localStorage.setItem(LS_MIC, JSON.stringify(micPref)); } catch (e) { } };

  /* 麦克风小圆点：绿=已授权可随时说话，灰=未授权，红=被拒 */
  function paintMic() {
    const b = $('btnMic');
    if (!b) return;
    b.classList.toggle('granted', micState === 'granted');
    b.classList.toggle('denied', micState === 'denied');
    b.title = micState === 'granted' ? '麦克风已授权，直接说就行'
      : micState === 'denied' ? '麦克风被浏览器拦了，点开看怎么恢复'
        : '点击开始语音对话';
  }

  async function micPermission() {
    // 本机离线识别只要 mediaDevices 就行，不依赖 SpeechRecognition
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micState = 'unsupported'; paintMic(); return micState;
    }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'microphone' });
        micState = st.state;                     // granted / denied / prompt
        st.onchange = () => {
          micState = st.state; paintMic();
          if (micState === 'granted') { micPref.deniedHint = false; saveMicPref(); autoStart(); }
        };
        paintMic();
        return micState;
      }
    } catch (e) { /* Safari 不支持查询 microphone */ }
    micState = 'unknown'; paintMic();
    return micState;
  }

  /* 只申请一次：拿到常驻授权后，浏览器不会再弹第二次 */
  async function ensureMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    if (micState === 'granted') return true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());      // 拿到授权就关掉，不占用麦克风
      micState = 'granted';
      micPref.deniedHint = false; saveMicPref(); paintMic();
      return true;
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        micState = 'denied';
        if (!micPref.deniedHint) {
          micPref.deniedHint = true; saveMicPref();
          toast('麦克风被拦了：地址栏左侧的锁 → 网站设置 → 麦克风 → 允许，只设一次', 6000);
        }
      }
      paintMic();
      return false;
    }
  }

  /* 两条识别通道，自动挑：
     local —— 本机 vosk（后端 /asr/*），不联网，内网断网都能用；
     web   —— 浏览器自带 SpeechRecognition，要靠 Google/微软的云服务。
     两条路都按"说完停顿 1.4 秒"结算，不会挂在那儿一直听。 */
  const SILENCE = 1400;
  let voiceTimer = null, voiceHintTimer = null;
  let textAt = 0;                      // 最近一次听到文字的时间（噪声大时用来兜底结算）
  let asrMode = 'probe';                 // probe | local | web | off
  let asrInfo = null;
  let asrBroken = false;                 // 语音服务整体不可用，别死循环重连
  let micStream = null, audioCtx = null, meterSrc = null, analyser = null, meterRaf = 0, meterData = null;
  let procNode = null, resampler = null, pumpTimer = 0;
  let pcmQ = [], pcmBytes = 0, asrChain = Promise.resolve();
  let asrSid = '', asrText = '', heardAny = false, asrClosing = false, lastVoice = '';
  let hushUntil = 0, ttsUntil = 0;

  /* 现在该不该把麦克风的声音喂给识别：
     播报中 / 刚播完的回声尾 / 正在收尾，都要闭麦，否则会把 AI 自己的声音当成用户说的话。
     播报时长按字数估一个上限，超了就强制解禁——有的浏览器没有中文发音人，
     speak() 之后 speaking 会一直挂着 true，不设上限麦克风就永远醒不过来。 */
  function audioGag() {
    if (hush || Date.now() < hushUntil) return true;
    const ss = window.speechSynthesis;
    if (ss && ss.speaking) {
      if (Date.now() < ttsUntil) return true;
      try { ss.cancel(); } catch (e) { }      // 卡死的播报：掐掉，把麦还回来
      hushUntil = Date.now() + 300;
      return true;
    }
    return false;
  }

  function listenState(txt) {
    const b = document.getElementById('listenState');
    if (b) b.textContent = txt;
  }

  let previewTxt = '';
  function voicePreview(t) {
    const el = $('listenTxt');
    if (el) el.textContent = t;
    const box = $('txt');
    // 同步到输入框，但别把用户正在打的内容顶掉
    if (box && t && (box.value === '' || box.value === previewTxt)) box.value = t;
    previewTxt = t;
    if (!t) previewTxt = '';
  }

  /* 问一下本机后端有没有离线识别能力；没有就退回浏览器识别 */
  function probeAsr() {
    if (window.__forceAsr) { asrMode = window.__forceAsr; return Promise.resolve(asrMode); }
    return new Promise(resolve => {
      let done = false;
      const fin = mode => { if (!done) { done = true; asrMode = mode; resolve(mode); } };
      const fallback = () => fin(SR ? 'web' : 'off');
      const ctl = window.AbortController ? new AbortController() : null;
      const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) { } fallback(); }, 1600);
      fetch('/asr/health', ctl ? { signal: ctl.signal } : {})
        .then(r => r.json())
        .then(j => {
          clearTimeout(timer);
          asrInfo = j || null;
          if (j && j.ok) {
            fin('local');
            fetch('/asr/warm').catch(() => { });        // 后台把模型热起来，第一句话不用等
          } else fallback();
        })
        .catch(() => { clearTimeout(timer); fallback(); });
    });
  }

  /* ---------- 采集：麦克风 → 16k 单声道 PCM ---------- */
  function toI16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function makeResampler(from, to) {
    const step = from / to;
    let pos = 0, tail = new Float32Array(0);
    return function (input) {
      let data = input;
      if (tail.length) {
        data = new Float32Array(tail.length + input.length);
        data.set(tail); data.set(input, tail.length);
      }
      const n = Math.max(0, Math.ceil((data.length - 1 - pos) / step));
      const out = new Float32Array(n);
      let p = pos;
      for (let i = 0; i < n; i++) {
        const k = Math.floor(p), f = p - k;
        out[i] = data[k] * (1 - f) + data[k + 1] * f;
        p += step;
      }
      const keep = Math.min(Math.floor(p), data.length);
      tail = data.slice(keep);
      pos = p - keep;
      return out;
    };
  }

  function paintLevel(rms) {
    const bar = $('listenBar');
    if (!bar) return;
    const lv = Math.min(1, rms * 6);
    bar.style.setProperty('--lv', lv.toFixed(2));
    bar.classList.toggle('hot', lv > 0.08);
  }

  /* feed=true 时同时把音频喂给识别（离线通道才需要） */
  async function openMic(feed) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
      }
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { audioCtx = new AC({ sampleRate: 16000 }); } catch (e) { audioCtx = new AC(); }
      }
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) { } }
      if (!meterSrc) meterSrc = audioCtx.createMediaStreamSource(micStream);
      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        meterSrc.connect(analyser);
        meterData = new Uint8Array(analyser.fftSize);
      }
      if (feed && !procNode) {
        // 浏览器不保证给到 16k，不是就自己降采样
        resampler = audioCtx.sampleRate === 16000 ? null : makeResampler(audioCtx.sampleRate, 16000);
        procNode = audioCtx.createScriptProcessor(2048, 1, 1);
        procNode.onaudioprocess = e => onAudio(e.inputBuffer.getChannelData(0));
        meterSrc.connect(procNode);
        const sink = audioCtx.createGain();
        sink.gain.value = 0;               // 不接到 destination 有些浏览器不跑回调
        procNode.connect(sink); sink.connect(audioCtx.destination);
      }
      if (feed && !pumpTimer) pumpTimer = setInterval(pump, 200);
      if (!meterRaf) {
        const tick = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(meterData);
          let sum = 0;
          for (let i = 0; i < meterData.length; i++) {
            const v = (meterData[i] - 128) / 128;
            sum += v * v;
          }
          paintLevel(Math.sqrt(sum / meterData.length));
          meterRaf = requestAnimationFrame(tick);
        };
        meterRaf = requestAnimationFrame(tick);
      }
      return true;
    } catch (e) { return false; }
  }

  function closeMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = 0;
    if (procNode) {
      try { procNode.disconnect(); } catch (e) { }
      procNode.onaudioprocess = null;
      procNode = null;
    }
    resampler = null;
    pcmQ = []; pcmBytes = 0;
    try { if (meterSrc) meterSrc.disconnect(); } catch (e) { }
    meterSrc = null; analyser = null;
    // 不听了就把麦克风让出来，浏览器地址栏的小红点也跟着消失
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    const bar = $('listenBar');
    if (bar) { bar.style.setProperty('--lv', '0'); bar.classList.remove('hot'); }
  }

  /* ---------- 离线识别：边说边传，边说边出字 ---------- */
  function asrPost(path, body, sid) {
    const s = sid === undefined ? asrSid : sid;
    const url = path + (s ? '?sid=' + encodeURIComponent(s) : '');
    asrChain = asrChain.then(() => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body || new Uint8Array(0)
    }).then(r => r.json()).catch(() => ({})));
    return asrChain;
  }

  async function asrOpen() {
    try {
      const r = await fetch('/asr/start', { method: 'POST' });
      const j = await r.json();
      if (!j || !j.ok) return false;
      asrSid = j.sid; asrText = ''; heardAny = false; asrClosing = false;
      pcmQ = []; pcmBytes = 0;
      return true;
    } catch (e) { return false; }
  }

  function takePcm() {
    if (!pcmQ.length) return null;
    const buf = new Uint8Array(pcmBytes);
    let o = 0;
    pcmQ.forEach(p => { buf.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += p.byteLength; });
    pcmQ = []; pcmBytes = 0;
    return buf;
  }

  function flushPcm(final) {
    if (asrClosing && !final) return Promise.resolve({});   // 已经在收尾，别再往里灌
    if (!asrSid) return Promise.resolve({});                // 还没开会话，音频先留着
    const buf = takePcm();
    if (!buf && !final) return Promise.resolve({});
    if (final) { asrClosing = true; pcmQ = []; pcmBytes = 0; }
    return asrPost(final ? '/asr/final' : '/asr/chunk', buf || undefined).then(j => {
      j = j || {};
      if (j.text) asrText = j.text;
      const shown = ((asrText || '') + (j.partial || '')).trim();
      if (!final && shown) { voicePreview(shown); listenState('听到了'); }
      if (final) {
        const t = String(j.text || asrText || '').trim();
        asrSid = ''; asrText = '';
        if (t) commitVoice(t);
        else listenState('没听清');
      } else if (pcmBytes >= 16000 * 2 * 0.3) {
        flushPcm(false);                  // 说话时还有积压，接着传
      }
      return j;
    });
  }

  /* 每一块音频只负责攒数据；什么时候发、有没有人在说，交给 pump 定时判断。
     不依赖 onaudioprocess 的回调节奏（后台标签页、无头浏览器里它会被节流）。 */
  function onAudio(f32) {
    if (asrMode !== 'local' || !listening || asrClosing || audioGag()) return;
    const out = resampler ? resampler(f32) : toI16(f32);
    if (!out.length) return;
    pcmQ.push(out);
    pcmBytes += out.byteLength;
    if (pcmBytes > 16000 * 2 * 30) {          // 说了 30 秒还没结算：丢掉最老的，别涨爆内存
      pcmQ.shift(); pcmBytes = 0;
      pcmQ.forEach(p => { pcmBytes += p.byteLength; });
    }
  }

  /* 200ms 一拍：看电平（判断有没有人在说）+ 把攒的音频送出去 */
  function pump() {
    if (asrMode !== 'local' || !listening) return;
    if (analyser && meterData && !audioGag() && !busy) {
      analyser.getByteTimeDomainData(meterData);
      let sum = 0;
      for (let i = 0; i < meterData.length; i++) {
        const v = (meterData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / meterData.length);
      if (rms > 0.014) {
        heardAny = true;
        clearTimeout(voiceHintTimer);
        if (listening) listenState('听到了');
        // 有声音就顺延，停 1.4 秒才结算；但环境噪声一直超标时不能无限续期，
        // 听到文字超过 4.2 秒没有新内容就按现有的收尾
        if (!voiceTimer || !textAt || Date.now() - textAt < 4200) armVoice(SILENCE);
      }
    }
    if (pcmBytes && !asrClosing) flushPcm(false);
  }

  function finishLocal() {
    clearTimeout(voiceTimer);
    if (!asrSid || asrClosing) { listenState('没听清'); return; }
    listenState('收尾中…');
    flushPcm(true).then(() => {
      asrClosing = false;
      if (listening) { listenState('我在听'); asrOpen(); }
    });
  }

  function initSR() {
    if (!SR) return null;
    const r = new SR();
    r.lang = 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      setListening(true);
      asrBroken = false;
      listenState('我在听');
      if (micState !== 'granted') { micState = 'granted'; paintMic(); }
    };

    r.onresult = e => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      heardAny = true;
      clearTimeout(voiceHintTimer);
      const shown = (final + interim).trim();
      if (shown) {
        listenState('听到了');
        voicePreview(shown);
        textAt = Date.now();
      }
      if (final.trim()) {
        commitVoice(final.trim());
      } else if (interim.trim()) {
        armVoice(SILENCE);               // 只有中间结果也别一直等
      }
    };

    r.onerror = e => {
      const err = e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        listening = false; setListening(false);
        if (micState !== 'granted') {
          micState = 'denied'; paintMic();
          if (!micPref.deniedHint) {
            micPref.deniedHint = true; saveMicPref();
            toast('麦克风被拦了：地址栏左侧的锁 → 网站设置 → 麦克风 → 允许', 6000);
          }
        }
      } else if (err === 'network') {
        // 浏览器语音服务在部分网络下连不上：换成说清楚 + 自动找本机离线识别
        asrBroken = true;
        listening = false; setListening(false);
        micPref.auto = false; saveMicPref();
        sys('浏览器的语音服务连不上（这个网络访问不到 Google/微软的识别接口）。正在改走本机离线识别，稍等两秒再点麦克风。');
        probeAsr().then(m => {
          if (m === 'local') {
            asrBroken = false;
            toast('已切到本机离线识别，再点一下麦克风就能说话');
          }
        });
      } else if (err === 'no-speech') {
        listenState('没声音');
      } else if (err === 'aborted') {
        /* 收麦时正常出现的，忽略 */
      }
    };

    r.onend = () => {
      clearTimeout(voiceHintTimer);
      if (listening && !hush && !asrBroken) {
        // 引擎会自己断，隔一下再接上，太急会抛 InvalidStateError
        setTimeout(() => {
          if (listening && !hush && !asrBroken) {
            try { r.start(); listenState('我在听'); } catch (e) { }
          }
        }, 260);
      } else if (!listening) {
        setListening(false);
      }
    };
    return r;
  }

  /* 静音计时：说完停顿 1.4 秒就收尾发出去 */
  function armVoice(ms) {
    clearTimeout(voiceTimer);
    voiceTimer = setTimeout(() => {
      if (asrMode === 'local') {
        if (!heardAny) return;
        const lt = ($('txt').value || '').trim();
        if (asrSid) {
          finishLocal();
          // 本机识别万一没吐出结果（会话空转），别把用户说的这句丢掉
          if (lt) setTimeout(() => {
            if ((($('txt').value) || '').trim() === lt) commitVoice(lt);
          }, 1000);
          return;
        }
        if (lt) commitVoice(lt);
        return;
      }
      const t = ($('txt').value || '').trim();
      if (t) commitVoice(t);
    }, ms || SILENCE);
  }

  function commitVoice(text) {
    clearTimeout(voiceTimer);
    clearTimeout(voiceHintTimer);
    let t = String(text || '').trim();
    if (t && window.BIM.nlp && N.asrFix) t = N.asrFix(t);   // 同音字纠回来（往左/风机盘管…）
    if (!t) { listenState('没听清'); return false; }
    if (busy) {                       // 上一条还在处理：先把话留在输入框里
      $('txt').value = t;
      toast('上一条还在处理，这话先放输入框里了');
      return false;
    }
    $('txt').value = '';
    voicePreview('');
    listenState('我在听');
    lastVoice = t;
    send(t, true);
    return true;
  }

  /* 用户点"说完"：立刻结算，不再等静音 */
  function finishVoice() {
    if (asrMode === 'local' && asrSid) { finishLocal(); return; }
    const t = ($('txt').value || '').trim();
    if (t) { commitVoice(t); return; }
    listenState('没听清');
    toast('还没听到内容，再说一遍或者直接打字');
  }

  function setListening(on) {
    const b = $('btnMic');
    if (b) b.classList.toggle('on', on);
    const bar = $('listenBar');
    if (bar) bar.hidden = !on;
    if (!on) {
      clearTimeout(voiceTimer); clearTimeout(voiceHintTimer);
      const el = $('listenTxt');
      if (el) el.textContent = '';
      previewTxt = '';
      closeMeter();
    }
  }

  async function startListening(silent) {
    if (listening) return true;
    if (asrMode === 'probe') await probeAsr();
    if (asrMode === 'off') {
      if (!silent) toast('这个浏览器没有可用的语音通道，用键盘输入吧');
      return false;
    }
    hush = false;
    listening = true;
    setListening(true);                     // 先给反馈，识别引擎慢半拍也不像卡住
    listenState('我在听');
    heardAny = false;
    clearTimeout(voiceHintTimer);
    voiceHintTimer = setTimeout(() => {
      if (listening && !heardAny) {
        listenState('没收到声音');
        toast('还没听到说话：先看波形有没有动（动了说明麦克风正常），再大声说一遍', 4200);
      }
    }, 9000);

    if (asrMode === 'local') {
      const opened = await asrOpen();
      const got = await openMic(true);
      if (!opened || !got) {
        // 本机识别起不来就退回浏览器识别，别让用户发现"开了没反应"
        listening = false;
        clearTimeout(voiceHintTimer);
        if (SR) { asrMode = 'web'; return startListening(silent); }
        setListening(false);
        asrBroken = true;
        if (!silent) toast('本机识别没起来：确认是 python tools/serve.py 起的页面');
        return false;
      }
    } else {
      if (!rec) rec = initSR();
      openMic(false);                       // 只要电平
      try { rec.start(); } catch (e) {
        listening = false; setListening(false);
        if (!silent) toast('麦克风还没准备好，再点一下');
        return false;
      }
    }
    TTS.stop();
    if (!silent) {
      toast(asrMode === 'local'
        ? '我在听（本机识别，不联网），说完停一下就发出去'
        : '我在听，说完停一下自动发出去');
    }
    return true;
  }

  function stopListening() {
    listening = false;
    if (asrSid) { asrPost('/asr/cancel', new Uint8Array(0), asrSid); asrSid = ''; }
    try { rec && rec.stop(); } catch (e) { }
    setListening(false);
    TTS.stop();
  }

  /* 已授权就自动开麦，用户什么都不用点 */
  async function autoStart() {
    if (!micPref.auto || listening || asrBroken) return;
    const st = await micPermission();
    if (st === 'granted') startListening(true);
  }

  async function toggleMic() {
    if (listening) { stopListening(); return; }
    if (asrMode === 'probe') await probeAsr();
    if (asrMode === 'off') { toast('这个浏览器没有可用的语音通道，用键盘输入吧'); return; }
    // 只在第一次真正申请权限，之后走缓存状态
    const ok = await ensureMic();
    if (!ok) {
      if (micState === 'denied') {
        toast('麦克风被拦了：地址栏左侧的锁 → 网站设置 → 麦克风 → 允许，只设一次', 6000);
      }
      return;
    }
    startListening(false);
  }

  /* ---------------- 大模型设置 ---------------- */
  function aiForm() {
    const cfg = window.BIM.agent.cfg;
    $('llmEp').value = cfg.endpoint || '';
    $('llmModel').value = cfg.model || '';
    $('llmKey').value = cfg.key || '';
    $('llmTo').value = cfg.timeout || 12000;
  }
  function readAIForm() {
    return {
      endpoint: window.BIM.agent.normEndpoint($('llmEp').value),
      model: $('llmModel').value.trim(),
      key: $('llmKey').value.trim(),
      timeout: Math.max(3000, +$('llmTo').value || 12000)
    };
  }
  /* 把诊断摊开给用户看：实际请求的地址、状态码、对方原话、怎么修 */
  /* 面板里把工具摊开：用户能看见 AI 究竟能对这个模型做什么 */
  function paintTools() {
    const list = $('toolList'), cnt = $('toolCount');
    const T = window.BIM.mcp;
    if (!list || !T) return;
    const tools = T.tools || [];
    if (cnt) cnt.textContent = tools.length + ' 个';
    const cn = {
      place_equipment: '放设备', remove_equipment: '撤设备', move_equipment: '挪设备',
      replace_equipment: '换设备', resize_equipment: '改尺寸', query_equipment: '查设备',
      list_devices: '列设备', suggest_positions: '给建议位', show_properties: '看属性', query_capacity: '算余量',
      open_door: '开门', remove_door: '拆门', move_door: '挪门',
      resize_door: '改门尺寸', query_door: '查门', list_doors: '列门',
      open_window: '开窗', remove_window: '拆窗', move_window: '挪窗',
      focus_view: '聚焦看图', show_all: '显示全部', set_view: '切楼层', list_scene: '读场景',
      focus_floor: '整体聚焦', view_circuit: '看回路走向', show_conduits: '看管线',
      toggle_valve: '开关阀门', query_impact: '查阀影响', undo_last: '撤回一步'
    };
    list.innerHTML = tools.map(t => {
      const f = t.function;
      const args = Object.keys((f.parameters && f.parameters.properties) || {});
      return '<div class="p-tool"><i>' + (cn[f.name] || f.name) + '</i><code>' + f.name + '</code>' +
        (args.length ? '<s>' + args.slice(0, 4).join(' / ') + '</s>' : '') + '</div>';
    }).join('');
  }

  function showDiag(d) {
    const el = $('llmDiag');
    if (!el) return;
    if (!d) { el.hidden = true; el.textContent = ''; return; }
    const L = [];
    if (d.url) L.push('POST ' + d.url);
    if (d.status) L.push('HTTP ' + d.status + (d.ms != null ? ' · ' + d.ms + ' ms' : ''));
    else if (d.ms != null) L.push(d.ms + ' ms');
    if (d.ok && d.reply) L.push('模型回了：' + d.reply);
    if (d.err) {
      // 状态行已经写过"HTTP xxx"，这里只留原因，别重复
      const head = d.status ? ('HTTP ' + d.status) : '';
      let e = String(d.err);
      if (head && e.indexOf(head) === 0) e = e.slice(head.length).replace(/^\s*·\s*/, '');
      if (e) L.push('原因：' + e);
    }
    if (d.note) L.push('已自动处理：' + d.note);
    if (d.hint && d.hint !== d.err && d.err.indexOf(d.hint) < 0) L.push('怎么修：' + d.hint);
    if (!d.ok && d.body) L.push('对方原话：' + d.body);
    el.textContent = L.join('\n') || '没有可显示的信息';
    el.className = 'p-diag ' + (d.ok ? 'ok' : 'bad');
    el.hidden = false;
  }
  /* 状态小灯：绿=大模型在理解，黄=连不上走本地，灰=本来就用本地 */
  function paintAI() {
    const chip = $('btnAI');
    if (!chip) return;
    const A = window.BIM.agent, st = A.status();
    chip.classList.toggle('llm', st.k === 'llm');
    chip.classList.toggle('bad', st.k === 'bad');
    $('aiTxt').textContent = st.t;
    chip.title = st.k === 'llm' ? '大模型在理解你的话'
      : st.k === 'bad' ? '大模型没连上（' + (A.llmState.msg || '超时') + '），先用本地理解；点开看原因'
        : '点这里接上大模型';
  }
  /* 上下文条：让用户看见"系统记得我们在说哪间房、哪台设备" */
  function paintCtx() {
    const el = $('ctxNow');
    if (!el) return;
    const t = window.BIM.agent.ctxLine();
    el.className = 'ctx-now' + (t ? ' on' : '');
    el.innerHTML = '<i></i>' + esc(t || '还没开始');
  }

  function openAI() {
    paintTools();
    aiForm();
    showDiag(window.BIM.agent.diag);
    $('pAI').hidden = false;
  }

  function saveAI() {
    const A = window.BIM.agent;
    const p = readAIForm();
    A.saveCfg(p);
    $('llmEp').value = A.cfg.endpoint;      // 回填补全后的地址，用户能看到实际用的是哪个
    paintAI();
    $('pAI').hidden = true;
    ai(A.cfg.on ? '记住了，之后说话它就接着上下文听。' : '好，先用本地理解，一样能接着上文说。', null, false);
  }

  /* 拉模型列表：省得猜模型名 */
  async function loadModels() {
    const A = window.BIM.agent;
    const b = $('llmModels');
    const box = $('llmModelList');
    const p = readAIForm();
    if (!p.endpoint) { toast('先填接口地址'); return; }
    A.saveCfg(p);
    b.disabled = true; const old = b.textContent; b.textContent = '拉取中…';
    const r = await A.models();
    b.disabled = false; b.textContent = old;
    if (!r.ok) {
      box.hidden = true;
      showDiag({ ok: false, url: r.url, err: r.err, body: r.body });
      toast(r.err, 5000);
      return;
    }
    box.innerHTML = '';
    r.list.slice(0, 40).forEach(id => {
      const btn = document.createElement('button');
      btn.textContent = id;
      if (id === $('llmModel').value.trim()) btn.classList.add('on');
      btn.onclick = () => {
        $('llmModel').value = id;
        box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
        window.BIM.agent.saveCfg(readAIForm());
        paintAI();
        toast('模型选好了：' + id + '，点测试连接');
      };
      box.appendChild(btn);
    });
    box.hidden = false;
    toast('拉到 ' + r.list.length + ' 个模型，点一个就行');
    showDiag({ ok: true, url: r.url, ms: 0, reply: r.list.slice(0, 3).join('、') + (r.list.length > 3 ? ' 等 ' + r.list.length + ' 个' : '') });
  }

  async function testAI() {
    const A = window.BIM.agent;
    const p = readAIForm();
    const needKey = !A.isRel(p.endpoint);
    if (!p.endpoint || !p.model || (needKey && !p.key)) {
      toast(!p.endpoint ? '先填接口地址' : (!p.model ? '先选模型（可以点上面的拉取）' : '还差 Key'));
      return;
    }
    A.saveCfg(p);
    $('llmEp').value = A.cfg.endpoint;
    const b = $('llmTest');
    b.disabled = true; b.textContent = '连接中…';
    showDiag(null);
    const r = await A.test();
    b.disabled = false; b.textContent = '测试连接';
    $('llmEp').value = A.cfg.endpoint;       // 地址若被自动纠正，回填给人看
    paintAI();
    showDiag(A.diag);
    if (r.ok) {
      toast('通了 · ' + r.ms + ' ms');
      ai('大模型接上了，' + r.ms + ' 毫秒就回。', null, false);
    } else {
      toast(r.hint || r.err || '没通', 6000);
    }
  }

  /* 服务端（tools/serve.py）如果已经配好网关，页面启动就自动接上，什么都不用填。
     注意：以前只要 localStorage 里有记录就整个跳过，结果服务端换模型（比如
     qwen3.8-max 上游挂了、自动回落到 qwen3.8-27b）页面就永远用旧名字发请求，
     每条 500 看着像"对接坏了"。现在改成：自动接上的配置每次都跟服务端对齐，
     只有用户自己手填过的才不碰。 */
  async function autoConnect(force) {
    const A = window.BIM.agent;
    let j = null;
    try {
      const r = await fetch('/llm-config', { cache: 'no-store' });
      if (!r.ok) return { changed: false };
      j = await r.json();
    } catch (e) { return { changed: false }; }        // 普通静态服务器没有这个接口
    if (!j || !j.endpoint || !j.model) return { changed: false };

    const self = A.isSelfGw ? A.isSelfGw(A.cfg.endpoint, j.target) : A.isRel(A.cfg.endpoint);
    const list = j.models || [];
    const badModel = !!A.cfg.model && list.length > 0 && list.indexOf(A.cfg.model) < 0;
    const same = A.cfg.on && A.cfg.endpoint === A.normEndpoint(j.endpoint) && A.cfg.model === j.model;
    if (same) return { changed: false };

    /* 什么情况下可以动用户存的配置：
       ① 没手填过（是自动接上的）→ 跟着服务端走；
       ② force（请求刚因为模型不可用失败）且指向自家网关；
       ③ 指向自家网关、但存的模型名网关里根本没有（newapi_channel_conn 这种占位名），
          或者地址里把网页上的相对路径 /llm/v1 当成绝对地址拼到域名后面了 —— 这就是填错了，替它改掉。 */
    const mayFix = !(A.touched && A.touched()) || (self && force) || (self && badModel);
    if (!mayFix) return { changed: false };

    const was = A.cfg.model, wasEp = A.cfg.endpoint;
    A.saveCfg({
      endpoint: j.endpoint, model: j.model,
      key: A.isRel(j.endpoint) ? '' : (A.cfg.key || ''),   // 同源转发用服务端的 Key
      timeout: Math.max(A.cfg.timeout || 0, 60000)
    }, { auto: true });
    aiForm(); paintAI();
    let why;
    if (badModel) why = '「' + was + '」不是能聊天的模型名，已换成 ' + j.model;
    else if (was && was !== j.model) why = '网关的模型换成 ' + j.model + ' 了（原来记的 ' + was + ' 已经不可用），已自动跟过去';
    else why = '已接上网关（' + j.model + '）';
    if (wasEp && wasEp !== A.normEndpoint(j.endpoint)) why += '，接口地址也改用 ' + A.normEndpoint(j.endpoint) + '（原来填的 ' + wasEp + ' 走不通）';
    ai(why + '，直接说话就行。', null, false);
    return { changed: true, model: j.model, was: was };
  }
  /* 让 agent 在请求因模型不可用失败时，能反过来请求这里对一次配置 */
  window.BIM.agent.resync = function () { return autoConnect(true); };

  /* ---------------- 三维回调 ---------------- */
  /* 点门/点窗 = 选中它。
     用户原话："当我的鼠标点击门或者点击窗的时候 高亮，这个时候我可以通过对话的方式
     对门、窗进行尺寸以及位置的设置"。
     所以点中以后要做三件事：① 画出选中框；② 把这一扇记进上下文
     （ST.selOpening + agent.mem.ctx.selOpening），后面"这扇门加宽到 1.5 米"
     才知道说的是哪一扇；③ 面板里给出可直接点的改尺寸/挪位入口。 */
  function selectOpening(hit, silent) {
    const kind = hit && (hit.kind === 'door' || hit.kind === 'window') ? hit.kind : null;
    if (!kind) return false;
    const raw = hit.data || hit.obj || null;
    const list = kind === 'door' ? (M.doors || []) : (M.windows || []);
    const d = (raw && raw.id && list.find(x => x.id === raw.id)) || raw;
    if (!d) return false;
    const g = kind === 'door' ? S.highlightDoor(d) : S.highlightWindow(d);
    if (!g) return false;
    ST.selOpening = { kind: kind, id: d.id, name: d.name, w: d.w, h: d.h, sill: d.sill || 0, wall: d.wall, floor: d.floor };
    const A = window.BIM.agent;
    if (A && A.mem && A.mem.ctx) A.mem.ctx.selOpening = ST.selOpening;
    /* 选门/选窗时把镜头摆正一点：不然选中框可能只有几十个像素，用户以为没反应。
       ⚠ 只按"洞口周围两米"判断在不在画面里 —— 以前按整面墙算，
       5F 一道墙 33 米长，正常情况下永远判"不在画面里"，
       于是每点一次门窗镜头就飞一次（用户："改完尺寸后再次点击的视角会有点问题"）。 */
    const wall = M.walls.find(w => w.id === d.wall);
    if (wall) {
      const at = kind === 'door' ? S.doorAt(d, wall) : S.windowAt(d, wall);
      /* 只判"在不在画面里"，不再要求"够不够大"：
         洞口小但已经在画面里时，用户自己会推近；系统一动镜头，他刚摆好的视角就没了。 */
      if (at != null && (!S.inView || !S.inView(wall.floor,
        d.pos[0] - 1.6, d.pos[1] - 1.6, d.pos[0] + 1.6, d.pos[1] + 1.6, 0.04))) {
        S.focusDoor(wall, at, (M.rooms.find(r => (d.rooms || []).indexOf(r.id) >= 0)) || null);
      }
    }
    if (silent) return true;
    const cn = kind === 'door' ? '门' : '窗';
    const sizeTxt = kind === 'door'
      ? d.w.toFixed(2) + ' 米宽、' + d.h.toFixed(2) + ' 米高'
      : d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' 米，窗台高 ' + (d.sill || 0).toFixed(2) + ' 米';
    toast('已选中' + cn + '「' + (d.name || '') + '」' + sizeTxt);
    ai('选中了' + cn + '「' + (d.name || '') + '」：' + sizeTxt + '。' +
      '现在是这一扇，直接说就行 —— 「加宽到 1.5 米」「改成 2.2 米高」' +
      (kind === 'door' ? '「往左挪 0.3 米」' : '「抬高 0.3 米」「沿墙往右挪半米」') + '。',
      '<div class="res ok"><div class="res-top"><span class="k">已选中</span><span class="tag">' + cn + '</span></div>' +
      '<div class="res-grid"><div><i>编号</i><b>' + (d.name || d.id) + '</b></div>' +
      '<div><i>洞口</i><b>' + d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' m</b></div>' +
      (kind === 'window' ? '<div><i>窗台高</i><b>' + (d.sill || 0).toFixed(2) + ' m</b></div>' : '') +
      '</div></div>');
    chips(kind === 'door'
      ? [
        { label: '加宽到 1.5 m', fn: () => send('把这扇门加宽到1.5米') },
        { label: '加宽到 1.8 m', fn: () => send('把这扇门加宽到1.8米') },
        { label: '往左挪 0.3 m', fn: () => send('把这扇门往左挪0.3米') }
      ]
      : [
        { label: '加宽到 2.0 m', fn: () => send('把这扇窗加宽到2米') },
        { label: '抬高 0.3 m', fn: () => send('把这扇窗往上挪0.3米') },
        { label: '沿墙往左 0.5 m', fn: () => send('把这扇窗往左挪半米') }
      ]);
    return true;
  }
  window.BIM.selectOpening = selectOpening;

  function onPick(hit, hits, ev) {
    if (ST.mode === 'place') return pickPlace(hit);
    if (ST.mode === 'door') return pickDoor(hit, hits, ev);
    if (ST.mode === 'window') return pickWindow(hit, hits, ev);
    if (ST.mode === 'valve') return pickValve(hit);
    /* 点门/点窗先走"选中"：高亮 + 记上下文，供后面用对话改尺寸改位置 */
    if (hit && (hit.kind === 'door' || hit.kind === 'window')) {
      if (selectOpening(hit)) return;
    }
    if (hit) showProps(hit);
  }

  /* ---------------- 方位偏好 → 目标点 ----------------
     贴墙的位置按「转正之后的进深」算：靠西墙站，垂直于墙的是 d 不是 w。
     以前一律用 w/2，3.4×1.8 的风冷冷水机组选"靠墙"会浮在离墙 1.2 米的地方。 */
  function sideInset(room, dev, side, gap) {
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    const g = gap == null ? 0.2 : gap;
    const sideRot = (window.BIM.detail && window.BIM.detail.rotOfSide) ? window.BIM.detail.rotOfSide(side) : 0;
    const f = C.foot(dev, sideRot);
    if (side === 'west') return { x: room.x0 + f.w / 2 + g, y: cy, rot: sideRot };
    if (side === 'east') return { x: room.x1 - f.w / 2 - g, y: cy, rot: sideRot };
    if (side === 'south') return { x: cx, y: room.y0 + f.d / 2 + g, rot: sideRot };
    if (side === 'north') return { x: cx, y: room.y1 - f.d / 2 - g, rot: sideRot };
    return null;
  }

  /* 位置和朝向互相咬：朝向决定宽深要不要互换，互换又决定贴不贴边。
     迭代到稳定（最多三次），避免"先按横着挑点、转 90° 又戳出墙"。
     hint = 这个候选点本来就是按哪面墙算的（sideInset 给的），
     有 hint 就照它落，别用位置反推 —— 反推会把"靠西墙"的理想点重新判成朝南。 */
  function settle(room, dev, x, y, hint) {
    const fixed = dev.rot != null || hint != null;
    let rot = hint != null ? hint : (dev.rot != null ? dev.rot : 0);
    for (let i = 0; i < 3; i++) {
      if (!fixed) rot = C.rotOf({ x: x, y: y, room: room.id, rot: null, w: dev.w, d: dev.d });
      const f = C.foot(dev, rot);
      const nx = clamp(x, room.x0 + f.w / 2 + 0.12, room.x1 - f.w / 2 - 0.12);
      const ny = clamp(y, room.y0 + f.d / 2 + 0.12, room.y1 - f.d / 2 - 0.12);
      const stable = Math.abs(nx - x) < 1e-6 && Math.abs(ny - y) < 1e-6;
      x = nx; y = ny;
      if (stable) break;
    }
    return { x: x, y: y, rot: rot };
  }

  /* 落点定下来之后，朝向由"这个位置该朝哪"最终裁定 ——
     房间中间就该朝门，不能因为选空位时先试了哪个方向就朝哪个方向。
     朝向一变占位就变，所以顺手把位置再收进房间、碰撞重算一遍。

     另外补一条「摆正」：设备已经贴着某面墙、但方向是侧身/背朝屋里的时候
     （选空位经常挑出这种位子），把它转成"背靠这面墙、正面朝房间"再落到墙上。
     只有贴得够近（面距 ≤ 1.0 m）才动，房间中间的不许被吸到墙边去。 */
  function bless(room, dev, x, y, others) {
    const rot = C.rotOf({ x: x, y: y, room: room.id, rot: null, w: dev.w, d: dev.d });
    const E = Object.assign({}, dev, { rot: rot });
    const f = C.foot(E);
    let bx = clamp(x, room.x0 + f.w / 2 + 0.12, room.x1 - f.w / 2 - 0.12);
    let by = clamp(y, room.y0 + f.d / 2 + 0.12, room.y1 - f.d / 2 - 0.12);
    let brot = rot;
    let bob = C.obstruct({ room, equip: E, cx: bx, cy: by, others: others });

    const cost = (ob, px, py, pr, pfx, pfy) =>
      ob.blocks.length * 10
      + (C.frontFree(room, null, px, py, { w: pfx, d: pfy, rot: pr }) < 0.6 ? 6 : 0)
      + Math.hypot(px - x, py - y) * 0.8;
    let bestCost = cost(bob, bx, by, brot, f.w, f.d);

    // 现在这台离四面墙各多远（按当前朝向的真实占位量）
    const face = {
      west: bx - f.w / 2 - room.x0,
      east: room.x1 - bx - f.w / 2,
      south: by - f.d / 2 - room.y0,
      north: room.y1 - by - f.d / 2
    };
    ['west', 'east', 'south', 'north'].forEach(side => {
      if (face[side] > 1.0 || face[side] < -0.05) return;      // 太远的不吸，压进墙的也不管
      const r2 = C.sideRot(side);
      const f2 = C.foot(dev, r2);
      let px = bx, py = by;
      if (side === 'west') px = room.x0 + f2.w / 2 + 0.12;
      if (side === 'east') px = room.x1 - f2.w / 2 - 0.12;
      if (side === 'south') py = room.y0 + f2.d / 2 + 0.12;
      if (side === 'north') py = room.y1 - f2.d / 2 - 0.12;
      px = clamp(px, room.x0 + f2.w / 2 + 0.1, room.x1 - f2.w / 2 - 0.1);
      py = clamp(py, room.y0 + f2.d / 2 + 0.1, room.y1 - f2.d / 2 - 0.1);
      const E2 = Object.assign({}, dev, { rot: r2 });
      const ob2 = C.obstruct({ room, equip: E2, cx: px, cy: py, others: others });
      const c2 = cost(ob2, px, py, r2, f2.w, f2.d);
      if (c2 < bestCost) { bestCost = c2; bx = px; by = py; brot = r2; bob = ob2; }
    });

    return { x: bx, y: by, rot: brot, ob: bob };
  }

  /* 朝向翻译成人话：正面朝哪、是不是贴着墙。属性面板和回执都用它，
     用户不用自己转相机去猜"这台到底朝哪"。 */
  const FACE_CN = { 东: '东', 西: '西', 南: '南', 北: '北' };
  function faceInfo(room, eq) {
    if (!room || !eq || eq.rot == null) return null;
    const fx = Math.sin(eq.rot), fy = -Math.cos(eq.rot);
    const face = Math.abs(fx) > 0.5 ? (fx > 0 ? '东' : '西') : (fy > 0 ? '北' : '南');
    const back = { 东: '西', 西: '东', 北: '南', 南: '北' }[face];
    const f = C.foot(eq);
    const gap = face === '东' ? (eq.x - f.w / 2 - room.x0)
      : face === '西' ? (room.x1 - eq.x - f.w / 2)
        : face === '北' ? (eq.y - f.d / 2 - room.y0)
          : (room.y1 - eq.y - f.d / 2);
    return { face: FACE_CN[face], back: FACE_CN[back], backGap: gap, onWall: gap <= 0.5 };
  }
  const faceTxt = fi => (fi ? ('正面朝' + fi.face + (fi.onWall ? '，背靠' + fi.back + '墙' : '')) : '');

  /* 位子变了就重判朝向，并同步到三维：只改 rotation.y，不重建模型。
     挪动/换房间后必须走这一趟，否则会出现"人走到别处了、正面还冲着旧墙"。 */
  function setEquipRot(eq, room) {
    const rot = C.rotOf({ x: eq.x, y: eq.y, room: room.id, rot: null, w: eq.w, d: eq.d });
    applyRot(eq, rot);
    return rot;
  }

  /* 朝向既写数据也写三维，两处必须同步（eq.rotApplied 是给自检/回放看的） */
  function applyRot(eq, rot) {
    eq.rot = rot;
    eq.rotApplied = rot;
    if (eq._obj) eq._obj.rotation.y = rot;
  }

  function prefPoints(room, dev, pref) {
    if (!pref) return [];
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    const mx = dev.w / 2 + 0.4, my = dev.d / 2 + 0.4;
    const walls = M.walls || [];
    const sideWall = k => walls.find(w => w.id === (room.sides || {})[k]);
    const out = [];

    if (pref === 'corridor') {
      ['south', 'north', 'west', 'east'].forEach(s => {
        const w = sideWall(s);
        if (w && w.kind === 'corr') { const p = sideInset(room, dev, s); if (p) out.push(p); }
      });
      if (!out.length) {
        const corr = (M.rooms || []).find(r => r.zone === 'corr' && r.floor === room.floor);
        if (corr) {
          const dx = (corr.x0 + corr.x1) / 2 - cx, dy = (corr.y0 + corr.y1) / 2 - cy;
          const p = Math.abs(dx) > Math.abs(dy)
            ? sideInset(room, dev, dx > 0 ? 'east' : 'west')
            : sideInset(room, dev, dy > 0 ? 'north' : 'south');
          if (p) out.push(p);
        }
      }
    }

    if (pref === 'door' || pref === 'inner') {
      // 入口参考：先看这间房登记过的门；没登记就用朝走廊那面墙的中点
      let refs = (M.doors || []).filter(d => d.floor === room.floor && (d.rooms || []).indexOf(room.id) >= 0)
        .map(d => ({ x: d.pos[0], y: d.pos[1], dir: d.dir }));
      if (!refs.length) {
        const corrSide = ['south', 'north', 'west', 'east'].find(k => {
          const w = sideWall(k);
          return w && w.kind === 'corr';
        });
        const p0 = corrSide ? sideInset(room, dev, corrSide) : null;
        if (p0) refs = [{ x: p0.x, y: p0.y }];
      }
      if (!refs.length) {
        // 既没门也没走廊：把"最里的那个角"当结果，总比扔回房间正中强
        refs = [{ x: room.x0, y: room.y0 }];
      }
      if (pref === 'door') {
        const near = refs[0];
        const [ux, uy] = near.dir || [1, 0];
        let nx = -uy, ny = ux;
        if ((cx - near.x) * nx + (cy - near.y) * ny < 0) { nx = -nx; ny = -ny; }
        out.push({
          x: clamp(near.x + nx * (1.3 + mx), room.x0 + mx, room.x1 - mx),
          y: clamp(near.y + ny * (1.3 + my), room.y0 + my, room.y1 - my)
        });
      } else {
        // 靠里 = 离入口最远的那块地
        let far = null, fd = -1;
        for (let x = room.x0 + mx; x <= room.x1 - mx + 1e-6; x += 0.3)
          for (let y = room.y0 + my; y <= room.y1 - my + 1e-6; y += 0.3) {
            let m0 = 1e9;
            refs.forEach(r => { m0 = Math.min(m0, Math.hypot(x - r.x, y - r.y)); });
            if (m0 > fd) { fd = m0; far = { x: x, y: y }; }
          }
        if (far) out.push(far);
      }
    }

    if (pref === 'window' || pref === 'wall') {
      const ws = (M.windows || []).filter(w => w.floor === room.floor && (w.rooms || []).indexOf(room.id) >= 0);
      if (pref === 'window' && ws.length) {
        const w = ws[Math.floor(ws.length / 2)];
        // 靠窗：贴到窗所在的那面墙
        if (Math.abs(w.pos[1] - room.y0) < 0.6) out.push(sideInset(room, dev, 'south'));
        else if (Math.abs(w.pos[1] - room.y1) < 0.6) out.push(sideInset(room, dev, 'north'));
        else if (Math.abs(w.pos[0] - room.x0) < 0.6) out.push(sideInset(room, dev, 'west'));
        else out.push(sideInset(room, dev, 'east'));
      }
    }

    if (pref === 'corner') {
      ['west', 'east'].forEach(xs => ['south', 'north'].forEach(ys => {
        out.push({
          x: xs === 'west' ? room.x0 + mx : room.x1 - mx,
          y: ys === 'south' ? room.y0 + my : room.y1 - my
        });
      }));
    }

    if (pref === 'column' || pref === 'beam') {
      const list = pref === 'column'
        ? (M.columns || []).filter(c => c.floor === room.floor)
        : (M.beams || []).filter(b => b.floor === room.floor).map(b => ({ x: (b.a[0] + b.b[0]) / 2, y: (b.a[1] + b.b[1]) / 2, s: b.w }));
      let best = null, bd = 1e9;
      list.forEach(c => { const dd = Math.hypot(c.x - cx, c.y - cy); if (dd < bd) { bd = dd; best = c; } });
      if (best) {
        const half = (best.s || 0.5) / 2;
        out.push({ x: clamp(best.x + half + mx, room.x0 + mx, room.x1 - mx), y: clamp(best.y, room.y0 + my, room.y1 - my) });
        out.push({ x: clamp(best.x, room.x0 + mx, room.x1 - mx), y: clamp(best.y + half + my, room.y0 + my, room.y1 - my) });
      }
    }

    if (pref === 'center') out.push({ x: cx, y: cy });
    if (pref === 'wall') {
      ['south', 'north', 'west', 'east'].forEach(k => { const p = sideInset(room, dev, k, 0.14); if (p) out.push(p); });
      // 靠墙也要能贴着角放，墙中间被窗/门占住时还有路可走
      out.push({ x: room.x0 + dev.w / 2 + 0.16, y: room.y0 + dev.d / 2 + 0.16 });
      out.push({ x: room.x1 - dev.w / 2 - 0.16, y: room.y1 - dev.d / 2 - 0.16 });
    }
    // 候选点统一过一遍 settle：朝向和占位互相校正后再交出去
    return out.map(p => { const s = settle(room, dev, p.x, p.y, p.rot); return { x: s.x, y: s.y, rot: s.rot }; });
  }

  /* 依次试偏好点，挑第一个放得下的；都不行就找离它最近的空位；
     连空位都没有（房间被家具/设备塞满了）也照样给一个「碰撞最少、离目标最近」的点——
     按需求，房间挤不挤是用户的事，系统只负责把碰撞讲清楚，不替用户否决。 */
  function bestSpotFor(room, dev, pref, seed, seedFirst) {
    const others = othersIn(room);
    const cands = prefPoints(room, dev, pref);
    if (seed) { if (seedFirst) cands.unshift(seed); else cands.push(seed); }
    if (!cands.length) cands.push({ x: (room.x0 + room.x1) / 2, y: (room.y0 + room.y1) / 2, rot: null });
    for (const c of cands) {
      const s = settle(room, dev, c.x, c.y, c.rot);
      const E = Object.assign({}, dev, { rot: s.rot });
      const ob = C.obstruct({ room, equip: E, cx: s.x, cy: s.y, others });
      if (ob.pass) return { x: s.x, y: s.y, ob: ob, exact: true, rot: s.rot };
      /* ★ seed 就是"用户说的那个方向"（放左边 / 靠镜头右边）。
         它要是被门口、柱子、门扇扫掠区占住了，不能一头扎回房间正中 ——
         用户说的是"这一侧"，那就以 seed 为原点就近找合法的空位，还留在这一侧。
         以前没有这一步：说了"放在左边"，结果落到正中间，看着像没听懂。 */
      if (seed && c === seed) {
        const sn = C.suggestSpot({ room: room, equip: dev, cx: seed.x, cy: seed.y, others: others });
        if (sn && Math.hypot(sn.x - seed.x, sn.y - seed.y) <= 2.6) {
          const bl = bless(room, dev, sn.x, sn.y, others);
          return { x: bl.x, y: bl.y, ob: bl.ob, exact: false, rot: bl.rot };
        }
      }
    }
    const base = cands[0];
    const s0 = C.suggestSpot({ room, equip: dev, cx: base.x, cy: base.y, others });
    if (s0) {
      const bl = bless(room, dev, s0.x, s0.y, others);
      return { x: bl.x, y: bl.y, ob: bl.ob, exact: false, rot: bl.rot };
    }

    let bestC = null;
    cands.forEach(c => {
      const st = settle(room, dev, c.x, c.y, c.rot);
      const E = Object.assign({}, dev, { rot: st.rot });
      const ob = C.obstruct({ room, equip: E, cx: st.x, cy: st.y, others });
      // 碰撞最少优先；一样撞的时候，别选"正面冲着墙"的那个
      const faceBad = C.frontFree(room, E, st.x, st.y, C.foot(E)) < 0.6 ? 6 : 0;
      const score = ob.blocks.length * 10 + faceBad + Math.hypot(st.x - c.x, st.y - c.y);
      if (!bestC || score < bestC.score) bestC = { x: st.x, y: st.y, ob: ob, score: score, rot: st.rot };
    });
    if (!bestC) return null;
    const bl = bless(room, dev, bestC.x, bestC.y, others);
    return { x: bl.x, y: bl.y, ob: bl.ob, exact: false, rot: bl.rot };
  }

  /* 给"不知道放哪好"的用户算 2~4 个候选位，每个配一句人话的利弊。
     这就是用户引导的原料：模型拿去讲、按钮拿去点，都是同一份。 */
  const SPOT_ORDER = ['inner', 'wall', 'corner', 'center', 'window', 'corridor', 'column'];
  const SPOT_NOTE = {
    inner: ['离门口最远，进出和搬运都不挡道', '从门口到这儿要绕着走一段'],
    wall: ['贴着墙放，房间中间整片通道都让出来', '侧面只剩检修宽度，拆侧板会挤'],
    corner: ['两面墙夹着，最省地方', '背角通风差一点，潮气不容易散'],
    center: ['四面都能走人，检修、接管最方便', '占掉房间中间，通道会变窄'],
    window: ['挨着窗，进风和散热都好', '以后要是换窗、擦窗会挡一下'],
    corridor: ['靠走廊，以后搬运进出最近', '贴着门口，人来人往容易被碰到'],
    column: ['靠着柱子放，楼板受力最有利', '离旁边设备可能偏近，要注意净距']
  };

  function spotOptions(room, dev, n) {
    if (!room || !dev) return [];
    const out = [];
    const seen = [];
    const hasWin = (M.windows || []).some(w => w.floor === room.floor && (w.rooms || []).indexOf(room.id) >= 0);
    SPOT_ORDER.forEach(pref => {
      if (pref === 'window' && !hasWin) return;      // 没窗就别给一个其实办不到的选项
      const s = bestSpotFor(room, dev, pref, null);
      if (!s) return;
      if (seen.some(p => Math.hypot(p.x - s.x, p.y - s.y) < 0.8)) return;   // 位置重合的只留最靠前那个
      seen.push(s);
      const nt = SPOT_NOTE[pref] || ['这儿放得下', ''];
      out.push({
        pref: pref, label: N.PREF_CN[pref] || pref, note: nt[0], bad: nt[1],
        x: s.x, y: s.y, ob: s.ob, exact: s.exact
      });
    });
    return out.slice(0, Math.max(1, n || 3));
  }

  /* ---------------- 设备放置 ---------------- */
  function startPlace(p) {
    const room = p.room;
    if (!room) {
      ai('要放到哪一间？说个房间号就行，比如「2 楼 202」。');
      $('txt').focus();
      return;
    }
    let dev = p.device || ST.device;
    if (!dev && /这个|这台|该设备/.test(p.raw || '')) dev = M.equipmentLibrary[0];
    if (!dev && p.weight) {
      dev = { id: 'CUSTOM', name: '这台设备', weight: p.weight, w: 1.6, d: 1.0, h: 1.4, shape: 'box', color: '#6f7cf0', note: '手动录入' };
    }
    if (!dev) {
      ai('要把哪台设备放进去？选一个，我马上带你放。');
      chips(M.equipmentLibrary.slice(0, 4).map(e => ({
        label: e.name + ' ' + (e.weight / 1000).toFixed(1) + 't',
        fn: () => { ST.device = e; send('把' + e.name + '放到' + room.num + '室' + (p.pref ? (N.PREF_CN[p.pref] || '') : '')); }
      })));
      openEquip();
      return;
    }

    ST.device = dev;
    ST.mode = 'place';
    ST.pending = { device: dev, room, pref: p.pref || null };
    S.mode = 'place';
    focusSoft(room);                    // 已经在画面里就不动相机，只调显隐/高亮
    S.highlightRoom(room, 0x10a394);

    // 语音里已经说了方位 → 直接按方位落位，省一步点击
    if (p.pref) {
      const spot = bestSpotFor(room, dev, p.pref, null);
      if (spot) {
        const where = N.PREF_CN[p.pref] || '这个位置';
        ai('按你说的「' + where + '」，我把位置定在这儿了。不合适可以自己再点一下。');
        ST.pending.device = Object.assign({}, dev, { rot: spot.rot });
        commitPlace(spot.x, spot.y, spot.ob);
        return;
      }
    }

    setMode('放置 ' + dev.name + ' · ' + room.num + ' 室', cancelMode);
    let t = '好的，' + room.num + ' 室。楼板已经亮起来了，在图上点一下要放的位置。';
    if (p.guess) t = '你说的 ' + p.said + ' 我理解成 ' + room.floor + ' 楼的 ' + room.num + ' 室。在图上点一下要放的位置。';
    ai(t);
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function pickPlace(hit) {
    if (!hit || hit.kind !== 'slab') { toast('点一下房间里的楼板'); return; }
    const room = ST.pending.room;
    if (hit.data.room !== room.id) {
      const other = M.rooms.find(r => r.id === hit.data.room);
      toast('这里是 ' + (other ? other.num : hit.data.room) + ' 室');
      return;
    }
    const dev0 = ST.pending.device;
    // 点哪儿就按哪儿的朝向来站（贴哪面墙决定正面朝哪），再迭代收缩进房间
    const st = settle(room, dev0, hit.x, hit.y);
    const dev = Object.assign({}, dev0, { rot: st.rot });
    const others = othersIn(room);
    const ob = C.obstruct({ room, equip: dev, cx: st.x, cy: st.y, others });
    // 有碰撞也照放：位置是人指的，系统不再一口回绝，只把冲突摆明白
    ST.pending.device = dev;
    commitPlace(st.x, st.y, ob);
  }

  function commitPlace(x, y, ob, moved, quiet) {
    if (!ST.pending) return null;
    return commitPlaceAt(ST.pending.room, ST.pending.device, x, y, ob, moved, quiet);
  }

  /* room / dev 显式传入，智能体的多步任务不依赖交互状态。
     ob 里带着碰撞信息：pass=false 也照放，只是回复里把每一处冲突列出来并描红。 */
  function commitPlaceAt(room, dev, x, y, ob, moved, quiet) {
    if (!room || !dev) return null;
    dropClr();                 // 位置变了，旧的净距标注不再成立
    const eq = Object.assign({}, dev, {
      id: 'EQP' + (ST.equipId++), lib: dev.lib || dev.id, x: x, y: y, floor: room.floor, room: room.id,
      floorElev: room.elev, name: dev.name, color: dev.color || '#4f7df3'
    });
    /* 朝向在落位这一刻定死：正面朝哪由"背靠哪面墙 / 门在哪"自动判，
       之后算碰撞、描红、挪动都复用这一个值，不会各算一套。 */
    if (eq.rot == null) eq.rot = C.rotOf({ x: x, y: y, room: room.id, rot: null, w: eq.w, d: eq.d });
    eq._ob = ob || null;
    S.addEquipment(eq);
    ST.placed.push(eq);
    refreshTree();
    const TRE = window.BIM.tree;
    if (TRE && TRE.reveal) TRE.reveal('equip', eq);      // 树上跟着跳到这台新设备

    const r = C.check({ room, equip: eq, cx: x, cy: y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    // 点了也算上下文：后面「再放一台」「挪一下」都知道在说哪儿
    const AM = window.BIM.agent.mem;
    AM.ctx.room = room; AM.ctx.floor = room.floor; AM.ctx.device = dev.name;
    AM.lastPlaced = eq;
    if (AM.placed.indexOf(eq) < 0) AM.placed.push(eq);
    AM.lastResult = r;
    finishMode();

    const clash = !!(ob && ob.blocks && ob.blocks.length);
    // 撞到的东西直接框成红的：别让人凭一句话猜"哪儿撞了"。
    // 只有"放不下 / 快到头"才铺色块，正常放好只描一圈边 —— 不铺那块绿板。
    if (!markClash(ob)) {
      const bad = clash || r.verdict === 'bad';
      S.highlightRoom(room, bad ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394),
        { fill: bad ? .22 : (r.verdict === 'warn' ? .12 : 0) });
    }

    if (quiet) return eq;

    const head = clash
      ? '放好了，不过撞到了 ' + ob.blocks.length + ' 处东西，都标红了。'
      : {
        ok: '放在这没问题，' + r.v.word + '。',
        okw: '可以放，' + r.v.word + '。',
        warn: '能放下，但这块板子快到头了。',
        bad: '这个位置放不下，得换个办法。'
      }[r.verdict];

    const note = moved ? '<p style="margin:0 0 6px;color:#8a95a3;font-size:11.5px">这个位置已经让开了，稍微挪了一点。</p>' : '';
    // 正面朝哪是自动判的，顺手写在回执里，用户不用转相机去猜
    const fi0 = faceInfo(room, eq);
    const oriTxt = fi0 ? ' <span style="opacity:.6;font-size:12px">' + faceTxt(fi0) + '</span>' : '';
    const clashTxt = clash
      ? '<div class="res bad" style="margin-top:8px"><div class="res-top"><span class="k">' + ob.blocks.length +
      '</span><span class="kl">处碰撞</span><span class="tag">已放置</span></div>' +
      '<div class="res-adv">' + ob.blocks.map(b => '<s>·</s> ' + b.t).join('<br>') + '</div></div>' : '';
    const warnTxt = (ob && ob.warns && ob.warns.length)
      ? '<div class="res-adv" style="border-top:1px solid #eef1f5">' + ob.warns.map(w => '<s>·</s> ' + w).join('<br>') + '</div>' : '';
    ai(note + head + oriTxt, card(r) + clashTxt + warnTxt);

    const cs = [];
    if (clash) {
      const spot = C.suggestSpot({ room, equip: eq, cx: x, cy: y, others: othersIn(room).filter(e => e !== eq) });
      if (spot) {
        cs.push({
          label: '挪到 ' + spot.d.toFixed(1) + ' 米外的空位', fn: () => {
            const ob2 = C.obstruct({ room, equip: eq, cx: spot.x, cy: spot.y, others: othersIn(room).filter(e => e !== eq) });
            stepMoveTo(eq, spot.x, spot.y, ob2);
          }
        });
      }
      cs.push({ label: '换台小一点的设备', fn: openEquip });
    }
    cs.push({ label: '看计算书', fn: () => openCalc() });
    if (!clash) {
      if (r.alt.length) cs.push({ label: r.alt[0].name + '再算一次', fn: () => retryWith(r.alt[0].name) });
      else cs.push({ label: '再放一台', fn: () => send('再放一台' + dev.name) });
    }
    chips(cs);

    // 放得下 ≠ 搬得进来：门洞不够宽就当场问一句要不要拓宽
    const pd = C.passDoor({ room, equip: eq });
    eq._door = pd;
    if (!pd.ok) askDoorWiden(room, eq, pd);
    return eq;
  }

  /* 把一台已经在场上的设备挪到 (x,y)——「挪到空位」这类按钮走这条，不再走对话 */
  function stepMoveTo(eq, x, y, ob) {
    const room = M.rooms.find(r => r.id === eq.room);
    if (!room || !eq) return false;
    const before = { x: eq.x, y: eq.y };
    eq.x = x; eq.y = y;
    if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
    const r = C.check({ room: room, equip: eq, cx: x, cy: y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    window.BIM.agent.mem.lastResult = r;
    window.BIM.agent.mem.lastPlaced = eq;
    pushUndo('把' + eq.name + '挪回原位', () => {
      eq.x = before.x; eq.y = before.y;
      if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
    });
    const clash = !!(ob && ob.blocks && ob.blocks.length);
    if (!markClash(ob)) S.highlightRoom(room, 0x10a394);
    ai(clash
      ? '挪过去了，不过还剩 ' + ob.blocks.length + ' 处碰撞：' + ob.blocks.map(b => b.t).join('；') + '。'
      : '挪好了，这个位置撞不到东西了。', card(r));
    return true;
  }

  function retryWith(name) {
    const r = ST.last, eq = ST.sel;
    if (!r || !eq) return;
    const others = othersIn(r.room).filter(e => e !== eq);
    let res;
    if (name === '加垫板') {
      res = C.check({ room: r.room, equip: eq, cx: r.cx, cy: r.cy, pad: true, others });
      eq.pad = true;
    } else {
      res = C.check({ room: r.room, equip: eq, cx: r.room.x0 + 0.9, cy: r.room.y0 + 0.9, others });
      eq.x = r.room.x0 + 0.9; eq.y = r.room.y0 + 0.9;
      if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
    }
    ST.last = res;
    ai('按「' + name + '」重算了一次，安全系数到 ' + C.fmt(res.K) + '。', card(res), true);
  }

  function card(r) {
    const n = r.others.length;
    const extra = n
      ? '<div class="res-grid"><div><i>这块板上已有</i><b>' + n + ' 台 / ' + (r.POthers * 1000 / 9.81 / 1000).toFixed(2) + ' t</b></div>' +
      '<div><i>合计压着</i><b>' + (r.PTotal * 1000 / 9.81 / 1000).toFixed(2) + ' t</b></div></div>'
      : '';
    /* 打通以后必须点名"按哪块板算的"：跨度和边界都变了，
       用户看到安全系数变小会以为算错了，得让他知道是"中间那道墙没了"。 */
    const merged = r.merged && r.plate
      ? '<div class="res-adv" style="border-top:1px solid #eef1f5"><s>·</s> 这块板和 ' +
      (r.plate.rooms || []).filter(x => x.id !== r.room.id).map(x => x.num).join('、') +
      ' 已经打通，中间那道墙不再是支座，按联通后的大板 ' + r.lx.toFixed(2) + '×' + r.ly.toFixed(2) +
      ' m 校核（不再按单间小板算）</div>' : '';
    return '<div class="res ' + r.v.cls + '">' +
      '<div class="res-top"><span class="k">' + C.fmt(r.K) + '</span><span class="kl">安全系数</span><span class="tag">' + r.v.tag + '</span></div>' +
      '<div class="res-grid">' +
      '<div><i>建议上限</i><b>' + (r.Pmax_kg / 1000).toFixed(2) + ' t</b></div>' +
      '<div><i>这台设备</i><b>' + (r.equip.weight / 1000).toFixed(2) + ' t</b></div>' +
      '</div>' + extra + merged +
      '<div class="res-adv">' + r.advice.map(a => '<s>·</s> ' + a).join('<br>') + '</div></div>';
  }

  /* ---------------- 开门 ---------------- */
  /* 「左边那面墙」到底是哪面：把屏幕方向换成罗盘，取朝向最接近的那一面墙。
     以前把"左"写死成西墙，用户把镜头转过去再说话就开到别的墙上去了。 */
  const REL_SIDES = ['left', 'right', 'front', 'back', 'up', 'down'];
  const FOUR_SIDES = [['east', 1, 0], ['west', -1, 0], ['north', 0, 1], ['south', 0, -1]];
  function viewSide(rel) {
    if (!rel || REL_SIDES.indexOf(rel) < 0) return null;
    const v = dirVec(rel, null);
    if (!v) return null;
    let best = null, bd = -9;
    FOUR_SIDES.forEach(([k, dx, dy]) => {
      const s = v.x * dx + v.y * dy;
      if (s > bd) { bd = s; best = k; }
    });
    return best;
  }
  // 反查：这面墙是房间的哪一侧（记录用，保证存的一定是罗盘方向）
  const sideOfWall = (room, wall) => (room && wall)
    ? (Object.keys(room.sides || {}).find(k => room.sides[k] === wall.id) || null) : null;
  /* 这扇门/窗到底属于哪一间。
     ★ 一扇门/窗的 rooms 是**整面墙上的所有房间**（5F 南墙挂了 501~505 五间），
       以前直接取 rooms[0]，于是 505 那扇窗被认成 501 的 ——
       改尺寸时按 501 的墙面范围一卡，就变成"出了本房间的墙面范围，会开到隔壁去"。
       正确做法：挑"在这面墙上真的罩住这个洞口位置"的那一间，并且优先非走廊。 */
  function roomOfOpening(d, wall, at) {
    const list = (d.rooms || []).map(id => M.rooms.find(r => r.id === id))
      .filter(r => r && r.floor === d.floor);
    if (!list.length) return null;
    const rooms = list.filter(r => r.zone !== 'corr').concat(list.filter(r => r.zone === 'corr'));
    if (at == null) return rooms[0];
    let best = null, bw = Infinity;
    rooms.forEach(r => {
      const sp = roomSpanOnWall(wall, r);
      if (at < sp.lo - 0.05 || at > sp.hi + 0.05) return;
      const w = sp.hi - sp.lo;
      if (w < bw) { bw = w; best = r; }
    });
    return best || rooms[0];
  }
  /* "放在左边"——按当前镜头把"左边"换成墙，再给一个贴着那面墙的起始点，
     不然用户说了方位，设备还是往房间中间跑。
     side 里也可能直接是 left/right/front/back（工具参数只有 side 一个口），
     所以相对方位要在这里一起换算，不能只认 sideRel。 */
  function seedForSide(room, side, rel) {
    const isRel = v => REL_SIDES.indexOf(v) >= 0;
    const k = (rel ? viewSide(rel) : null) || (isRel(side) ? viewSide(side) : null) || side;
    if (!room || !k || !FOUR_SIDES.some(f => f[0] === k)) return null;
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2, pad = 0.9;
    if (k === 'east') return { x: room.x1 - pad, y: cy };
    if (k === 'west') return { x: room.x0 + pad, y: cy };
    if (k === 'north') return { x: cx, y: room.y1 - pad };
    return { x: cx, y: room.y0 + pad };
  }

  /* 这间房某一面墙是什么性质：ext 外墙 / corr 走廊墙 / int·part 内隔墙 */
  function sideKind(room, k) {
    if (!room || !k) return null;
    const w = M.walls.find(x => x.id === (room.sides || {})[k]);
    return w ? w.kind : null;
  }

  /* 开门只能开在**走廊墙和内墙**上。
     用户原话："随便说开个门的时候不能开在外墙！只能是走廊和内墙"。
     以前这里按 west→east→south→north 硬取第一面，5F 的南墙正好是外墙，于是
     "开个门"十次有八次开到外立面上去了。现在先把外墙剔掉，再按
     走廊墙 > 内墙 > 隔墙 排序；四面全是外墙就返回 null，由上层如实说开不了。 */
  function pickDoorSide(room, p) {
    const sides = room.sides || {};
    const rel = p.sideRel || (REL_SIDES.indexOf(p.side) >= 0 ? p.side : null);
    const byView = viewSide(rel);
    const usable = k => !!sides[k] && sideKind(room, k) !== 'ext';
    const rank = k => { const t = sideKind(room, k); return t === 'corr' ? 0 : (t === 'int' ? 1 : (t === 'part' ? 2 : 3)); };
    const all = ['south', 'north', 'west', 'east'].filter(usable).sort((a, b) => rank(a) - rank(b));
    if (!all.length) return null;

    // 「靠走廊」→ 直接找走廊那面
    if (p.pref === 'corridor') {
      const c = all.find(k => sideKind(room, k) === 'corr');
      if (c) return c;
    }
    // 用户/镜头指的那一面能用就用它（指到外墙则往下走）
    if (byView && usable(byView)) return byView;
    if (p.side && usable(p.side)) return p.side;
    return all[0];
  }

  /* 用户点名的那一面被跳过了（是外墙），得在回执里说清楚换成了哪一面 */
  function doorSideNote(room, want, chosen) {
    if (!want || !chosen || want === chosen) return '';
    const t = sideKind(room, want);
    if (t !== 'ext') return '';
    return '你说的' + N.SIDE_CN[want] + '面是外墙，不能开门，我换成了' + N.SIDE_CN[chosen] + '面';
  }

  /* 记住这次开门，接着说话时能引用 */
  function rememberDoor(room, side, w, h) {
    const AM = window.BIM.agent.mem;
    AM.ctx.room = room; AM.ctx.floor = room.floor;
    if (side) AM.ctx.side = side;
    AM.lastDoor = { room: room, side: side, w: w, h: h };
  }

  /* 把一扇门撤掉，墙恢复成"开门之前"的样子。
     用户原话："撤掉这扇门也需要回复原装，目前没有"。
     "原装"不只是洞口补上，还有两件事要一起退回：
      ① 开门时为让位置而改道的线管 —— 放回原来的走法，不然图上一直挂着一截绿线；
      ② 开门时被顶掉 / 吃掉的原有门窗 —— 按记下的参数装回去。
     顺手把选中态、门洞标记、上下文一起清掉，别让下一次操作还对着一扇不存在的门。 */
  function undoDoor(d, quiet) {
    if (!d) return null;
    const wall = M.walls.find(w => w.id === d.wall);
    const at = wall ? S.doorAt(d, wall) : null;
    const snap = {
      id: d.id, name: d.code || d.name || d.id, w: d.w, h: d.h, at: at,
      room: d.room, added: !!d.added, wall: wall ? wall.id : null
    };
    const E = window.BIM.elec;
    let condBack = 0;
    (d._reroutes || []).forEach(cid => {
      if (E && E.undoReroute && E.undoReroute(cid)) condBack++;
    });
    /* 门身上记的 id 只是"开门那一刻"的名单。只要中间重建过一次
       （开窗、打通、改尺寸都会重建），被洞口切开的线管就换了 id，
       按 id 一个都撤不掉 —— 图上那截绿线永远挂着。
       所以再按"这个洞口范围"兜一次底，凡是记在这个洞上的改线全撤。 */
    if (E && E.undoReroutesAt && wall && at != null) {
      const gone = E.undoReroutesAt(wall.id, at - (d.w || 1) / 2, at + (d.w || 1) / 2) || [];
      gone.forEach(cid => { if ((d._reroutes || []).indexOf(cid) < 0) condBack++; });
    }
    let ok = S.removeDoor(d);
    if (!ok && wall) {
      /* 洞口和门记录对不上时兜底：按反查号、再按最近位置硬摘一个洞口，然后把墙重建 */
      const i = wall.openings.findIndex(o => o.kind === 'door' &&
        (o.ref === d.id || (at != null && Math.abs(o.at - at) < 0.35)));
      if (i >= 0) {
        wall.openings.splice(i, 1);
        S.rebuildWall(wall);
        if (d._mesh && d._mesh.parent) d._mesh.parent.remove(d._mesh);
        M.doors = (M.doors || []).filter(x => x !== d);
        ok = true;
      }
    }
    if (!ok) return null;
    /* 开门时被吃掉的原有门窗装回去 */
    const ate = d._ate || [];
    let openBack = 0;
    ate.forEach(e => {
      if (!e || !e.obj || !wall) return;
      const nd = e.kind === 'door'
        ? S.addDoorOpening(wall, e.at, e.w, e.h)
        : S.addWindowOpening(wall, e.at, e.w, e.h, e.sill || 0);
      if (nd) {
        if (e.room) nd.room = e.room;
        if (e.name) nd.name = e.name;
        if (e.added) nd.added = true;
        openBack++;
      }
    });
    if (openBack && wall) S.rebuildWall(wall);
    /* 洞口补上了 → 线管按"没有这个洞"重铺一遍，门口那一截接回连续 */
    syncElecAfterDoor();
    /* 撤门 = 这一屏就结束了，画面上不能再留着"这扇门办事时的痕迹"：
       红色碰撞标记、绿色绕行路线、只剩那几根的隔离、还有半透明的墙。
       以前这里什么都不清，用户看到的就是"门撤了，可原来绕行的那几根还挂在那儿"
       （原话："撤掉门后还是有原来绕行的管线"）。 */
    S.clearConduitMarks && S.clearConduitMarks();
    S.clearGhostWalls && S.clearGhostWalls();
    S.clearHighlight && S.clearHighlight();
    S.markDoorSpotClear && S.markDoorSpotClear();
    S.clearOpeningHighlight && S.clearOpeningHighlight();
    if (ST.lastDoor && ST.lastDoor.d === d) ST.lastDoor = null;
    if (ST.selOpening && ST.selOpening.id === d.id) {
      ST.selOpening = null;
      const AM = window.BIM.agent && window.BIM.agent.mem;
      if (AM && AM.ctx) AM.ctx.selOpening = null;
    }
    snap.conduitsRestored = condBack;
    snap.openingsRestored = openBack;
    /* 记住"刚撤掉的是哪一扇"：用户撤完常常就在同一个位置再点回来，
       有这条记录才能在他点偏/点不准时报出"刚才那扇在 X 米处"并按原尺寸开回去，
       而不是一句"会撞上东西"把人挡回去。 */
    if (wall && at != null) {
      ST.lastUndone = { wall: wall.id, floor: wall.floor, at: at, w: d.w, h: d.h, room: d.room, t: Date.now() };
    }
    if (!quiet) {
      ai('把「' + snap.name + '」撤掉了，墙上恢复成没有洞口的样子' +
        (condBack ? '；开门时为它改道的那 ' + condBack + ' 根线管也放回原来的走法了' : '') +
        (openBack ? '；原来被让开的 ' + openBack + ' 处门窗装回去了' : '') + '。');
    }
    lastData = { removed: snap.name, width: snap.w, height: snap.h, restored: { conduits: condBack, openings: openBack } };
    return snap;
  }

  /* 每条开门回执都挂一个"我自己点位置"：
     用户经常觉得系统挑的位置不合意（要偏一点、要对着设备），点一下自己定，
     定完照样走 holeDecision 那套校核 + 改线规划，不是"想放哪就放哪"。
     用户原话："每次开门的时候回复都要加一个按钮提供给用户自己点击位置，
     并进行后续的改线规划。"
     ★ 点之前必须先把刚才自动开的那一扇撤掉 —— 否则墙上会多出一扇没人要的门，
     用户原话："对应的按钮我自己点位置需要撤掉之前对应自动生成的，重新开"。 */
  function doorPointChips(room, side, w, h, firstLabel) {
    if (!room) return;
    const last = (ST.lastDoor && ST.lastDoor.d && (M.doors || []).indexOf(ST.lastDoor.d) >= 0)
      ? ST.lastDoor.d : null;
    const one = {
      label: firstLabel || '我自己点位置',
      fn: () => {
        if (last) {
          undoDoor(last, true);
          toast('刚才自动开的那扇已经撤掉了，在墙上点一下你要的位置');
        }
        startDoor({ room: room, side: side, width: w, doorH: h });
      }
    };
    const undo = last
      ? { label: '撤掉这扇门', fn: () => { const r = undoDoor(last); if (!r) ai('这扇门已经不在墙上了。'); } }
      : null;
    chips(undo ? [one, undo] : [one]);
  }

  function startDoor(p) {
    const room = p.room;
    if (!room) { ai('要在哪一间开？说个房间号，比如「3 楼 306」。'); return; }
    const side = pickDoorSide(room, p);
    if (!side) {
      /* 四面全是外墙：开门这条路对用户就没意义，说清楚并给两条别的路 */
      ai(room.num + ' 四面都是外墙，不能在上面开门（外墙兼承重，还要管防水）。' +
        '要连通只能往内墙方向想办法 —— 要么换一间挨着走廊的房，要么把它和隔壁打通。');
      chips([
        { label: '和隔壁打通', fn: () => send('把' + room.num + '和隔壁打通') },
        { label: '换一间房', fn: () => send('换一间房开门') }
      ]);
      return;
    }
    const wid = (room.sides || {})[side];
    const wall = M.walls.find(w => w.id === wid);
    if (!wall) { ai('这间房找不到对应的墙。'); return; }
    const swap = doorSideNote(room, p.sideRel || p.side, side);

    const w = p.width || 1.0, h = p.doorH || 2.1;
    ST.mode = 'door';
    ST.pending = { room, side, wall, width: w, height: h, pref: p.pref || null };
    S.mode = 'door';
    focusSoft(room, { color: false });
    /* 点选开门时也只留这一层：上下层的半透明墙会挡在镜头前面，门洞看不清 */
    S.isolateFloor && S.isolateFloor(room.floor);
    S.highlightWall(wall, 0x10a394);
    setMode('开门 · ' + room.num + ' ' + N.SIDE_CN[side] + '墙 · ' + w.toFixed(1) + 'm', cancelMode);

    let t = room.num + ' ' + N.SIDE_CN[side] + '边这面墙亮出来了，点一下要开的位置。';
    if (p.pref === 'corridor') t = '按你说的靠走廊，我选了' + N.SIDE_CN[side] + '边这面墙。点一下开门的位置。';
    if (w > 1.05 || Math.abs(w - 1.0) > 1e-6) t = '门宽按你说的 ' + w.toFixed(2) + ' 米、高 ' + h.toFixed(2) + ' 米。' + t;
    if (swap) t = swap + '。' + t;
    ai(t);
  }

  function pickDoor(hit, hits, ev) {
    const p = ST.pending, room = p.room;
    const list = (hits && hits.length ? hits : (hit ? [hit] : [])).filter(h => h.kind === 'wall');

    // 先用射线和该房间四面墙的平面求交，斜视角下也能落到正确的墙上
    const plan = ev && S.pickWallOfRoom ? S.pickWallOfRoom(room, ev) : null;
    let wall = null, at = 0;

    if (plan) { wall = plan.wall; at = plan.at; }
    else {
      let pick = list.find(h => h.data.rooms && h.data.rooms.indexOf(room.id) >= 0) || list[0];
      if (!pick) { toast('点一下要开门的那面墙'); return; }
      wall = pick.data;
      if (!(wall.rooms && wall.rooms.indexOf(room.id) >= 0)) { toast('这面墙不属于 ' + room.num + ' 室'); return; }
      const [ax, ay] = wall.p1, [bx, by] = wall.p2;
      const L = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      at = (pick.x - ax) * ux + (pick.y - ay) * uy;
    }

    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = Math.hypot(bx - ax, by - ay);
    at = clamp(at, 0, L);

    /* 外墙不许开：用户原话"随便说开个门的时候不能开在外墙！只能是走廊和内墙"。
       手点的位置也一样 —— 点到外墙上就当场说清，别偷偷把门开到外立面上去。 */
    if (wall.kind === 'ext') {
      S.highlightWall(wall, 0xdd534f);
      toast('外墙不能开门：外墙兼承重，还要管防水');
      ai('这面是外墙，不能在上面开门 —— 外墙兼承重，还得管防水和保温。' +
        '门只能开在走廊墙或者内隔墙上，往屋里那一侧点一下就行。');
      return;
    }

    // 一面长墙可能挨着好几个房间，把落点收进本房间对应的那一段
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
      .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
    const lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
    if (hi - lo > p.width + 0.5) {
      at = clamp(at, lo + p.width / 2 + 0.2, hi - p.width / 2 - 0.2);
    }

    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    let chk = C.door({ wall, at, w: p.width, h: p.height, equipments: eqs, room: room });
    S.markDoorSpot(wall, at, p.width, p.height, chk.pass);
    S.focusDoor(wall, at, room);

    /* 点的位置不合适，就走和语音开门同一套顺序：
       只撞线管 → 先牵线绕过；绕不过 → 顺着墙挪一点；都不行才拒绝。
       以前这里只有"能开 / 不能开"两档，用户手点反而比说一句话更难开成门。
       注意：线管属于"能靠改线解决"的，C.door 的 pass 仍会是 false，
       所以"能不能开"要看 holeDecision 的 ok，不能只看 chk.pass。 */
    let dec = null, ready = chk.pass;
    if (!ready) {
      dec = holeDecision(wall, {
        at: at, w: p.width, h: p.height, sill: 0,
        room: room, equipments: eqs, kind: 'door', noMove: true
      });
      if (dec.ok) {
        at = dec.at;
        chk = dec.chk || chk;
        ready = true;
        S.markDoorSpot(wall, at, p.width, p.height, true);
        S.focusDoor(wall, at, room);
      }
    }

    if (ready) {
      const rIds = [];
      const rerouted = (dec && dec.needReroute) ? applyReroutes(dec, rIds) : 0;
      const d = S.addDoorOpening(wall, at, p.width, p.height);
      d.room = room.id;
      if (rIds.length) d._reroutes = rIds;     // 撤门时把改道的线管放回原样
      syncElecAfterDoor();                      // 洞口变了，线管按新洞形重铺一遍
      ST.lastDoor = { wall, at, w: p.width, d, chk, room };
      rememberDoor(room, sideOfWall(room, wall) || p.side, p.width, p.height);
      ST.mode = 'idle'; S.mode = 'idle';
      finishMode();
      S.clearHighlight();
      S.markDoorSpot(wall, at, p.width, p.height, true);
      /* 是靠牵线 / 挪位才开成的，得如实说清楚，不然用户以为墙里本来就没管 */
      if (dec && (dec.needReroute || dec.moved)) {
        showHoleConflict(wall, dec.hits, dec.reroutes);
        ai('这个位置墙里有 ' + (dec.hits || []).length + ' 根线管，' +
          (dec.moved ? dec.moveNote + '；' : '') +
          (dec.rerouteNote ? dec.rerouteNote + '。' : '') +
          p.width.toFixed(2) + ' 米宽的门已经开在距墙端 ' + C.fmt(at, 2) + ' 米处。' +
          '红色的两个断头是管子原来穿门洞的位置（已经凿断），绿色是改完的新走向，绕行多走的线也补上了。',
          conduitCard(dec.hits, dec.reroutes || [], dec));
        doorPointChips(room, sideOfWall(room, wall) || p.side, p.width, p.height, '再挑个位置');
        return;
      }
      const warnTxt = (chk.warns || []).length ? '<div class="res-adv" style="border-top:1px solid #eef1f5">' + chk.warns.map(w => '<s>·</s> ' + w).join('<br>') + '</div>' : '';
      ai('这面墙可以开，' + p.width.toFixed(2) + ' 米宽的门已经放上去了。',
        '<div class="res ok"><div class="res-top"><span class="k">可以开</span><span class="tag">没有碰撞</span></div>' +
        '<div class="res-grid"><div><i>门宽</i><b>' + p.width.toFixed(2) + ' m</b></div>' +
        '<div><i>门高</i><b>' + p.height.toFixed(2) + ' m</b></div></div>' + warnTxt + '</div>');
      if ((chk.warns || []).length) ai(chk.warns[0] + '，先记一笔。', null, false);
      doorPointChips(room, sideOfWall(room, wall) || p.side, p.width, p.height, '再挑个位置');
    } else {
      ST.mode = 'idle'; S.mode = 'idle';
      finishMode();
      S.highlightWall(wall, 0xdd534f);
      const list2 = chk.blocks.map(b => '<s>·</s> ' + b.t).join('<br>');
      ai('这个位置不行，门会撞上东西。',
        '<div class="res bad"><div class="res-top"><span class="k">开不了</span><span class="tag">有碰撞</span></div>' +
        '<div class="res-adv">' + list2 + '</div></div>');

      const cs = [];
      /* 先看是不是"刚刚撤掉的那扇门"：用户撤了再点回来，多半就是想原样开回去。
         这时不要只冷冷地报"会撞上东西"（他上一次明明开成了），
         直接把那扇门的位置给出来，一点就照原样开回去（该改线还是会改线）。 */
      const lu = ST.lastUndone;
      if (lu && lu.wall === wall.id && lu.at != null && Date.now() - lu.t < 30 * 60 * 1000) {
        cs.push({
          label: '开回刚才撤掉的 ' + C.fmt(lu.at, 2) + ' 米处', fn: () => {
            const r2 = openDoorHere(wall, room, lu.at, lu.w, lu.h);
            if (!r2.ok) { ai('刚才那个位置现在也开不了了：' + (r2.dec && r2.dec.why || '原因不明')); return; }
            ST.lastUndone = null;
            ai('照刚才那扇的尺寸开回去了（' + C.fmt(lu.at, 2) + ' 米处），门已经放到墙上。' +
              (r2.ids && r2.ids.length ? '为它改道的 ' + r2.ids.length + ' 根线管也重新改好了。' : ''),
              '<div class="res ok"><div class="res-top"><span class="k">开回原位</span><span class="tag">已就位</span></div>' +
              '<div class="res-grid"><div><i>门宽</i><b>' + lu.w.toFixed(2) + ' m</b></div>' +
              '<div><i>门高</i><b>' + lu.h.toFixed(2) + ' m</b></div></div></div>');
            doorPointChips(room, sideOfWall(room, wall) || p.side, lu.w, lu.h, '再挑个位置');
          }
        });
      }
      const sug = C.suggestDoorAt({ wall, room, at: at, w: p.width, h: p.height, equipments: eqs });
      if (sug && sug.d >= 0.25 && sug.d < 3.2) {
        cs.push({
          label: '挪 ' + sug.d.toFixed(1) + ' 米就能开', fn: () => {
            /* 走完整链路：这个位置要动哪几根线管，一并规划好再开 */
            const r2 = openDoorHere(wall, room, sug.at, p.width, p.height);
            if (!r2.ok) { ai('往旁边挪 ' + sug.d.toFixed(1) + ' 米还是不行：' + (r2.dec && r2.dec.why || '原因不明')); return; }
            S.focusDoor(wall, r2.dec.at, room);
            ai('往旁边挪了 ' + sug.d.toFixed(1) + ' 米，这里能开，门已经放上去了。' +
              ((r2.dec.needReroute) ? '这个位置墙里有 ' + (r2.dec.hits || []).length + ' 根线管，' + (r2.dec.rerouteNote || '已经改线绕开') + '。' : ''),
              '<div class="res ok"><div class="res-top"><span class="k">可以开</span><span class="tag">无碰撞</span></div>' +
              '<div class="res-grid"><div><i>门宽</i><b>' + p.width.toFixed(2) + ' m</b></div><div><i>门高</i><b>' + p.height.toFixed(2) + ' m</b></div></div></div>');
            doorPointChips(room, sideOfWall(room, wall) || p.side, p.width, p.height, '再挑个位置');
          }
        });
      }
      cs.push({ label: '换个位置自己点', fn: () => { ST.mode = 'door'; S.mode = 'door'; ST.pending = p; setMode('开门 · ' + room.num, cancelMode); S.highlightWall(wall, 0x10a394); } });
      cs.push({ label: '换个方向', fn: () => { ST.mode = 'door'; S.mode = 'door'; ST.pending = p; setMode('开门 · ' + room.num, cancelMode); S.highlightRoom(room, 0x10a394); ai('那就在这间房的其它墙上点一下。'); } });
      chips(cs);
    }
  }

  /* ---------------- 阀门 / 管线影响 ---------------- */
  function downstream(v) {
    const kids = M.valves.filter(x => x.parent === v.id);
    let out = (v.serves || []).slice();
    kids.forEach(k => { out = out.concat(downstream(k)); });
    return out;
  }

  function affectedRooms(v) {
    const ids = Array.from(new Set(downstream(v)));
    return ids.map(id => M.rooms.find(r => r.id === id)).filter(Boolean);
  }

  /* 关闭/打开一个阀 → 受影响的房间 + 每条具体路由 */
  function valveImpact(v) {
    const R = window.BIM.routes;
    if (!M._routes) R.prepare(M);
    const hasTree = M.valves.some(x => x.parent);
    let rooms = [], pairs = [];

    if (hasTree) {
      rooms = affectedRooms(v);
      rooms.forEach(r => {
        const ids = R.pathToRoom(M, v, r.id);
        if (ids && ids.length) pairs.push({ ids: ids, room: r.id });
      });
    }
    if (!pairs.length) {
      const g = R.geoReach(M, v);
      if (!rooms.length) rooms = g.rooms;
      const keepIds = {};
      rooms.forEach(r => { keepIds[r.id] = 1; });
      g.paths.forEach(p => p.rooms.forEach(rid => {
        if (keepIds[rid]) pairs.push({ ids: p.ids, room: rid });
      }));
      // 几何上没找到房间，起码把阀所在管段画出来
      if (!pairs.length) {
        const own = M._routes.valveDuct[v.id];
        if (own) pairs.push({ ids: [own], room: null });
      }
    }

    // 同一串管段的房间并成一档
    const map = {};
    pairs.forEach(p => {
      const k = p.ids.join('>');
      if (!map[k]) map[k] = { ids: p.ids, rooms: [] };
      if (p.room && map[k].rooms.indexOf(p.room) < 0) map[k].rooms.push(p.room);
    });
    const paths = Object.keys(map).map(k => map[k])
      .filter(p => p.rooms.length)
      .sort((a, b) => a.ids.length - b.ids.length);

    paths.forEach(p => {
      p.names = p.rooms.map(id => (M.rooms.find(r => r.id === id) || {}).num).filter(Boolean);
    });
    return { rooms: rooms, paths: paths };
  }

  function allRouteIds(impact) {
    const out = [];
    impact.paths.forEach(p => p.ids.forEach(id => { if (out.indexOf(id) < 0) out.push(id); }));
    return out;
  }

  function selectRoute(v, path, all) {
    if (!ST.ducts) { ST.ducts = true; S.setDuctsVisible(true); }
    S.highlightRoute(path ? path.ids : all);
    const rooms = path && path.rooms.length
      ? M.rooms.filter(r => path.rooms.indexOf(r.id) >= 0)
      : M.rooms.filter(r => all.indexOf(r.id) >= 0 && all);
    S.highlightRooms(rooms, 0xe08a2b);
    const b = RT().bounds(M, path ? path.ids : []);
    if (b) S.focusBounds(v.floor, b.x0 - 1.2, b.y0 - 1.2, b.x1 + 1.2, b.y1 + 1.2);
  }

  function startValve(p) {
    const room = p.room;
    let v = null;
    // 点名了阀号就直接用（大模型/工具会这么传）
    if (p.valve) v = M.valves.find(x => x.id === p.valve || x.name === p.valve) || null;
    if (!v && room) {
      const cands = M.valves.filter(x => x.room === room.id);
      v = cands.find(x => x.kind === 'main') || cands.find(x => x.kind === 'zone') || cands[0];
      if (!v) {
        const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
        v = M.valves.filter(x => x.floor === room.floor)
          .sort((a, b) => (Math.hypot(a.pos[0] - cx, a.pos[1] - cy) - Math.hypot(b.pos[0] - cx, b.pos[1] - cy)))[0];
      }
    }
    if (!v) { ai('要关哪个阀？说个房间就行，比如「4 楼 405」。'); return; }
    ST.mode = 'valve'; S.mode = 'valve';
    const wantOpen = p.valveAction === 'open';
    toggleValve(v, wantOpen, true);
  }

  function toggleValve(v, open, speak) {
    S.setValve(v, open);
    const im = valveImpact(v);
    const rooms = im.rooms;
    const bs = rooms.length ? rooms : [{ x0: v.pos[0] - 3, y0: v.pos[1] - 3, x1: v.pos[0] + 3, y1: v.pos[1] + 3 }];
    const x0 = Math.min.apply(null, bs.map(r => r.x0).concat([v.pos[0]])) - 1.5;
    const y0 = Math.min.apply(null, bs.map(r => r.y0).concat([v.pos[1]])) - 1.5;
    const x1 = Math.max.apply(null, bs.map(r => r.x1).concat([v.pos[0]])) + 1.5;
    const y1 = Math.max.apply(null, bs.map(r => r.y1).concat([v.pos[1]])) + 1.5;
    S.focusBounds(v.floor, x0, y0, x1, y1);
    S.highlightRooms(rooms, 0xe08a2b);
    beginFlowVisual(v, im);
    showTopo(v, im);
    setMode('阀门 · 点阀件任意开关', cancelMode);

    const names = rooms.map(r => r.num).join('、');
    if (open) {
      ai(v.name + ' 已经打开，' + (rooms.length ? names + ' 的送风恢复了。' : '系统恢复正常。'));
    } else {
      ai(v.name + ' 关掉了，' + (rooms.length ? '有 ' + rooms.length + ' 个房间会没风：' + names + '。' : '暂时没有房间受影响。'));
      if (rooms.length > 4) ai('这层几乎整层都靠它供风，建议先通知使用方，别赶在工作时间关。', null, false);
    }
    ST.lastValve = v;
    // 阀门也算上下文：下一句「那 3 楼呢」能接着问
    const AM = window.BIM.agent.mem;
    AM.lastValve = v;
    if (v.room) {
      const vr = M.rooms.find(r => r.id === v.room);
      if (vr) { AM.ctx.room = vr; AM.ctx.floor = vr.floor; }
    } else AM.ctx.floor = v.floor;
  }

  function pickValve(hit) {
    if (!hit || hit.kind !== 'valve') { toast('点一下绿色的阀件'); return; }
    toggleValve(hit.data, !hit.data.open, true);
  }

  function showTopo(v, im) {
    const p = $('pTopo');
    $('topoTitle').textContent = '送风管路 · ' + v.name;
    const hasTree = M.valves.some(x => x.parent);
    let treeHtml = '';

    if (hasTree) {
      let root = v, guard = 0;
      const seen = {};
      while (root.parent && !seen[root.id] && guard++ < 20) {
        seen[root.id] = 1;
        const par = M.valves.find(x => x.id === root.parent);
        if (!par) break;
        root = par;
      }
      const build = (valve, depth) => {
        const pad = depth * 12;
        const cur = valve.id === v.id;
        let h = '<div class="topo-row' + (valve.open ? '' : ' closed') + (cur ? ' cur' : '') + '" ' +
          'data-vid="' + valve.id + '" style="padding-left:' + pad + 'px">' +
          (depth ? '<span class="bar"></span>' : '') +
          '<span class="nd">' + (valve.open ? '●' : '○') + ' ' + valve.name + '</span></div>';
        M.valves.filter(x => x.parent === valve.id).forEach(k => { h += build(k, depth + 1); });
        return h;
      };
      treeHtml = '<div class="topo-tree">' + build(root, 0) + '</div>';
    }

    const paths = im.paths || [];
    let routeHtml = '';
    if (paths.length) {
      routeHtml = '<div class="topo-sep"></div>' +
        '<div class="tp-lb">影响路径 ' + paths.length + ' 条 · 点一条看它走哪</div>' +
        paths.slice(0, 6).map((p2, i) =>
          '<div class="tp-row" data-ri="' + i + '">' +
          '<span class="tp-no">' + (i + 1) + '</span>' +
          '<span class="tp-txt"><b>' + (p2.names.length ? p2.names.join('、') : '仅管路') + '</b>' +
          '<i>' + p2.ids.length + ' 段风管</i></span>' +
          '<button class="tp-go">高亮</button></div>'
        ).join('') +
        (paths.length > 6 ? '<div class="tp-more">还有 ' + (paths.length - 6) + ' 条同向路径</div>' : '');
    }

    $('topoBody').innerHTML =
      treeHtml + routeHtml +
      '<div class="topo-sep"></div>' +
      '<div class="tp-lb">受影响房间 ' + im.rooms.length + ' 间</div>' +
      '<div class="tags">' + (im.rooms.length ? im.rooms.map(r => '<span>' + r.num + '</span>').join('') : '<span style="background:#eef2f6;color:#8b95a2">无</span>') + '</div>';

    $('topoBody').querySelectorAll('.tp-row').forEach(row => {
      row.onclick = () => {
        const p2 = paths[+row.dataset.ri];
        $('topoBody').querySelectorAll('.tp-row').forEach(x => x.classList.remove('on'));
        row.classList.add('on');
        selectRoute(v, p2, allRouteIds(im));
        toast('已高亮第 ' + (+row.dataset.ri + 1) + ' 条路由');
      };
    });
    $('topoBody').querySelectorAll('.topo-row').forEach(row => {
      row.onclick = () => {
        const nv = M.valves.find(x => x.id === row.dataset.vid);
        if (nv && nv.id !== v.id) toggleValve(nv, nv.open, false);
      };
    });
    openPanel('pTopo');
  }

  /* ---------------- 属性 ---------------- */
  const RIGHT_PANELS = ['pProps', 'pEquip', 'pCalc', 'pTopo'];
  /* 模型树 pTree 故意不在这组里：它是导航面板，可以和属性面板同屏，
     这也正是「点树看构件」该有的样子，跟别的功能不抢位置。 */
  function openPanel(id) {
    if (S.hideTip) S.hideTip();
    RIGHT_PANELS.forEach(x => { if (x !== id) $(x).hidden = true; });
    if (id !== 'pTopo') endFlowVisual();
    /* 切到别的面板就别再亮着计算书那块板：门、窗、设备都改完了还挂两块蓝板，
       看着像"还在算这一块"，实际早就不关了。 */
    if (id !== 'pCalc') endCalcPlate();
    $(id).hidden = false;
  }

  /* "计算书算的是这块板"的蓝色高亮：只在计算书面板开着的时候亮 */
  function endCalcPlate() {
    if (!ST.calcLit) return;
    ST.calcLit = false;
    S.clearHighlight && S.clearHighlight();
  }

  /* 流向/路由高亮只在「问某个阀门影响哪些房间」的时候亮，
     关掉影响面板、切去别的面板、复位视角都把它收掉，平时画面是干净的。 */
  function endFlowVisual() {
    if (ST.flowOn) {
      ST.flowOn = false;
      S.setFlow(false);
      S.clearRoute && S.clearRoute();
    }
  }

  /* 反过来：要讲影响就先把这一层的风管露出来、聚焦到那层，再把流向打开 */
  function beginFlowVisual(v, im) {
    if (!ST.ducts) { ST.ducts = true; S.setDuctsVisible(true); }
    if (v && v.floor && S.focus !== v.floor) {
      ST.focus = v.floor;
      S.setFocus(v.floor, false);
    }
    const d = window.BIM.detail;
    if (d && d.setFlow) {
      S.setFlow(true);
      ST.flowOn = true;
    } else if (im) {
      S.highlightRoute(allRouteIds(im));     // 没有真实感层时退回"整条路由涂色"
    }
    paintFloors();                            // 模型树跟着跳到这一层
  }

  function kv(a, b, cls) { return '<div class="kv"><i>' + a + '</i><b' + (cls ? ' class="' + cls + '"' : '') + '>' + b + '</b></div>'; }

  function showProps(hit) {
    const p = $('pProps'), body = $('propsBody');
    let title = '属性', html = '';
    const d = hit.data;
    if (hit.kind === 'room') {
      const r = d;
      const ZONE = { south: '南侧', north: '北侧', corr: '走廊', core: '核心筒' };
      const eqs = (ST.placed || []).filter(e => e.room === r.id);
      title = r.num + ' ' + (r.use || '');
      html = kv('房间编号', r.num) + kv('用途', r.use || '—') + kv('面积', r.area + ' m²') +
        kv('所在楼层', r.floor + ' F') + kv('楼面标高', '+' + r.elev.toFixed(2) + ' m') +
        kv('活荷载标准值', r.live.toFixed(1) + ' kN/m²') + kv('分区', ZONE[r.zone] || r.zone || '—') +
        kv('板厚 / 混凝土', (r.slab.thk * 1000) + ' mm / ' + r.slab.grade) +
        kv('房间里的设备', eqs.length ? eqs.length + ' 台' : '空着');
      ST.selRoom = r;
    } else if (hit.kind === 'column') {
      title = '框架柱 · ' + d.id;
      html = kv('截面', (d.s * 1000).toFixed(0) + '×' + (d.s * 1000).toFixed(0) + ' mm') +
        kv('柱高', d.h.toFixed(2) + ' m') + kv('所在楼层', d.floor + ' F') +
        kv('柱底标高', '+' + d.z.toFixed(2) + ' m') +
        kv('轴网位置', 'X ' + d.x.toFixed(2) + ' / Y ' + d.y.toFixed(2));
    } else if (hit.kind === 'beam') {
      const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
      title = '框架梁 · ' + d.id;
      html = kv('截面', (d.w * 1000).toFixed(0) + '×' + (d.h * 1000).toFixed(0) + ' mm') +
        kv('跨度', len.toFixed(2) + ' m') + kv('走向', d.axis === 'x' ? 'X 向（南北）' : 'Y 向（东西）') +
        kv('梁顶标高', '+' + d.a[2].toFixed(2) + ' m') + kv('所在楼层', d.floor + ' F');
    } else if (hit.kind === 'equip') {
      title = d.name;
      const r = ST.last && ST.last.equip && ST.last.equip.id === d.id ? ST.last : null;
      const fi = faceInfo(M.rooms.find(x => x.id === d.room), d);
      html = kv('设备编号', d.id) + kv('单重', (d.weight / 1000).toFixed(2) + ' t') +
        kv('外形尺寸', d.w.toFixed(2) + '×' + d.d.toFixed(2) + '×' + d.h.toFixed(2) + ' m') +
        kv('所在楼层', d.floor + ' F') + kv('所在房间', (M.rooms.find(x => x.id === d.room) || {}).num || '—') +
        kv('放置坐标', d.x.toFixed(2) + ', ' + d.y.toFixed(2)) +
        (fi ? kv('正面朝向', faceTxt(fi).replace('正面朝', '').replace('，背靠', ' · 背靠')) : '') +
        (r ? kv('安全系数', C.fmt(r.K), r.v.cls) + kv('最多可放', (r.Pmax_kg / 1000).toFixed(2) + ' t') : '');
      ST.sel = d;
    } else if (hit.kind === 'slab') {
      const room = M.rooms.find(r => r.id === d.room);
      title = '楼板 · ' + (room ? room.num : d.room);
      html = kv('房间用途', room ? room.use : '—') +
        kv('面积', (room ? room.area : 0) + ' m²') +
        kv('板厚', (d.thk * 1000) + ' mm') + kv('混凝土', d.slab.grade) +
        kv('配筋', 'φ' + d.slab.dia + '@' + d.slab.sp) +
        kv('活荷载标准值', room.live.toFixed(1) + ' kN/m²');
      ST.selRoom = room;
    } else if (hit.kind === 'wall') {
      title = '墙 · ' + d.name;
      html = kv('类型', d.kind === 'ext' ? '外墙' : (d.kind === 'corr' ? '走廊隔墙' : '内隔墙')) +
        kv('厚度', (d.t * 1000) + ' mm') + kv('高度', d.h.toFixed(2) + ' m') +
        kv('所属房间', d.rooms.join(' / ') || '—') +
        kv('洞口', d.openings.length + ' 个');
    } else if (hit.kind === 'door') {
      title = '门 · ' + d.name;
      html = kv('编号', d.name) + kv('宽度', d.w.toFixed(2) + ' m') + kv('高度', d.h.toFixed(2) + ' m') +
        kv('所在墙', d.wall) + kv('状态', d.added ? '新增' : '原有');
    } else if (hit.kind === 'window') {
      title = '窗 · ' + (d.name || '窗');
      const wr = (d.rooms || []).map(id => (M.rooms.find(r => r.id === id) || {}).num).filter(Boolean);
      html = kv('编号', d.name || '—') + kv('宽度', (d.w || 0).toFixed(2) + ' m') +
        kv('高度', (d.h || 0).toFixed(2) + ' m') + kv('窗台高', ((d.sill || 0)).toFixed(2) + ' m') +
        kv('窗顶标高', ((d.sill || 0) + (d.h || 0)).toFixed(2) + ' m') +
        kv('所在墙', d.wall || '—') + kv('所属房间', wr.join(' / ') || '—') +
        kv('状态', d.added ? '新增' : '原有');
    } else if (hit.kind === 'duct') {
      const idx = M._routes || window.BIM.routes.prepare(M);
      const rs = (idx.ductRooms[d.id] || []).map(id => (M.rooms.find(r => r.id === id) || {}).num).filter(Boolean);
      const vs = (idx.ductValve[d.id] || []).map(id => (M.valves.find(v => v.id === id) || {}).name).filter(Boolean);
      title = '风管 · ' + (d.name || d.id);
      html = kv('规格', (d.w * 1000).toFixed(0) + '×' + (d.h * 1000).toFixed(0) + ' mm') +
        kv('长度', Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2]).toFixed(2) + ' m') +
        kv('管中标高', d.a[2].toFixed(2) + ' m') +
        kv('经过房间', rs.length ? rs.join('、') : '—') +
        kv('相关阀件', vs.length ? vs.join('、') : '—');
    } else if (hit.kind === 'valve') {
      title = '阀 · ' + d.name;
      const rooms = valveImpact(d).rooms;
      html = kv('类型', { main: '楼层总阀', zone: '分区阀', room: '支管阀' }[d.kind] || '阀件') +
        kv('所在房间', (M.rooms.find(r => r.id === d.room) || {}).num || d.room || '—') +
        kv('状态', d.open ? '开启' : '关闭', d.open ? 'ok' : 'bad') +
        kv('影响房间', rooms.length + ' 间');
      ST.lastValve = d;
    }
    $('propsTitle').textContent = title;
    body.innerHTML = html || '<div style="color:#93a0ad;font-size:11px">没有可显示的属性</div>';
    openPanel('pProps');
    // 模型树跟着点选走：树上展开到这一件并高亮（树没开就只记状态，不打扰）
    const T = window.BIM.tree;
    if (T && hit.kind !== 'room') T.reveal(hit.kind, d);
  }

  /* ---------------- 计算书 ---------------- */
  /* 看计算书时才亮"算的是哪块板"：打通了两间就两块板一起亮。
     用户原话："点开查看计算书的时候需要高亮对应的区块，如果是打通的计算书 应该是对应俩块板"。
     强调"只在看计算书这一刻亮" —— 平时不亮，否则就是一路盖着的那块绿色区块。 */
  function showCalcPlate(r) {
    if (!r || !r.room) return null;
    const pl = r.plate || null;
    const rooms = (pl && pl.merged && pl.rooms && pl.rooms.length) ? pl.rooms.slice() : [r.room];
    S.highlightRooms(rooms, 0x2f7df6);
    ST.calcLit = true;
    const floor = r.room.floor;
    const b = rooms.reduce((a, x) => ({
      x0: Math.min(a.x0, x.x0), y0: Math.min(a.y0, x.y0),
      x1: Math.max(a.x1, x.x1), y1: Math.max(a.y1, x.y1)
    }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
    S.setFocus(floor, false);
    /* 板子只剩屏幕角落一小块的时候，计算书上的数字对不上画面，得把镜头摆过去 */
    if (!S.inView || !S.inView(floor, b.x0, b.y0, b.x1, b.y1, 0.12, 0.2)) {
      S.frameBounds(floor, b.x0 - 0.8, b.y0 - 0.8, b.x1 + 0.8, b.y1 + 0.8, true, 0.8);
    }
    return { rooms: rooms.map(x => x.num), merged: !!(pl && pl.merged) };
  }
  window.BIM.showCalcPlate = showCalcPlate;

  function openCalc() {
    if (!ST.last) { toast('先放一台设备再来看计算书'); return; }
    $('calcBody').innerHTML = C.book(ST.last);
    openPanel('pCalc');
    const lit = showCalcPlate(ST.last);
    if (lit) lastData = Object.assign({}, lastData, { calc_plate: lit.rooms, calc_merged: lit.merged });
  }
  window.BIM.openCalc = openCalc;      // 回归/自检要能直接开这一屏

  function downloadCalc() {
    if (!ST.last) return;
    const r = ST.last;
    const html = '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>单板承载力计算书</title>' +
      '<style>body{font-family:-apple-system,"Microsoft YaHei";max-width:760px;margin:40px auto;padding:0 24px;color:#222;line-height:1.7}' +
      'h1{font-size:20px;border-bottom:2px solid #10a394;padding-bottom:10px}h3{font-size:14px;margin:18px 0 6px;color:#0b7f74}' +
      'table{width:100%;border-collapse:collapse;font-size:12.5px}td{padding:5px 8px;border-bottom:1px solid #eee}' +
      'td:last-child{text-align:right;font-weight:600}.f{font-family:monospace;background:#f6f8fa;padding:8px;border-radius:6px;font-size:12px}' +
      '.concl{background:#e7f7f4;padding:14px;border-radius:8px;margin-top:12px}.sub{color:#888;font-size:12px}</style>' +
      '<h1>单板承载力校核计算书</h1>' +
      '<div class="sub">AIbim 运维系统 · 滨海科创中心 A 座 · ' + r.room.num + ' 室 · ' + new Date().toLocaleString('zh-CN') + '</div>' +
      C.book(r) + '</body></html>';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '计算书_' + r.room.num + '_' + r.equip.name + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ---------------- 设备库 ---------------- */
  function openEquip() {
    const body = $('equipBody');
    body.innerHTML = M.equipmentLibrary.map(e =>
      '<div class="eq-item" data-id="' + e.id + '"><span class="eq-dot" style="background:' + e.color + '"></span>' +
      '<span class="eq-n">' + e.name + '</span><span class="eq-w">' + (e.weight / 1000).toFixed(1) + ' t</span></div>'
    ).join('');
    body.querySelectorAll('.eq-item').forEach(el => {
      el.onclick = () => {
        const e = M.equipmentLibrary.find(x => x.id === el.dataset.id);
        ST.device = e;
        $('pEquip').hidden = true;
        if (ST.mode === 'place' && ST.pending) {
          ST.pending.device = e;
          ai('换成 ' + e.name + ' 了，在 ' + ST.pending.room.num + ' 室里点一下位置。');
        } else {
          toast('已选 ' + e.name + '，说一句「放到 2 楼 202」');
        }
      };
    });
    openPanel('pEquip');
  }

  /* ---------------- 状态条 ---------------- */
  function setMode(text, cancel) {
    if (S.hideTip) S.hideTip();
    const c = $('modeChip');
    $('modeTxt').textContent = text;
    c.hidden = false;
    c.querySelector('#modeCancel').onclick = cancel;
  }
  function finishMode() {
    $('modeChip').hidden = true;
    ST.mode = 'idle'; S.mode = 'idle'; ST.pending = null;
  }
  function cancelMode() {
    finishMode();
    S.clearHighlight();
    S.markDoorSpotClear && S.markDoorSpotClear();
    ai('好，先不放了。');
  }

  /* ---------------- 输入分发（对话智能体：上下文 + 任务拆解） ---------------- */
  let busy = false;

  function startTyping() {
    const d = document.createElement('div');
    d.className = 'msg ai typing';
    d.innerHTML = '<div class="av">AI</div><div class="body"><span class="dots"><i></i><i></i><i></i></span></div>';
    d.style.opacity = '0';
    chat.appendChild(d);
    scrollBottom();
    const t = setTimeout(() => { d.style.opacity = '1'; }, 260);   // 太快就不闪一下
    // 推理型模型首包慢，超过 6 秒补一句「还在想」，别让人以为死机
    const s = setTimeout(() => {
      const b = d.querySelector('.body');
      if (b) b.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="slow">大模型还在想…</span>';
    }, 6000);
    return { el: d, t: t, s: s };
  }
  function stopTyping(x) {
    if (!x) return;
    clearTimeout(x.t); clearTimeout(x.s);
    if (x.el && x.el.parentNode) x.el.parentNode.removeChild(x.el);
  }

  /* 工具执行器：Agent 循环每调一次工具都走这里，
     顺便把"模型到底调了什么"记下来，诊断面板和回归脚本都看这份 */
  async function toolExec(name, args) {
    const A = window.BIM.agent;
    const map = A.toolToStep || {};
    let step = null;
    if (map[name]) {
      try { step = A.fillStep(Object.assign(map[name](args || {}), { text: '', tool: name })); }
      catch (e) { step = null; }
    }
    const out = await window.BIM.mcp.call(name, args || {});
    if (step) { step.ok = !!(out && out.ok !== false); toolSteps.push(step); }
    return out;
  }

  async function send(text) {
    if (!text || busy) return;
    me(text);
    busy = true;
    ST.mute = false; ST.quiet = false;
    const typing = startTyping();
    const A = window.BIM.agent;

    let plan = null, loopRes = null;
    lastSay = ''; lastHtml = ''; sayBuf = []; chipQ = []; lastData = null; toolSteps = [];

    /* ① 先走 Agent 循环：模型可以连着调几次工具、看着执行结果改方案。
       以前只发一次请求，模型根本看不到结果，只能反问用户——这就是"像没执行"的根。 */
    if (A.cfg.on && A.loop) {
      loopQuiet = true;
      try { loopRes = await A.loop(text, toolExec); }
      catch (e) { loopRes = { ok: false, err: String((e && e.message) || e) }; }
      loopQuiet = false;

      /* ── "说了要动手、模型却只查了一下" ──
         用户的原话："关闭空开这个模糊指令跟回路控制得到的结果不一致，关闭空开是没有关闭"。
         本地说得清清楚楚是"关电"（circuitset），模型却没调 toggle_circuit，
         回头列了一屏分路 —— 屏幕上就是"什么都没关"。
         碰到这种情况以本地解析为准：同一句话按同一个执行器跑，结果才一致。 */
      if (loopRes && loopRes.ok && loopRes.calls > 0 && A.local) {
        const lp0 = A.local(text);
        const wantAct = (lp0.steps || []).some(s => s.act === 'circuitset' || s.act === 'valve');
        const onlyQuery = (loopRes.trace || []).length > 0
          && loopRes.trace.every(t => /^(query_|list_)/.test(t.name));
        if (wantAct && onlyQuery) {
          sayBuf = []; chipQ = []; lastSay = ''; lastHtml = '';   // 模型"只查"的那一屏不再重复展示
          loopRes = null;
          plan = lp0;                                            // 直接按本地解析执行，不再问模型第二遍
        }
      }

      if (loopRes && loopRes.ok && loopRes.calls > 0) {
        stopTyping(typing); busy = false;
        window.BIM._lastPlan = {
          source: 'llm', tools: loopRes.trace.map(t => t.name), steps: toolSteps.slice(),
          reply: loopRes.reply, trace: loopRes.trace, rounds: loopRes.rounds, calls: loopRes.calls
        };
        const said = sayBuf.filter(Boolean);
        const modelSay = String(loopRes.reply || '').trim();
        const lastLocal = said.length ? said[sayBuf.length - 1] : '';
        ST.mute = false;
        /* 单步：本地回执最准（安全系数、两侧余量都是实算的）。
           多步：模型看到了每一步的结果，让它综合说；它说得太空就把本地那条补上。 */
        let body;
        if (loopRes.calls > 1) {
          const solid = modelSay && /[0-9]|米|系数|吨|室|门/.test(modelSay);
          body = solid ? modelSay : (modelSay ? modelSay + (lastLocal ? '　' + lastLocal : '') : lastLocal);
        } else {
          body = lastLocal || modelSay;
        }
        if (body) ai(body, lastHtml || null, true);
        else ai('这一步没办成，换个说法？比如「把空压机放到 5 楼 506 靠走廊」。');
        flushChips();
        paintAI();
        notifyLLMDown();
        return;
      }

      if (loopRes && !loopRes.ok) {
        A.llmState = { ok: false, msg: loopRes.err || '未返回', hint: loopRes.hint || '', at: Date.now() };
      }

      /* 模型一个字都没动手：本地能解析出实质动作就本地办，实在办不了才用它那句回答 */
      if (loopRes && loopRes.ok && !(loopRes.calls > 0)) {
        const lp = A.local(text);
        const real = lp.steps && lp.steps.length && lp.steps[0].act !== 'unknown';
        if (real) { lp.reply = ''; plan = lp; }
        else if (loopRes.reply) {
          stopTyping(typing); busy = false;
          window.BIM._lastPlan = { source: 'llm', tools: [], steps: [], reply: loopRes.reply };
          ST.mute = false;
          ai(loopRes.reply, null, true);
          flushChips(); paintAI(); notifyLLMDown();
          return;
        }
      }
    }

    /* ② 循环这条路不通（没接大模型 / 模型不认 tools）：退回一句一规划 */
    if (!plan) {
      try { plan = await A.plan(text); } catch (e) { plan = null; }
    }
    stopTyping(typing);
    busy = false;
    paintAI();
    window.BIM._lastPlan = plan;      // 调试用：看这句被拆成了什么
    notifyLLMDown();

    if (!plan || !plan.steps || !plan.steps.length) { fallbackSay(text); return; }
    await runPlan(plan, text);
  }

  /* 大模型连不上时，只在原因变化时说一次，别每句都刷 */
  let lastLLMNotice = '';
  function shortReason(msg) {
    const m = /HTTP (\d{3})/.exec(String(msg || ''));
    if (m) return '对方返回 ' + m[1];
    if (/等太久/.test(msg)) return '等太久没回';
    if (/连不上/.test(msg)) return '连不上服务器';
    if (/JSON/.test(msg)) return '回的格式对不上';
    return String(msg || '没回').slice(0, 20);
  }
  function notifyLLMDown() {
    const A = window.BIM.agent;
    if (!A.cfg.on) { lastLLMNotice = ''; return; }
    if (A.llmState.ok !== false) { lastLLMNotice = ''; return; }
    const msg = A.llmState.msg || '没回';
    if (msg === lastLLMNotice) return;
    lastLLMNotice = msg;
    const hint = A.llmState.hint && A.llmState.hint !== msg ? A.llmState.hint : '';
    sys('大模型没接上（' + shortReason(msg) + '）' + (hint ? '，' + hint : '') + ' —— 这句先用本地理解');
  }

  async function runPlan(plan, raw) {
    const A = window.BIM.agent;
    const acts = plan.steps.filter(s => s.act !== 'unknown');
    const doing = acts.filter(s => s.act !== 'ask');

    // 只是提问/解释：一条回复收尾，别再补一句"没听清"
    if (!doing.length) {
      if (plan.reply) { ai(plan.reply, null, true); paintAI(); return; }
      if (acts.length) { await A.exec(plan, io); paintAI(); return; }
      fallbackSay(raw);           // 全是 unknown：交给兜底，只说一条
      return;
    }

    const auto = doing.length > 1;      // 多步任务：不再要求逐个点击，直接排好
    ST.quiet = auto;
    ST.mute = true;                     // 执行期间只说最后一句话
    lastSay = ''; lastHtml = ''; sayBuf = [];
    chipQ = [];
    const res = await A.exec(plan, io);
    ST.mute = false; ST.quiet = false;
    const said = sayBuf.filter(Boolean).join(' ');

    // 工具模式下以执行结果为准（带真实数字）；老式 JSON 步骤则以模型的话为准
    const fromTool = plan.tools && plan.tools.length;
    const say = fromTool ? (said || plan.reply) : (plan.reply || said);
    if (say) ai(say, lastHtml);
    else if (res.fails.length) ai('这句我没完全接住，换个说法？比如「把空压机放到 2 楼 202 靠里」。');
    flushChips();                       // 该给的选择项，等话说完再弹
    paintAI();
  }

  /* 执行器：agent 只产出步骤，具体动作仍由这里落地 */
  const io = {
    /* 工具/大模型点名要做的动作一律直接落地，不再停下来等用户点 */
    place: async (step, plan) => {
      const auto = !!step.tool || (plan.steps.filter(s => s.act === 'place' || s.act === 'door' || s.act === 'valve' || s.act === 'move').length > 1);
      return stepPlace(step, auto);
    },
    window: async (step, plan) => {
      const clear = !!(step.tool || step.side || step.sideRel || step.pref);
      const auto = clear || (plan.steps.filter(s => s.act !== 'unknown' && s.act !== 'ask' && s.act !== 'info').length > 1);
      return stepWindow(step, auto);
    },
    windowoff: async step => stepWindowOff(step),
    winmove: async step => stepMoveWindow(step),
    door: async (step, plan) => {
      // 说清了在哪面墙（或靠哪边）就直接开，别再让用户点一下；
      // 只有"给我开个门"这种什么都没说的，才进点选模式
      const clear = !!(step.tool || step.side || step.sideRel || step.pref);
      const auto = clear || (plan.steps.filter(s => s.act !== 'unknown' && s.act !== 'ask' && s.act !== 'info').length > 1);
      return stepDoor(step, auto);
    },
    valve: async step => stepValve(step),
    move: async step => stepMove(step),
    remove: async step => stepRemove(step),
    replace: async step => stepReplace(step),
    resize: async step => stepResize(step),
    devices: async step => stepDevices(step),
    clearance: async step => stepClearance(step),
    findroom: async step => stepFindRoom(step),
    suggest: async step => stepSuggest(step),
    dooroff: async step => stepDoorOff(step),
    doormove: async step => stepDoorMove(step),
    doorsize: async step => stepDoorSize(step),
    doorinfo: async step => stepDoorInfo(step),
    doors: async step => stepDoors(step),
    wins: async step => stepWindows(step),
    wininfo: async step => stepWinInfo(step),
    winsize: async step => stepWindowSize(step),
    opening: async step => stepOpening(step),
    focus: async step => stepFocus(step),
    showall: async () => stepShowAll(),
    undo: async () => stepUndo(),
    view: async step => stepView(step),
    floorview: async step => stepFocusFloor(step),
    conduitsview: async step => stepShowConduits(step),
    circview: async step => stepCircuitView(step),
    info: async step => stepInfo(step),
    ask: async step => stepAsk(step),
    impact: async step => stepImpact(step),
    scene: async step => stepScene(step),
    /* 打穿 / 拆墙 / 电路 */
    passage: async step => stepPassage(step),
    circuit: async step => stepCircuits(step),
    circuitset: async step => stepToggleCircuit(step),
    conduits: async step => stepConduits(step)
  };

  async function stepPlace(step, auto) {
    const A = window.BIM.agent;
    /* "放到 209 和 210 中间"会把两个房号一起塞进 room，
       roomByNum 查不到就整条指令作废 —— 从里面捞出能认的那一间，
       合并成一块板以后，落在哪一间其实无所谓。
       ★ 顺序很重要：必须先认"用户明说的那间"，再退回上下文里那间。
         以前先取 A.mem.ctx.room，刚开过 207 的门再说"放到 209、210 中间"，
         就会拿 207 去放，设备落在隔壁房间里。 */
    let room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    if (!room && step.room) {
      const hit = String(step.room).match(/\d{3}/);
      if (hit) room = A.roomByNum(hit[0], step.floor);
    }
    if (!room) room = A.mem.ctx.room;
    if (!room) { ai('要放到哪一间？说个房间号就行，比如「2 楼 202」。'); return false; }

    let dev = step.device ? A.deviceByName(step.device) : null;
    if (!dev) dev = ST.device;
    if (!dev && step.weight) dev = { id: 'CUSTOM', name: '这台设备', weight: step.weight, w: 1.6, d: 1.0, h: 1.4, shape: 'box', color: '#6f7cf0', note: '手动录入' };
    if (!dev) {
      ai(room.num + ' 室要放哪台设备？选一个，我马上带你放。');
      chips(M.equipmentLibrary.slice(0, 4).map(e => ({
        label: e.name + ' ' + (e.weight / 1000).toFixed(1) + 't',
        fn: () => { ST.device = e; send('把' + e.name + '放到' + room.num + '室' + (step.pref ? (N.PREF_CN[step.pref] || '') : '')); }
      })));
      openEquip();
      return false;
    }

    const n = Math.max(1, Math.min(4, step.count || 1));
    const cont = !!step.cont;           // 「再放一台」：接着上文直接落位
    if (auto || step.pref || step.side || step.sideRel || n > 1 || cont) {
      const quietEach = auto || n > 1 || cont;
      /* 打通以后按合并的大板来放：可放范围是整个连通块，
         没说放哪儿时默认就落在**两块板的中间**（也就是原来那道墙的位置）——
         用户原话："在打通的房间内放置设备应该默认放到两个打通的房间中间"。 */
      const sp0 = spaceOf(room);
      const space = sp0.space;
      const merged = !!sp0.plate;
      const pref = step.pref || (merged ? 'center' : null);
      focusSoft(space);                 // 自动聚焦到这块板，别的楼层淡出
      let last = null, okCount = 0, hostRoom = room, passInfo = null;
      const from0 = ST.placed.length;
      /* 打通以后（用户只说"放到这两间中间"）默认落在合并板正中；
         但只要用户说了方位（"放左边""靠镜头右边"），就必须按**这块合并大板**的
         前后左右算 —— 用户原话："需要能够按照当前视角的前后左右方向在合并后的楼板进行放置"。
         以前这里写成 merged && !step.pref → seed 恒为 null，说了方向也被扔掉，
         设备永远跑回中间。 */
      const seed = seedForSide(space, step.side, step.sideRel);
      for (let i = 0; i < n; i++) {
        const spot = bestSpotFor(space, dev, pref, i === 0 ? seed : null, !!seed);
        if (!spot) break;
        const dvi = spot.rot != null ? Object.assign({}, dev, { rot: spot.rot }) : dev;
        /* 落位点可能落在隔壁那间（合并后很正常），设备要记在真正包含它的那间房上 */
        hostRoom = roomAt(space, spot.x, spot.y) || room;
        last = commitPlaceAt(hostRoom, dvi, spot.x, spot.y, spot.ob, false, quietEach);
        okCount++;
      }
      if (!okCount) {
        ai(room.num + ' 室里已经腾不出放「' + dev.name + '」的地方了，换个房间或者先挪走别的设备。');
        return false;
      }
      const made = ST.placed.slice(from0);
      if (made.length) {
        pushUndo('把刚放的 ' + made.length + ' 台「' + dev.name + '」撤掉', () => {
          made.forEach(e => { S.removeEquipment(e); if (ST.sel === e) ST.sel = null; });
          ST.placed = ST.placed.filter(e => made.indexOf(e) < 0);
          A.mem.placed = A.mem.placed.filter(e => made.indexOf(e) < 0);
          A.mem.lastPlaced = A.mem.placed[A.mem.placed.length - 1] || null;
        });
      }
      if (quietEach) {
        const prefTxt = step.pref ? ('，' + (N.PREF_CN[step.pref] || '')) : '';
        const tail = okCount < n ? '（只剩 ' + okCount + ' 台的位置）' : '';
        // 一次放多台时不再逐台刷屏，但碰撞一定要汇总说清楚
        const made0 = ST.placed.slice(from0);
        const clashList = [];
        made0.forEach(e => {
          if (e._ob && e._ob.blocks) e._ob.blocks.forEach(b => { if (clashList.indexOf(b.t) < 0) clashList.push(b.t); });
        });
        const hitEq = made0.filter(e => e._ob && e._ob.hits && e._ob.hits.length).slice(-1)[0];
        if (hitEq) markClash(hitEq._ob);
        const lastMade = made0[made0.length - 1];
        const fTxt = lastMade ? faceTxt(faceInfo(room, lastMade)) : '';
        /* 落位点可能在合并后的另一间里，报房号要报真实那一间 */
        const hostNum = lastMade ? ((M.rooms.find(x => x.id === lastMade.room) || {}).num || room.num) : room.num;
        /* 打通过的板：把"合并后的新承载"直接写进回执，别只丢一张卡片让用户自己去点计算书 */
        const mgTxt = (lastMade && ST.last && ST.last.merged)
          ? '这块板已经和 ' + ((ST.last.plate && ST.last.plate.rooms) || []).filter(x => x.id !== lastMade.room)
            .map(x => x.num).join('、') + ' 打通，按合并后的大板 ' +
            ST.last.lx.toFixed(2) + '×' + ST.last.ly.toFixed(2) + ' m 重新校核：安全系数 ' + C.fmt(ST.last.K) + '（' + ST.last.v.word + '）。'
          : '';
        /* 沿用上一轮那间（用户没报房号）时要说清"我按哪间放的"，
           不然用户不知道系统是接着上文理解，还是自己猜的 */
        const inhTxt = step.inheritedRoom ? '（沿用刚才的 ' + room.num + ' 室' + (ST.last && ST.last.merged ? '，已算作打通后的大板' : '') + '）' : '';
        ai((cont ? '接着又放了 ' : '好，' + hostNum + ' 室' + prefTxt + '放好 ') + okCount +
          ' 台「' + dev.name + '」。' + inhTxt + tail + (fTxt ? fTxt + '。' : '') + mgTxt +
          (clashList.length ? '有 ' + clashList.length + ' 处和周边撞上了，都放进去了，位置列在下面。' : ''),
          card(ST.last) + (clashList.length
            ? '<div class="res bad" style="margin-top:8px"><div class="res-top"><span class="k">' + clashList.length +
            '</span><span class="kl">处碰撞</span><span class="tag">已放进去</span></div>' +
            '<div class="res-adv">' + clashList.map(t => '<s>·</s> ' + t).join('<br>') + '</div></div>' : ''));
        // 门问一次就够，挑最后放下的那台算
        const lastEq = made0[made0.length - 1];
        if (lastEq) {
          const pd = C.passDoor({ room: room, equip: lastEq });
          lastEq._door = pd;
          if (!pd.ok) askDoorWiden(room, lastEq, pd);
          /* 搬不进时把"这块板上有哪几扇门、各自现状多宽、至少要多宽"一并交出去：
             大模型要靠这份清单让用户挑一扇拓，不用自己猜门在哪儿。 */
          if (!pd.ok) {
            passInfo = {
              need_w: pd.needW, need_h: pd.needH, why: pd.why,
              doors: (pd.candidates || []).map(c => ({
                door: c.name, id: c.id, room: c.roomNum, w: c.w, h: c.h, fit: !!c.fit
              }))
            };
          }
        }
      }
      lastData = {
        device: dev.name, room: room.num, count: okCount,
        K: ST.last ? C.fmt(ST.last.K) : null, verdict: ST.last ? ST.last.verdict : null,
        positions: made.map(e => [+e.x.toFixed(2), +e.y.toFixed(2)]),
        /* 合并板信息要显式给出来：用户问的"有没有按打通后的大板算承载"看这一行就够 */
        plate: (ST.last && ST.last.merged)
          ? {
            merged: true, size_m: [+ST.last.lx.toFixed(2), +ST.last.ly.toFixed(2)],
            span_m: +ST.last.l.toFixed(2),
            rooms: ((ST.last.plate && ST.last.plate.rooms) || []).map(x => x.num),
            K: C.fmt(ST.last.K), verdict: ST.last.verdict
          }
          : null,
        door_pass: passInfo
      };
      A.commit(step, { room: room, eq: last, result: ST.last, device: dev.name });
      return true;
    }

    ST.device = dev;
    startPlace({ room: room, device: dev, pref: null });
    A.commit(step, { room: room });
    return true;
  }

  async function stepDoor(step, auto) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (!room) { ai('要在哪一间开？说个房间号，比如「3 楼 306」。'); return false; }
    const w = step.width || 1.0, h = step.height || 2.1;
    const p = { room: room, side: step.side, sideRel: step.sideRel, width: w, doorH: h, pref: step.pref };

    if (!auto) { startDoor(p); A.commit(step, { room: room }); return true; }

    const side = pickDoorSide(room, p);
    if (!side) {
      ai(room.num + ' 四面都是外墙，不能在上面开门（外墙兼承重，还要管防水）。' +
        '要连通只能往内墙方向想办法 —— 要么换一间挨着走廊的房，要么把它和隔壁打通。');
      chips([
        { label: '和隔壁打通', fn: () => send('把' + room.num + '和隔壁打通') },
        { label: '换一间房', fn: () => send('换一间房开门') }
      ]);
      return false;
    }
    const sideSwap = doorSideNote(room, step.sideRel || step.side, side);
    const wall = M.walls.find(x => x.id === (room.sides || {})[side]);
    if (!wall) { ai(room.num + ' 这间房找不到对应的墙。'); return false; }
    const L = Math.hypot(wall.p2[0] - wall.p1[0], wall.p2[1] - wall.p1[1]);
    const eqs = ST.placed.filter(e => e.floor === wall.floor);

    /* 同开窗：先在墙中间试，撞墙内线管就按 牵线 → 挪位 → 不建议 逐级处理。
       门尤其常见——插座回路本来就贴着地面从门口引过来。 */
    const dec = holeDecision(wall, { at: L / 2, w: w, h: h, sill: 0, room: room, equipments: eqs, kind: 'door' });

    if (!dec.ok) {
      focusSoft(room);
      S.highlightWall(wall, 0xdd534f);
      if (dec.hits && dec.hits.length) showHoleConflict(wall, dec.hits, dec.plans);
      const bs = (dec.blocks && dec.blocks.length) ? dec.blocks : [{ t: dec.why || '这个位置开不了' }];
      const detail = bs.map(b => '<s>·</s> ' + b.t).join('<br>');
      ai(room.num + ' ' + N.SIDE_CN[side] + '墙这个位置开不了 ' + w.toFixed(2) + ' 米宽的门：' + bs[0].t +
        ((dec.hits && dec.hits.length) ? '，墙里的线管也没有改线的余地' : ''),
        '<div class="res bad"><div class="res-top"><span class="k">不建议开</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + detail + '</div></div>');
      chips([
        { label: '换个墙面试试', fn: () => send('在' + room.num + '换个墙开个门') },
        { label: '门开窄一点', fn: () => send('在' + room.num + '开个0.9米的门') },
        { label: '我自己点位置', fn: () => startDoor({ room: room, side: side, width: w, doorH: h }) }
      ]);
      return false;
    }

    const reroutedIds = [];
    const rerouted = dec.needReroute ? applyReroutes(dec, reroutedIds) : 0;
    const d = S.addDoorOpening(wall, dec.at, w, h);
    d.room = room.id;                 // 记住"为哪间房开的"，长墙上才分得清
    /* 这扇门为了腾位置让哪几根线管改了道，记在门身上：
       撤门时按这份名单把管子放回原来的走法（"回复原装"）。 */
    if (reroutedIds.length) d._reroutes = reroutedIds;
    /* 洞口变了 → 线管重新按新洞形铺一遍（门口该断的断开），再画红标/绿线 */
    syncElecAfterDoor();
    focusSoft(room, { keepView: true, color: false });
    const sp = doorSpot(wall, dec.at);
    if (!S.inView(wall.floor, sp.x - 1.8, sp.y - 1.8, sp.x + 1.8, sp.y + 1.8)) S.focusDoor(wall, dec.at, room);
    /* 只留当前楼层，门洞别被上下层挡住 */
    S.isolateFloor && S.isolateFloor(wall.floor);
    S.markDoorSpot(wall, dec.at, w, h, true);
    if (dec.needReroute || dec.moved) showHoleConflict(wall, dec.hits, dec.reroutes);
    ST.lastDoor = { wall: wall, at: dec.at, w: w, d: d, chk: dec.chk, room: room };
    rememberDoor(room, side, w, h);
    pushUndo('把刚开的 ' + (d.code || d.name) + ' 拆掉', () => { undoDoor(d, true); ST.lastDoor = null; });
    const card2 = (dec.needReroute || dec.moved) ? conduitCard(dec.hits, dec.reroutes, dec)
      : '<div class="res ok"><div class="res-top"><span class="k">可以开</span><span class="tag">无碰撞</span></div>' +
      '<div class="res-grid"><div><i>门宽</i><b>' + w.toFixed(2) + ' m</b></div>' +
      '<div><i>门高</i><b>' + h.toFixed(2) + ' m</b></div></div></div>';
    const head2 = (sideSwap ? sideSwap + '。' : '') + '在 ' + room.num + ' ' + N.SIDE_CN[side] + '墙开了 ' +
      w.toFixed(2) + ' 米宽、' + h.toFixed(2) + ' 米高的门';
    if (dec.needReroute) {
      ai(head2 + '。' + (dec.moved ? dec.moveNote + '；让过去之后，' : '') +
        '这个位置墙里有 ' + dec.hits.length + ' 根线管，' + dec.rerouteNote +
        '。红色的两个断头是管子原来穿门洞的位置（已经凿断），绿色是改完的新走向。', card2);
    } else if (dec.moved) {
      ai(head2 + '。' + dec.moveNote + '。', card2);
    } else {
      ai(head2 + '。', card2);
    }
    /* 三个成功分支（牵线 / 挪位 / 直接开）都挂上"我自己点位置"：
       用户要的是"每次开门回复都能自己点"。放在分支之后，省得漏。 */
    doorPointChips(room, side, w, h);
    lastData = {
      door: d.code || d.name, door_id: d.id, room: room.num, side: side, width: w, height: h,
      at: +dec.at.toFixed(2),
      moved: dec.moved ? +dec.movedBy.toFixed(2) : 0,
      rerouted: rerouted,
      reroute_add_m: rerouted ? +dec.reroutes.reduce((s, p) => s + p.addLen, 0).toFixed(2) : 0,
      conduit_hit: (dec.hits || []).map(c => c.circuit),
      side_from: sideSwap ? (step.sideRel || step.side) : null
    };
    A.commit(step, { room: room, side: side });
    return true;
  }

  /* ---------------- 窗：选墙 / 点选 / 落地 ---------------- */
  /* 开窗优先外墙（内墙开的是观察窗，采光靠不住） */
  function pickWindowSide(room, p) {
    const sides = room.sides || {};
    const rel = p.sideRel || (REL_SIDES.indexOf(p.side) >= 0 ? p.side : null);
    const byView = viewSide(rel);
    if (p.pref === 'window' && byView && sides[byView]) return byView;
    if (p.side && sides[p.side]) return p.side;
    if (byView && sides[byView]) return byView;
    for (const k of ['south', 'north', 'east', 'west']) {
      const w = M.walls.find(x => x.id === sides[k]);
      if (w && w.kind === 'ext') return k;
    }
    for (const k of ['south', 'north', 'east', 'west']) if (sides[k]) return k;
    return 'south';
  }

  function rememberWindow(room, side, w, h, sill) {
    const AM = window.BIM.agent.mem;
    AM.ctx.room = room; AM.ctx.floor = room.floor;
    if (side) AM.ctx.side = side;
    AM.lastWin = { room: room, side: side, w: w, h: h, sill: sill };
  }

  function winCard(w, h, sill, chk) {
    const warnTxt = (chk && chk.warns && chk.warns.length)
      ? '<div class="res-adv" style="border-top:1px solid #eef1f5">' + chk.warns.map(x => '<s>·</s> ' + x).join('<br>') + '</div>' : '';
    return '<div class="res ok"><div class="res-top"><span class="k">可以开</span><span class="tag">无碰撞</span></div>' +
      '<div class="res-grid"><div><i>窗宽</i><b>' + w.toFixed(2) + ' m</b></div>' +
      '<div><i>窗高</i><b>' + h.toFixed(2) + ' m</b></div>' +
      '<div><i>窗台高</i><b>' + sill.toFixed(2) + ' m</b></div></div>' + warnTxt + '</div>';
  }

  /* =============== 开洞与墙内线管：一套固定的处理顺序 ===============
     最容易被忽略的一种情形：位置、尺寸、结构全都合适，墙里却埋着一路线管。
     真实施工这一凿就打断一路电，所以每次开洞前都按这个顺序走，别临场发挥：
       ① 原位不撞         → 直接开
       ② 原位只撞线管     → 先"牵线"：上翻/下翻绕过洞口，能绕就绕完再开
       ③ 绕不过去         → 顺同一面墙找不撞管线的位置，挪过去开
       ④ 都不行           → 明确不建议开，并说清卡在哪
     返回：
       { ok:true,  at, chk, reroutes:[], hits:[], moved:false, note:'' }
       { ok:false, chk, hits, plans, why }
  */
  function holeDecision(wall, o) {
    const E = window.BIM.elec;
    const sufMt = v => C.fmt(v, 2) + ' 米';
    const check = at => o.kind === 'door'
      ? C.door({ wall: wall, at: at, w: o.w, h: o.h, room: o.room, equipments: o.equipments, self: o.self })
      : (o.kind === 'passage'
        ? C.passage({ wall: wall, at: at, w: o.w, h: o.h, room: o.room, equipments: o.equipments, self: o.self, demolish: o.demolish })
        : C.window({ wall: wall, at: at, w: o.w, h: o.h, sill: o.sill, room: o.room, equipments: o.equipments, self: o.self }));

    /* 顺着这面墙找一个能开的空位。门和窗的"默认位置"往往是墙中点，
       而一面长墙常常横跨好几间房，中点未必落在本房间这一截上——
       这是位置问题，不是不能开，得先让一让。
       ignoreConduit=true 时只解决位置，线管留到下一步再处理。 */
    const findSpot = ignore => o.kind === 'door'
      ? C.suggestDoorAt({ wall: wall, room: o.room, at: o.at, w: o.w, h: o.h, equipments: o.equipments, self: o.self, ignoreConduit: ignore })
      : (o.kind === 'passage'
        ? C.suggestPassageAt({ wall: wall, room: o.room, at: o.at, w: o.w, h: o.h, equipments: o.equipments, self: o.self, ignoreConduit: ignore })
        : C.suggestWindowAt({ wall: wall, room: o.room, at: o.at, w: o.w, h: o.h, sill: o.sill, equipments: o.equipments, self: o.self, ignoreConduit: ignore }));

    /* panel（压在配电箱上）也算硬伤：箱子不是线管，挪不了的 */
    const HARD = { structure: 1, size: 1, height: 1, panel: 1 };
    const split = c => ({
      hard: (c.blocks || []).filter(b => b.k !== 'conduit' && HARD[b.k]),
      soft: (c.blocks || []).filter(b => b.k !== 'conduit' && !HARD[b.k])
    });

    let at = o.at, c0 = check(at), moved = 0, note = '', moveNote = '';
    let part = split(c0);

    /* 位置类问题的说法：要能一句话讲清"为什么原位不行" */
    const SOFT_WHY = {
      span: '原位不在这间房这一段墙上', angle: '原位贴着墙端头，留不住墙垛',
      open: '原位和原有的门窗挤在一起', col: '原位正好压在框架柱上', duct: '原位有风管穿过'
    };

    /* ── 第一段：先把"位置"摆对 ──────────────────────────────
       出了本房间范围、贴着墙端头、和旧门窗挤在一起，都属于"换个地方就行"。
       但用户是**手点的位置**（o.noMove）时不能自作主张挪走——
       他点哪儿就该在哪儿，开不了就如实说，别偷偷换个地方放一扇。 */
    if (!c0.pass && part.soft.length && !part.hard.length && !o.demolish) {
      if (o.noMove) {
        return { ok: false, chk: c0, hits: c0.conduits || [], why: part.soft[0].t, blocks: part.soft.concat(part.hard) };
      }
      const s0 = findSpot(true);
      if (s0 && s0.at != null) {
        moved = Math.abs(s0.at - o.at);
        moveNote = (SOFT_WHY[part.soft[0].k] || part.soft[0].t) +
          '，顺墙让到 ' + sufMt(s0.at) + '处（挪了 ' + C.fmt(moved, 2) + ' 米）';
        note = moveNote;
        at = s0.at;
        c0 = check(at);
        part = split(c0);
      } else {
        return { ok: false, chk: c0, hits: c0.conduits || [], why: part.soft[0].t, blocks: part.soft.concat(part.hard) };
      }
    }

    /* 位置摆好之后还有硬伤（外墙承重、洞口太窄、挖到顶留不出过梁）就到此为止 */
    if (part.hard.length) {
      return { ok: false, chk: c0, hits: c0.conduits || [], why: part.hard[0].t, blocks: part.hard.concat(part.soft) };
    }
    if (c0.pass) {
      return { ok: true, at: at, chk: c0, reroutes: [], hits: [], moved: moved > 0, movedBy: moved, note: note, moveNote: moveNote };
    }
    if (part.soft.length) {
      return { ok: false, chk: c0, hits: c0.conduits || [], why: part.soft[0].t, blocks: part.soft };
    }

    /* ── 第二段：位置没问题，剩下的只可能是墙里的线管 ────────── */
    const hits = c0.conduits || [];
    const sill = o.kind === 'window' ? o.sill : 0;
    const hole = { at0: at - o.w / 2, at1: at + o.w / 2, z0: sill, z1: sill + o.h };
    /* 同一个洞口常常不止一根管：一根一根排，后面的要避开前面已经占掉的标高，
       否则三根管会被排到同一个高度上 —— 画出来是一条绿线，实际是三根叠在一起。
       用户原话："在管线开门汇集处没有考虑所有管线的绕行"。 */
    const avoidZ = [];
    const plans = (E && hits.length) ? hits.map(c => {
      const p = E.planReroute(c, hole, avoidZ);
      if (p && p.ok) {
        const hf = (c.s || 0.04) / 2 + 0.04;
        avoidZ.push([p.z - hf, p.z + hf]);
      }
      return p;
    }) : [];
    if (plans.length && plans.every(p => p && p.ok)) {
      const rn = plans.map(p => p.why).join('；');
      return {
        ok: true, at: at, chk: c0, reroutes: plans, hits: hits, moved: moved > 0, movedBy: moved,
        needReroute: true, moveNote: moveNote, rerouteNote: rn,
        note: (moveNote ? moveNote + '；' : '') + rn
      };
    }

    /* ③ 牵不了线 → 顺墙挪个不撞管线的位置（挪多少要如实说）
       整段拆不能挪：挪了就不是"拆这面墙"了。
       手点的位置也不能挪：用户点的就是这儿。 */
    if (o.demolish) {
      /* 整面拆墙时墙里的线管是另一个性质的问题：墙都没了，管子没有"绕过去"这条路，
         只能随墙作废、从吊顶或相邻墙重新敷设。这时候报"拆不了"等于告诉用户
         这面墙永远拆不掉 —— 不是他要的答案。所以照样放行，但把要重做的线点出来。 */
      return {
        ok: true, at: at, chk: c0, hits: hits, reroutes: [], needReroute: false,
        moved: false, movedBy: 0, demolishNote: true,
        note: '墙里的 ' + hits.length + ' 根线管随墙一起作废，要从吊顶或相邻墙重新敷设',
        why: '', moveNote: '', rerouteNote: ''
      };
    }
    if (o.noMove) {
      const bad = plans.filter(p => p && !p.ok).map(p => p.why)[0];
      return {
        ok: false, chk: c0, hits: hits, plans: plans,
        why: (bad || '这个位置墙里的线管绕不过去') + '；你点的就是这个位置，可以换个地方点，或者让我顺墙找位置'
      };
    }
    const sug = findSpot(false);
    if (sug && sug.at != null) {
      const d = Math.abs(sug.at - at);
      const why = plans.filter(p => p && !p.ok).map(p => p.why)[0] || '这段位置线管绕不过去';
      return {
        ok: true, at: sug.at, chk: sug.check, reroutes: [], hits: hits, moved: true, movedBy: d,
        needReroute: false,
        moveNote: moveNote, rerouteNote: '',
        note: (moveNote ? moveNote + '；' : '') + why + '，顺墙让到 ' + sufMt(sug.at) + ' 的位置（挪了 ' + C.fmt(d, 2) + ' 米）'
      };
    }

    /* ④ 全线都躲不开 → 不建议开 */
    return {
      ok: false, chk: c0, hits: hits, plans: plans,
      why: '这面墙整段都躲不开线管，也没有能改线的余地'
    };
  }

  /* 真的把线改掉：写进 elec 的 reroutes，之后这根管在这个洞口就不再算冲突。
     注意这是"改设计"，所以只在校核确认洞能开（结构没问题）之后才落地。 */
  /* 真把线管改道落到数据里。out 传进来就把"改了哪几根"记进去 ——
     撤门的时候要按这份名单撤回（E.undoReroute），否则管子会一直保持着
     "为这扇门绕行"的走法，墙明明恢复原样了，图上还挂着一截绿线。 */
  /* 门窗洞一改，电气数据必须跟着重算一遍。
     ★ 这里修的是"撤掉门后还是有原来绕行的管线"的最后一块：
       线管是按"墙上现在有哪些洞口"铺的（splitByOpenings）。开了门不重算，
       管子还跨着洞口走，红标和绿线就成了图纸上的一层贴纸；
       撤了门不重算，管子就永远停在"为那扇门断开"的样子 —— 墙上洞都没了，
       管子在门口还缺一截。所以开/撤之后都重建一次，让管子回到真实形态：
       有洞就断在洞口（红色那截就是"原来的位置"），绕行由绿线表达。 */
  function syncElecAfterDoor() {
    if (!window.BIM.elec) return;
    try {
      window.BIM.elec.rebuild();
      S.rebuildElec();
      S.rebuildPanels && S.rebuildPanels();
      S.syncCircuitPower && S.syncCircuitPower();
    } catch (e) { console.warn('elec sync', e && e.message); }
  }

  function applyReroutes(dec, out) {
    const E = window.BIM.elec;
    if (!E || !dec || !dec.reroutes || !dec.reroutes.length) return 0;
    let n = 0;
    dec.reroutes.forEach(p => {
      if (p && p.ok && p.c) {
        E.applyReroute(p.c, p.hole, p); n++;
        if (out && p.c.id) out.push(p.c.id);
      }
    });
    return n;
  }

  /* 在一面墙的某个位置把门放上去：结构校核 → 顺墙让位 → 线管改线，一条不落。
     ★ 快捷按钮（"往旁边挪 X 米就能开""开回原位"）必须走这里。
       以前那几个按钮是直接 S.addDoorOpening，跳过了 holeDecision ——
       墙上那几根管根本没被算进来，门照样放上去，用户看到的就是
       "门口汇集了好几根线，系统只绕了其中一部分"。 */
  function openDoorHere(wall, room, at, w, h) {
    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    const dec = holeDecision(wall, { at: at, w: w, h: h, sill: 0, room: room, equipments: eqs, kind: 'door' });
    if (!dec.ok) return { ok: false, dec: dec };
    const ids = [];
    if (dec.needReroute) applyReroutes(dec, ids);
    const d = S.addDoorOpening(wall, dec.at, w, h);
    d.room = room.id;
    if (ids.length) d._reroutes = ids;
    syncElecAfterDoor();
    ST.lastDoor = { wall: wall, at: dec.at, w: w, d: d, chk: dec.chk, room: room };
    rememberDoor(room, sideOfWall(room, wall) || null, w, h);
    S.markDoorSpot(wall, dec.at, w, h, true);
    if ((dec.hits && dec.hits.length) || dec.moved) showHoleConflict(wall, dec.hits, dec.reroutes);
    return { ok: true, d: d, dec: dec, ids: ids };
  }

  /* 打通预览：用户问"这两间能不能打通"时要的那一屏。
     三件事必须同时成立，缺一个就不是他想要的样子：
       ① 楼体整体保持实心（不整层压成虚影）—— 空间结构得还看得出来
       ② 只有**要打通的那面墙**半透明 —— 一眼看到墙里有什么
       ③ 管线只留这面墙里的，别的分路全收起来
     这跟"显示线管"的默认行为正好相反（那道开关会把整层墙都变虚），
     所以这里每次都先 setXray(false) 把它掰回来。 */
  function previewPassage(wall, markList, touchedN, deadList) {
    if (!window.BIM.elec || !wall) return;
    const E = window.BIM.elec;
    const inWall = (E.conduitsOf({ wall: wall.id }) || []);
    S.showConduits(true);
    S.setXray(false);
    /* 只留当前楼层：别层的墙和管会把这一层糊住（用户原话"打通房间的视角需要只显示当前楼层"） */
    S.isolateFloor && S.isolateFloor(wall.floor);
    S.clearGhostWalls && S.clearGhostWalls();
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    /* 打通牵涉到管线时，用户要能看清"这一层的电线是怎么走的、哪几根要改道"，
       所以不再只留墙里那几根（只剩几根时，根本判断不出这堵墙在电气系统里的位置），
       而是整层管子都留着、压成半透明，真正被墙打断的那几根再描红。
       用户原话："打通墙壁的时候如果涉及到管线，需要能够把管线半透明显示"，
       第二轮又点明了具体口径："涉及到的管线显示 50% 半透明"。 */
    S.clearIsolate && S.clearIsolate();
    /* "牵涉到管线"要按**拆之前**墙里那几根算：demolish 是先拆墙再调这里，
       那时 inWall 已经空了；markList 就是被切断的那几根。 */
    const touched = inWall.length || (markList && markList.length) || touchedN || 0;
    /* 被打断的那几路 = 50%（用户点名的口径）；其余分路压到 28% 当背景，
       既知道这层整体怎么走线，又能一眼分出"要动的是哪几根"。 */
    const inv = {};
    (markList || []).concat(deadList || []).forEach(c => { if (c && c.circuit) inv[c.circuit] = 0.50; });
    S.conduitAlpha && S.conduitAlpha(touched ? 0.28 : 0.30, touched ? inv : null);
    /* ★ 整面拆掉时，墙里那几段会被 elec.rebuild() 一起"消失"（墙没了就不生成），
       屏幕上就只剩一句"随墙作废"的文字，看不到管子原本走在哪儿。
       把拆除前抓下来的那几段按 50% 留在原位（虚线描边），这才是用户说的
       "墙体区域涉及到拆除的管线看不到"要补的那一眼。只画真的消失了的，没消失的别重复画。 */
    if (deadList && deadList.length && S.showRemovedConduits) {
      const live = (E.data && E.data.conduits) || [];
      /* 按几何签名比，不按 id 比：rebuild 是从头重新排号的，
         整面墙一拆，后面所有管子的 id 都会往前挪一位，按 id 比会把"其实还在的管子"也画成虚影。 */
      const sig = c => c.circuit + '|' + (c.wall || '') + '|' +
        [c.at0, c.at1, c.z, c.x, c.y, c.z0, c.z1].map(v => (v == null ? '' : (+v).toFixed(2))).join(',') +
        '|' + (c.p1 ? c.p1.map(v => (+v).toFixed(2)).join(',') : '') +
        '|' + (c.p2 ? c.p2.map(v => (+v).toFixed(2)).join(',') : '');
      const liveSet = new Set(live.map(sig));
      const gone = deadList.filter(c => !liveSet.has(sig(c)));
      if (gone.length) S.showRemovedConduits(gone, 0.50);
    }
    if (markList && markList.length) S.markConduits(markList, 0xff3b30);
    S.syncCircuitPower();
    return inWall;
  }

  /* 洞口两侧的"断口"：红色只标这一小截，不让整根管子横穿门洞。
     ★ 这是用户那句"这个地方还是没有修复"的落点：
       原来红色标记是把**开门前那根整管**罩粗画的，isolateConduits 也是拿旧对象画的，
       所以门口明明已经改过线，画面上仍有一根粗管从门里穿过去 —— 看着就是"没修好"。
       现在：洞外的管子用**重建之后**的真实线管（洞口处本来就断了），
       红色只点在洞口两侧各 0.18 m 的断头上，读作"这里被打断了"。 */
  function cutStubs(wall, list, hole) {
    if (!hole) return list || [];
    const out = [];
    (list || []).forEach(c => {
      const g = 0.18;
      if (c.vert) {
        const z0 = Math.min(c.z0, c.z1), z1 = Math.max(c.z0, c.z1);
        if (z1 > hole.z1 + 0.01) out.push(Object.assign({}, c, { id: c.id + '-s1', z0: hole.z1, z1: Math.min(z1, hole.z1 + g) }));
        if (z0 < hole.z0 - 0.01) out.push(Object.assign({}, c, { id: c.id + '-s0', z0: Math.max(z0, hole.z0 - g), z1: hole.z0 }));
        return;
      }
      if (c.at0 == null) return;
      const a0 = Math.max(c.at0, hole.at0 - g), a1 = Math.min(c.at1, hole.at0);
      if (a1 - a0 > 0.02) out.push(Object.assign({}, c, { id: c.id + '-s0', at0: a0, at1: a1 }));
      const b0 = Math.max(c.at0, hole.at1), b1 = Math.min(c.at1, hole.at1 + g);
      if (b1 - b0 > 0.02) out.push(Object.assign({}, c, { id: c.id + '-s1', at0: b0, at1: b1 }));
    });
    return out;
  }

  /* 把"撞上的线管 / 改线走向 / 半透明墙体"一次性摆到屏幕上。
     用户要的就是这一眼：墙里哪根管子挡着，新的线打算怎么走。 */
  function showHoleConflict(wall, hits, plans, alsoOpen) {
    if (!window.BIM.elec) return;
    const all = (hits || []).concat((alsoOpen && alsoOpen.conduits) || []);
    S.showConduits(true);
    /* showConduits 会顺手把整层墙都压成半透明（为了让墙里的管能看见）。
       但看"能不能打通"的时候，用户要的是**空间结构还在**：别的房间的墙、
       隔墙、外墙都得是实心的，只有要打通的那面墙半透明 ——
       否则一屋子全是虚影，根本分不清打通以后是什么样。
       所以这里**无条件**关透视：之前哪怕正在看分路透视，进了打通视图也一律回到实墙。 */
    S.setXray(false);
    /* 只留当前楼层：开门的视角以前被上下层的半透明墙挡住，看不清门洞和管线 */
    S.isolateFloor && S.isolateFloor(wall.floor);
    S.clearGhostWalls && S.clearGhostWalls();
    S.ghostWall(wall, true);
    S.clearConduitMarks();
    /* 只留真正撞上的这几根：其它分路的线管全收起来。
       满屏管子的时候根本看不清撞点在哪儿，"只显示碰撞的管线"是这个功能的前提。
       这面墙里一根管都没有时也要调一次 —— 传空数组等于"一根都不画"，
       画面只剩干净的墙体和空间关系，正是用户说的"隐藏管线的显示"。
       ★ 显示层要用**重建之后**的线管（E.data 里已经按新洞口断开的那几段），
         不能拿 hits 里的旧对象 —— 旧对象还跨着门洞，画出来就是"管子还穿过门"。
         按"同墙、同回路"重新取一遍，拿不到才退回旧对象。 */
    const E2 = window.BIM.elec;
    const circOn = {};
    all.forEach(c => { if (c && c.circuit) circOn[c.circuit] = 1; });
    const fresh = (E2.conduitsOf ? (E2.conduitsOf({ wall: wall.id }) || []) : [])
      .filter(c => circOn[c.circuit]);
    S.isolateConduits(fresh.length ? fresh : all);
    const hole = (plans && plans.length && plans[0] && plans[0].hole) || null;
    S.markConduits(hole ? cutStubs(wall, all, hole) : all, 0xff3b30);
    (plans || []).forEach(pl => { if (pl && pl.ok) S.showReroute(pl, 0x17a673); });
    S.syncCircuitPower();
  }

  /* 冲突卡：说清"撞了哪根、打算怎么办、还能怎么办" */
  function conduitCard(hits, plans, dec, kindCn) {
    const rows = (hits || []).map(c =>
      '<div><i>' + (window.BIM.elec ? window.BIM.elec.KIND_CN[c.kind] : c.kind) + '回路</i><b>' +
      c.circuit + ' · 距地 ' + C.fmt(c.z, 2) + ' m</b></div>').join('');
    const plan = (plans || []).filter(p => p && p.ok)
      .map(p => '<s>·</s> 把' + (window.BIM.elec ? window.BIM.elec.KIND_CN[p.c.kind] : '') +
        '线管' + (p.dir === 'up' ? '上翻' : '下翻') + '到 ' + C.fmt(p.z, 2) + ' m 处绕过，多走 ' +
        C.fmt(p.addLen, 2) + ' 米线').join('<br>');
    const moved = dec && dec.moved
      ? '<s>·</s> 也可以不牵线，顺墙挪 ' + C.fmt(dec.movedBy, 2) + ' 米避开（绿色是改线方案，红色是门洞两侧被打断的断口）'
      : '';
    return '<div class="res warn"><div class="res-top"><span class="k">' +
      (dec && dec.moved ? '挪位后可以开' : '要牵线才能开') + '</span>' +
      '<span class="tag">墙内有管线</span></div>' +
      '<div class="res-grid">' + rows + '</div>' +
      '<div class="res-adv">' + plan + (plan && moved ? '<br>' : '') + moved + '</div></div>';
  }

  async function stepWindow(step, auto) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (!room) { ai('要在哪一间开窗？说个房间号，比如「3 楼 306」。'); return false; }
    const w = step.width || 1.5, h = step.height || 1.5;
    const sill = step.sill == null ? 0.9 : step.sill;
    const p = { room: room, side: step.side, sideRel: step.sideRel, width: w, winH: h, sill: sill, pref: step.pref };

    if (!auto) { startWindow(p); A.commit(step, { room: room }); return true; }

    const side = pickWindowSide(room, p);
    const wall = M.walls.find(x => x.id === (room.sides || {})[side]);
    if (!wall) { ai(room.num + ' 这间房找不到对应的墙。'); return false; }
    const L = S.wallLen(wall);
    const eqs = ST.placed.filter(e => e.floor === wall.floor);

    /* 先在"墙中间"这个最自然的位置试。开不了就按 牵线 → 挪位 → 不建议 逐级处理，
       不要一上来就偷偷换个位置——用户得先知道这里为什么开不了。 */
    const dec = holeDecision(wall, { at: L / 2, w: w, h: h, sill: sill, room: room, equipments: eqs, kind: 'window' });

    if (!dec.ok) {
      focusSoft(room);
      S.highlightWall(wall, 0xdd534f);
      if (dec.hits && dec.hits.length) showHoleConflict(wall, dec.hits, dec.plans);
      const bs = (dec.blocks && dec.blocks.length) ? dec.blocks : [{ t: dec.why || '这个位置开不了' }];
      const detail = bs.map(b => '<s>·</s> ' + b.t).join('<br>');
      ai(room.num + ' ' + N.SIDE_CN[side] + '墙这个位置开不了 ' + w.toFixed(2) + '×' + h.toFixed(2) +
        ' 米的窗：' + bs[0].t + ((dec.hits && dec.hits.length) ? '，墙里的线管也绕不过去' : ''),
        '<div class="res bad"><div class="res-top"><span class="k">不建议开</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + detail + '</div></div>');
      chips([
        { label: '换一面墙', fn: () => send('在' + room.num + '的另一面墙开个窗') },
        { label: '开小一点', fn: () => send('在' + room.num + '开个1.0米的窗') },
        { label: '我自己点位置', fn: () => startWindow({ room: room, width: w, winH: h, sill: sill }) }
      ]);
      return false;
    }

    // 需要牵线的，先落地改线（绿色新走向），再开洞
    const rerouted = dec.needReroute ? applyReroutes(dec) : 0;
    const d = S.addWindowOpening(wall, dec.at, w, h, sill);
    d.room = room.id;
    focusSoft(room, { keepView: true, color: false });
    const sp = doorSpot(wall, dec.at);
    if (!S.inView(wall.floor, sp.x - 1.8, sp.y - 1.8, sp.x + 1.8, sp.y + 1.8)) S.focusDoor(wall, dec.at, room);
    /* 只留当前楼层，门洞别被上下层挡住 */
    S.isolateFloor && S.isolateFloor(wall.floor);
    S.markDoorSpot(wall, dec.at, w, h, true);
    if (dec.needReroute || dec.moved) showHoleConflict(wall, dec.hits, dec.reroutes);
    ST.lastWin = { wall: wall, at: dec.at, w: w, d: d, chk: dec.chk, room: room };
    rememberWindow(room, side, w, h, sill);
    pushUndo('把刚开的 ' + d.name + ' 封掉', () => { S.removeWindow(d); S.markDoorSpotClear && S.markDoorSpotClear(); ST.lastWin = null; });
    const card = (dec.needReroute || dec.moved) ? conduitCard(dec.hits, dec.reroutes, dec) : winCard(w, h, sill, dec.chk);
    if (dec.needReroute) {
      ai('在 ' + room.num + ' ' + N.SIDE_CN[side] + '墙开了 ' + w.toFixed(2) + ' 米宽、' + h.toFixed(2) +
        ' 米高的窗，窗台高 ' + sill.toFixed(2) + ' 米。' + (dec.moved ? dec.moveNote + '；让过去之后，' : '') +
        '这个位置墙里有 ' + dec.hits.length + ' 根线管，' + dec.rerouteNote +
        '。红色的两个断头是管子原来穿门洞的位置（已经凿断），绿色是改完的新走向。', card);
    } else if (dec.moved) {
      ai('在 ' + room.num + ' ' + N.SIDE_CN[side] + '墙开了 ' + w.toFixed(2) + ' 米宽、' + h.toFixed(2) +
        ' 米高的窗，窗台高 ' + sill.toFixed(2) + ' 米。' + dec.moveNote + '。', card);
    } else {
      ai('在 ' + room.num + ' ' + N.SIDE_CN[side] + '墙开了 ' + w.toFixed(2) + ' 米宽、' + h.toFixed(2) +
        ' 米高的窗，窗台高 ' + sill.toFixed(2) + ' 米。' + (dec.chk.warns.length ? dec.chk.warns[0] + '。' : ''),
        card);
    }
    lastData = {
      window: d.name, room: room.num, side: side, width: w, height: h, sill: sill,
      at: +dec.at.toFixed(2),
      moved: dec.moved ? +dec.movedBy.toFixed(2) : 0,
      rerouted: rerouted,
      reroute_add_m: rerouted ? +dec.reroutes.reduce((s, p) => s + p.addLen, 0).toFixed(2) : 0,
      conduit_hit: (dec.hits || []).map(c => c.circuit)
    };
    A.commit(step, { room: room, side: side });
    return true;
  }

  /* ================= 空间打穿 / 拆墙 =================
     用户说的"把这间和隔壁打通""这面墙拆了""砸个大洞"都走这里。
     跟开门最关键的区别：门是"能关上的"，打穿是"两边连通"，所以：
       · 承重外墙一律不动（拆了整栋楼传力路径就变）
       · 上方一定留过梁，不能挖到顶
       · 墙里的线管要改道，改不动就不建议开
     "拆墙"和"打穿"共用一套校核，只是洞口宽度不同（整段 vs 指定宽度）。 */
  function pickPassageSide(room, step) {
    const sides = room.sides || {};
    const cands = ['south', 'north', 'east', 'west'].filter(k => sides[k]);
    /* 有明确的隔壁房号 → 先取两面共用的那面墙，**优先于 side**。
       "把 201 和 202 打通"只可能是两家中间那道墙；模型或方向换算给出的 side
       一旦猜错，就会跑去拆南外墙，然后回一句"承重墙不能拆"——答非所问。
       只有找不到共用墙时才退回 side。 */
    if (step.to) {
      const other = window.BIM.agent.roomByNum(step.to, step.floor);
      if (other) {
        /* 关键：两间房"共用一面墙"必须是**对边**关系（我这面 east = 你那面 west）。
           201 和 202 并排时，南北两条长墙两边都挂着它们俩，用"同名边相等"去比，
           先命中的会是南外墙 —— 于是系统跑去拆承重外墙，回一句"四面都是外墙"。 */
        const OPP = { south: 'north', north: 'south', east: 'west', west: 'east' };
        const hit = cands.find(k => sides[k] && sides[k] === ((other.sides || {})[OPP[k]]));
        if (hit) return hit;
        const shared = cands.find(k => {
          const w = M.walls.find(x => x.id === sides[k]);
          return w && (w.rooms || []).indexOf(other.id) >= 0;
        });
        if (shared) return shared;
      }
    }
    /* 没有隔壁房号（或找不到共用墙）时，才认用户/相机给的方向 */
    if (step.side && sides[step.side]) return step.side;
    // 没指定 → 优先内隔墙（外墙不能拆），且这面墙的另一侧真有房间
    const inner = cands.filter(k => {
      const w = M.walls.find(x => x.id === sides[k]);
      if (!w || w.kind === 'ext') return false;
      const others = (w.rooms || []).filter(id => id !== room.id);
      return others.length > 0;
    });
    return inner[0] || cands.find(k => {
      const w = M.walls.find(x => x.id === sides[k]);
      return w && w.kind !== 'ext';
    }) || cands[0] || null;
  }

  /* 隔壁是哪一间（回复里要说清"连通到哪"） */
  function neighbourOf(room, wall) {
    const ids = (wall.rooms || []).filter(id => id !== room.id);
    const rs = ids.map(id => M.rooms.find(r => r.id === id)).filter(Boolean);
    return rs.find(r => r.zone !== 'corr') || rs[0] || null;
  }

  /* 洞口开完，墙里的线管要跟着重铺：洞口处线管被切断或改走套管，
     否则墙上明明开了洞，线管还横在那儿穿过去。 */
  function refreshElec(hits, plans) {
    if (!window.BIM.elec) return;
    try {
      window.BIM.elec.rebuild();
      S.rebuildElec();
      S.rebuildPanels();
      S.showConduits(true);
      /* 同上：开完洞不要把整层墙都变虚，只保留要打通的那面墙的半透明 */
      S.setXray(false);
      if (hits && hits.length) S.markConduits(hits, 0xff3b30);
      (plans || []).forEach(p => { if (p && p.ok) S.showReroute(p, 0x17a673); });
      S.syncCircuitPower();
    } catch (e) { console.warn('elec refresh', e && e.message); }
  }

  async function stepPassage(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (!room) {
      ai('要把哪一间打通？说个房间号，比如「3 楼 306」，或者告诉我打通到哪一间。');
      return false;
    }
    const pick = pickPassageSide(room, {
      side: step.side || (step.sideRel ? viewSide(step.sideRel) : null),
      to: step.to, floor: step.floor
    });
    if (!pick) { ai(room.num + ' 这间房找不到可以做洞口的墙。'); return false; }
    const whole = step.mode === 'demolish';

    /* 拆墙时"这面墙"往往不特指——先试用户/视角指的那一面，过不去就顺着这间房的
       其它内隔墙再试，哪面能拆就说哪面。一上来就报"有风管"对用户没帮助，
       他只想知道"到底哪面能拆"。打穿必须特指一处，所以只试一个方向。 */
    const candSides = (() => {
      if (!whole) return [pick];
      const sides = room.sides || {};
      const all = ['south', 'north', 'east', 'west'].filter(k => sides[k]);
      const inner = all.filter(k => {
        const x = M.walls.find(v => v.id === sides[k]);
        return x && x.kind !== 'ext' && (x.rooms || []).filter(id => id !== room.id).length > 0;
      });
      return [pick].concat(inner, all).filter((v, i, a) => v && a.indexOf(v) === i);
    })();

    /* 一面墙的洞口几何：拆墙=**整段到底**（洞宽打满本房间在这一段墙上的长度、
       洞高拆到梁底，不留过梁也不留墙垛）；打穿=指定宽度，默认 1.8 米。
       用户原话："打通不是在墙上开一个很小的洞，是需要去除这个墙"——
       所以 demolish 不能再用"墙高减 0.3 m 的过梁"和"两侧各留墙垛"这套开挖洞的规矩，
       否则屏幕上还是一片墙只中间掏空，跟没拆一样。 */
    function passageGeom(wl) {
      const sp = roomSpanOnWall(wl, room);
      const spanLen = Math.max(0.8, sp.hi - sp.lo);
      if (whole) {
        return { w: spanLen, h: wl.h, at: (sp.lo + sp.hi) / 2, full: true };
      }
      const hMax = Math.max(1.2, wl.h - 0.30);
      const hh = Math.min(step.height || 2.2, hMax);
      let ww = Math.min(step.width || 1.8, Math.max(0.8, spanLen - 0.26));
      let aa = step.at != null ? step.at : (sp.lo + sp.hi) / 2;
      const loA = sp.lo + ww / 2 + 0.1, hiA = sp.hi - ww / 2 - 0.1;
      if (hiA > loA) aa = Math.min(Math.max(aa, loA), hiA);
      return { w: ww, h: hh, at: aa };
    }

    const tried = [];
    let best = null;
    for (let i = 0; i < candSides.length; i++) {
      const sd = candSides[i];
      const wl = M.walls.find(x => x.id === (room.sides || {})[sd]);
      if (!wl) continue;
      const g = passageGeom(wl);
      const r2 = neighbourOf(room, wl);
      if (wl.kind === 'ext') {
        tried.push({ side: sd, wall: wl, room2: r2, geo: g, ext: true, blocks: [{ t: '外墙兼承重墙，拆了整栋楼的传力路径就变了' }] });
        continue;
      }
      const d = holeDecision(wl, {
        at: g.at, w: g.w, h: g.h, sill: 0, room: room,
        equipments: ST.placed.filter(e => e.floor === wl.floor),
        kind: 'passage', demolish: whole
      });
      const rec = {
        side: sd, wall: wl, room2: r2, geo: g, dec: d,
        blocks: (d.blocks && d.blocks.length) ? d.blocks : (d.ok ? [] : [{ t: d.why || '这个位置打不通' }])
      };
      tried.push(rec);
      if (d.ok) { best = rec; break; }
    }

    if (!best) {
      /* 一面都不行：把用户指的那一面的原因说清楚，并且如实交代"其它几面我也试了" */
      const f = tried[0] || null;
      focusSoft(room);
      if (f && f.wall) S.highlightWall(f.wall, 0xdd534f);
      /* 打不通也要摆这一屏：楼体实心、只半透明这面墙、只留墙内管线。
         用户得能看见"到底卡在哪儿"，而不是一屋子虚影加满屏管子。 */
      if (f && f.wall) {
        previewPassage(f.wall, (f.dec && f.dec.hits) || []);
        ((f.dec && f.dec.plans) || []).forEach(pl => { if (pl && pl.ok) S.showReroute(pl, 0x17a673); });
      }
      const bs = (f && f.blocks && f.blocks.length) ? f.blocks : [{ t: '这个位置打不通' }];
      /* 打不通也要留一份结构化结果：调用方/测试要能看出"系统拿的是哪面墙、
         为什么不给开"，而不是只读一句自然语言。 */
      lastData = {
        passage: 'blocked', room: room.num, side: (f && f.side) || pick,
        wall: (f && f.wall) ? f.wall.id : null, to: step.to || null,
        blocks: bs.map(b => b.t)
      };
      const others = tried.slice(1).filter(x => !x.ext);
      const allExt = tried.every(x => x.ext);
      if (allExt) {
        ai(room.num + ' 这间房四面都是外墙，拆不得——外墙兼承重，拆了整栋楼的传力路径就变了。要连通只能另找内隔墙。',
          '<div class="res bad"><div class="res-top"><span class="k">不建议开</span><span class="tag">承重结构</span></div>' +
          '<div class="res-adv"><s>·</s> 外墙/承重墙不允许开洞，需要结构加固与设计单位确认<br>' +
          '<s>·</s> 这间房没有可以打通的内隔墙</div></div>');
        chips([
          { label: '只开个门', fn: () => send('在' + room.num + '开个门') },
          { label: '换一间房', fn: () => send('换个房间打通') }
        ]);
        return false;
      }
      const why = bs.map(b => b.t).filter((v, i, a) => a.indexOf(v) === i);
      ai(room.num + ' ' + N.SIDE_CN[(f && f.side) || pick] + '墙' + (whole ? '拆不了' : '这个位置打不通') + '：' + why[0] +
        (others.length ? '。这间房另外 ' + others.length + ' 面内隔墙我也试过了，同样过不去' : '') +
        (why.length > 1 ? '（另外：' + why.slice(1, 3).join('；') + '）' : ''),
        '<div class="res bad"><div class="res-top"><span class="k">不建议开</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + why.map(t => '<s>·</s> ' + t).join('<br>') +
        (others.length ? '<br><s>·</s> 另外 ' + others.length + ' 面内隔墙也都试过了' : '') + '</div></div>');
      chips([
        { label: '窄一点试试', fn: () => send('在' + room.num + '打个1.2米的洞') },
        { label: '矮一点试试', fn: () => send('在' + room.num + '打个2.0米高的洞') },
        { label: '只开个门', fn: () => send('在' + room.num + '开个门') }
      ]);
      return false;
    }

    const side = best.side;
    const wall = best.wall;
    const room2 = best.room2;
    const dec = best.dec;
    const w = best.geo.w;
    const h = best.geo.h;
    const pickedFrom = best.side !== pick;

    const rerouted = dec.needReroute ? applyReroutes(dec) : 0;
    /* 整段拆的时候，落在洞口范围内的门窗本来就没了——先把它们摘掉再开洞，
       否则门扇、窗扇会悬在洞口里，看着像没拆干净。摘之前把参数记下来，撤销时好装回去。 */
    let eaten = [];
    if (whole) {
      const lo = dec.at - w / 2 + 0.02, hi = dec.at + w / 2 - 0.02;
      const grab = (list, atFn, kind) => list
        .filter(d => d.wall === wall.id && d.floor === wall.floor)
        .filter(d => { const a = atFn(d, wall); return a != null && a > lo && a < hi; })
        .map(d => ({ kind: kind, obj: d, at: atFn(d, wall), w: d.w, h: d.h, sill: d.sill || 0, room: d.room, name: d.name, added: d.added }));
      eaten = grab(M.doors || [], S.doorAt, 'door').concat(grab(M.windows || [], S.windowAt, 'window'));
      eaten.forEach(e => { e.kind === 'door' ? S.removeDoor(e.obj) : S.removeWindow(e.obj); });
    }
    /* ★ 拆墙前把这面墙里的管子整个抓一份。拆完 elec.rebuild() 会按新墙形重算，
       墙里那几段（包括竖向的墙内下引）会一并从模型里消失 —— 事后再想画"原来走在哪儿"
       就没有数据了。注意不能只抓 dec.hits：hitWall 是按洞口范围筛的，
       竖管 at0=at1=0，压根进不了 hits，可它同样随墙作废。 */
    const preWallConduits = (window.BIM.elec && window.BIM.elec.conduitsOf)
      ? (window.BIM.elec.conduitsOf({ wall: wall.id }) || []) : [];
    const p = S.addPassage(wall, dec.at, w, h, {
      to: room2 ? room2.id : null, from: room.id, demolish: whole
    });
    focusSoft(room);
    const sp = doorSpot(wall, dec.at);
    if (!S.inView(wall.floor, sp.x - 2, sp.y - 2, sp.x + 2, sp.y + 2)) S.focusDoor(wall, dec.at, room);
    pushUndo('把刚打穿的洞补回去', () => {
      S.removePassage(p);
      S.markDoorSpotClear && S.markDoorSpotClear();
      /* 拆墙时一起摘掉的门窗，撤销时装回去 */
      eaten.forEach(e => {
        const nd = e.kind === 'door'
          ? S.addDoorOpening(wall, e.at, e.w, e.h)
          : S.addWindowOpening(wall, e.at, e.w, e.h, e.sill);
        if (nd) { if (e.room) nd.room = e.room; if (e.name) nd.name = e.name; if (e.added) nd.added = true; }
      });
      if (eaten.length) S.rebuildWall(wall);
    });
    refreshElec(dec.hits, dec.reroutes);
    /* 画面按"打通预览"收口：楼体实心、这面墙半透明、只留墙内管线，
       有改线方案再叠一层绿色走向 —— 用户看完就知道动了哪根电、怎么绕的。
       必须放在 refreshElec 之后：重建电气层会把隔离组一起清掉，先摆就白摆了。 */
    /* 整面拆的时候不描红那几根已经作废的线管：墙都没了，红色粗条会挂在空房间中间，
       看着像还剩一道红墙。哪几路随墙作废，卡片里逐条列了。 */
    /* 整面拆的时候不描红那几根（墙都没了），但"涉及管线"这件事得传进去：
       管子要半透明浮出来，才看得出这面墙在配电里串了哪几路。 */
    previewPassage(wall, whole ? [] : (dec.hits || []),
      Math.max((dec.hits || []).length, whole ? preWallConduits.length : 0),
      whole ? preWallConduits : (dec.hits || []));
    (dec.reroutes || []).forEach(pl => { if (pl && pl.ok) S.showReroute(pl, 0x17a673); });

    /* 回复里要把"连通到哪、留了多少过梁、线管怎么处理、还要补什么"一次说清 */
    const above = wall.h - h;
    const toTxt = room2 ? ('，和 ' + room2.num + ' 连成一片了') : '，另一侧是走廊';
    const title = whole ? '整段拆掉了' : '打穿了';
    const eatenTxt = eaten.length
      ? '墙上原有的 ' + eaten.length + ' 处' + eaten.map(e => e.kind === 'door' ? '门' : '窗')
        .filter((v, i, a) => a.indexOf(v) === i).join('/') + '一起拆掉了'
      : '';
    const movedWallTxt = pickedFrom
      ? '你说的那面（' + N.SIDE_CN[pick] + '墙）过不去，我改成了' + N.SIDE_CN[side] + '墙'
      : '';
    /* 整面拆的时候"上方过梁"这一格没有意义（拆到梁底，本来就不留），
       换成"拆除高度"；墙里作废的线管单独列一块 —— 这是拆完以后必须补做的事。 */
    const scrap = (whole && !dec.needReroute && (dec.hits || []).length)
      ? '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      (dec.hits || []).map(c => '<s>·</s> ' + (window.BIM.elec ? window.BIM.elec.KIND_CN[c.kind] : '') +
        '线管 ' + c.circuit + ' 随墙作废，需从吊顶重新敷设').join('<br>') + '</div>'
      : '';
    const card =
      '<div class="res ' + (dec.needReroute || dec.moved ? 'warn' : 'ok') + '">' +
      '<div class="res-top"><span class="k">' + (whole ? '可以拆' : '可以开') + '</span><span class="tag">' +
      (dec.needReroute ? '已改线' : (dec.moved ? '已挪位' : '无碰撞')) + '</span></div>' +
      '<div class="res-grid"><div><i>' + (whole ? '拆除宽度' : '洞口宽') + '</i><b>' + w.toFixed(2) + ' m</b></div>' +
      '<div><i>' + (whole ? '拆除高度' : '洞口高') + '</i><b>' + h.toFixed(2) + ' m</b></div>' +
      '<div><i>' + (whole ? '拆到梁底' : '上方过梁') + '</i><b>' +
      (whole ? h.toFixed(2) + ' m 全高' : above.toFixed(2) + ' m') + '</b></div></div>' +
      scrap +
      ((dec.needReroute || dec.moved)
        ? '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
        (dec.hits || []).map(c => '<s>·</s> ' + (window.BIM.elec ? window.BIM.elec.KIND_CN[c.kind] : '') +
          '线管 ' + c.circuit + ' 已' + (dec.needReroute ? '改道' : '避让')).join('<br>') +
        (dec.needReroute ? '<br><s>·</s> 绿色是改完的新走向，多走 ' +
          dec.reroutes.reduce((s, x) => s + (x.ok ? x.addLen : 0), 0).toFixed(2) + ' 米线' : '') + '</div>'
        : '') +
      '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      (movedWallTxt ? '<s>·</s> ' + movedWallTxt + '<br>' : '') +
      dec.chk.warns.slice(0, 3).map(x => '<s>·</s> ' + x).join('<br>') +
      (eatenTxt ? '<br><s>·</s> ' + eatenTxt : '') + '</div></div>';

    /* 拆墙的叙述跟挖洞不一样：不说"洞口多大、上面留多少过梁"，
       而是"整面墙没了、拆到梁底、两端落在柱边"。 */
    const wholeTxt = whole
      ? ('这段墙 ' + w.toFixed(2) + ' 米长、' + h.toFixed(2) +
        ' 米高全部拆到梁底，两端落到墙端/柱边，不留过梁也不留墙垛')
      : ('洞口 ' + w.toFixed(2) + '×' + h.toFixed(2) + ' 米，上面留了 ' + above.toFixed(2) + ' 米过梁');
    ai(room.num + ' ' + N.SIDE_CN[side] + '墙' + title + '：' + wholeTxt + toTxt +
      (eatenTxt ? '，' + eatenTxt : '') +
      (dec.moved ? '，' + dec.moveNote : '') +
      (dec.needReroute ? '，墙里的 ' + dec.hits.length + ' 根线管已经改道（' + dec.rerouteNote + '）' : '') +
      (scrap ? '，墙里的 ' + (dec.hits || []).length + ' 根线管随墙一起作废，得从吊顶或相邻墙重新敷设' : '') +
      '。' + (movedWallTxt ? movedWallTxt + '。' : '') + (dec.chk.warns[0] || ''), card);

    lastData = {
      passage: p.name, room: room.num, side: side, width: +w.toFixed(2), height: +h.toFixed(2),
      above_m: +above.toFixed(2), to: room2 ? room2.num : null, demolish: whole,
      moved: dec.moved ? +dec.movedBy.toFixed(2) : 0,
      rerouted: rerouted,
      conduit_hit: (dec.hits || []).map(c => c.circuit),
      removed_openings: eaten.length,
      side_changed: pickedFrom ? { from: pick, to: side } : null,
      warns: dec.chk.warns
    };
    A.commit(step, { room: room, side: side, to: room2 ? room2.num : null });
    return true;
  }

  /* ================= 电路：查分路 / 切分路 =================
     用户说"3 楼照明是哪路电""把这路断电看看影响谁""这间房有几路电"都走这里。
     切分路要同时做三件事：分路变色、关联房间高亮、楼体半透明——
     不然光把线管变灰，看不出"这几间跟着黑了"。 */
  /* 回路显示名：六路之后一律以数据里的 kind_cn 为准（照明1/照明2/…），
     万一碰到老数据没带 kind_cn 才退回"照明/插座/动力"。 */
  function cnOf(c) {
    const E = window.BIM.elec;
    if (!c) return '';
    return c.kind_cn || c.short || (E && E.KIND_CN && E.KIND_CN[c.kind]) || '电';
  }

  function circuitSummary(circ) {
    const E = window.BIM.elec;
    const rooms = E.circuitRooms(circ.id);
    return {
      id: circ.id, name: circ.name, kind: cnOf(circ), on: circ.on !== false,
      panel: circ.panel, phase: circ.phase, rated: circ.rated,
      rooms: rooms.map(r => r.num), room_names: rooms.map(r => r.name),
      conduits: circ.conduits.length
    };
  }

  async function stepCircuits(step) {
    const E = window.BIM.elec;
    if (!E) { ai('电路这一层没加载起来。'); return false; }
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    const floor = step.floor != null ? step.floor : (room ? room.floor : (A.mem.ctx.floor || S.focus || 1));

    /* 问"这层总开关什么状态 / 总开关管哪些"——只报不改。
       真正的实操走 circuitset → stepMainSwitch，这里绝不能碰状态，
       否则"总开关现在合着吗"会直接把闸拉了。 */
    if (step.mainSwitch && !step.action) {
      const p = E.panelOf(floor);
      if (!p) { ai(floor + ' 楼没找到配电箱。'); return false; }
      const list = E.list(floor) || [];
      const imp = E.panelImpact(floor) || { rooms: [], count: 0 };
      const pmain = p.mainOn !== false;
      S.setFocus(floor, false);
      S.focusPanel(floor);
      S.refreshPanels(floor);
      const swRow = list.map(c =>
        '<div><i>第' + (c.no || 1) + '路 ' + c.kind_cn + '</i><b>' +
        (c.on ? '合闸·有电' : (c.switch_on === false ? '已断开' : '手柄合着·无电')) + '</b></div>').join('');
      ai(floor + ' 楼配电箱 ' + p.id + ' 的总开关现在是' + (pmain ? '合着的（整层有电）' : '断开的（整层没电）') +
        '。总开关管整层六路，现在：' +
        list.map(c => '第' + (c.no || 1) + '回路（' + c.kind_cn + '）' +
          (c.on ? '正常' : (c.switch_on === false ? '已断开' : '无电'))).join('、') + '。' +
        '控制范围不一样：总开关一断，六路一起停（' + (imp.count || 0) + ' 间房全黑）；' +
        '分路只各管自己那一路，断一路只停那一类功能。' +
        '要操作就说"把 ' + floor + ' 楼总开关' + (pmain ? '断开' : '送电') + '"。',
        '<div class="res ok"><div class="res-top"><span class="k">' + p.id + ' 总开关</span>' +
        '<span class="tag">' + (pmain ? '合闸' : '断开') + '</span></div>' +
        '<div class="res-grid">' + swRow + '</div>' +
        '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
        '<s>·</s> 最左一只总开关管整层六路；右边 1~6 号手柄各管自己那一路' +
        '<br><s>·</s> 总开关断 = 六路一起停；分路断 = 只停那一类' +
        '</div></div>');
      chips([
        { label: pmain ? '拉下总开关' : '合上总开关', fn: () => send('把' + floor + '楼总开关' + (pmain ? '断开' : '送电')) },
        { label: '看这层所有分路', fn: () => send(floor + '楼有哪些分路') }
      ]);
      lastData = {
        panel: p.id, floor: floor, main_on: pmain, scope: 'floor',
        circuits: list.map(c => ({ id: c.id, no: c.no, kind: c.kind_cn, on: c.on, switch_on: c.switch_on })),
        room_count: imp.count || 0
      };
      return true;
    }

    /* 指名某一间 → 说这间由哪几路电供；否则列这层的分路 */
    if (room && step.scope !== 'floor') {
      const cs = E.roomsCircuits(room);
      if (!cs.length) {
        ai(room.num + ' 这间没查到分路（可能是走廊或设备夹层）。');
        return false;
      }
      S.circuitView(null, [room]);
      const pw = E.roomPower(room);
      /* 两种"没电"必须分开说：自己那一路被拉下来了，还是总开关断了连坐。
         现场报修就常栽在这上面 —— 用户看着手柄都在上面，其实是总闸没合。 */
      const liveOf = c => c.live !== false;
      const ownOff = c => c.on === false;
      const dead = cs.filter(c => !liveOf(c));
      const hostMain = E.mainOn(room.floor);
      /* 每路在这间房里管什么，一起说清楚——不然"有几路电"答完也没用 */
      const perRoom = c => cnOf(c) +
        (!liveOf(c) ? (ownOff(c) ? '（这一路已断开，现在不能用）' : '（手柄没动，但总开关断了，现在没电）') : '');
      ai(room.num + ' 由 ' + cs.length + ' 路电供：' +
        cs.map(c => c.name + '（' + c.id + '，' + (liveOf(c) ? '正常' : (ownOff(c) ? '已断开' : '无电')) + '）').join('、') +
        '。' + cs.map(perRoom).join('、') + '。' +
        (dead.length ? '现在 ' + dead.length + ' 路没电，这间房的' +
          dead.map(cnOf).join('/') + '是停的。'
          : '六路都通，照明、插座、动力都正常。') +
        (hostMain ? '' : '注意：' + room.floor + ' 楼配电箱的总开关是断的，六路是一起失电的，' +
          '不是单独哪一路出问题，合上总开关才整层恢复。') +
        '要断哪一路，说"把 ' + room.num + ' 的照明断电"。',
        '<div class="res ok"><div class="res-top"><span class="k">' + room.num + '</span><span class="tag">' + cs.length + ' 路</span></div>' +
        '<div class="res-grid">' + cs.map(c => '<div><i>' + cnOf(c) + ' ' + c.id + '</i><b>' +
          (liveOf(c) ? '通电' : (ownOff(c) ? '断开' : '无电')) + '</b></div>').join('') + '</div>' +
        '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
        '<s>·</s> 每路管一类用电：照明是灯、插座是墙面取电、动力是空调和大设备，断一路只停那一类' +
        (dead.length ? '<br><s>·</s> 当前停用：' + dead.map(cnOf).join('、') : '') +
        (hostMain ? '' : '<br><s>·</s> 根子在总开关：' + room.floor + 'F 配电箱最左边那只手柄现在是断的') +
        '</div></div>');
      lastData = { room: room.num, circuits: cs.map(circuitSummary), lost: pw.lost, still: pw.still };
      return true;
    }

    const list = E.list(floor);
    if (!list.length) { ai(floor + ' 楼没有分路数据。'); return false; }
    S.circuitView(null, []);
    S.setFocus(floor, false);
    /* 说清这一层的电是怎么进来的，别只丢一串分路编号：
       主干立管 → 层配电箱 → 走廊干线 → 房间支线，这才是用户问"配电怎么分的"想要的东西 */
    const pid = list[0].panel || ('AL-' + floor);
    const corrN = list.reduce((a, c) => a + ((c.layers || {}).corridor || 0), 0);
    /* on = 实际带电，switch_on = 手柄位置。总开关一断，三个 switch_on 都还是 true。 */
    const pmain = list[0].main_on !== false;
    const stTxt = c => c.on ? '' : (c.switch_on === false ? '已断' : '没电');
    ai(floor + ' 楼共 ' + list.length + ' 路电：' + list.map(c =>
      '第' + (c.no || 1) + '回路（' + c.kind_cn + '）' + stTxt(c)).join('、') +
      '。走向是：电气竖井里的主干立管下来，进本层配电箱 ' + pid +
      '，再沿走廊桥架横铺一圈（' + corrN + ' 段干线），最后从走廊分进各房间。' +
      (pmain
        ? pid + ' 的总开关（箱门最左边那只）在合位，六路各自独立，断哪一路只停那一类。'
        : '⚠ ' + pid + ' 的总开关现在是断的：六路一起失电，六个分路手柄虽然都还停在合位，整层照样没电。' +
          '说"把 ' + floor + ' 楼总开关合上"可以一次全恢复。') +
      '要断哪一路，说"把 ' + floor + ' 楼第 1 回路断电"。',
      '<div class="res ok"><div class="res-top"><span class="k">' + floor + 'F 配电</span><span class="tag">' + list.length + ' 路</span></div>' +
      '<div class="res-grid">' + list.map(c => '<div><i>第' + (c.no || 1) + '回路 ' + c.kind_cn + '</i><b>' +
        (c.on ? c.room_nums.length + ' 间' : (c.switch_on === false ? '已断开' : '总开关断')) + '</b></div>').join('') + '</div>' +
      '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      '<s>·</s> 总开关（最左一只）管整层六路；右边 1~6 号手柄各管自己那一路' +
      '<br><s>·</s> 总开关断开时六个分路手柄不会动，只是失电 —— 屏幕上手柄仍朝上、灯变暗' +
      '<br><s>·</s> 主干立管（竖井）→ ' + pid + ' → 走廊干线 → 房间支线' +
      '<br><s>·</s> 干线在吊顶里分层走桥架，比房间支线粗；开关房门碰不到它</div></div>');
    lastData = { floor: floor, circuits: list };
    return true;
  }

  /* 从一句话/一组参数里定位到某一条分路。断电路、看回路走向两条路径共用，
     免得"关空开"和"看空开"对同一句话找出两个不同的回路来。 */
  function resolveCircuit(step, floor, room, txt) {
    const E = window.BIM.elec;
    if (!E) return null;
    txt = txt || '';
    let circ = null;
    if (step.circuit) circ = E.circuit(step.circuit) || E.circuit(String(step.circuit).toUpperCase());
    if (!circ && step.circuitNo) circ = E.circuitByNo(floor, step.circuitNo);
    if (!circ) {
      const m = txt.match(/第\s*([一二三四五六1-6])\s*回/)
        || txt.match(/回(?:路)?\s*([一二三四五六1-6])(?!\d)/)
        || txt.match(/第\s*([一二三四五六1-6])\s*(?:个|只|路|号)?\s*(?:空开|空气开关|电闸|闸刀|断路|开关)/);
      if (m) {
        const no = N.CN_NUM ? N.CN_NUM[m[1]] : ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[m[1]] || +m[1]);
        if (no) circ = E.circuitByNo(floor, no);
      }
    }
    if (!circ) {
      const kind = step.kind || (/照明|灯/.test(txt) ? 'light'
        : (/插座/.test(txt) ? 'socket' : (/动力|设备|空调/.test(txt) ? 'power' : null)));
      /* 同类里的第几条："照明2""插座1""动力2"。
         用户带序号说的时候要精确落到那一条，不能含糊成"第 1 条"。 */
      let sub = step.circuitSub || null;
      if (!sub) {
        const ms = txt.match(/(照明|插座|动力)\s*([12一二])/);
        if (ms) sub = /[12]/.test(ms[2]) ? +ms[2] : (N.CN_NUM ? N.CN_NUM[ms[2]] : null);
      }
      if (kind && sub) circ = E.circuitByKind(floor, kind, sub);
      if (!circ) {
        const pool = E.list(floor).filter(c => !kind || c.kind === kind);
        if (room) {
          const mine = pool.filter(c => (c.room_nums || []).indexOf(room.num) >= 0);
          circ = E.circuit((mine[0] || pool[0] || {}).id) || null;
        } else {
          circ = E.circuit((pool[0] || {}).id) || null;
        }
      }
    }
    return circ || null;
  }

  async function stepToggleCircuit(step) {
    const E = window.BIM.elec;
    if (!E) { ai('电路这一层没加载起来。'); return false; }
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    const floor = step.floor != null ? step.floor : (room ? room.floor : (A.mem.ctx.floor || S.focus || 1));
    const wantOff = step.power === 'off' || step.action === 'close' || step.action === 'off';
    const txt = step.text || '';

    /* ── 总开关分支 ──
       总开关（进线断路器）管整层六路，分路只管自己那一路，这是两层控制，不能混。
       不加这道拦截，说"把 2 楼总闸拉下来"会掉进下面按分路找路的逻辑 ——
       结果只断了随机某一路，用户以为整层黑了，其实只停了一类。 */
    const isMain = step.mainSwitch === true
      || (!step.circuit && !step.circuitNo && !step.kind
        && /总开关|总闸|总断路|总电源|进线开关|进线断路|整层断电|整层停|全层断电|这一层全停|一层全停/.test(txt));
    if (isMain) return await stepMainSwitch(step, floor);

    /* 找路：给了 id 用 id；说了"第几回路"按编号找；否则按房间 + 类型匹配。
       现场是按编号叫的（"2 楼第一个回路"），不是按 L2A 叫的。 */
    const circ = resolveCircuit(step, floor, room, txt);
    if (!circ) {
      ai((room ? room.num + ' 这间' : floor + ' 楼') + ' 找不到对应的分路。要不要先看看有哪些分路？');
      chips([
        { label: '列这层分路', fn: () => send(floor + '楼有哪些分路') },
        { label: '断第1回路', fn: () => send('把' + floor + '楼第1回路断电') }
      ]);
      return false;
    }

    const before = circ.on !== false;
    const nowOn = wantOff ? false : (step.power === 'on' || step.action === 'open' ? true : !before);
    E.toggle(circ.id, nowOn);
    const rooms = E.circuitRooms(circ.id);

    /* ── ① 先聚焦到这一层的配电箱，② 再把箱子重画一遍让那一路的手柄落下来 ──
       用户要的是"先看到箱子、看到开关被拉下来"，再谈影响了哪几间房。
       顺序不能反：refreshPanels 必须在 toggle 之后，几何是按当前状态烘的。 */
    const panel = S.focusPanel(circ.floor);
    S.refreshPanels(circ.floor);
    /* 图纸上这一路也一起标出来：先只留**本层**的管子（别的楼层全收起来，
       一层六路已经够密了，再叠上另外四层根本看不清），
       再让电从这只空开出发、沿走廊、下引、进房间跑一遍。 */
    S.showConduits(true);
    /* 只留本层：别的楼层整块不画。以前只是压暗成虚影，用户看到的仍然是
       "别的楼层的管线还在"，分不清哪根管是本层的 —— 看回路的时候必须干净。 */
    S.isolateFloor && S.isolateFloor(circ.floor);
    const floorCond = E.conduitsOf({ floor: circ.floor });
    /* 管径、接头都跟"看所有分路"时一模一样（grow 1 + 带接头）——
       以前这里 grow:1.6 把管子放粗、还不画接头，同一根管在两个视图里粗细不同。 */
    if (floorCond.length) S.isolateConduits(floorCond, { grow: 1, joints: true });
    const fluxList = E.conduitsOf({ circuit: circ.id }).concat(
      floorCond.filter(c => c.layer === 'trunk' || c.layer === 'feed'));
    S.flux(fluxList, { floor: circ.floor });
    S.syncCircuitPower();

    /* 影响面按"功能"算：一层只有一条照明、一条插座、一条动力，
       断了一条不等于这间房没电，而是这间房少了这一类功能。
       所以措辞只能按"这一类功能没了 / 其它几类还在"来讲，不能既说"会变黑"又说"不会黑"。 */
    const imp = E.impact(circ.id) || { rooms: [], count: 0, dark_rooms: [], bare_rooms: [], partial_rooms: [] };
    const K = circ.kind;
    const LOSS = {
      light: { gone: '灯全灭，这些房间会直接变黑', keep: '插座和动力还在，只是没灯' },
      socket: { gone: '墙上的插座全部没电，插电的设备会停', keep: '照明还在，房间不会黑' },
      power: { gone: '空调和大功率设备停', keep: '照明和插座还在' }
    }[K] || { gone: '这一路功能停用', keep: '其它分路不受影响' };
    const dark = nowOn ? [] : imp.dark_rooms;
    const bare = nowOn ? [] : imp.bare_rooms;

    const short = arr => arr.slice(0, 4).join('、') + (arr.length > 4 ? ' 等 ' + arr.length + ' 间' : '');
    /* 一条分路能带整层十几间房，平铺会挤 —— 同样按 5 列换行排 */
    const rows = rooms.slice(0, 12).map(r => {
      const pw = E.roomPower(r);
      const st = nowOn ? '正常' : (pw.lost.length >= 3 ? '全停' : (pw.lost.length ? pw.lost.join('+') + '停' : '正常'));
      const tail = nowOn ? '' : (pw.still.length ? '剩 ' + pw.still.join('/') : '全停');
      return '<div><i>' + r.num + '</i><b>' + st + '</b>' +
        (tail ? '<s style="display:block;font-weight:400;color:#8a929b;font-size:9.5px">' + tail + '</s>' : '') +
        '</div>';
    }).join('');

    /* 断路器位置说明：手柄从左到右就是第 1/2/3 回路，在箱子上看得见。
       三态必须分开：合闸有电 / 手柄还合着但总开关断了 / 这一路自己断了 */
    const pmain = E.mainOn(circ.floor);
    const swRow = (E.list(circ.floor) || []).map((c, i) =>
      '<div><i>第' + (i + 1) + '路 ' + c.kind_cn + '</i><b>' +
      (c.on ? '合闸' : (c.switch_on === false ? '已断开' : '手柄合着·无电')) + '</b></div>').join('');

    const card =
      '<div class="res ' + (nowOn ? 'ok' : (dark.length ? 'warn' : 'ok')) + '">' +
      '<div class="res-top"><span class="k">' + circ.id + ' ' + (nowOn ? '已合闸' : '已断电') + '</span>' +
      '<span class="tag">' + (circ.label || circ.name) + ' · ' + circ.phase + '</span></div>' +
      '<div class="res-grid wrap">' + rows + '</div>' +
      '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      '<s>·</s> 配电箱 ' + circ.panel + ' 上六只分路手柄，从左数第 ' + (circ.no || 1) + ' 只（' + cnOf(circ) + '）已' +
      (nowOn ? '合上，指示灯变绿' : '落下，指示灯变红') +
      (!pmain ? '（不过这层的总开关还断着，整层现在没电）' : '') +
      (nowOn ? '' : '；这一路带 ' + imp.count + ' 间房的' + cnOf(circ) + '，' + LOSS.gone) +
      (nowOn ? '' : '<br><s>·</s> ' + LOSS.keep) +
      (bare.length ? '<br><s>·</s> 其中 ' + bare.length + ' 间本来就只有这一路，等于彻底没电' : '') +
      '<br><s>·</s> 总开关（最左那只）管整层六路，右边这六只各管自己那一路' +
      '<br><s>·</s> 整条路径：' + circ.floor + 'F 竖井主干 → 层进线 → ' + circ.panel +
      ' → 走廊吊顶干线 → 墙内下引 → 各房间支线' +
      '<br><s>·</s> 点下面的「查看回路影响」可以只看这一条路走到哪几间房</div>' +
      '<div class="res-grid" style="border-top:1px solid #eef1f5">' + swRow + '</div></div>';

    ai(circ.name + '（' + circ.id + '）' + (nowOn ? ' 合上了：' : ' 断了：') +
      '这条分路带 ' + imp.count + ' 间房（' + short(implicitRoomNums(rooms)) + '）' +
      (nowOn ? '，现在全部恢复。'
        : '，' + LOSS.gone + '；' + LOSS.keep + '。') +
      '镜头已经站到 ' + (panel ? panel.name : circ.panel) + ' 前面，箱子上第 ' + (circ.no || 1) +
      ' 个手柄已经' + (nowOn ? '合上' : '落到断开位') + '。' +
      (!pmain
        ? ' 注意：' + circ.floor + 'F 的总开关现在是断的，' +
          (nowOn ? '光合这一路不会来电，得先合总开关。' : '这一路本来就无电，拉它不会带来任何变化；要先合总开关，才谈得上断哪一路。')
        : ''),
      card);

    chips([
      { label: '查看回路影响', fn: () => showCircuitImpact(circ.id) },
      nowOn
        ? { label: '断掉这一路', fn: () => send('把' + circ.floor + '楼第' + (circ.no || 1) + '回路断电') }
        : { label: '恢复这一路', fn: () => send('把' + circ.floor + '楼第' + (circ.no || 1) + '回路送电') },
      { label: '看这层所有分路', fn: () => send(circ.floor + '楼有哪些分路') }
    ]);

    lastData = {
      circuit: circ.id, name: circ.name, label: circ.label, no: circ.no,
      kind: cnOf(circ), on: nowOn,
      switch_on: circ.on !== false, main_on: pmain,
      panel: circ.panel, phase: circ.phase, rated: circ.rated,
      rooms: implicitRoomNums(rooms),
      dark_rooms: dark,
      bare_rooms: bare,
      partial_rooms: imp.partial_rooms,
      function_lost: nowOn ? null : cnOf(circ),
      still_powered: rooms.filter(r => E.roomPower(r).on.length > 0).map(r => r.num)
    };
    return true;
  }

  /* 总开关（进线断路器）：一拉整层六路全停，一合六路一起恢复。
     和"断某一分路"必须分开讲 —— 用户要能把"整层黑了"和"只停了一类"分清楚，
     也要知道总开关合上以后，之前单独断开的分路并不会跟着自动恢复。 */
  async function stepMainSwitch(step, floor) {
    const E = window.BIM.elec;
    const p = E.panelOf(floor);
    if (!p) {
      ai(floor + ' 楼没找到配电箱，查不到总开关。');
      return false;
    }
    const before = p.mainOn !== false;
    const wantOff = step.power === 'off' || step.action === 'close' || step.action === 'off';
    const nowOn = wantOff ? false : (step.power === 'on' || step.action === 'open' ? true : !before);
    E.togglePanel(floor, nowOn);

    const imp = E.panelImpact(floor) || { rooms: [], count: 0, circuits: [] };
    /* 先聚焦到这只箱子，再重画：几何是按状态烘出来的，顺序反了手柄还是旧的 */
    S.focusPanel(floor);
    S.refreshPanels(floor);
    S.showConduits(true);
    S.isolateFloor && S.isolateFloor(floor);      // 只留本层，别层的管/墙/板一并不画
    /* 总开关动的是整层，只留本层的管子；六路全部参与流动，
       一眼看出"这一闸管的就是这一层的这六条路"。 */
    const floorAll = E.conduitsOf({ floor: floor });
    /* 同上：管径与接头跟"看所有分路"保持一致 */
    if (floorAll.length) S.isolateConduits(floorAll, { grow: 1, joints: true });
    S.flux(floorAll, { floor: floor });
    S.syncCircuitPower();

    const list = E.list(floor) || [];
    /* 总开关合上了，但这几路自己的手柄还断着 —— 那几间房照样没电。
       这是最容易让人以为"合了总闸怎么还不亮"的地方，必须点名。 */
    const stillOff = list.filter(c => c.switch_on === false);
    const rooms = imp.rooms || [];
    const short = arr => arr.slice(0, 4).join('、') + (arr.length > 4 ? ' 等 ' + arr.length + ' 间' : '');

    let msg = floor + ' 楼配电箱 ' + p.id + ' 的总开关';
    if (nowOn) {
      msg += '已合上：照明1/2、插座1/2、动力1/2 六路一起恢复，' + (imp.count || 0) + ' 间房重新有电。';
      if (stillOff.length) {
        msg += '不过 ' + stillOff.map(c => '第' + (c.no || 1) + '回路（' + c.kind_cn + '）').join('、') +
          ' 自己的手柄还断着，它带的那几间现在仍然没电 —— 总开关只管"整层有没有电送进来"，' +
          '分路该合还得单独合：说"把 ' + floor + ' 楼第 ' + (stillOff[0].no || 1) + ' 回路送电"。';
      }
    } else {
      msg += '已拉下：照明1/2、插座1/2、动力1/2 六路一起失电，整层 ' + (imp.count || 0) + ' 间房全停' +
        (rooms.length ? '（' + short(rooms.map(r => r.num)) + '）' : '') + '。' +
        '六个分路手柄我一个没碰，还都停在合位 —— 总闸一断分路不会自己跳，' +
        '箱子上看到的就是"手柄全朝上、灯全灭"。' +
        '只想停某一类，用"把 ' + floor + ' 楼第 1 回路断电"，那才只停那一路。';
    }

    /* 整层 10 间房，平铺成 10 列会挤成一团 —— 用 wrap 网格按 5 列排。
       "全停"要按这间房自己的分路数判：有的房间只有 2 路，
       总开关一断它也是全停，不能因为 lost=2 就说成"缺 2 路"。 */
    const rows = rooms.slice(0, 10).map(r => {
      const total = E.roomsCircuits(r).length;
      const lost = E.roomPower(r).lost.length;
      const st = lost === 0 ? '正常' : (lost >= total ? '全停' : '缺' + lost + '路');
      return '<div><i>' + r.num + '</i><b>' + st + '</b></div>';
    }).join('');

    /* 六路各自的状态：这里能直接看出"手柄位置"和"有没有电"是两件事 */
    const swRow = list.map(c =>
      '<div><i>第' + (c.no || 1) + '路 ' + c.kind_cn + '</i><b>' +
      (c.on ? '合闸·有电' : (c.switch_on === false ? '已断开' : '手柄合着·无电')) + '</b></div>').join('');

    const card =
      '<div class="res ' + (nowOn ? 'ok' : 'warn') + '">' +
      '<div class="res-top"><span class="k">' + p.id + ' 总开关</span>' +
      '<span class="tag">' + floor + 'F · 管整层六路</span></div>' +
      '<div class="res-grid wrap">' + rows + '</div>' +
      '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      '<s>·</s> 总开关在箱门最左边，中间隔了一道挡板；右边六个手柄才是第 1~6 回路' +
      '<br><s>·</s> 左只管全层、右各管一路：总开关断 = 六路一起停，分路断 = 只停那一类' +
      (nowOn ? '' : '<br><s>·</s> 分路手柄没有被拉下来，只是没电（灯变暗表示失电，不是断开）') +
      (stillOff.length ? '<br><s>·</s> 仍有 ' + stillOff.length + ' 路自己断着：' +
        stillOff.map(c => '第' + (c.no || 1) + '回路').join('、') : '') +
      '</div>' +
      '<div class="res-grid" style="border-top:1px solid #eef1f5">' + swRow + '</div></div>';

    ai(msg, card);

    chips([
      nowOn
        ? { label: '拉下总开关', fn: () => send('把' + floor + '楼总开关断开') }
        : { label: '合上总开关', fn: () => send('把' + floor + '楼总开关送电') },
      { label: '看这层所有分路', fn: () => send(floor + '楼有哪些分路') },
      stillOff.length
        ? { label: '合上第' + (stillOff[0].no || 1) + '回路', fn: () => send('把' + floor + '楼第' + (stillOff[0].no || 1) + '回路送电') }
        : { label: '断第1回路', fn: () => send('把' + floor + '楼第1回路断电') }
    ]);

    lastData = {
      panel: p.id, floor: floor, main_on: nowOn,
      scope: 'floor',                       // 总开关 = 整层，不是某一路
      circuits: list.map(c => ({ id: c.id, no: c.no, kind: c.kind_cn, on: c.on, switch_on: c.switch_on })),
      rooms: rooms.map(r => r.num),
      room_count: imp.count || 0,
      dark_rooms: nowOn ? [] : rooms.map(r => r.num)
    };
    return true;
  }

  /* 「查看回路影响」气泡的动作：把主干线 + 这一路的支路 + 受影响房间单独亮出来。
     和"断电"分开两步 —— 先看清箱子上的开关，再看这一路到底喂了哪些房间。 */
  function showCircuitImpact(circId) {
    const E = window.BIM.elec;
    if (!E) return;
    const circ = E.circuit(circId);
    if (!circ) { ai('找不到这条分路，可能模型刚重建过。'); return; }
    const rooms = E.circuitRooms(circ.id);
    const list = S.circuitRoute(circ, rooms) || [];
    const cnt = k => list.filter(c => c.layer === k).length;
    /* 三态：带电 / 手柄合着但总开关断了 / 这一路自己断了。
       光写"已断电"会让人以为手柄被拉了，现场排查就靠这一句话分辨。 */
    const live = circ.live !== false;
    const ownOn = circ.on !== false;
    const nums = rooms.map(r => r.num);
    const stateTxt = live ? '带电' : (ownOn ? '总开关断·无电' : '已断电');

    /* 每一段路由都点名：干线几段、下引几处、支线几段，别只说"带 11 间房"。
       计数为 0 的层级不列 —— 照明支线 2.90 紧贴干线 3.00，本来就不需要下引，
       列一行"墙内下引 0 处"只会让人以为漏了。 */
    const rows = [
      ['主干立管', cnt('trunk'), '段'],
      ['层进线', cnt('feed'), '段'],
      ['配电箱', 1, '台'],
      ['箱到桥架', cnt('out'), '段'],
      ['走廊干线', cnt('corridor'), '段'],
      ['墙内下引', cnt('drop'), '处'],
      ['房间支线', cnt('room'), '段'],
      ['影响房间', rooms.length, '间']
    ].filter(r => r[1] > 0)
      .map(r => '<div><i>' + r[0] + '</i><b>' + r[1] + ' ' + r[2] + '</b></div>').join('');

    const where = circ.kind === 'light'
      ? '照明支线走吊顶（2.90 m），紧贴走廊干线（3.00 m），不需要单独下引'
      : '通过墙内下引从走廊桥架接到房间支线';

    const card =
      '<div class="res ' + (live ? 'ok' : 'warn') + '">' +
      '<div class="res-top"><span class="k">' + (circ.label || circ.id) + ' 完整路由</span>' +
      '<span class="tag">' + stateTxt + '</span></div>' +
      '<div class="res-grid">' + rows + '</div>' +
      '<div class="res-adv" style="border-top:1px solid #eef1f5">' +
      '<s>·</s> 影响的房间：' + nums.slice(0, 12).join('、') + (nums.length > 12 ? ' 等 ' : '') +
      '<br><s>·</s> ' + where +
      '<br><s>·</s> 图上只留下这一条路（本层主干立管 + 本回路），其它回路、以及别的楼层都已收起；本层墙体/梁柱 50% 半透明，绿色地面就是受影响的房间' +
      (live ? '' : (ownOn
        ? '<br><s>·</s> 这路的手柄其实还合着，是 ' + circ.floor + 'F 总开关断了才没电 —— 合总开关就整层恢复'
        : '<br><s>·</s> 这一路自己的手柄是落下的，其它两路不受影响')) +
      '</div></div>';

    ai((circ.label || circ.name) + ' 的完整路由已单独显示：' + circ.floor + 'F 竖井主干这一段 → 层进线 → ' +
      circ.panel + ' → 走廊干线 → ' + (cnt('drop') ? '墙内下引 → ' : '') + '各房间支线，' +
      '一共照亮 ' + rooms.length + ' 间房' +
      (live ? '。' : (ownOn ? '（这一路手柄是合的，但 ' + circ.floor + 'F 总开关断着，所以没电）。' : '（这一路手柄已拉下，断电状态）。')),
      card);

    lastData = {
      circuit: circ.id, no: circ.no, label: circ.label,
      on: live, switch_on: ownOn, main_on: E.mainOn(circ.floor),
      route: { trunk: cnt('trunk'), feed: cnt('feed'), out: cnt('out'), corridor: cnt('corridor'), drop: cnt('drop'), room: cnt('room') },
      rooms: nums
    };
  }

  function implicitRoomNums(rooms) { return (rooms || []).map(r => r.num); }

  /* ── 工具 view_circuit：把某一路的走向单独画出来（只看走向，不改通断） ── */
  async function stepCircuitView(step) {
    const E = window.BIM.elec;
    if (!E) { ai('电路这一层没加载起来。'); return false; }
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    const floor = step.floor != null ? step.floor : (room ? room.floor : (A.mem.ctx.floor || S.focus || 1));
    const circ = resolveCircuit(step, floor, room, step.text || '');
    if (!circ) {
      ai(floor + ' 楼找不到对应的分路。先说"列这层分路"看看有哪几路，或者直接告诉我第几回路。');
      return false;
    }
    showCircuitImpact(circ.id);
    return true;
  }

  /* ── 工具 focus_floor：整体聚焦到某一层（0 = 回到全楼） ──
     聚焦后本层实心、其它楼层和顶梁 50% 半透明（不隐藏），管线只画本层。
     具体透明度都在 scene.js 的 applyBody 里算，这里只负责切楼层和说话。 */
  async function stepFocusFloor(step) {
    const lv = Math.max(0, Math.min(6, +step.floor || 0));
    ST.focus = lv;
    S.setFocus(lv);
    S.clearHighlight && S.clearHighlight();
    finishMode(); paintFloors();
    /* 文案跟着当前模式走：正在看管线（透视开着）时别层是收起的，
       这时说"别的楼层 50% 半透明"就是骗人。 */
    if (!lv) ai('回到全楼视角：所有楼层和顶梁都出来了，管线按当前开关显示全部。', null, false);
    else if (S.xray) ai('聚焦到 ' + lv + ' 楼：其它楼层收起，' + lv + 'F 的墙体/梁柱 50% 半透明，管线只画这一层。', null, false);
    else ai('聚焦到 ' + lv + ' 楼：' + lv + 'F 实心看得清，' + lv + 'F 以上的楼层和顶梁收起来了（不挡住这一层），以下的楼层留 50% 半透明当参照，管线只画这一层。', null, false);
    return true;
  }

  /* ── 工具 show_conduits：看管线（全部 / 某层 / 收起） ── */
  async function stepShowConduits(step) {
    const sc = step.scope || 'floor';
    if (sc === 'off') {
      S.showConduits(false);
      ai('管线收起来了。', null, false);
      return true;
    }
    if (sc === 'all') {
      /* 看全部管线：先把视角退回全楼，整栋楼压到 20% 半透明（楼体还在，不是不显示） */
      ST.focus = 0;
      S.setFocus(0);
      S.showConduits(true);
      finishMode(); paintFloors();
      ai('显示全部楼层的管线：整栋楼压到 20% 半透明做背景，六路分路的管子都在上面跑。', null, false);
      return true;
    }
    const lv = Math.max(1, Math.min(6, +(step.floor || S.focus || 1)));
    ST.focus = lv;
    S.setFocus(lv);
    S.showConduits(true);
    finishMode(); paintFloors();
    ai('只看 ' + lv + ' 楼的管线：其它楼层已经收起，' + lv + 'F 的墙体、梁柱压到 50% 半透明，墙里的暗管才看得见。', null, false);
    return true;
  }

  /* 查一面墙里到底埋了什么。开洞前先看一眼，比开了再撞上强 */
  async function stepConduits(step) {
    const E = window.BIM.elec;
    if (!E) { ai('电路这一层没加载起来。'); return false; }
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (!room) { ai('要查哪一间房的墙？说个房间号。'); return false; }
    const side = pickPassageSide(room, {
      side: step.side || (step.sideRel ? viewSide(step.sideRel) : null),
      to: step.to, floor: step.floor
    }) || 'south';
    const wall = M.walls.find(w => w.id === (room.sides || {})[side]);
    if (!wall) { ai(room.num + ' 这间房找不到对应的墙。'); return false; }

    const list = (E.conduitsOf({ floor: wall.floor }) || []).filter(c => c.wall === wall.id);
    S.circuitView(null, [room]);
    S.ghostWall(wall, true);
    S.showConduits(true);
    /* 查墙里有什么，就只把这面墙里的管子亮出来，别的全收掉 */
    if (list.length) { S.isolateConduits(list); S.markConduits(list, 0xff3b30); }

    if (!list.length) {
      ai(room.num + ' ' + N.SIDE_CN[side] + '墙里没查到预埋线管，开洞不会碰到电。',
        '<div class="res ok"><div class="res-top"><span class="k">无预埋</span><span class="tag">可以开</span></div>' +
        '<div class="res-adv"><s>·</s> 墙内没有照明/插座/动力线管经过</div></div>');
      lastData = { room: room.num, side: side, conduits: [] };
      return true;
    }

    const byCirc = {};
    list.forEach(c => {
      const k = c.circuit;
      (byCirc[k] = byCirc[k] || []).push(c);
    });
    const rows = Object.keys(byCirc).map(id => {
      const cs = byCirc[id];
      const circ = E.circuit(id) || {};
      const kinds = [];
      cs.forEach(c => { const k = cnOf(c); if (kinds.indexOf(k) < 0) kinds.push(k); });
      return '<div><i>' + id + ' ' + cnOf(circ) + '</i><b>' +
        cs.length + ' 段 · ' + kinds.join('/') + '</b></div>';
    }).join('');
    const zs = list.map(c => c.z).sort((a, b) => a - b);
    /* 干线和支线要分开说：干线在吊顶桥架里，普通门洞根本够不着，
       支线才是开洞真正会碰到的。混在一起讲，用户会以为"这墙不能动"。 */
    const trunkN = list.filter(c => c.layer === 'corridor' || c.layer === 'trunk').length;
    const branchN = list.filter(c => c.layer === 'room' || c.layer === 'drop').length;
    const split = (trunkN ? '，其中 ' + trunkN + ' 段是走廊/主干的高位干线（在吊顶桥架里，' +
      '开普通的门窗洞够不着它）' : '') +
      (branchN ? '，' + branchN + ' 段是房间支线（会挡开洞）' : '');
    ai(room.num + ' ' + N.SIDE_CN[side] + '墙里埋着 ' + list.length + ' 段线管，分属 ' +
      Object.keys(byCirc).length + ' 条分路：' + Object.keys(byCirc).map(id => id).join('、') +
      '，高度大致在 ' + C.fmt(zs[0], 2) + '~' + C.fmt(zs[zs.length - 1], 2) + ' 米之间' + split +
      '。在这个高度范围内开洞就会撞上，我已经标红了。',
      '<div class="res warn"><div class="res-top"><span class="k">墙内有线管</span><span class="tag">' +
      list.length + ' 段</span></div><div class="res-grid">' + rows + '</div>' +
      '<div class="res-adv" style="border-top:1px solid #eef1f5"><s>·</s> 红色为线管位置，墙体已半透明' +
      (trunkN ? '<br><s>·</s> 高位干线在吊顶里，开普通门窗洞碰不到，只有做到顶的高窗才会撞' : '') +
      '<br><s>·</s> 要在这里开洞的话，系统会先算能不能改线，改不动才建议换个位置</div></div>');
    lastData = {
      room: room.num, side: side,
      conduits: list.map(c => ({
        id: c.id, circuit: c.circuit, kind: cnOf(c),
        layer: c.layer, layer_cn: E.LAYER_CN[c.layer] || c.layer,
        at0: +c.at0.toFixed(2), at1: +c.at1.toFixed(2), z: c.z
      }))
    };
    return true;
  }

  async function stepWindowOff(step) {
    let d = null;
    if (step.window) d = M.windows.find(x => x.id === step.window || x.name === step.window);
    if (!d && ST.lastWin) d = ST.lastWin.d;
    if (!d) {
      const A = window.BIM.agent;
      const room = step.room ? A.roomByNum(step.room, step.floor) : A.mem.ctx.room;
      if (room) {
        const cands = M.windows.filter(x => x.added && (x.rooms || []).indexOf(room.id) >= 0);
        if (cands.length) d = cands[cands.length - 1];
      }
    }
    if (!d) { ai('现在没有可以封的窗。只说我新建的窗才能拆。'); return false; }
    if (!d.added) { ai('「' + d.name + '」是模型里原有的窗，拆不了。只说我新建的窗才能拆。'); return false; }
    const wall = M.walls.find(w => w.id === d.wall);
    const at = wall ? S.windowAt(d, wall) : null;
    const rmW = wall ? (roomOfOpening(d, wall, at) || A.mem.ctx.room) : null;
    const snap = { wall: wall, at: at, w: d.w, h: d.h, sill: d.sill, name: d.name, room: d.room };
    S.removeWindow(d);
    if (ST.lastWin && ST.lastWin.d === d) ST.lastWin = null;
    pushUndo('把「' + snap.name + '」重新开回去', () => {
      const nd = S.addWindowOpening(snap.wall, snap.at, snap.w, snap.h, snap.sill);
      if (snap.room) nd.room = snap.room;
      ST.lastWin = { wall: snap.wall, at: snap.at, w: snap.w, d: nd, room: snap.room };
    });
    ai('把 ' + snap.name + ' 封了，墙上恢复成整面墙。要说撤回也行。');
    lastData = { removed: snap.name };
    if (rmW) window.BIM.agent.commit({ act: 'windowoff', text: step.text }, { room: rmW });
    return true;
  }

  function winRow(d) {
    const r = M.rooms.find(x => x.id === (d.rooms || [])[0]);
    return '<div class="kv"><i>' + esc(d.name) + (r ? ' · ' + r.num : '') + '</i><b>' +
      (d.added ? '新增' : '原有') + ' · ' + d.w.toFixed(2) + '×' + d.h.toFixed(2) +
      ' m · 台 ' + (d.sill || 0).toFixed(2) + '</b></div>';
  }

  async function stepWindows(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    let wins = (M.windows || []).slice();
    if (room) wins = wins.filter(d => (d.rooms || []).indexOf(room.id) >= 0);
    else if (step.floor) wins = wins.filter(d => d.floor === +step.floor);
    if (!wins.length) { ai((room ? room.num + ' 室' : '这层') + '没有登记的外窗。'); return false; }
    const where = room ? room.num + ' 室' : (step.floor ? step.floor + ' 楼' : '全楼');
    ai(where + '一共 ' + wins.length + ' 樘窗，其中新建的 ' + wins.filter(d => d.added).length + ' 樘：',
      '<div class="res ok"><div class="res-adv">' + wins.map(winRow).join('') + '</div></div>', false);
    lastData = { where: where, count: wins.length, items: wins.map(d => ({ name: d.name, width: d.w, height: d.h, sill: d.sill, added: !!d.added })) };
    return true;
  }

  async function stepWinInfo(step) {
    let wins = (M.windows || []).slice();
    if (step.window) wins = wins.filter(x => x.id === step.window || x.name === step.window);
    else {
      const A = window.BIM.agent;
      const room = step.room ? A.roomByNum(step.room, step.floor) : (ST.lastWin ? ST.lastWin.room : null);
      if (room) wins = wins.filter(d => (d.rooms || []).indexOf(room.id) >= 0);
    }
    if (!wins.length) { ai('没找到对应的窗。'); return false; }
    ai('这 ' + wins.length + ' 樘窗是这样：',
      '<div class="res ok"><div class="res-adv">' + wins.map(winRow).join('') +
      '<div class="kv"><i>窗顶标高</i><b>' + ((wins[0].pos && wins[0].pos[2]) || 0).toFixed(2) + ' m 附近</b></div>' +
      '</div></div>', false);
    lastData = { count: wins.length, items: wins.map(d => ({ name: d.name, width: d.w, height: d.h, sill: d.sill })) };
    return true;
  }

  /* 找"要挪的那扇窗"：明确点名 > 刚开的那扇 > 这间房最近的一扇 */
  function resolveWindow(step) {
    /* 顺序同门：先认"刚点的那一扇"，再认 id/代号，名字重名不瞎猜 */
    const all = M.windows || [];
    const sel = (ST.selOpening && ST.selOpening.kind === 'window')
      ? (all.find(x => x.id === ST.selOpening.id) || null) : null;
    if (step.window) {
      const h = openingBy(all, step.window);
      if (h && h.d) return h.d;
      if (h && h.amb) {
        if (sel && h.amb.some(x => x.id === sel.id)) return sel;
        ST.openingAmb = { kind: 'window', list: h.amb };
        return null;
      }
    }
    if (sel) return sel;
    if (ST.lastWin && ST.lastWin.d) return ST.lastWin.d;
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (room) {
      const c = all.filter(x => (x.rooms || []).indexOf(room.id) >= 0);
      const added = c.filter(x => x.added);
      if (added.length) return added[added.length - 1];
      if (c.length) return c[c.length - 1];
    }
    return null;
  }

  /* 挪窗。窗在墙上只有两个自由度，所以方向语义要分开：
     · 往上 / 往下 → 改窗台高 sill（窗宽窗高不变，整扇窗抬起来）
     · 往左 / 往右 / 前 / 后 → 沿着墙滑动 at
       这里的方向一律按**当前镜头**换算（走 dirVec → S.viewAxes），
       用户把模型转过去之后说"往左"，动的还是他眼睛看到的左边，不会反过来。
     每次挪完都重新跑一遍窗的校核：压墙角、撞柱、贴上别的门窗、顶到梁，都拦下来说清原因。 */
  async function stepMoveWindow(step) {
    const d = resolveWindow(step);
    if (!d) {
      ai('现在没有可以挪的窗。先说「在 306 开个窗」，或者用鼠标点一下要挪的那扇。');
      return false;
    }
    if (!d.added) {
      /* 模型里原有的窗也允许挪/改：用户点了它、又明说要改，就该改得动。
         只是回执里交代一句"这是原有窗"，别让人以为系统偷偷加了一扇。 */
      toast('「' + d.name + '」是模型原有的窗，按你的要求改');
    }
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) { ai('找不到这扇窗挂在哪面墙上了。'); return false; }
    const at0 = S.windowAt(d, wall);
    // 同改尺寸：窗在哪一段墙上说了算，上下文那间只作兜底
    const room = roomOfOpening(d, wall, at0) || step.roomRef || null;
    if (at0 == null) { ai('这扇窗的位置读不出来，可能墙上的洞口已经被改掉了。'); return false; }
    const sill0 = d.sill == null ? 0.9 : d.sill;
    const w = d.w, h = d.h;
    const dist = step.dist || 0.3;
    const dir = step.dir;

    if (!dir) {
      ai('往哪边挪？「往上挪」是把窗抬高等，也可以说「往左挪半米」沿墙滑。');
      chips([
        { label: '抬高 0.3 m', fn: () => send('把窗往上挪一点') },
        { label: '降低 0.3 m', fn: () => send('把窗往下挪一点') },
        { label: '沿墙往左', fn: () => send('把窗往左挪半米') },
        { label: '沿墙往右', fn: () => send('把窗往右挪半米') }
      ]);
      return false;
    }

    const vertical = (dir === 'up' || dir === 'down');
    const span = roomSpanOnWall(wall, room);
    let at = at0, sill = sill0, dirTxt = '';
    if (vertical) {
      sill = sill0 + (dir === 'up' ? dist : -dist);
      dirTxt = dir === 'up' ? '往上' : '往下';
    } else if (dir === 'center') {
      at = (span.lo + span.hi) / 2;
      dirTxt = '往墙中间';
    } else {
      const v = dirVec(dir, room);
      if (!v) { ai('没听懂往哪边挪。「往上」「往下」「往左」「往右」这几个说法都行。'); return false; }
      const ax = S.wallAxis(wall);
      const sgn = (v.x * ax.x + v.y * ax.y) >= 0 ? 1 : -1;
      at = at0 + sgn * dist;
      dirTxt = '往' + (v.txt || '旁边');
    }

    // 先夹进"这面墙、这间房"能用的范围，别一挪就跑到隔壁房间去
    const loA = span.lo + w / 2 + 0.12, hiA = Math.max(loA, span.hi - w / 2 - 0.12);
    const atC = vertical ? at0 : clamp(at, loA, hiA);
    const sillMax = Math.max(0.12, wall.h - h - 0.28);
    const sillC = vertical ? clamp(sill, 0.12, sillMax) : sill0;

    const movedAt = Math.abs(atC - at0), movedSill = Math.abs(sillC - sill0);
    if (movedAt < 0.01 && movedSill < 0.01) {
      S.highlightWall(wall, 0xdd9a2c);
      const why = vertical
        ? '窗已经到' + (dir === 'up' ? '顶了，窗顶顶住上面的梁（墙净高 ' + wall.h.toFixed(2) + ' 米）' : '底了，窗台再低就落地了')
        : '已经挪到头了，再过去就出房间墙面了';
      ai(why + '。' + (dir === 'up' ? '想再高得先把窗做矮一点。' : ''), null);
      chips(vertical
        ? [{ label: '把窗做矮 0.3 m', fn: () => send('把这扇窗的窗高改成' + Math.max(0.5, h - 0.3).toFixed(1) + '米') }]
        : [{ label: '反过来挪', fn: () => send('把窗往' + (dir === 'left' ? '右' : '左') + '挪半米') }]);
      return false;
    }

    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    let chk = C.window({ wall: wall, at: atC, w: w, h: h, sill: sillC, equipments: eqs, room: room, self: d });
    let atF = atC, note = '';

    // 目标位置被挡时不要一口回绝：用户要的是"朝这边动一动"，
    // 不是"必须正好挪 0.4 米"。顺着同一个方向找最近的合法位置（限 2 米内），
    // 找到了就退一点落位，并在回执里说清让了多少。
    if (!chk.pass && !vertical) {
      const sug = C.suggestWindowAt({ wall: wall, room: room, at: atC, w: w, h: h, sill: sillC, equipments: eqs, self: d });
      const sameWay = sug && sug.at != null && Math.sign(sug.at - at0) === Math.sign(atC - at0 || 1);
      if (sameWay && sug.check && sug.check.pass && Math.abs(sug.at - atC) < 2.0 && Math.abs(sug.at - at0) > 0.01) {
        atF = sug.at;
        chk = sug.check;
        note = (chk.blocks[0] ? chk.blocks[0].t : '那边有点挤') + '，顺着墙让到了 ' + atF.toFixed(2) + ' 米的位置。';
      }
    }

    if (!chk.pass) {
      S.highlightWall(wall, 0xdd534f);
      const bs = (chk.blocks || []).slice(0, 3).map(b => b.t).join('；') || '这个位置不行';
      ai('这个位置挪不过去：' + bs + '。',
        '<div class="res bad"><div class="res-top"><span class="k">挪不了</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + (chk.blocks || []).map(b => '<s>·</s> ' + b.t).join('<br>') + '</div></div>');
      chips(vertical
        ? [{ label: '往上挪', fn: () => send('把窗往上挪一点') },
           { label: '往下挪', fn: () => send('把窗往下挪一点') }]
        : [{ label: '往左挪', fn: () => send('把窗往左挪半米') },
           { label: '往右挪', fn: () => send('把窗往右挪半米') },
           { label: '挪到墙中间', fn: () => send('把窗挪到墙中间') }]);
      return false;
    }

    const nd = S.replaceWindow(d, { at: atF, sill: sillC, w: w, h: h });
    if (!nd) { ai('这扇窗挪不过去，墙上原来的洞口找不到了。'); return false; }
    ST.lastWin = { wall: wall, at: atF, w: w, h: h, d: nd, chk: chk, room: room };
    const sp = doorSpot(wall, atF);
    S.markDoorSpot(wall, atF, w, h, true);
    if (room) focusSoft(room, { keepView: true, color: false });
    if (!S.inView(wall.floor, sp.x - 1.8, sp.y - 1.8, sp.x + 1.8, sp.y + 1.8)) S.focusDoor(wall, atF, room);

    pushUndo('把窗挪回原来的位置', () => {
      const bak = S.replaceWindow(nd, { at: at0, sill: sill0, w: w, h: h });
      if (bak) ST.lastWin = { wall: wall, at: at0, w: w, h: h, d: bak, room: room };
    });

    // 回执要能直接回答"挪了多少、现在到哪了、还剩多少余地"
    const left = atF - w / 2 - span.lo, right = span.hi - atF - w / 2;
    const upLeft = (wall.h - 0.28) - (sillC + h);
    const movedAt2 = Math.abs(atF - at0);
    const bits = [];
    if (movedSill > 0.01) bits.push('窗台高 ' + sill0.toFixed(2) + ' → ' + sillC.toFixed(2) + ' 米');
    if (movedAt2 > 0.01) bits.push('沿墙 ' + dirTxt + '滑了 ' + movedAt2.toFixed(2) + ' 米');
    ai('把 ' + (room ? room.num + ' 室那扇窗' : nd.name) + dirTxt + '挪了 ' + Math.max(movedAt2, movedSill).toFixed(2) + ' 米：' +
      bits.join('，') + '。' +
      (vertical
        ? '窗顶离梁还有 ' + Math.max(0, upLeft).toFixed(2) + ' 米。'
        : '两头到墙角分别还有 ' + left.toFixed(2) + ' / ' + right.toFixed(2) + ' 米。') +
      (note ? '（' + note + '）' : '') +
      (chk.warns && chk.warns.length ? chk.warns[0] + '。' : ''),
      winCard(w, h, sillC, chk));
    lastData = {
      window: nd.name, room: room ? room.num : null,
      moved: { dir: dirTxt, by_m: +Math.max(movedAt2, movedSill).toFixed(2) },
      at: +atF.toFixed(2), sill: +sillC.toFixed(2),
      corner_left_m: +left.toFixed(2), corner_right_m: +right.toFixed(2),
      headroom_m: +Math.max(0, upLeft).toFixed(2),
      slid_to_fit: !!note
    };
    if (room) window.BIM.agent.commit({ act: 'winmove', text: step.text }, { room: room });
    return true;
  }

  /* 改窗的尺寸（宽 / 高 / 窗台高）。以前只能"开一扇新窗"，点了某一扇再想改大小是死路 ——
     用户原话："点击窗…通过对话的方式对窗进行尺寸以及位置的设置"。位置走 move_window，
     尺寸走这里；两个都是"改这一扇"，不是"再开一扇"。 */
  async function stepWindowSize(step) {
    const d = resolveWindow(step);
    if (!d) {
      if (ST.openingAmb && ST.openingAmb.kind === 'window') {
        const L = ST.openingAmb.list;
        ai('同名的窗有 ' + L.length + ' 扇，要改哪一扇？选一个，我接着按原话改：');
        askWhichOpening('window', L, dd => stepWindowSize(Object.assign({}, step, { window: dd.id })));
        return false;
      }
      ai('没有选中的窗。先用鼠标点一下那扇窗，或者说是哪一间的窗。'); return false;
    }
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) { ai('找不到这扇窗挂在哪面墙上了。'); return false; }
    const at0w = S.windowAt(d, wall);
    /* ★ 房间以"这扇窗实际在墙上的哪一段"为准，其次才用对话里给的房号/上下文。
       反过来的话，刚在某间房打完洞（上下文记着那间），再点另一间的窗改尺寸，
       会拿错房间去校核 —— 报"这个位置已经出了本房间的墙面范围"，
       明明原位扩 0.15 m 都过不了。 */
    const room = roomOfOpening(d, wall, at0w)
      || step.roomRef || (step.room ? window.BIM.agent.roomByNum(step.room, step.floor) : null) || null;

    const has = step.width != null || step.height != null || step.sill != null;
    if (!has) {
      ai('这扇窗现在是 ' + d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' 米，窗台高 ' +
        (d.sill || 0).toFixed(2) + ' 米。要改成多大？',
        null);
      chips([
        { label: '加宽到 2.0 m', fn: () => send('把这扇窗加宽到2米') },
        { label: '做矮到 1.2 m', fn: () => send('把这扇窗的高度改成1.2米') },
        { label: '窗台抬到 1.1 m', fn: () => send('把这扇窗的窗台抬到1.1米') }
      ]);
      return false;
    }
    const at = S.windowAt(d, wall);
    if (at == null) { ai('这扇窗在墙上的位置读不出来。'); return false; }
    const nw = step.width != null ? clamp(+step.width, 0.4, 6.0) : d.w;
    const nh = step.height != null ? clamp(+step.height, 0.4, 4.0) : d.h;
    const nsill = step.sill != null ? clamp(+step.sill, 0, 2.2) : (d.sill || 0);
    const before = { w: d.w, h: d.h, sill: d.sill || 0 };

    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    let chk = C.window({ wall: wall, at: at, w: nw, h: nh, sill: nsill, equipments: eqs, room: room, self: d });
    let atF = at, slid = '';
    /* 原位放不下时先别急着拒绝：用户要的是"变大"，不是"必须原地变大"。
       顺着同一面墙找最近的合法位置（限 2 米内），找到了就落在那儿并说清让了多少。 */
    if (!chk.pass && C.suggestWindowAt) {
      const sug = C.suggestWindowAt({ wall: wall, room: room, at: at, w: nw, h: nh, sill: nsill, equipments: eqs, self: d });
      if (sug && sug.at != null && sug.check && sug.check.pass && Math.abs(sug.at - at) < 2.0) {
        atF = sug.at; chk = sug.check;
        slid = '原位边角转不开，顺着墙让到了轴位 ' + atF.toFixed(2) + ' 米处';
      }
    }
    if (!chk.pass) {
      S.highlightWall(wall, 0xdd534f);
      const bs = (chk.blocks || []).slice(0, 3).map(b => b.t).join('；') || '这个尺寸开不了';
      ai(nw.toFixed(2) + '×' + nh.toFixed(2) + ' 米的窗开不了：' + bs + '。',
        '<div class="res bad"><div class="res-top"><span class="k">开不了</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + ((chk.blocks || []).map(b => '<s>·</s> ' + b.t).join('<br>') || '位置不够') + '</div></div>');
      chips([
        { label: '小一点试试', fn: () => send('把这扇窗加宽到' + Math.max(0.6, nw - 0.3).toFixed(1) + '米') },
        { label: '还是原尺寸', fn: () => { } }
      ]);
      return false;
    }

    const nd = S.replaceWindow(d, { at: atF, w: nw, h: nh, sill: nsill });
    if (!nd) { ai('洞口没改成功，先撤回再试。'); return false; }
    ST.lastWin = { wall: wall, at: atF, w: nw, h: nh, d: nd, chk: chk, room: room };
    S.markDoorSpot(wall, atF, nw, nh, true);
    if (room) focusSoft(room, { keepView: true, color: false });
    pushUndo('把这扇窗改回 ' + before.w.toFixed(2) + '×' + before.h.toFixed(2) + ' 米', () => {
      const bak = S.replaceWindow(nd, { at: at, w: before.w, h: before.h, sill: before.sill });
      if (bak) ST.lastWin = { wall: wall, at: at, w: before.w, h: before.h, d: bak, room: room };
    });
    /* 改完还是选中的那一扇：接着还能说"再挪左一点"，不用重新点 */
    if (ST.selOpening && ST.selOpening.kind === 'window') {
      ST.selOpening = Object.assign({}, ST.selOpening, { id: nd.id, name: nd.name, w: nw, h: nh, sill: nsill });
      window.BIM.agent.mem.ctx.selOpening = ST.selOpening;
    }
    S.highlightWindow(nd);

    const sp = doorSpot(wall, atF);
    if (!S.inView(wall.floor, sp.x - 1.8, sp.y - 1.8, sp.x + 1.8, sp.y + 1.8)) S.focusDoor(wall, atF, room);
    const span = roomSpanOnWall(wall, room);
    if (slid) S.highlightWall(wall, 0xdd9a2c);
    ai('把 ' + (room ? room.num + ' 室那扇窗' : (nd.name || '这扇窗')) + '改成了 ' +
      nw.toFixed(2) + '×' + nh.toFixed(2) + ' 米、窗台高 ' + nsill.toFixed(2) + ' 米。' +
      (slid ? slid + '。' : '') +
      (chk.warns && chk.warns.length ? chk.warns[0] + '。' : '洞口校核过了，没撞上柱、梁和别的门窗。'),
      winCard(nw, nh, nsill, chk));
    lastData = {
      window: nd.name, room: room ? room.num : null,
      size: { w: +nw.toFixed(2), h: +nh.toFixed(2), sill: +nsill.toFixed(2) },
      before: { w: +before.w.toFixed(2), h: +before.h.toFixed(2), sill: +before.sill.toFixed(2) },
      at: +atF.toFixed(2), corner_left_m: +(atF - nw / 2 - span.lo).toFixed(2),
      corner_right_m: +(span.hi - atF - nw / 2).toFixed(2), slid_to_fit: !!slid
    };
    if (room) window.BIM.agent.commit({ act: 'winsize', text: step.text }, { room: room });
    return true;
  }

  /* 由对话/工具主动"选中"一扇门或窗：跟鼠标点中是同一条路 ——
     scene 里高亮、上下文里记下，后面改尺寸改位置都认这一扇。 */
  async function stepOpening(step) {
    const kind = step.kind === 'window' ? 'window' : 'door';
    const cn = kind === 'door' ? '门' : '窗';
    const list = kind === 'door' ? (M.doors || []) : (M.windows || []);
    let d = null;
    if (step.name) d = list.find(x => x.id === step.name || x.name === step.name) || null;
    if (!d && step.room) {
      const room = window.BIM.agent.roomByNum(step.room, step.floor);
      if (room) {
        const c = list.filter(x => (x.rooms || []).indexOf(room.id) >= 0);
        const k = step.side ? (viewSide(step.side) || step.side) : null;
        const wantWall = k ? (room.sides || {})[k] : null;
        const bySide = wantWall ? c.filter(x => x.wall === wantWall) : [];
        d = (bySide.length ? bySide : c).slice(-1)[0] || null;
      }
    }
    if (!d) {
      const s = (ST.selOpening && ST.selOpening.kind === kind)
        ? list.find(x => x.id === ST.selOpening.id) : null;
      d = s || (kind === 'door' ? (ST.lastDoor && ST.lastDoor.d) : (ST.lastWin && ST.lastWin.d)) || null;
    }
    if (!d) { ai('没找到要选中的' + cn + '。说个房间号，或者用鼠标直接点一下。'); return false; }
    if (!selectOpening({ kind: kind, data: d })) { ai('这' + cn + '没法在场景里选中。'); return false; }
    lastData = {
      kind: kind, id: d.id, name: d.name, w: +d.w.toFixed(2), h: +d.h.toFixed(2),
      sill: +((d.sill || 0)).toFixed(2), wall: d.wall, floor: d.floor,
      room: ((M.rooms.find(r => (d.rooms || []).indexOf(r.id) >= 0)) || {}).num || null
    };
    return true;
  }

  function startWindow(p) {
    const room = p.room;
    if (!room) { ai('要在哪一间开窗？说个房间号，比如「3 楼 306」。'); return; }
    const side = pickWindowSide(room, p);
    const wall = M.walls.find(w => w.id === (room.sides || {})[side]);
    if (!wall) { ai('这间房找不到对应的墙。'); return; }
    ST.mode = 'window';
    ST.pending = { room: room, side: side, wall: wall, width: p.width || 1.5, winH: p.winH || 1.5, sill: p.sill == null ? .9 : p.sill, pref: p.pref || null };
    S.mode = 'window';
    focusSoft(room);
    S.isolateFloor && S.isolateFloor(room.floor);
    S.highlightWall(wall, 0x10a394);
    setMode('开窗 · ' + room.num + ' ' + N.SIDE_CN[side] + '墙 · ' + (p.width || 1.5).toFixed(1) + '×' + (p.winH || 1.5).toFixed(1), cancelMode);
    ai(room.num + ' ' + N.SIDE_CN[side] + '边这面墙亮出来了，点一下要开窗的位置。');
  }

  function pickWindow(hit, hits, ev) {
    const p = ST.pending, room = p.room;
    const plan = ev && S.pickWallOfRoom ? S.pickWallOfRoom(room, ev) : null;
    let wall = null, at = 0;
    if (plan) { wall = plan.wall; at = plan.at; }
    else {
      const list = (hits && hits.length ? hits : (hit ? [hit] : [])).filter(h => h.kind === 'wall');
      const pick = list.find(h => h.data.rooms && h.data.rooms.indexOf(room.id) >= 0) || list[0];
      if (!pick) { toast('点一下要开窗的那面墙'); return; }
      wall = pick.data;
      if (!(wall.rooms && wall.rooms.indexOf(room.id) >= 0)) { toast('这面墙不属于 ' + room.num + ' 室'); return; }
      const [ax, ay] = wall.p1, [bx, by] = wall.p2;
      const L = Math.hypot(bx - ax, by - ay);
      at = (pick.x - ax) * (bx - ax) / L + (pick.y - ay) * (by - ay) / L;
    }
    const L = S.wallLen(wall);
    at = clamp(at, 0, L);
    const span = roomSpanOnWall(wall, room);
    if (span.hi - span.lo > p.width + 0.6) {
      at = clamp(at, span.lo + p.width / 2 + 0.2, span.hi - p.width / 2 - 0.2);
    }
    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    let chk = C.window({ wall: wall, at: at, w: p.width, h: p.winH, sill: p.sill, equipments: eqs, room: room });
    S.markDoorSpot(wall, at, p.width, p.winH, chk.pass);
    S.focusDoor(wall, at, room);

    /* 和开门一样：手点的位置撞了线管，先牵线、再挪位，别直接一句"开不了"。
       同样地，只撞线管时 chk.pass 仍为 false，能不能开要看 holeDecision 的 ok。 */
    let dec = null, ready = chk.pass;
    if (!ready) {
      dec = holeDecision(wall, {
        at: at, w: p.width, h: p.winH, sill: p.sill,
        room: room, equipments: eqs, kind: 'window', noMove: true
      });
      if (dec.ok) {
        at = dec.at;
        chk = dec.chk || chk;
        ready = true;
        S.markDoorSpot(wall, at, p.width, p.winH, true);
        S.focusDoor(wall, at, room);
      }
    }

    if (ready) {
      if (dec && dec.needReroute) applyReroutes(dec);
      const d = S.addWindowOpening(wall, at, p.width, p.winH, p.sill);
      d.room = room.id;
      ST.lastWin = { wall: wall, at: at, w: p.width, d: d, chk: chk, room: room };
      rememberWindow(room, sideOfWall(room, wall) || p.side, p.width, p.winH, p.sill);
      ST.mode = 'idle'; S.mode = 'idle';
      finishMode();
      S.clearHighlight();
      S.markDoorSpot(wall, at, p.width, p.winH, true);
      pushUndo('把刚开的 ' + d.name + ' 封掉', () => { S.removeWindow(d); S.markDoorSpotClear && S.markDoorSpotClear(); });
      if (dec && (dec.needReroute || dec.moved)) {
        showHoleConflict(wall, dec.hits, dec.reroutes);
        ai('这个位置墙里有 ' + (dec.hits || []).length + ' 根线管，' +
          (dec.moved ? dec.moveNote + '；' : '') +
          (dec.rerouteNote ? dec.rerouteNote + '。' : '') +
          p.width.toFixed(2) + '×' + p.winH.toFixed(2) + ' 米的窗已经开在距墙端 ' + C.fmt(at, 2) + ' 米处。',
          conduitCard(dec.hits, dec.reroutes || [], dec));
        return;
      }
      ai('这面墙可以开，' + p.width.toFixed(2) + '×' + p.winH.toFixed(2) + ' 米的窗已经放上去了。', winCard(p.width, p.winH, p.sill, chk));
    } else {
      ST.mode = 'idle'; S.mode = 'idle';
      finishMode();
      S.highlightWall(wall, 0xdd534f);
      ai('这个位置不行，窗会撞上东西。',
        '<div class="res bad"><div class="res-top"><span class="k">开不了</span><span class="tag">有冲突</span></div>' +
        '<div class="res-adv">' + chk.blocks.map(b => '<s>·</s> ' + b.t).join('<br>') + '</div></div>');
      const cs = [];
      const sug = C.suggestWindowAt({ wall: wall, room: room, at: at, w: p.width, h: p.winH, sill: p.sill, equipments: eqs });
      if (sug && sug.d >= 0.2 && sug.d < 3.2) {
        cs.push({
          label: '挪 ' + sug.d.toFixed(1) + ' 米就能开', fn: () => {
            const d = S.addWindowOpening(wall, sug.at, p.width, p.winH, p.sill);
            d.room = room.id;
            S.markDoorSpot(wall, sug.at, p.width, p.winH, true);
            S.focusDoor(wall, sug.at, room);
            ST.lastWin = { wall: wall, at: sug.at, w: p.width, d: d, chk: sug.check, room: room };
            rememberWindow(room, sideOfWall(room, wall) || p.side, p.width, p.winH, p.sill);
            ai('往旁边挪了 ' + sug.d.toFixed(1) + ' 米，这里能开，窗已经放上去了。', winCard(p.width, p.winH, p.sill, sug.check));
          }
        });
      }
      cs.push({ label: '换个位置自己点', fn: () => { ST.mode = 'window'; S.mode = 'window'; ST.pending = p; setMode('开窗 · ' + room.num, cancelMode); S.highlightWall(wall, 0x10a394); } });
      chips(cs);
    }
  }

  async function stepValve(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    const v = step.valve ? M.valves.find(x => x.id === step.valve || x.name === step.valve) : null;
    if (!room && !v) { ai('要关哪个阀？说个房间就行，比如「4 楼 405」。'); return false; }
    startValve({ room: room, valve: step.valve, valveAction: step.action === 'open' ? 'open' : 'close' });
    A.commit(step, { room: room, valve: ST.lastValve });
    return true;
  }

  /* 入口朝向：从门/走廊那侧指进房间的单位向量，往里挪用它 */
  function entranceDir(room) {
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    const ds = (M.doors || []).filter(d => d.floor === room.floor && (d.rooms || []).indexOf(room.id) >= 0);
    let ref = ds.length ? { x: ds[0].pos[0], y: ds[0].pos[1] } : null;
    if (!ref) {
      const k = ['south', 'north', 'west', 'east'].find(kk => {
        const w = M.walls.find(x => x.id === (room.sides || {})[kk]);
        return w && w.kind === 'corr';
      });
      if (k) {
        const p = sideInset(room, { w: 0.1, d: 0.1 }, k, 0);
        if (p) ref = p;
      }
    }
    if (!ref) return { x: 0, y: 1 };
    const dx = cx - ref.x, dy = cy - ref.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  }

  /* 方向 → BIM 平面向量。
     左右前后上下 一律按"用户此刻看到的画面"，不是写死的东南西北；
     最后再用屏幕投影自检一次（S.screenSign），哪个符号反了就掰回来。 */
  function dirVec(dir, room) {
    const ax = (S.viewAxes && S.viewAxes()) || { right: { x: 1, y: 0 }, fwd: { x: 0, y: 1 } };
    let v = null;
    if (dir === 'left') v = { x: -ax.right.x, y: -ax.right.y, txt: '左' };
    else if (dir === 'right') v = { x: ax.right.x, y: ax.right.y, txt: '右' };
    else if (dir === 'front' || dir === 'up') v = { x: ax.fwd.x, y: ax.fwd.y, txt: dir === 'up' ? '上' : '前' };
    else if (dir === 'back' || dir === 'down') v = { x: -ax.fwd.x, y: -ax.fwd.y, txt: dir === 'down' ? '下' : '后' };
    else if (dir === 'east') v = { x: 1, y: 0, txt: '东' };
    else if (dir === 'west') v = { x: -1, y: 0, txt: '西' };
    else if (dir === 'north') v = { x: 0, y: 1, txt: '北' };
    else if (dir === 'south') v = { x: 0, y: -1, txt: '南' };
    else if (dir === 'in' || dir === 'out') {
      const e = entranceDir(room);
      v = (dir === 'in') ? { x: e.x, y: e.y, txt: '里' } : { x: -e.x, y: -e.y, txt: '外' };
    }
    if (!v) return null;
    if (room && S.screenSign) {
      const k = S.screenSign(dir, room, v);
      if (k < 0) { v.x = -v.x; v.y = -v.y; }
    }
    return v;
  }

  /* ---------------- 撤回 ---------------- */
  function pushUndo(label, fn) {
    ST.history = ST.history || [];
    ST.history.push({ label: label, fn: fn, at: Date.now() });
    if (ST.history.length > 20) ST.history.shift();
  }

  async function stepUndo() {
    const h = ST.history || [];
    const last = h.pop();
    if (!last) { ai('没有可撤回的操作了。'); return false; }
    try {
      last.fn();
      // 撤回以后上下文可能还指着一台已经不存在的设备（比如把型号换回去了），
      // 不刷新的话底部还挂着旧名字，下一句"往左挪"就找不着东西
      const A = window.BIM.agent, names = (ST.placed || []).map(e => e.name);
      if (A.mem.ctx && A.mem.ctx.device && names.indexOf(A.mem.ctx.device) < 0) {
        const back = (ST.placed || []).slice(-1)[0];
        A.mem.ctx.device = back ? back.name : null;
        A.mem.ctx.pref = null;
      }
      if (ST.sel && names.indexOf(ST.sel.name) < 0) ST.sel = (ST.placed || []).slice(-1)[0] || null;
      if (typeof paintCtx === 'function') paintCtx();
      ai('撤回了上一步：' + last.label + '。');
      return true;
    } catch (e) {
      ai('这一步撤不回来了：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /* 取"当前这台设备"：显式点名 → 上下文 → 选中的 → 最后放的 */
  function resolveEq(step) {
    const A = window.BIM.agent;
    const want = step && step.target;
    if (want) {
      const list = ST.placed || [];
      const cur = A.mem.lastPlaced || ST.sel;
      /* 现场可能已经摆着好几台同名设备（演示里很常见）。
         用户说"把这台挪一下"，指的一定是眼下这间、刚放上去的这台，
         不能因为地上别处还有一台更早放的就被抢走。 */
      const hitCur = cur && (cur.name === want || (cur.name || '').indexOf(want) >= 0 || want.indexOf(cur.name) >= 0);
      if (hitCur) return cur;
      let hit = list.find(e => e.name === want) || list.find(e => (e.name || '').indexOf(want) >= 0)
        || list.find(e => want.indexOf(e.name) >= 0);
      if (!hit) {
        const d = A.deviceByName(want);
        if (d) hit = list.filter(e => e.name === d.name).slice(-1)[0];
      }
      if (hit) return hit;
    }
    return A.mem.lastPlaced || ST.sel || (ST.placed || [])[(ST.placed || []).length - 1] || null;
  }

  /* 取"这扇门"：编号 → 最近的 → 这间房最近开的那扇 */
  /* 按"用户说的那串字符"认门窗：id 最硬，其次唯一代号，最后才按名字。
     名字重名时**不猜** —— 返回 { amb } 让上层去做成一排按钮，
     否则就会"点的是上面那扇，改的是下面那扇"（用户截图里的那个 bug）。 */
  function openingBy(list, x) {
    if (x == null || x === '') return null;
    const all = list || [];
    const byId = all.find(d => d.id === x);
    if (byId) return { d: byId };
    const byCode = all.filter(d => d.code === x);
    if (byCode.length === 1) return { d: byCode[0] };
    const byName = all.filter(d => d.name === x);
    if (byName.length === 1) return { d: byName[0] };
    if (byName.length > 1) return { amb: byName };
    return null;
  }

  /* 重名的时候把候选摆成一排：选哪个就选中哪个，然后按原话再跑一遍 */
  function askWhichOpening(kind, list, again) {
    const cn = kind === 'door' ? '门' : '窗';
    chips(list.slice(0, 4).map(d => ({
      label: S.openingCode(d) + (d.floor ? ' · ' + d.floor + 'F' : ''),
      fn: () => {
        selectOpening({ kind: kind, data: d }, true);
        S.highlightDoor && kind === 'door' && S.highlightDoor(d);
        S.highlightWindow && kind === 'window' && S.highlightWindow(d);
        if (again) again(d);
      }
    })));
    return cn;
  }

  function resolveDoor(step) {
    /* 点中过哪扇就改哪扇：用户原话"点击门…然后通过对话的方式对门进行尺寸以及位置的设置"。
       顺序很要紧 —— 先认 id，再认"刚点的那一扇"，最后才轮到名字。
       以前名字排在点选前面，而同规格的门全叫一个名（5 楼 45 扇 M1021），
       于是经常改到别的那一扇上去。 */
    const all = (M.doors || []);
    const sel = (ST.selOpening && ST.selOpening.kind === 'door')
      ? (all.find(d => d.id === ST.selOpening.id) || null) : null;
    const want = step && step.door;
    if (want) {
      const h = openingBy(all, want);
      if (h && h.d) return h.d;
      if (h && h.amb) {
        if (sel && h.amb.some(d => d.id === sel.id)) return sel;   // 选中的正是重名里的一个
        ST.openingAmb = { kind: 'door', list: h.amb };
        return null;
      }
    }
    if (sel) return sel;
    const doors = all.filter(d => d.added);
    if (ST.lastDoor && ST.lastDoor.d && all.indexOf(ST.lastDoor.d) >= 0) return ST.lastDoor.d;
    if (step && (step.room || step.roomRef)) {
      const room = step.roomRef || (step.room ? window.BIM.agent.roomByNum(step.room, step.floor) : null);
      if (room) {
        const mine = doors.filter(d => (d.rooms || []).indexOf(room.id) >= 0);
        if (mine.length) return mine[mine.length - 1];
      }
    }
    return doors.length ? doors[doors.length - 1] : null;
  }

  /* 聚焦但不打断用户视角：已经在画面里、而且占屏够大就只调显隐/高亮；
     不在画面里、或者远得只剩一小块，才动相机（保持原观察方向）。
     ⚠ 默认**不铺色块**：以前这里的 highlightRoom 会在房间里糊一块薄荷绿的板，
     打通之后正好盖住两块楼板和墙洞，用户原话"去掉房间打通后的绿色区块"。
     要"这块就是它"的强提示（撞上东西）由调用方显式传 fill。 */
  function focusSoft(room, opts) {
    if (!room) return;
    const o = opts || {};
    S.setFocus(room.floor, false);
    if (o.only) S.isolateRoom(room, true);
    /* keepView：只切显隐，相机一点都不碰。
       门窗选中/改尺寸/挪位置都走这条 —— 用户原话："不要旋转，保持用户视角不变"。
       frameBounds 就算 keepAngle 也会把俯角拉到 0.86 rad，用户看来就是"镜头转了一下"。 */
    if (o.keepView) {
      if (o.color === false) return;
      if (o.color || o.fill > 0) S.highlightRoom(room, o.color || 0x10a394, { fill: o.fill || 0, beam: o.beam });
      return;
    }
    // tight：不管房间在不在画面里都重新取景。问净距必须这么干——
    // 全楼视角下房间"确实在画面里"，可虚框上 0.5 m 的数字只剩三五个像素
    if (o.tight || !S.inView || !S.inView(room.floor, room.x0, room.y0, room.x1, room.y1, 0.06, 0.12)) {
      S.frameBounds(room.floor, room.x0 - 0.6, room.y0 - 0.6, room.x1 + 0.6, room.y1 + 0.6, true, 0.86);
    }
    if (o.color === false) return;
    if (o.color || o.fill > 0) S.highlightRoom(room, o.color || 0x10a394, { fill: o.fill || 0, beam: o.beam });
  }


  /* 找一间放得下的房：纯查询，只给候选不动手 */
  async function stepFindRoom(step) {
    const A = window.BIM.agent;
    const dev = (step.device ? A.deviceByName(step.device) : null) || A.mem.lastPlaced || ST.sel;
    if (!dev) { ai('要放哪台设备？说个名字，我找哪间放得下。'); return false; }
    const floor = step.floor != null ? step.floor : (A.mem.ctx.floor || (M.floors[0] && M.floors[0].level) || 1);
    const list = roomsFitting(dev, floor);
    if (!list.length) {
      ai(floor + ' 楼没有能放下「' + dev.name + '」的房间了，换个楼层或者把这台换小一点。');
      lastData = { floor: floor, device: dev.name, rooms: [] };
      return false;
    }
    const n = Math.max(1, Math.min(6, step.want || 3));
    const top = list.slice(0, n);
    ai(floor + ' 楼放得下「' + dev.name + '」的有 ' + list.length + ' 间，' +
      top.map(x => x.room.num + '（安全系数 ' + C.fmt(x.chk.K) + '）').join('、') +
      '。想放到哪一间？', null, true);
    chips(top.map(x => ({
      label: '放到 ' + x.room.num, fn: () => send('把' + dev.name + '放到' + x.room.num + '室')
    })));
    lastData = {
      floor: floor, device: dev.name,
      rooms: list.map(x => ({ num: x.room.num, k: +C.fmt(x.chk.K), verdict: x.chk.verdict }))
    };
    return true;
  }

  /* 这一层哪些房间真放得下这台设备：搬家被拒时给替代方案用，不是拿面积糊弄 */
  function roomsFitting(dev, floor) {
    const out = [];
    M.rooms.filter(r => r.floor === floor && r.zone !== 'corr' && r.zone !== 'core').forEach(r => {
      const s = bestSpotFor(r, Object.assign({}, dev, { rot: null }), 'corridor', null);
      if (!s) return;
      const c = C.check({ room: r, equip: dev, cx: s.x, cy: s.y, others: othersIn(r).filter(e => e !== dev) });
      if (c.verdict !== 'bad') out.push({ room: r, spot: s, chk: c });
    });
    // 余量大的排前面：用户要的是"哪间更放得下"，不是"哪间更近"
    out.sort((a, b) => b.chk.K - a.chk.K);
    return out;
  }

  /* 换到另一间房（搬家）。以前是先把 eq.room 改掉、再反问"你想怎么挪"，
     结果设备落在新房间的旧坐标上，直接掉到楼板外面。现在反过来：
     先在新房间把位置算出来、把承重和门洞都验一遍，全过了才真搬。 */
  async function moveToRoom(eq, from, to, step) {
    const A = window.BIM.agent;
    const bare = Object.assign({}, eq, { rot: null });
    const pref0 = step.pref || 'corridor';        // 搬家默认靠走廊：进出搬运路线最短
    let prefTxt = N.PREF_CN[pref0] || '靠走廊';
    let spot = bestSpotFor(to, bare, pref0, null);
    if (!spot && pref0 !== 'inner') { spot = bestSpotFor(to, bare, 'inner', null); prefTxt = N.PREF_CN.inner || '靠里'; }

    if (!spot) {
      ai(to.num + ' 室里腾不出能放「' + eq.name + '」的地方，设备先留在 ' + from.num + ' 没动。');
      const fit = roomsFitting(eq, to.floor).filter(x => x.room.id !== to.id);
      if (fit.length) {
        chips(fit.slice(0, 3).map(x => ({
          label: '改放 ' + x.room.num, fn: () => send('把' + eq.name + '放到' + x.room.num + '室')
        })));
      }
      return false;
    }

    const rot = spot.rot != null ? spot.rot
      : C.rotOf({ x: spot.x, y: spot.y, room: to.id, rot: null, w: eq.w, d: eq.d });
    const probe = Object.assign({}, eq, { rot: rot });
    const r = C.check({ room: to, equip: probe, cx: spot.x, cy: spot.y, others: othersIn(to).filter(e => e !== eq) });
    if (r.verdict === 'bad') {
      ai('先别搬：' + to.num + ' 室的楼板吃不消「' + eq.name + '」，安全系数只有 ' + C.fmt(r.K) +
        '（' + r.v.word + '）。这间最多还能加 ' + Math.max(0, Math.round(r.Pmax_kg / 100) / 10) + ' 吨。设备留在 ' + from.num + '。');
      const fit = roomsFitting(eq, to.floor).filter(x => x.room.id !== to.id && x.chk.verdict !== 'bad');
      if (fit.length) chips(fit.slice(0, 3).map(x => ({ label: '改放 ' + x.room.num, fn: () => send('把' + eq.name + '放到' + x.room.num + '室') })));
      return false;
    }

    /* 位置、承重都过了，才真搬 */
    const before = { x: eq.x, y: eq.y, room: eq.room, floor: eq.floor, elev: eq.floorElev, rot: eq.rot };
    S.removeEquipment(eq);
    eq.room = to.id; eq.floor = to.floor; eq.floorElev = to.elev;
    eq.x = spot.x; eq.y = spot.y;
    S.addEquipment(eq);
    applyRot(eq, rot);
    if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);

    ST.last = r; ST.sel = eq;
    A.mem.lastResult = r; A.mem.lastPlaced = eq;
    A.mem.ctx.room = to; A.mem.ctx.floor = to.floor; A.mem.ctx.device = eq.name;
    pushUndo('把' + eq.name + '搬回 ' + from.num, () => {
      S.removeEquipment(eq);
      eq.room = before.room; eq.floor = before.floor; eq.floorElev = before.elev;
      eq.x = before.x; eq.y = before.y;
      S.addEquipment(eq);
      applyRot(eq, before.rot);
      if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
      A.mem.ctx.room = from; A.mem.ctx.floor = from.floor;
    });
    focusSoft(to, { color: r.verdict === 'bad' ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394) });

    const obf = C.obstruct({ room: to, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(to).filter(e => e !== eq) });
    markClash(obf);
    const fi = faceInfo(to, eq);
    /* 搬到新房间，门洞得按这间房重新量一遍：进不来就等于白搬 */
    const pd = C.passDoor({ room: to, equip: eq });
    eq._door = pd;
    // 门的事先算出来（quiet：不单独说话），跟"搬到哪、多少系数"拼成一句话一起说
    const doorNote = pd.ok ? '' : askDoorWiden(to, eq, pd, true);

    ai('搬到 ' + to.num + ' 室了，放在' + prefTxt + '那边' + (fi ? '，' + faceTxt(fi) : '') +
      '。按这间的新位置重算，安全系数 ' + C.fmt(r.K) + '（' + r.v.word + '）。' +
      (obf.pass ? '' : '不过撞上了 ' + obf.blocks.length + ' 处东西：' + obf.blocks.map(x => x.t).join('；') + '。') +
      (doorNote ? '另外，' + doorNote : ''),
      card(r));

    chips([
      { label: '看计算书', fn: () => openCalc() },
      { label: '换回 ' + from.num, fn: () => send('把' + eq.name + '搬回' + from.num + '室') }
    ]);
    lastData = {
      moved_to: to.num, from: from.num, at: [+eq.x.toFixed(2), +eq.y.toFixed(2)],
      pref: prefTxt, k: +C.fmt(r.K), verdict: r.verdict, door_ok: pd.ok
    };
    return true;
  }

  async function stepMove(step) {
    const A = window.BIM.agent;
    const eq = resolveEq(step);
    if (!eq) { ai('现在还没有设备可挪。先放一台，或者点一下要挪的那台。'); return false; }
    dropClr();
    let room = M.rooms.find(r => r.id === eq.room);
    if (!room) return false;
    // 说了房间就是搬家，没说就在原地挪
    const target = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    if (target && target.id !== eq.room) return moveToRoom(eq, room, target, step);
    const before = { x: eq.x, y: eq.y, room: eq.room, floor: eq.floor, elev: eq.floorElev };

    let nx = eq.x, ny = eq.y, prefTxt = '', realDist = 0, blocked = '', spotRot = null;

    // 只说了"挪一下"，没说往哪、也没说靠哪 → 问一句，别自己猜个方向乱挪
    if (!step.dir && !step.pref) {
      const opts = spotOptions(room, eq, 3);
      ai('你想怎么挪？可以按方向说（往左一点），也可以直接挑一个我看着更合适的位置：');
      chips(opts.map(o => ({
        label: o.label,
        fn: () => send('把' + eq.name + '挪到' + (N.PREF_CN[o.pref] || o.pref))
      })).concat([
        { label: '往左', fn: () => send('往左挪一点') },
        { label: '往里', fn: () => send('往里挪一点') }
      ]));
      return false;
    }

    if (step.dir) {
      // 方向挪动：按用户视角的左右前后，先找"既走得过去又不撞"的最远点；
      // 一路都撞也别拦着——按用户说的距离挪到位，然后把碰撞讲清楚
      const v = dirVec(step.dir, room);
      if (!v) { ai('没听懂要往哪挪，说「往左一点」「往里挪半米」都行。'); return false; }
      const want = step.dist || 0.4;
      const fe = C.foot(eq);
      const lim = { x0: room.x0 + fe.w / 2 + 0.12, x1: room.x1 - fe.w / 2 - 0.12, y0: room.y0 + fe.d / 2 + 0.12, y1: room.y1 - fe.d / 2 - 0.12 };
      const others = othersIn(room).filter(e => e !== eq);
      let fallback = null;
      [1, 0.8, 0.6, 0.4, 0.25].forEach(k => {
        if (realDist) return;
        const t = want * k;
        const cx = clamp(eq.x + v.x * t, lim.x0, lim.x1);
        const cy = clamp(eq.y + v.y * t, lim.y0, lim.y1);
        const d = Math.hypot(cx - eq.x, cy - eq.y);
        if (d < 0.05) { blocked = blocked || 'wall'; return; }
        const ob = C.obstruct({ room: room, equip: eq, cx: cx, cy: cy, others: others });
        if (ob.pass) { nx = cx; ny = cy; realDist = d; }
        else {
          if (!fallback) fallback = { x: cx, y: cy, d: d };
          blocked = blocked || ((ob.blocks || []).some(b => b.k === 'eq') ? 'hit' : 'wall');
        }
      });
      if (!realDist && fallback) { nx = fallback.x; ny = fallback.y; realDist = fallback.d; }
      prefTxt = '往' + v.txt;
      if (!realDist) {
        ai('往' + v.txt + '已经贴着墙了，再挪就出去了。要不换个方向，或者我帮你挑个空位？');
        chips([
          { label: '挪到靠里', fn: () => send('把设备挪到靠里') },
          { label: '挪到墙角', fn: () => send('把设备挪到墙角') }
        ]);
        return false;
      }
    } else {
      // 挪到新方位 = 换了靠的墙，旧朝向必须放开重判
      const spot = bestSpotFor(room, Object.assign({}, eq, { rot: null }), step.pref || 'center', null);
      if (!spot) { ai(room.num + ' 室里实在挤不出位置了。'); return false; }
      nx = spot.x; ny = spot.y;
      if (spot.rot != null) spotRot = spot.rot;   // 换了那面墙就换朝向
      prefTxt = step.pref ? ('到' + (N.PREF_CN[step.pref] || '')) : '';
    }

    eq.x = nx; eq.y = ny;
    /* 先按落位后的实际朝向夹进房间，再定朝向。
       原来这段写成 if (spotRot != null) { … if (spotRot != null) applyRot else setEquipRot }，
       内层 else 永远走不到 —— 换方位时朝向不会被重判，设备会背对着新墙。 */
    const fe2 = C.foot(eq, spotRot);
    eq.x = clamp(eq.x, room.x0 + fe2.w / 2 + 0.10, room.x1 - fe2.w / 2 - 0.10);
    eq.y = clamp(eq.y, room.y0 + fe2.d / 2 + 0.10, room.y1 - fe2.d / 2 - 0.10);
    if (spotRot != null) applyRot(eq, spotRot);
    if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
    const r = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    A.mem.lastResult = r;
    A.mem.ctx.room = room; A.mem.ctx.floor = room.floor;
    A.mem.lastPlaced = eq;
    pushUndo('把' + eq.name + '挪回原位', () => {
      if (eq.room !== before.room) {
        S.removeEquipment(eq);
        eq.room = before.room; eq.floor = before.floor; eq.floorElev = before.elev;
        S.addEquipment(eq);
      }
      eq.x = before.x; eq.y = before.y;
      if (eq._obj) eq._obj.position.set(eq.x, eq.floorElev, -eq.y);
    });
    focusSoft(room, { color: r.verdict === 'bad' ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394) });

    // 挪到位之后再看一眼周边：撞上了就照实说，并把撞到的构件框红
    const obf = C.obstruct({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    const clashTxt = obf.pass ? '' : ('不过撞上了 ' + obf.blocks.length + ' 处东西：' + obf.blocks.map(x => x.t).join('；') + '。');
    markClash(obf);

    const short = realDist && realDist < (step.dist || 0.4) - 0.02 ? ('（本来想挪 ' + (step.dist || 0.4).toFixed(1) + ' 米，' + (blocked === 'hit' ? '那边有设备' : '到头了') + '，只走了 ' + realDist.toFixed(2) + ' 米）') : '';
    const head = step.dir ? (prefTxt + '挪了 ' + realDist.toFixed(2) + ' 米，') : ('挪' + prefTxt + '了，');
    ai(head + '安全系数 ' + C.fmt(r.K) + '。' + short + clashTxt, card(r));
    if (realDist && realDist >= 0.2) {
      const alt = spotOptions(room, eq, 2).filter(o => o.pref !== step.pref);
      if (alt.length) chips(alt.map(o => ({ label: '改成' + o.label, fn: () => send('把' + eq.name + '挪到' + (N.PREF_CN[o.pref] || o.pref)) })));
    }
    return true;
  }

  async function stepRemove(step) {
    const A = window.BIM.agent;
    dropClr();
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    let list = [];
    if (step.all) {
      const rm = room || A.mem.ctx.room;
      if (!rm) { ai('要清空哪一间？说个房间号就行。'); return false; }
      list = (ST.placed || []).filter(e => e.room === rm.id);
      if (!list.length) { ai(rm.num + ' 室里现在没放设备。'); return false; }
    } else {
      const eq = resolveEq(step);
      if (!eq) { ai('现在没有可撤的设备。'); return false; }
      list = [eq];
    }
    const snap = list.map(e => ({ eq: e, x: e.x, y: e.y, room: e.room, floor: e.floor, elev: e.floorElev, obj: e._obj }));
    list.forEach(eq => {
      S.removeEquipment(eq);
      ST.placed = ST.placed.filter(e => e !== eq);
      A.mem.placed = A.mem.placed.filter(e => e !== eq);
      if (ST.sel === eq) ST.sel = null;
    });
    refreshTree();
    A.mem.lastPlaced = A.mem.placed[A.mem.placed.length - 1] || null;
    pushUndo('把撤掉的 ' + list.length + ' 台设备放回去', () => {
      snap.forEach(s => {
        ST.placed.push(s.eq);
        A.mem.placed.push(s.eq);
        S.addEquipment(s.eq);
      });
      A.mem.lastPlaced = snap[snap.length - 1].eq;
    });
    ai(list.length > 1
      ? '把 ' + (room ? room.num : '') + ' 室里的 ' + list.length + ' 台设备都撤掉了。'
      : '「' + list[0].name + '」撤掉了。', null, false);
    lastData = { removed: list.map(e => e.name), count: list.length };
    return true;
  }

  /* ---------------- 设备：改 / 换 / 列清单 / 位置引导 ---------------- */
  function eqSnap(eq) {
    return {
      name: eq.name, weight: eq.weight, lib: eq.lib, w: eq.w, d: eq.d, h: eq.h,
      shape: eq.shape, color: eq.color, note: eq.note, x: eq.x, y: eq.y, rot: eq.rot
    };
  }

  /* 按快照恢复（尺寸变了必须重建网格，否则看上去还是旧的） */
  function eqRestore(eq, s) {
    Object.assign(eq, s);
    S.removeEquipment(eq);
    if (s.rot == null) eq.rot = null;
    S.addEquipment(eq);
    const room = M.rooms.find(r => r.id === eq.room);
    if (!room) return;
    const r = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    const A = window.BIM.agent;
    A.mem.lastResult = r; A.mem.lastPlaced = eq;
    S.highlightRoom(room, r.verdict === 'bad' ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394),
      { fill: r.verdict === 'bad' ? .22 : (r.verdict === 'warn' ? .12 : 0) });
  }

  /* 换型号：位置尽量不动；新尺寸原地放不下才在这间房里让一让 */
  async function stepReplace(step) {
    const A = window.BIM.agent;
    const eq = resolveEq(step);
    if (!eq) { ai('现在还没有可换的设备。先放一台，或者点一下要换的那台。'); return false; }
    const room = M.rooms.find(r => r.id === eq.room);
    if (!room) { ai('这台设备的房间信息丢了，撤掉重新放一台吧。'); return false; }

    let dev = step.device ? A.deviceByName(step.device) : null;
    if (!dev && step.weight) {
      dev = { id: 'CUSTOM', name: '另一台设备', weight: step.weight, w: eq.w, d: eq.d, h: eq.h, shape: eq.shape, color: eq.color };
    }
    if (!dev) {
      const pool = (M.equipmentLibrary || []).filter(e => e.name !== eq.name).slice(0, 3);
      ai('换成哪台？说个名字就行，比如「换成' + (pool[0] ? pool[0].name : '精密空调') + '」。');
      chips(pool.map(e => ({ label: e.name, fn: () => send('把' + eq.name + '换成' + e.name) })));
      return false;
    }
    if (dev.name === eq.name) {
      ai('现在放的就是「' + dev.name + '」。要换别的型号可以直说名字。');
      return false;
    }

    const before = eqSnap(eq);
    const others = othersIn(room).filter(e => e !== eq);
    const probe = { w: dev.w, d: dev.d, h: dev.h, weight: dev.weight, name: dev.name, rot: eq.rot };
    let nx = eq.x, ny = eq.y, nudged = false;
    const ob0 = C.obstruct({ room: room, equip: probe, cx: nx, cy: ny, others: others });
    if (!ob0.pass) {
      const spot = bestSpotFor(room, probe, 'center', { x: eq.x, y: eq.y });
      if (!spot) {
        ai('这间房腾不出放「' + dev.name + '」的地方。要不先挪开旁边的设备，或者换一间？');
        return false;
      }
      nx = spot.x; ny = spot.y;
      nudged = Math.hypot(nx - eq.x, ny - eq.y) > 0.05;
    }

    eq.name = dev.name; eq.weight = dev.weight;
    eq.lib = dev.lib || dev.id;
    eq.w = dev.w; eq.d = dev.d; eq.h = dev.h;
    if (dev.shape) eq.shape = dev.shape;
    if (dev.color) eq.color = dev.color;
    if (dev.note) eq.note = dev.note;
    eq.x = nx; eq.y = ny;
    eq.rot = null;                       // 外形换了，正面朝向按新外形重判
    S.removeEquipment(eq); S.addEquipment(eq);
    setEquipRot(eq, room);
    refreshTree();

    const r = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    A.mem.lastResult = r; A.mem.lastPlaced = eq;
    A.mem.ctx.room = room; A.mem.ctx.floor = room.floor; A.mem.ctx.device = eq.name;

    pushUndo('把「' + eq.name + '」换回' + before.name, () => eqRestore(eq, before));
    focusSoft(room, { color: r.verdict === 'bad' ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394) });

    const mv = nudged ? '，原位放不下新的外形，我往旁边让了 ' + Math.hypot(nx - before.x, ny - before.y).toFixed(2) + ' 米' : '，位置没动';
    ai('把「' + before.name + '」换成「' + eq.name + '」了' + mv + '，安全系数 ' + C.fmt(r.K) + '。', card(r));
    lastData = { from: before.name, to: eq.name, moved: nudged, K: C.fmt(r.K), verdict: r.verdict };
    const pdC = C.passDoor({ room: room, equip: eq });
    eq._door = pdC;
    if (!pdC.ok) askDoorWiden(room, eq, pdC);
    return true;
  }

  /* 改尺寸/单重：改完立刻复算，碰了就说撞到谁 */
  async function stepResize(step) {
    const A = window.BIM.agent;
    const eq = resolveEq(step);
    if (!eq) { ai('现在还没有可改的设备。先放一台，或者点一下要改的那台。'); return false; }
    const room = M.rooms.find(r => r.id === eq.room);
    if (!room) return false;

    const has = step.width != null || step.depth != null || step.height != null || step.weight != null;
    if (!has) {
      ai('「' + eq.name + '」现在是 ' + eq.w.toFixed(2) + '×' + eq.d.toFixed(2) + '×' + eq.h.toFixed(2) +
        ' 米、' + (eq.weight / 1000).toFixed(2) + ' 吨。要改哪个？');
      chips([
        { label: '小一点', fn: () => send('把' + eq.name + '改小一点') },
        { label: '大一点', fn: () => send('把' + eq.name + '加大一点') },
        { label: '按 2 吨算', fn: () => send('把' + eq.name + '按2吨算') }
      ]);
      return false;
    }

    const nw = step.width != null ? Math.max(0.2, +step.width) : eq.w;
    const nd = step.depth != null ? Math.max(0.2, +step.depth) : eq.d;
    const nh = step.height != null ? Math.max(0.2, +step.height) : eq.h;
    const nW = step.weight != null ? Math.max(1, +step.weight) : eq.weight;
    const before = eqSnap(eq);

    eq.w = nw; eq.d = nd; eq.h = nh; eq.weight = nW;
    eq.rot = null;                       // 宽深变了，贴哪面墙要重新判
    const others = othersIn(room).filter(e => e !== eq);
    // 变大可能把周围挤住：先原地试，不行就在房间里让一点
    let nx = eq.x, ny = eq.y, nudged = false;
    const ob = C.obstruct({ room: room, equip: eq, cx: nx, cy: ny, others: others });
    if (!ob.pass) {
      const spot = bestSpotFor(room, eq, 'center', { x: eq.x, y: eq.y });
      if (spot && Math.hypot(spot.x - eq.x, spot.y - eq.y) > 0.05) { nx = spot.x; ny = spot.y; nudged = true; }
    }
    eq.x = nx; eq.y = ny;
    S.removeEquipment(eq); S.addEquipment(eq);
    setEquipRot(eq, room);
    refreshTree();

    const r = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    ST.last = r; ST.sel = eq;
    A.mem.lastResult = r; A.mem.lastPlaced = eq;
    A.mem.ctx.room = room; A.mem.ctx.floor = room.floor; A.mem.ctx.device = eq.name;

    pushUndo('把「' + eq.name + '」的尺寸改回去', () => eqRestore(eq, before));
    focusSoft(room, { color: r.verdict === 'bad' ? 0xdd534f : (r.verdict === 'warn' ? 0xdd9a2c : 0x10a394) });

    const diff = [];
    if (nw !== before.w) diff.push('宽 ' + before.w.toFixed(2) + '→' + nw.toFixed(2) + ' m');
    if (nd !== before.d) diff.push('进深 ' + before.d.toFixed(2) + '→' + nd.toFixed(2) + ' m');
    if (nh !== before.h) diff.push('高 ' + before.h.toFixed(2) + '→' + nh.toFixed(2) + ' m');
    if (nW !== before.weight) diff.push('单重 ' + (before.weight / 1000).toFixed(2) + '→' + (nW / 1000).toFixed(2) + ' t');
    // 尺寸变了要按新尺寸重新看一遍周边，别拿改之前的结论说事
    const obNow = C.obstruct({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
    markClash(obNow);
    const collide = obNow.pass ? ''
      : '新尺寸在这个位置有 ' + obNow.blocks.length + ' 处碰撞（' + obNow.blocks.map(x => x.t).join('；') + '），已经标红了。';
    ai('「' + eq.name + '」改好了：' + diff.join('，') + '。' +
      (nudged ? '原位装不下新尺寸，我往外让了 ' + Math.hypot(nx - before.x, ny - before.y).toFixed(2) + ' 米。' : '') +
      collide + '安全系数 ' + C.fmt(r.K) + '。', card(r));
    lastData = { name: eq.name, w: nw, d: nd, h: nh, weight_t: +(nW / 1000).toFixed(2), K: C.fmt(r.K), moved: nudged };
    const pdR = C.passDoor({ room: room, equip: eq });     // 变大了可能就搬不进门了
    eq._door = pdR;
    if (!pdR.ok) askDoorWiden(room, eq, pdR);
    return true;
  }

  /* 列一下放了什么（一间房 / 一层 / 全楼） */
  async function stepDevices(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    let list = (ST.placed || []).slice();
    if (room) list = list.filter(e => e.room === room.id);
    else if (step.floor) list = list.filter(e => e.floor === +step.floor);
    if (!list.length) {
      ai((room ? room.num + ' 室' : (step.floor ? step.floor + ' 楼' : '现场')) + '现在还没放设备。');
      return false;
    }
    const tot = list.reduce((s, e) => s + (e.weight || 0), 0) / 1000;
    const where = room ? room.num + ' 室' : (step.floor ? step.floor + ' 楼' : '全楼');
    const rows = list.map(e => {
      const r = M.rooms.find(x => x.id === e.room);
      return '<div class="kv"><i>' + esc(e.name) + ' · ' + (r ? r.num : e.room) + '</i><b>' +
        (e.weight / 1000).toFixed(2) + ' t</b></div>';
    }).join('');
    ai(where + '一共 ' + list.length + ' 台，合计 ' + tot.toFixed(2) + ' 吨：',
      '<div class="res ok"><div class="res-adv">' + rows + '</div></div>', false);
    lastData = { where: where, count: list.length, total_t: +tot.toFixed(2), items: list.map(e => ({ name: e.name, room: e.room, weight_t: +(e.weight / 1000).toFixed(2) })) };
    return true;
  }

  /* 不知道放哪时：算几个候选，挑最合适的一个先放上去，其余作为可改选项
     —— 用户说"你看着放"就是让系统拿主意，不能反过来再问他"你要放哪" */
  async function stepSuggest(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    if (!room) { ai('要看哪一间？说个房间号就行，比如「2 楼 202」。'); return false; }
    let dev = step.device ? A.deviceByName(step.device) : null;
    if (!dev) dev = A.mem.lastPlaced || ST.sel || ST.device || (M.equipmentLibrary || [])[0];
    if (!dev) { ai('先告诉我要放什么设备，我再帮你挑位置。'); return false; }

    const n = Math.max(2, Math.min(4, step.want || 3));
    const opts = spotOptions(room, dev, n);
    if (!opts.length) {
      ai(room.num + ' 室实在腾不出放「' + dev.name + '」的地方了，得先挪走点东西。');
      return false;
    }

    const have = (ST.placed || []).filter(e => e.name === dev.name && e.room === room.id);
    if (step.apply !== false && !have.length) {
      // 先按最合适那个落地
      const best = opts[0];
      const eq = commitPlaceAt(room, dev, best.x, best.y, best.ob, false, true);
      if (eq) {
        const alt = opts.slice(1);
        focusSoft(room, { color: ST.last && ST.last.verdict === 'bad' ? 0xdd534f : (ST.last && ST.last.verdict === 'warn' ? 0xdd9a2c : 0x10a394) });
        pushUndo('把刚放的「' + dev.name + '」撤掉', () => {
          S.removeEquipment(eq);
          ST.placed = ST.placed.filter(e => e !== eq);
          A.mem.placed = A.mem.placed.filter(e => e !== eq);
          if (ST.sel === eq) ST.sel = null;
          A.mem.lastPlaced = A.mem.placed[A.mem.placed.length - 1] || null;
        });
        A.commit({ act: 'place', text: step.text }, { room: room, eq: eq, result: ST.last, device: dev.name });
        const obB = eq._ob;
        const clashTxt = (obB && obB.blocks && obB.blocks.length)
          ? '不过这个位置撞到了 ' + obB.blocks.length + ' 处：' + obB.blocks.map(x => x.t).join('；') + '。' : '';
        if (obB) markClash(obB);
        ai('我按「' + best.label + '」给它放好了——' + best.note + '。' + clashTxt +
          (alt.length ? '想换个感觉可以改到：' + alt.map(o => o.label).join('、') + '。' : ''), card(ST.last));
        const pdS = C.passDoor({ room: room, equip: eq });
        eq._door = pdS;
        if (!pdS.ok) askDoorWiden(room, eq, pdS);
        chips(alt.map(o => ({
          label: '改到' + o.label,
          fn: () => send('把' + dev.name + '挪到' + room.num + '室' + o.label)
        })).concat([
          { label: '往左挪一点', fn: () => send('往左挪一点') },
          { label: '看计算书', fn: () => openCalc() }
        ]));
        lastData = {
          room: room.num, device: dev.name, placed: true, chose: best.label,
          K: ST.last ? C.fmt(ST.last.K) : null,
          options: opts.map(o => ({ pref: o.label, good: o.note, bad: o.bad }))
        };
        return true;
      }
    }

    // 已经放过了、或用户只要建议：只讲选项，不重复放
    focusSoft(room);
    const lines = opts.map((o, i) => (i + 1) + '. ' + o.label + '——' + o.note);
    ai(room.num + ' 室放「' + dev.name + '」，这几个位置都行：' + lines.join('；') + '。你想放哪个？',
      '<div class="res ok"><div class="res-adv">' +
      opts.map(o => '<s>·</s> <b>' + esc(o.label) + '</b>　' + esc(o.note) + (o.bad ? '<span style="color:#8a95a3">（' + esc(o.bad) + '）</span>' : '')).join('<br>') +
      '</div></div>');
    chips(opts.map(o => ({
      label: o.label,
      fn: () => send((have.length ? '把' + dev.name + '挪到' : '把' + dev.name + '放到') + room.num + '室' + o.label)
    })));
    lastData = {
      room: room.num, device: dev.name, placed: false,
      options: opts.map(o => ({ pref: o.label, good: o.note, bad: o.bad }))
    };
    return true;
  }

  /* ---------------- 门：删 / 挪 / 改 / 查 ---------------- */
  function doorSpot(wall, at) {
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const L = S.wallLen(wall);
    return { x: ax + (bx - ax) / L * at, y: ay + (by - ay) / L * at };
  }
  function doorRoom(d) {
    const A = window.BIM.agent;
    // 首选"当初就是为这间房开的"（一条长墙可能串着好几间）
    if (d.room) {
      const r0 = M.rooms.find(x => x.id === d.room);
      if (r0) return r0;
    }
    const ids = d.rooms || [];
    // 一条长墙串好几间时，d.rooms 里排第一的不一定是这扇门所在的那间，
    // 所以先挑"门确实落在它那段墙上"的；都对不上再退回第一个
    const wall = M.walls.find(w => w.id === d.wall);
    if (wall) {
      const at = S.doorAt(d, wall) || 0;
      const half = (d.w || 1) / 2;
      let hit = null;
      ids.forEach(id => {
        const r = M.rooms.find(x => x.id === id && x.zone !== 'corr');
        if (!r) return;
        const sp = roomSpanOnWall(wall, r);
        if (at - half >= sp.lo - 0.05 && at + half <= sp.hi + 0.05 && !hit) hit = r;
      });
      if (hit) return hit;
    }
    for (let i = 0; i < ids.length; i++) {
      const r = M.rooms.find(x => x.id === ids[i] && x.zone !== 'corr');
      if (r) return r;
    }
    if (ST.lastDoor && ST.lastDoor.room) return ST.lastDoor.room;
    return A.mem.ctx.room || null;
  }

  /* 一条长墙可能串着好几间房：算出"本房间"在这面墙上占的那一段（起止参数） */
  function roomSpanOnWall(wall, room) {
    const L = S.wallLen(wall);
    if (!room) return { lo: 0, hi: L };
    const [ax, ay] = wall.p1, [bx, by] = wall.p2;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
      .map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
    return { lo: Math.min.apply(null, ts), hi: Math.max.apply(null, ts) };
  }

  async function stepDoorOff(step) {
    const d = resolveDoor(step);
    if (!d) {
      if (ST.openingAmb && ST.openingAmb.kind === 'door') {
        const L = ST.openingAmb.list;
        ai('重名的门有 ' + L.length + ' 扇，要撤哪一扇？选一个，我立刻撤：');
        askWhichOpening('door', L, dd => stepDoorOff(Object.assign({}, step, { door: dd.id })));
        return false;
      }
      ai('现在没有可以撤的门。先用鼠标点一下那扇门，或者说是哪一间。');
      return false;
    }
    const wasModel = !d.added;
    const rmD = (d.room && M.rooms.find(r => r.id === d.room))
      || M.rooms.find(r => (d.rooms || []).indexOf(r.id) >= 0) || null;
    const snap = undoDoor(d, true);
    if (!snap) { ai('这扇门在墙上找不到对应的洞口，没敢动它。'); return false; }
    /* 以前这里对模型原有的门一律拒绝（"只说我新建的门才能拆"）。
       但用户是**点中了它、又明说要撤**，那就得撤 —— 只是要知道
       这一扇是原设计的，拆了以后图纸上少一道门。 */
    ai('把「' + snap.name + '」撤掉了，墙上恢复成没有洞口的样子' +
      (snap.conduitsRestored ? '；开门时为它改道的那 ' + snap.conduitsRestored + ' 根线管也放回原来的走法了' : '') +
      (snap.openingsRestored ? '；原来被让开的 ' + snap.openingsRestored + ' 处门窗装回去了' : '') + '。' +
      (wasModel ? '这一扇是原设计里就有的门，拆掉以后图纸上会少一道，记得补图。' : ''));
    const wall = M.walls.find(w => w.id === snap.wall);
    pushUndo('把「' + snap.name + '」重新开回去', () => {
      if (!wall) return;
      const nd = S.addDoorOpening(wall, snap.at, snap.w, snap.h);
      if (!nd) return;
      if (snap.room) nd.room = snap.room;
      if (snap.added) nd.added = true;
      ST.lastDoor = { wall: wall, at: snap.at, w: snap.w, d: nd, room: doorRoom(nd) };
    });
    if (rmD) window.BIM.agent.commit({ act: 'dooroff', text: step.text }, { room: rmD });
    return true;
  }

  async function stepDoorMove(step) {
    const d = resolveDoor(step);
    if (!d) {
      if (ST.openingAmb && ST.openingAmb.kind === 'door') {
        const L = ST.openingAmb.list;
        ai('重名的门有 ' + L.length + ' 扇，要挪哪一扇？选一个，我接着按原话挪：');
        askWhichOpening('door', L, dd => stepDoorMove(Object.assign({}, step, { door: dd.id })));
        return false;
      }
      ai('现在没有可挪的门。'); return false;
    }
    const wall0 = M.walls.find(w => w.id === d.wall);
    if (!wall0) return false;
    // 门实际挂在哪一段墙上，比上下文更可信（否则挪门会拿错房间校核）
    const room = roomOfOpening(d, wall0, S.doorAt(d, wall0))
      || step.roomRef || (step.room ? window.BIM.agent.roomByNum(step.room, step.floor) : null) || doorRoom(d);

    // 换墙：说到另一面墙时把门整体搬过去（"左边那面墙"要按当前镜头换算）
    let wall = wall0, changedWall = false;
    let wantSide = step.side;
    const relSide = step.sideRel || (REL_SIDES.indexOf(step.side) >= 0 ? step.side : null);
    if (relSide) wantSide = viewSide(relSide) || wantSide;
    if (wantSide && room && (room.sides || {})[wantSide]) {
      const w2 = M.walls.find(x => x.id === room.sides[wantSide]);
      if (w2 && w2.id !== wall0.id) { wall = w2; changedWall = true; }
    }

    // 一条长墙串着几间房，所以一律按"本房间在这面墙上那一段"来算
    const span = roomSpanOnWall(wall, room);
    const L = S.wallLen(wall);
    const mid = (span.lo + span.hi) / 2;
    const at0 = changedWall ? mid : S.doorAt(d, wall0);
    let at = at0;
    const along = step.along;
    if (along === 'center') {
      at = mid;
    } else if (along) {
      // 屏幕方向投到墙的走向上：往左就是墙上朝屏幕左边那一头
      const v = dirVec(along, room);
      const ax = S.wallAxis(wall);
      if (!v) { ai('没听懂往哪边挪，说「往左」「往右」或者「挪到墙中间」都行。'); return false; }
      const sgn = (v.x * ax.x + v.y * ax.y) >= 0 ? 1 : -1;
      at = at0 + sgn * (step.dist || 0.5);
    } else if (!changedWall) {
      ai('往哪边挪？往左、往右，或者直接说「挪到墙中间」。');
      chips([
        { label: '往左半米', fn: () => send('把门往左挪半米') },
        { label: '往右半米', fn: () => send('把门往右挪半米') },
        { label: '挪到墙中间', fn: () => send('把门挪到墙中间') }
      ]);
      return false;
    }
    const loA = span.lo + d.w / 2 + 0.15, hiA = span.hi - d.w / 2 - 0.15;
    at = clamp(at, loA, Math.max(loA, hiA));

    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    let chk = C.door({ wall: wall, at: at, w: d.w, h: d.h, equipments: eqs, room: room, self: d });
    const before = { wall: wall0, at: S.doorAt(d, wall0), w: d.w, h: d.h };
    let finalAt = at, note = '';
    let moveReroutes = null;

    if (!chk.pass) {
      /* 只剩墙里线管挡着 ≠ 挪不过去：挪过去再牵一次线就行（跟开门同一套规矩） */
      const bl = chk.blocks || [];
      if (bl.length === 1 && bl[0].k === 'conduit' && C.rerouteForConduits) {
        const pl = C.rerouteForConduits(chk.conduits || [], at, d.w, d.h, 0);
        if (pl) { moveReroutes = pl; chk = Object.assign({}, chk, { pass: true, blocks: [] }); }
      }
    }
    if (!chk.pass) {
      const sug = C.suggestDoorAt({ wall: wall, room: room, at: at, w: d.w, h: d.h, equipments: eqs, self: d, ignoreConduit: true });
      if (sug && sug.check && (sug.check.pass || (sug.check.blocks || []).every(b => b.k === 'conduit')) && Math.abs(sug.at - at) < 2.0) {
        finalAt = sug.at;
        chk = sug.check;
        note = (chk.blocks[0] ? chk.blocks[0].t : '那边有东西挡着') +
          '，我顺着墙让了 ' + Math.abs(sug.at - at).toFixed(2) + ' 米。';
        if (!chk.pass && (chk.blocks || []).every(b => b.k === 'conduit') && C.rerouteForConduits) {
          const pl = C.rerouteForConduits(chk.conduits || [], finalAt, d.w, d.h, 0);
          if (pl) { moveReroutes = pl; chk = Object.assign({}, chk, { pass: true, blocks: [] }); }
        }
      } else {
        S.highlightWall(wall, 0xdd534f);
        ai('这个位置挪不过去：' + chk.blocks.map(b => b.t).join('；') + '。要不换个方向，或者换一面墙？');
        chips([
          { label: '挪到墙中间', fn: () => send('把门挪到墙中间') },
          { label: '换到另一面墙', fn: () => send('把这个门换到' + (room ? room.num + '室的另一面墙' : '另一面墙')) }
        ]);
        return false;
      }
    }

    const nd = S.replaceDoor(d, { wall: wall, at: finalAt, w: d.w, h: d.h });
    if (!nd) { ai('这扇门挪不过去，可能墙上的洞口找不到了。'); return false; }
    const rm = room || doorRoom(nd);
    ST.lastDoor = { wall: wall, at: finalAt, w: d.w, d: nd, chk: chk, room: rm };
    if (moveReroutes) {
      const E = window.BIM.elec;
      (d._reroutes || []).forEach(cid => { if (E && E.undoReroute) E.undoReroute(cid); });
      const ids = [];
      moveReroutes.forEach(p => { if (p && p.ok && p.c && E) { E.applyReroute(p.c, p.hole, p); ids.push(p.c.id); } });
      if (ids.length) nd._reroutes = ids;
      showHoleConflict(wall, moveReroutes.map(p => p.c), moveReroutes);
    } else if (d._reroutes) {
      nd._reroutes = d._reroutes;
    }
    if (rm) rememberDoor(rm, wantSide || null, d.w, d.h);
    const sp = doorSpot(wall, finalAt);
    S.markDoorSpot(wall, finalAt, d.w, d.h, true);
    if (rm) focusSoft(rm, { color: false, keepView: true });
    if (!S.inView(wall.floor, sp.x - 1.6, sp.y - 1.6, sp.x + 1.6, sp.y + 1.6)) S.focusDoor(wall, finalAt, rm);

    pushUndo('把门挪回原来的位置', () => {
      const bak = S.replaceDoor(nd, { wall: before.wall, at: before.at, w: before.w, h: before.h });
      if (bak) ST.lastDoor = { wall: before.wall, at: before.at, w: before.w, d: bak, room: rm };
    });

    const moved = Math.abs(finalAt - at0);
    const head = changedWall
      ? '门换到' + (room ? N.SIDE_CN[wantSide] + '墙' : '新的一面墙') + '上了，'
      : (moved < 0.05 ? '门还在原来那儿，' : '门沿墙挪了 ' + moved.toFixed(2) + ' 米，');
    ai('挪好了：' + head + (note ? note : (chk.warns && chk.warns.length ? chk.warns[0] + '。' : '通道还够宽。')) +
      (moveReroutes ? '墙里那 ' + moveReroutes.length + ' 根线管按新位置重新绕了一次，绿色是改完的走向。' : ''));
    lastData = { width: d.w, height: d.h, moved_m: +moved.toFixed(2), changedWall: changedWall,
                 at: +finalAt.toFixed(2), rerouted: moveReroutes ? moveReroutes.length : 0 };
    if (rm) window.BIM.agent.commit({ act: 'doormove', text: step.text }, { room: rm });
    return true;
  }

  async function stepDoorSize(step) {
    const d = resolveDoor(step);
    if (!d) {
      if (ST.openingAmb && ST.openingAmb.kind === 'door') {
        const L = ST.openingAmb.list;
        ai('「' + (step.door || '') + '」这个名字底下有 ' + L.length + ' 扇门，得先认准哪一扇。选一个，我接着按原话改：');
        askWhichOpening('door', L, dd => stepDoorSize(Object.assign({}, step, { door: dd.id })));
        return false;
      }
      ai('现在没有可改的门。先用鼠标点一下那扇门，或者说是哪一间。');
      return false;
    }
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) return false;
    /* 同开窗：这扇门实际在哪一段墙上才是准的，上下文那间只作兜底 */
    const atD0 = S.doorAt(d, wall);
    const room = roomOfOpening(d, wall, atD0)
      || step.roomRef || (step.room ? window.BIM.agent.roomByNum(step.room, step.floor) : null) || doorRoom(d);

    const has = step.width != null || step.height != null;
    if (!has) {
      ai('这扇门现在是 ' + d.w.toFixed(2) + ' 米宽、' + d.h.toFixed(2) + ' 米高。要改多宽多高？');
      chips([
        { label: '加宽到 1.5 米', fn: () => send('把门加宽到1.5米') },
        { label: '门矮一点 2 米', fn: () => send('把门改成2米高') }
      ]);
      return false;
    }
    const nw = step.width != null ? clamp(+step.width, 0.5, 3.0) : d.w;
    const nh = step.height != null ? clamp(+step.height, 1.5, 4.0) : d.h;
    const at = S.doorAt(d, wall);
    const before = { w: d.w, h: d.h };
    const eqs = ST.placed.filter(e => e.floor === wall.floor);
    // 改宽也是拓门：先看两侧各能扩多少，再决定对半扩还是只往一侧挖
    const plan = C.widenPlan({ wall: wall, at: at, w: d.w, h: nh, need: nw, room: room, equipments: eqs, self: d });
    const best = plan.best;

    if (!best || best.w < nw - 1e-6) {
      S.highlightWall(wall, 0xdd534f);
      const cap = best ? '最多只能到 ' + best.w.toFixed(2) + ' m' : '两侧都扩不动';
      const blocks = (best ? best.chk.blocks : (plan.blocked || [])).map(b => b.t);
      ai(nw.toFixed(2) + '×' + nh.toFixed(2) + ' 米开不了：' + widenSidesTxt(plan) + '，' + cap + '。' +
        (blocks.length ? blocks.join('；') + '。' : '') + '要不门小一点，或者先把门挪个位置？',
        '<div class="res bad"><div class="res-top"><span class="k">开不了</span><span class="tag">有碰撞</span></div>' +
        '<div class="res-adv">' + (blocks.length ? blocks.map(b => '<s>·</s> ' + b).join('<br>')
          : '<s>·</s> ' + widenSidesTxt(plan)) + '</div></div>');
      const cs = [{ label: '还是原尺寸', fn: () => { } }];
      if (best) cs.push({ label: '改成 ' + best.w.toFixed(2) + ' m', fn: () => doWidenDoor(room, d, best.w, nh) });
      cs.push({ label: '把门挪一下', fn: () => send('把门往左挪半米') });
      chips(cs);
      return false;
    }

    const nd = S.replaceDoor(d, { at: best.at, w: best.w, h: nh });
    if (!nd) { ai('洞口改不回来，先撤回再试。'); return false; }
    const chk = best.chk;
    /* 洞口宽了，原来为这扇门改道的线管要按**新洞口**重新绕一次：
       绕行折线的两条"竖腿"落在洞口两侧，洞口变宽它们就落进洞里了。
       先把旧的改线记录撤掉，再按新洞口重牵，最后挂到新门身上（撤门时还要用）。 */
    const E = window.BIM.elec;
    let reRouted = 0;
    if (best.needReroute && best.reroutes) {
      (d._reroutes || []).forEach(cid => { if (E && E.undoReroute) E.undoReroute(cid); });
      const ids = [];
      best.reroutes.forEach(p => {
        if (p && p.ok && p.c && E) { E.applyReroute(p.c, p.hole, p); ids.push(p.c.id); }
      });
      if (ids.length) { nd._reroutes = ids; reRouted = ids.length; }
      showHoleConflict(wall, best.reroutes.map(p => p.c), best.reroutes);
    } else if (d._reroutes) {
      nd._reroutes = d._reroutes;      // 这次没动到那几根，原来的改线记录原样带着走
    }
    ST.lastDoor = { wall: wall, at: best.at, w: best.w, d: nd, chk: chk, room: room };
    if (room) rememberDoor(room, null, best.w, nh);
    S.markDoorSpot(wall, best.at, best.w, nh, true);
    if (room) focusSoft(room, { keepView: true, color: false });
    pushUndo('把门改回 ' + before.w.toFixed(2) + '×' + before.h.toFixed(2) + ' 米', () => {
      const bak = S.replaceDoor(nd, { at: best.at, w: before.w, h: before.h });
      if (bak) ST.lastDoor = { wall: wall, at: best.at, w: before.w, d: bak, room: room };
    });

    // 门定下来以后，把房间里这台设备的安全系数重算一遍，并给计算书入口
    const eq = ST.sel && ST.sel.room === (room && room.id) ? ST.sel
      : (window.BIM.agent.mem.lastPlaced && window.BIM.agent.mem.lastPlaced.room === (room && room.id)
        ? window.BIM.agent.mem.lastPlaced : null);
    let r2 = null;
    if (eq) {
      r2 = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
      ST.last = r2; ST.sel = eq;
      window.BIM.agent.mem.lastResult = r2;
    }
    const moved = Math.abs(best.at - at);
    const growL = Math.max(0, (best.w - before.w) / 2 + (at - best.at));
    const growR = Math.max(0, (best.w - before.w) / 2 - (at - best.at));
    const note = (best.w - before.w) < 0.005
      ? '宽度没变，只改了高度'
      : (moved > 0.02
        ? '原位放不下，' + (best.why || '顺墙让了 ' + moved.toFixed(2) + ' 米') + '，左侧扩 ' + growL.toFixed(2) + ' m、右侧扩 ' + growR.toFixed(2) + ' m'
        : (best.why || '两侧各扩一半') + '，左侧扩 ' + growL.toFixed(2) + ' m、右侧扩 ' + growR.toFixed(2) + ' m');
    ai('门改成 ' + best.w.toFixed(2) + ' 米宽、' + nh.toFixed(2) + ' 米高：' + note + '。开门校核通过。' +
      (reRouted ? '墙里那 ' + reRouted + ' 根线管跟着新洞口重新绕了一次（绿色是改完的走向），不是不能改。' : '') +
      (r2 ? '这间房里的「' + eq.name + '」顺势重算了一遍，最终安全系数 ' + C.fmt(r2.K) + '（' + r2.v.word + '）。' : ''),
      (r2 ? card(r2) : '') +
      '<div class="res ok" style="margin-top:8px"><div class="res-top"><span class="k">可以开</span><span class="tag">' +
      (reRouted ? '已改线' : '无碰撞') + '</span></div>' +
      '<div class="res-grid"><div><i>门宽</i><b>' + best.w.toFixed(2) + ' m</b></div>' +
      '<div><i>门高</i><b>' + nh.toFixed(2) + ' m</b></div>' +
      '<div><i>左侧扩</i><b>' + growL.toFixed(2) + ' m</b></div>' +
      '<div><i>右侧扩</i><b>' + growR.toFixed(2) + ' m</b></div></div></div>');
    const cs = [];
    if (r2) cs.push({ label: '看计算书', fn: () => openCalc() });
    cs.push({ label: '看看这扇门', fn: () => stepDoorInfo({}) });
    chips(cs);
    lastData = { door: nd.code || nd.name, door_id: nd.id, width: best.w, height: nh,
                 moved: +moved.toFixed(2), rerouted: reRouted,
                 grow: [+growL.toFixed(2), +growR.toFixed(2)], k: r2 ? +C.fmt(r2.K) : null };
    if (room) window.BIM.agent.commit({ act: 'doorsize', text: step.text }, { room: room });
    return true;
  }

  /* 同层里还有哪间房"门够大、搬得进去"——门拓不了的时候给个退路 */
  function altRoomFor(room, eq) {
    if (!room || !eq) return null;
    const cands = (M.rooms || []).filter(r => r.floor === room.floor && r.id !== room.id && r.zone !== 'corr');
    const ok = cands.filter(r => C.passDoor({ room: r, equip: eq }).ok);
    if (!ok.length) return null;
    // 机房优先，其次挑大的：设备本来就该往机房塞
    ok.sort((a, b) => {
      const sa = (/机房/.test(a.use) ? 1000 : 0) + a.area;
      const sb = (/机房/.test(b.use) ? 1000 : 0) + b.area;
      return sb - sa;
    });
    return ok[0];
  }

  /* ---------------- 门不够宽 → 问一句要不要拓宽 ----------------
     规则：设备最小包裹宽 min(w,d) + 0.12 ≤ 门净宽，高 + 0.08 ≤ 门高，才算搬得进去。
     拓宽必须过 C.door 校核（撞墙角、贴隔壁门、压柱、风管穿越、设备挡门都不合格），
     过不了就明说「门没动」——这就是「不影响开门才真正开启」。 */
  /* 门两侧各剩多少，说人话。拓门不是两边对半长，所以这两个数必须摆出来 */
  function widenSidesTxt(plan) {
    const sd = plan.side;
    if (!sd) return '';
    const one = (v, near) => v < 0.02
      ? '0（' + (near || '障碍') + '顶死）'
      : v.toFixed(2) + ' m';
    return '左侧可扩 ' + one(sd.left, sd.nearL) + '，右侧可扩 ' + one(sd.right, sd.nearR);
  }

  /* quiet=true：不自己说话，只把"要不要拓门"这段文案返回给调用方拼进自己的回执。
     搬家时用得着——先说完"搬到 506 了、安全系数多少"，再顺带提门的事，
     不然最后一句被门的话盖掉，用户以为没搬。 */
  function askDoorWiden(room, eq, pd, quiet) {
    const say = (t, h) => { if (!quiet) ai(t, h); return t; };
    if (!pd || pd.ok) return '';
    if (!room) return '';
    // 同一间房问过一次就不再问：连续放五台设备不该弹五遍同一个问题
    if (ST.doorAsked[room.id]) return '';
    ST.doorAsked[room.id] = true;
    if (pd.why === 'no-door') {
      const t = '「' + eq.name + '」放好了，但这间房没登记门 —— 等于搬不进来也搬不出去。要开一扇吗？';
      say(t, '<div class="res warn"><div class="res-top"><span class="k">没门</span><span class="tag">搬不进去</span></div>' +
        '<div class="res-adv">设备最小包裹尺寸 ' + pd.needW.toFixed(2) + ' × ' + pd.needH.toFixed(2) + ' m，门洞至少得这么大。</div></div>');
      chips([{
        label: '开一扇 ' + Math.max(1.2, pd.needW).toFixed(2) + ' 米门',
        fn: () => send('在' + room.num + '室靠走廊的位置开一个' + Math.max(1.2, pd.needW).toFixed(1) + '米宽的门')
      }]);
      return t;
    }
    const d = pd.door;
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) return '';
    /* 打通以后这块板上有好几扇门（每一间各一扇靠走廊的）。
       用户点名过："放不进门需要可以任意选择俩个打通房间其中一个走廊的门进行拓宽"。
       每扇门各自量一遍余量，把"能拓到多少"先说清，再让用户点。 */
    const cands = (pd.candidates || []).filter(c => c && c.door);
    if (cands.length > 1) return askDoorWhich(room, eq, pd, cands, quiet);
    const nw = Math.max(d.w, pd.needW), nh = Math.max(d.h, pd.needH);
    const at = S.doorAt(d, wall);
    const eqs = (ST.placed || []).filter(e => e.floor === wall.floor);
    // 先看两侧：能对半扩、还是只能往一侧挖、还是得顺着墙让一段
    const plan = C.widenPlan({ wall: wall, at: at, w: d.w, h: nh, need: nw, room: room, equipments: eqs, self: d });
    const why = pd.why === 'width'
      ? '门净宽只有 ' + d.w.toFixed(2) + ' m，「' + eq.name + '」立起来搬最窄也要 ' + pd.needW.toFixed(2) + ' m'
      : '门高只有 ' + d.h.toFixed(2) + ' m，「' + eq.name + '」高 ' + pd.needH.toFixed(2) + ' m';

    if (!plan.best || plan.best.w < nw - 1e-6) {
      // 两侧都量过了还是不够 —— 把"最多能到多少"说清楚，别让用户自己猜
      const cap = plan.best
        ? '原位最多只能拓到 ' + plan.best.w.toFixed(2) + ' m'
        : '原位一点也扩不了';
      const alt = altRoomFor(room, eq);
      const t2 = '设备放得下，但搬不进来：' + why + '。我量了门洞两侧——' + widenSidesTxt(plan) +
        '；' + cap + '，还差 ' + (nw - (plan.best ? plan.best.w : d.w)).toFixed(2) + ' m。';
      say(t2,
        '<div class="res bad"><div class="res-top"><span class="k">拓不到位</span><span class="tag">两侧余量不够</span></div>' +
        '<div class="res-grid"><div><i>门洞现状</i><b>' + d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' m</b></div>' +
        '<div><i>至少需要</i><b>' + nw.toFixed(2) + '×' + nh.toFixed(2) + ' m</b></div></div>' +
        '<div class="res-adv">' + widenSidesTxt(plan) + '。' + cap + '，差距 ' +
        (nw - (plan.best ? plan.best.w : d.w)).toFixed(2) + ' m。</div></div>');
      const cs = [];
      if (alt && eq) cs.push({ label: '改放到 ' + alt.num + ' 室', fn: () => send('把' + eq.name + '放到' + alt.num + '室') });
      if (eq) cs.push({ label: '把设备改小一点', fn: () => send('把' + eq.name + '改小一点') });
      // 只能拓一部分时，给一个"就按能到的宽度先拓"的出口
      if (plan.best && plan.best.w > d.w + 0.01) {
        cs.push({
          label: '先拓到 ' + plan.best.w.toFixed(2) + ' m',
          fn: () => doWidenDoor(room, d, plan.best.w, nh)
        });
      }
      chips(cs);
      return t2;
    }

    const modeTxt = plan.best.mode === 'slide'
      ? '原位两侧都放不下，得' + plan.best.why
      : (plan.best.why || '原位加宽');
    const t3 = '设备放得下，但搬不进来：' + why + '。要不要把「' + d.name + '」拓到 ' + nw.toFixed(2) + ' × ' + nh.toFixed(2) +
      ' m？我量过两侧——' + widenSidesTxt(plan) + '，可以' + modeTxt + '。';
    say(t3,
      '<div class="res warn"><div class="res-top"><span class="k">搬不进</span><span class="tag">门偏小</span></div>' +
      '<div class="res-grid"><div><i>门洞现状</i><b>' + d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' m</b></div>' +
      '<div><i>至少需要</i><b>' + nw.toFixed(2) + '×' + nh.toFixed(2) + ' m</b></div></div>' +
      '<div class="res-adv">' + widenSidesTxt(plan) + ' → ' + modeTxt + '</div></div>');
    chips([
      { label: '把门拓到 ' + nw.toFixed(2) + ' m', fn: () => doWidenDoor(room, d, nw, nh) },
      { label: '先不改门', fn: () => toast('门保持原样，设备先放着了') }
    ]);
    return t3;
  }

  /* 打通后"有好几扇门可以走"时的那一问：每扇门都量一遍能拓到多宽，
     然后让用户自己挑 —— 拓哪一扇都行，别替他定死其中一间。 */
  function askDoorWhich(room, eq, pd, cands, quiet) {
    const say = (t, h) => { if (!quiet) ai(t, h); return t; };
    const rows = cands.map(c => {
      const wall = M.walls.find(w => w.id === c.door.wall);
      const at = (wall && S.doorAt(c.door, wall) != null) ? S.doorAt(c.door, wall) : null;
      const nw = Math.max(c.door.w, pd.needW), nh = Math.max(c.door.h, pd.needH);
      const plan = (wall && at != null)
        ? C.widenPlan({
          wall: wall, at: at, w: c.door.w, h: nh, need: nw, room: room,
          equipments: (ST.placed || []).filter(e => e.floor === wall.floor), self: c.door
        })
        : null;
      const cap = (plan && plan.best) ? plan.best.w : c.door.w;
      return {
        c: c, wall: wall, at: at, nw: nw, nh: nh, plan: plan, cap: cap,
        can: !!plan && !!plan.best && plan.best.w >= nw - 1e-6
      };
    });
    const nmC = r => (r.c.roomNum || room.num) + ' 室';
    const list = rows.map(r => '<s>·</s> ' + nmC(r) + '「' + (r.c.name || '门') + '」' + r.c.w.toFixed(2) + '×' +
      r.c.h.toFixed(2) + ' m，原位' + (r.can ? '能' : '最多只能') + '拓到 ' + r.cap.toFixed(2) + ' m').join('<br>');
    const t = '设备放得下，但搬不进来：这块板打通后一共有 ' + rows.length + ' 扇门，最宽的也只有 ' +
      Math.max.apply(null, rows.map(r => r.c.w)).toFixed(2) + ' m，「' + eq.name + '」最少要 ' +
      pd.needW.toFixed(2) + ' m。要拓哪一扇？';
    /* 先把默认推荐那扇（能拓到位、且需要拓得最少的）在场景里点亮，用户看得到是哪一扇 */
    const best = rows.slice().sort((a, b) => (b.can ? 1 : 0) - (a.can ? 1 : 0) || a.nw - b.nw)[0];
    if (best && best.c.door) S.highlightDoor(best.c.door, 0xdd9a2c);
    say(t,
      '<div class="res warn"><div class="res-top"><span class="k">搬不进</span><span class="tag">' + rows.length + ' 扇门都不够</span></div>' +
      '<div class="res-grid"><div><i>最宽的门</i><b>' + Math.max.apply(null, rows.map(r => r.c.w)).toFixed(2) + ' m</b></div>' +
      '<div><i>至少需要</i><b>' + pd.needW.toFixed(2) + ' m</b></div></div>' +
      '<div class="res-adv">' + list + '</div></div>');
    chips(rows.map(r => ({
      label: (r.can ? '拓 ' : '试拓 ') + nmC(r) + '「' + (r.c.name || '门') + '」→ ' + r.nw.toFixed(2) + ' m',
      fn: () => doWidenDoor(room, r.c.door, r.nw, r.nh)
    })).concat([{ label: '不改门', fn: () => toast('门保持原样，设备先放着了') }]));
    return t;
  }

  function doWidenDoor(room, d, nw, nh) {
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) { toast('找不到这扇门所在的墙'); return false; }
    const eq = ST.sel || (window.BIM.agent.mem.lastPlaced) || null;
    const at = S.doorAt(d, wall);
    const eqs = (ST.placed || []).filter(e => e.floor === wall.floor);
    const plan = C.widenPlan({ wall: wall, at: at, w: d.w, h: nh, need: nw, room: room, equipments: eqs, self: d });
    const best = plan.best;

    // 两侧都量过仍不够 → 门一个字都不改（硬规则：为了塞设备把门改到开不了，不干）
    if (!best || best.w < nw - 1e-6) {
      S.highlightWall(wall, 0xdd534f);
      const alt = altRoomFor(room, eq);
      const cap = best ? '最多只能拓到 ' + best.w.toFixed(2) + ' m' : '原位一点也扩不了';
      const blocks = (best ? best.chk.blocks : (plan.blocked || [])).map(b => b.t);
      ai('拓不到 ' + nw.toFixed(2) + '×' + nh.toFixed(2) + ' m：' + widenSidesTxt(plan) + '，' + cap +
        '。' + (blocks.length ? blocks.join('；') + '。' : '') +
        '门没动 —— 拓完开不了门等于白拓。' + (alt ? '这层的 ' + alt.num + ' 室门够大，搬那边去？' : ''),
        '<div class="res bad"><div class="res-top"><span class="k">不能拓</span><span class="tag">开门校核没过</span></div>' +
        '<div class="res-adv">' + (blocks.length ? blocks.map(b => '<s>·</s> ' + b).join('<br>')
          : '<s>·</s> 两侧余量加起来不够 ' + nw.toFixed(2) + ' m') + '</div></div>');
      const cs = [];
      if (alt && eq) cs.push({ label: '改放到 ' + alt.num + ' 室', fn: () => send('把' + eq.name + '放到' + alt.num + '室') });
      if (eq) cs.push({ label: '把设备改小一点', fn: () => send('把' + eq.name + '改小一点') });
      chips(cs);
      return false;
    }

    const nd = S.replaceDoor(d, { at: best.at, w: best.w, h: nh });
    if (!nd) { ai('洞口没改成功，先撤回再试。'); return false; }
    const chk = best.chk;
    ST.lastDoor = { wall: wall, at: best.at, w: best.w, d: nd, chk: chk, room: room };
    if (room) rememberDoor(room, null, best.w, nh);
    S.markDoorSpot(wall, best.at, best.w, nh, true);
    if (room) focusSoft(room, { keepView: true, color: false });
    pushUndo('把门改回 ' + d.w.toFixed(2) + '×' + d.h.toFixed(2) + ' 米', () => {
      const bak = S.replaceDoor(nd, { at: best.at, w: d.w, h: d.h });
      if (bak) ST.lastDoor = { wall: wall, at: best.at, w: d.w, d: bak, room: room };
    });

    // 改完复核：设备现在能不能过、门口还留没留出开启范围
    let pd2 = null;
    if (eq) { pd2 = C.passDoor({ room: room, equip: eq }); eq._door = pd2; }
    const passTxt = pd2 ? (pd2.ok ? '「' + eq.name + '」现在搬得进去了。' : '设备最小包裹宽 ' + pd2.needW.toFixed(2) + ' m，还差一点。') : '';

    // 最终验算：门定下来以后，设备在这个位置的安全系数重新算一遍
    let r2 = null;
    if (eq) {
      const rm = M.rooms.find(r => r.id === eq.room) || room;
      r2 = C.check({ room: rm, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(rm).filter(e => e !== eq) });
      ST.last = r2; ST.sel = eq;
      window.BIM.agent.mem.lastResult = r2;
      window.BIM.agent.mem.lastPlaced = eq;
    }

    const moved = Math.abs(best.at - at);
    const shiftTxt = best.mode === 'slide' || moved > 0.005
      ? '（' + best.why + '，门心挪了 ' + moved.toFixed(2) + ' m）' : '（' + (best.why || '原位加宽') + '）';
    const growL = ((best.w - d.w) / 2 + (at - best.at));
    const growR = ((best.w - d.w) / 2 - (at - best.at));
    const growTxt = '左侧扩了 ' + Math.max(0, growL).toFixed(2) + ' m、右侧扩了 ' + Math.max(0, growR).toFixed(2) + ' m';

    ai('「' + d.name + '」拓到 ' + best.w.toFixed(2) + ' m 宽、' + nh.toFixed(2) + ' m 高' + shiftTxt +
      '：' + growTxt + '。开门校核通过：' + ((chk.warns && chk.warns[0]) || '门口 0.9 m 开启范围里没有设备，门能正常开合') +
      '。' + passTxt +
      (r2 ? ' 门定了以后把设备的受力重算了一遍，最终安全系数 ' + C.fmt(r2.K) + '（' + r2.v.word + '）。' : ''),
      (r2 ? card(r2) : '') +
      '<div class="res ok" style="margin-top:8px"><div class="res-top"><span class="k">可以开</span><span class="tag">开门校核通过</span></div>' +
      '<div class="res-grid"><div><i>门宽</i><b>' + best.w.toFixed(2) + ' m</b></div>' +
      '<div><i>门高</i><b>' + nh.toFixed(2) + ' m</b></div>' +
      '<div><i>左侧扩</i><b>' + Math.max(0, growL).toFixed(2) + ' m</b></div>' +
      '<div><i>右侧扩</i><b>' + Math.max(0, growR).toFixed(2) + ' m</b></div></div></div>');

    // 验算完了，下面直接给计算书入口
    const cs = [];
    if (r2) cs.push({ label: '看计算书', fn: () => openCalc() });
    if (eq && pd2 && !pd2.ok) cs.push({ label: '把设备改小一点', fn: () => send('把' + eq.name + '改小一点') });
    cs.push({ label: '看看这扇门', fn: () => stepDoorInfo({}) });
    chips(cs);

    toast('门已拓宽到 ' + best.w.toFixed(2) + ' m，开门校核通过');
    if (room) delete ST.doorAsked[room.id];       // 门变宽了，以后再放大设备要能重新问
    lastData = { door: d.name, width: best.w, height: nh, pass: true, equip_pass: pd2 ? pd2.ok : null,
                 k: r2 ? +C.fmt(r2.K) : null, grow: [+Math.max(0, growL).toFixed(2), +Math.max(0, growR).toFixed(2)] };
    if (window.BIM.tree) window.BIM.tree.rebuild();
    return true;
  }

  async function stepDoorInfo(step) {
    const d = resolveDoor(step);
    if (!d) { ai('现在没有可查的门。'); return false; }
    const wall = M.walls.find(w => w.id === d.wall);
    if (!wall) return false;
    const room = step.roomRef || (step.room ? window.BIM.agent.roomByNum(step.room, step.floor) : null) || doorRoom(d);
    const at = S.doorAt(d, wall);
    const sp = doorSpot(wall, at);
    let near = null, nd = 1e9;
    (ST.placed || []).forEach(e => {
      if (e.floor !== d.floor) return;
      const ef = C.foot(e);
      const dx = Math.max(Math.abs(sp.x - e.x) - ef.w / 2, 0);
      const dy = Math.max(Math.abs(sp.y - e.y) - ef.d / 2, 0);
      const dd = Math.hypot(dx, dy);
      if (dd < nd) { nd = dd; near = e; }
    });
    const chk = C.door({ wall: wall, at: at, w: d.w, h: d.h, equipments: ST.placed.filter(e => e.floor === d.floor), room: room, self: d });
    const side = room ? Object.keys(room.sides || {}).find(k => room.sides[k] === wall.id) : null;
    const sideTxt = side ? N.SIDE_CN[side] + '墙' : ('墙 ' + wall.id);

    showProps({ kind: 'door', data: d });
    ai('这扇门在' + (room ? room.num + '室的' : '') + sideTxt + '上，' + d.w.toFixed(2) + ' 米宽、' + d.h.toFixed(2) + ' 米高，' +
      (d.added ? '是新建的门。' : '是模型原有的门。') +
      (near ? '离它最近的设备是「' + near.name + '」，净距 ' + nd.toFixed(2) + ' 米' + (nd < 0.9 ? '，人进出得侧身' : '，通行没问题') + '。' : '这层还没放设备。') +
      (chk.pass ? '' : '现在这个位置有碰撞：' + chk.blocks.map(b => b.t).join('；') + '。'), null, false);
    lastData = { door: d.name, wall: wall.id, side: side || null, width: d.w, height: d.h, added: !!d.added, nearest: near ? near.name : null, clear_m: +nd.toFixed(2), pass: chk.pass };
    return true;
  }

  async function stepDoors(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    let doors = (M.doors || []).slice();
    if (room) doors = doors.filter(d => (d.rooms || []).indexOf(room.id) >= 0);
    else if (step.floor) doors = doors.filter(d => d.floor === +step.floor);
    if (!doors.length) {
      ai((room ? room.num + ' 室' : '这层') + '没有登记的门。');
      return false;
    }
    const rows = doors.map(d => {
      const r = M.rooms.find(x => x.id === (d.rooms || [])[0]);
      return '<div class="kv"><i>' + esc(d.name) + (r ? ' · ' + r.num : '') + '</i><b>' +
        (d.added ? '新增' : '原有') + ' · ' + d.w.toFixed(2) + ' m</b></div>';
    }).join('');
    const where = room ? room.num + ' 室' : (step.floor ? step.floor + ' 楼' : '全楼');
    ai(where + '一共 ' + doors.length + ' 扇门，其中新建的 ' + doors.filter(d => d.added).length + ' 扇：',
      '<div class="res ok"><div class="res-adv">' + rows + '</div></div>', false);
    lastData = { where: where, count: doors.length, items: doors.map(d => ({ name: d.name, width: d.w, height: d.h, added: !!d.added })) };
    return true;
  }

  /* ---------------- 视图：聚焦 / 还原 ---------------- */
  async function stepFocus(step) {
    const A = window.BIM.agent;
    let room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null);
    let eq = null;
    if (!room && step.device) {
      const dev = A.deviceByName(step.device);
      if (dev) eq = (ST.placed || []).filter(e => e.name === dev.name).slice(-1)[0];
      if (eq) room = M.rooms.find(r => r.id === eq.room);
    }
    if (!room && step.floor) {
      ST.focus = +step.floor;
      S.setFocus(+step.floor);
      S.isolateRoom(null, false);
      S.clearHighlight(); S.clearRoute && S.clearRoute();
      paintFloors(); finishMode();
      ai(+step.floor ? '切到 ' + step.floor + ' 楼了。' : '回到全楼视角了。', null, false);
      return true;
    }
    if (!room) room = A.mem.ctx.room;
    if (!room) { ai('要聚焦到哪一间？说个房间号就行，比如「2 楼 202」。'); return false; }

    ST.focus = room.floor;
    ST.mode = 'idle'; S.mode = 'idle';
    finishMode();
    S.setFocus(room.floor, false);
    if (step.only === false) {
      S.isolateRoom(null, false);
      S.setFocus(room.floor, false);
    } else {
      S.isolateRoom(room, true);
    }
    S.clearHighlight();
    S.highlightRoom(room, 0x10a394);
    if (eq) ST.sel = eq;
    paintFloors();
    const vis = (ST.placed || []).filter(e => e.room === room.id);
    if (!S.inView(room.floor, room.x0 - .6, room.y0 - .6, room.x1 + .6, room.y1 + .6, 0.06, 0.12)) {
      S.frameBounds(room.floor, room.x0 - 1.0, room.y0 - 1.0, room.x1 + 1.0, room.y1 + 1.0, true, 0.86);
    }
    ai('眼睛放到 ' + room.num + ' 室了' + (step.only === false ? '，别的房间留着没藏。' : '，别的楼层和房间先藏起来，说「都显示出来」就还原。') +
      (vis.length ? '这里现在有 ' + vis.map(e => e.name).join('、') + '。' : ''), null, false);
    lastData = { room: room.num, floor: room.floor, isolated: step.only !== false, devices: vis.map(e => e.name) };
    return true;
  }

  async function stepShowAll() {
    S.isolateRoom(null, false);
    S.markDoorSpotClear && S.markDoorSpotClear();
    S.clearHighlight(); S.clearRoute && S.clearRoute();
    S.setFocus(0);
    ST.focus = 0;
    ST.mode = 'idle'; S.mode = 'idle';
    finishMode();
    paintFloors();
    if (ST.ducts) S.setDuctsVisible(true);
    ai('回到全楼视角了，刚才藏起来的楼层、房间、设备都放出来了。', null, false);
    return true;
  }

  async function stepView(step) {
    const lv = step.floor || 0;
    ST.focus = lv; S.setFocus(lv); S.clearHighlight(); S.clearRoute && S.clearRoute();
    finishMode(); paintFloors();
    ai(lv ? '切到 ' + lv + ' 楼了。' : '回到全楼视角。', null, false);
    return true;
  }

  async function stepInfo(step) {
    const A = window.BIM.agent;
    const eq = (step && step.target) ? resolveEq(step) : (A.mem.lastPlaced || ST.sel);
    if (eq) {
      const room = M.rooms.find(r => r.id === eq.room);
      showProps({ kind: 'equip', data: eq });
      const r = C.check({ room: room, equip: eq, cx: eq.x, cy: eq.y, others: othersIn(room).filter(e => e !== eq) });
      ST.last = r; ST.last.equip = eq; ST.sel = eq;
      ai('「' + eq.name + '」' + (eq.weight / 1000).toFixed(2) + ' 吨，外形 ' + eq.w.toFixed(2) + '×' + eq.d.toFixed(2) + '×' + eq.h.toFixed(2) +
        ' 米，在 ' + (room ? room.num + ' 室' : '—') + '，安全系数 ' + C.fmt(r.K) + '，这块板最多还能压 ' +
        (r.Pmax_kg / 1000).toFixed(2) + ' 吨。右边是它的属性。', null, false);
      lastData = {
        name: eq.name, weight_t: +(eq.weight / 1000).toFixed(2), size: [eq.w, eq.d, eq.h],
        room: room ? room.num : null, K: C.fmt(r.K), max_t: +(r.Pmax_kg / 1000).toFixed(2), verdict: r.verdict
      };
      return true;
    }
    ST.mode = 'info'; S.mode = 'info';
    setMode('点选构件查看属性', () => finishMode());
    ai('点一下设备、墙体或阀件，右边就出属性。');
    return false;
  }

  /* 只查影响，不动阀门（工具 query_impact 走这条） */
  async function stepImpact(step) {
    const A = window.BIM.agent;
    const room = step.roomRef || (step.room ? A.roomByNum(step.room, step.floor) : null) || A.mem.ctx.room;
    let v = null;
    if (step.valve) v = M.valves.find(x => x.id === step.valve || x.name === step.valve);
    if (!v && room) {
      const cands = M.valves.filter(x => x.room === room.id);
      v = cands.find(x => x.kind === 'main') || cands.find(x => x.kind === 'zone') || cands[0];
    }
    if (!v && A.mem.lastValve) v = A.mem.lastValve;
    if (!v) { ai('要查哪个阀？说个房间号就行，比如「4 楼 405」。'); return false; }
    const im = valveImpact(v);
    showTopo(v, im);
    beginFlowVisual(v, im);
    S.highlightRooms(im.rooms, 0xe08a2b);
    ai('「' + v.name + '」下游会影响 ' + im.rooms.length + ' 个房间、' + im.paths.length +
      ' 条路由。右边列表点一行就能单独高亮。');
    A.commit(step, { valve: v, room: room || null });
    return true;
  }

  /* 报一下场景清单（工具 list_scene 走这条） */
  async function stepScene(step) {
    const A = window.BIM.agent;
    const what = step.what || 'all';
    const rooms = M.rooms.filter(r => r.zone !== 'corr');
    const floors = M.floors.map(f => f.level + '层').join('、');
    const placed = ST.placed.map(e => e.name + '@' + e.room);
    const addedDoors = (M.doors || []).filter(d => d.added);
    const bits = [];
    const vi = S.viewInfo ? S.viewInfo() : null;
    if (what === 'all' || what === 'rooms') {
      bits.push('一共 ' + floors + '，' + rooms.length + ' 个房间');
      const cur = A.mem.ctx.floor;
      const sample = rooms.filter(r => cur == null || r.floor === cur).slice(0, 8).map(r => r.num + ' ' + (r.use || '')).join('、');
      if (sample) bits.push((cur ? cur + ' 楼有 ' : '比如 ') + sample);
    }
    if (what === 'all' || what === 'equipment') {
      bits.push('设备库 ' + (M.equipmentLibrary || []).length + ' 种：' + (M.equipmentLibrary || []).slice(0, 6).map(e => e.name).join('、'));
    }
    if (what === 'all' || what === 'placed') {
      bits.push(placed.length ? '现场已放 ' + placed.length + ' 台：' + placed.slice(-6).join('、') : '现场还没放设备');
    }
    if (what === 'all' || what === 'doors') {
      bits.push(addedDoors.length
        ? '自己开的门 ' + addedDoors.length + ' 扇：' + addedDoors.map(d => d.name + '(' + d.w.toFixed(2) + 'm)').join('、')
        : '还没开过门');
    }
    if (vi) {
      bits.push('现在看的是' + (vi.floor ? vi.floor + ' 楼' : '全楼') + '，镜头朝' + vi.looking + '，屏幕右边是' + vi.rightIs +
        (vi.xray ? '，已开透视' : ''));
    }
    ai(bits.join('；') + '。', null, false);
    const ctxRoom = A.mem.ctx.room;
    lastData = {
      floors: M.floors.map(f => f.level),
      rooms: rooms.length,
      placed: ST.placed.map(e => ({ name: e.name, room: e.room, floor: e.floor })),
      doors: addedDoors.map(d => ({ name: d.name, width: d.w, height: d.h, floor: d.floor })),
      context: { room: ctxRoom ? ctxRoom.num : null, floor: A.mem.ctx.floor || null, device: A.mem.lastPlaced ? A.mem.lastPlaced.name : null },
      view: vi ? { floor: vi.floor, looking: vi.looking, rightIs: vi.rightIs } : null
    };
    return true;
  }

  /* ---------------- 设备四周净距 ---------------- */
  /* 模型一改（放/挪/删/换），之前的净距虚框就过期了，直接收掉 */
  function dropClr() {
    if (S.clearClearance) S.clearClearance();
    ST.lastClr = null;
  }

  /* 净距卡片：四个方向并排，最窄那条顶在最上面 */
  function clrCard(cl) {
    const cls = cl.minV < 0.3 ? 'bad' : (cl.minV < 0.7 ? 'warn' : 'ok');
    const cell = (cn, s) => {
      const c2 = s.v < 0.05 ? ' class="bad"' : (s.v < 0.7 ? ' class="warn"' : '');
      return '<div><i>' + cn + '</i><b' + c2 + '>' + (s.v < 0.05 ? '贴死' : s.v.toFixed(2) + ' m') + '</b></div>';
    };
    return '<div class="res ' + cls + '">' +
      '<div class="res-top"><span class="k">' + cl.minV.toFixed(2) + '</span><span class="kl">最窄一侧 · ' +
      cl.minCn + '</span><span class="tag">' + C.clearWord(cl.minV) + '</span></div>' +
      '<div class="res-grid">' + cell('左侧', cl.west) + cell('右侧', cl.east) +
      cell('南侧', cl.south) + cell('北侧', cl.north) + '</div>' +
      '<div class="res-adv"><s>·</s> 最窄处卡在' + cl.minWho + '。<br>' +
      '<s>·</s> 正面朝' + cl.faceCn + '，检修面 ' + cl.faceV.toFixed(2) + ' m，' +
      C.clearWord(cl.faceV, true) + '。<br>' +
      '<s>·</s> 模型楼板上已经用虚线框把四周范围标出来了。</div></div>';
  }

  /* 量设备四周的净距，并在模型上画虚框标出来 */
  async function stepClearance(step) {
    const A = window.BIM.agent;
    const eq = resolveEq(step);
    if (!eq) { ai('先放一台设备，或者点一下要量的那台。'); return false; }
    const room = step.roomRef || M.rooms.find(r => r.id === eq.room);
    if (!room) { ai('这台设备不在任何房间里，量不了四周净距。'); return false; }
    /* 打通以后按合并的那块板量：中间那道墙没了，就不能再拿单间边界当墙 */
    const space = spaceOf(room).space;
    const cl = C.clearance({ room: space, equip: eq, x: eq.x, y: eq.y, others: othersIn(space) });
    if (!cl) { ai('这台设备的净距量不出来，换个位置再试。'); return false; }

    const drawn = step.show !== false;
    if (drawn && S.showClearance) S.showClearance(space, eq, cl);
    focusSoft(space, { tight: true });   // 一定要拉近，否则虚框上的米数看不清
    ST.lastClr = { room: room, eq: eq, cl: cl };
    A.mem.lastClr = cl;

    const one = s => (s.v < 0.05 ? '0（' + s.who + '）' : s.v.toFixed(2) + ' m');
    const narrow = cl.minV < 0.3 ? '，这块基本卡住了，人过不去'
      : (cl.minV < 0.7 ? '，只能侧着身子过' : '');
    ai('「' + eq.name + '」四周的净距：左侧 ' + one(cl.west) + '、右侧 ' + one(cl.east) +
      '、南侧 ' + one(cl.south) + '、北侧 ' + one(cl.north) + '。' +
      '最窄的是' + cl.minCn + ' ' + cl.minV.toFixed(2) + ' m（' + cl.minWho + '）' + narrow + '；' +
      '正面朝' + cl.faceCn + '，检修面还有 ' + cl.faceV.toFixed(2) + ' m，' + C.clearWord(cl.faceV, true) +
      (drawn ? '。模型上已经用虚框标出来了。' : '。'),
      clrCard(cl));

    chips([
      { label: '收掉虚框', fn: () => { if (S.clearClearance) S.clearClearance(); toast('虚框收起来了'); } },
      { label: '看计算书', fn: () => openCalc() },
      { label: '挪个位置', fn: () => send('把' + eq.name + '挪一下') }
    ]);

    lastData = {
      device: eq.name, room: room.num,
      clearance_m: {
        west: +cl.west.v.toFixed(2), east: +cl.east.v.toFixed(2),
        south: +cl.south.v.toFixed(2), north: +cl.north.v.toFixed(2)
      },
      narrowest: { side: cl.minCn, m: +cl.minV.toFixed(2), against: cl.minWho },
      front: { side: cl.faceCn, m: +cl.faceV.toFixed(2) },
      drawn: drawn
    };
    return true;
  }

  async function stepAsk(step) {
    const A = window.BIM.agent;
    if (step.kind === 'capacity') {
      const r = A.mem.lastResult, eq = A.mem.lastPlaced;
      if (!r || !eq) { ai('先放一台设备，我再算这间房还能放几台。'); return false; }
      const remainT = r.Pmax_kg / 1000, per = eq.weight / 1000;
      const n = Math.floor(remainT / Math.max(per, 1e-6));
      ai(r.room.num + ' 室这块板按 1.3 倍余量还能再加 ' + remainT.toFixed(2) + ' 吨，' +
        (n >= 1 ? '也就是还能放 ' + n + ' 台「' + eq.name + '」。' : '也就是说这种 ' + per.toFixed(2) + ' 吨的设备已经放不下了。'));
      return true;
    }
    ai('这句我还接不住，换个说法？我能算承重、开门、查阀门影响。');
    return false;
  }

  /* 智能体没给出步骤时的兜底（只说房间号/问帮助等） */
  function fallbackSay(text) {
    const p = N.parse(text);
    if (p.intent === 'view') {
      S.setFocus(0); S.clearHighlight(); ST.focus = 0; paintFloors();
      finishMode(); ai('已回到全楼视角。'); return;
    }
    if (p.intent === 'help') {
      ai('我能做三件事：放设备算承重、在墙上开门判断碰撞、查阀门关掉会影响哪些房间。也能接着上文说「再放一台」「挪到靠里」。'); return;
    }
    if (p.room) {
      S.focusRoom(p.room);
      S.highlightRoom(p.room);
      ST.focus = p.room.floor; paintFloors();
      window.BIM.agent.mem.ctx.room = p.room;
      window.BIM.agent.mem.ctx.floor = p.room.floor;
      ai(p.room.num + ' 室，' + p.room.use + '，' + p.room.area + ' 平方。要放设备还是开门？');
      chips([
        { label: '放设备', fn: () => send('把设备放到' + p.room.num + '室') },
        { label: '开个门', fn: () => send('在' + p.room.num + '室左边开个门') }
      ]);
      return;
    }
    ai('没听清，再说一次？比如「把空压机放到 2 楼 202」。');
  }

  /* ---------------- 楼层：全部收进模型树 ----------------
     顶部那排 F1..F5 药丸已经去掉，切楼层只剩两个入口：模型树的楼层节点、
     或者对话里说「看 3 楼」。下面两个函数名保留，调用点不用改。 */
  function paintFloors() {
    const T = window.BIM.tree;
    if (T && T.setCurrent) T.setCurrent(ST.focus ? 'f' + ST.focus : 'root');
  }

  function buildFloors() {
    const T = window.BIM.tree;
    if (T && T.rebuild) T.rebuild();
  }

  /* 把「流向 / 吊顶 / 家具」三个按钮的状态和真实状态对齐
     （工具栏上已经没有这三个开关了，这里只负责把状态同步给 ST，
       尤其是流向打开时会自动收起吊顶，不同步按钮会骗人） */
  function paintDeco() {
    const d = window.BIM.detail;
    const on = (d && d.on) || {};
    ST.flow = !!on.flow;
    ST.flowOn = !!on.flow;
  }

  /* ---------------- 工具栏（画面底部居中） ---------------- */
  const ICON = {
    reset: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
    tree: '<svg viewBox="0 0 24 24"><path d="M12 3v5"/><path d="M5 21v-4"/><path d="M19 21v-4"/><path d="M12 8H5v9"/><path d="M12 8h7v9"/><rect x="9.5" y="2.5" width="5" height="3.4" rx=".8"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/></svg>',
    equip: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="11" rx="1.5"/><path d="M7 7V5h6v2"/><path d="M7 12h4"/></svg>',
    pipe: '<svg viewBox="0 0 24 24"><path d="M4 20v-6a2 2 0 0 1 2-2h6"/><path d="M12 12V8"/><path d="M9 4h6v4H9z"/><path d="M4 17h0"/><circle cx="4" cy="20" r="1.4"/></svg>'
  };

  /* ---------------- 管线按钮 + 悬浮图层开关 ----------------
     用户要的是"点一下就在当前画面里看管线，楼板自己变半透明，
     鼠标一悬停还能挑要看哪一层管子"。所以：
       · 点击 = 开/关（跟着当前聚焦层走；全楼视角才看整栋）
       · 悬停 = 弹出图层开关（主干立管/层进线/箱到桥架/走廊干线/墙内下引/房间支线
                + 按分路种类过滤：照明/插座/动力）
     开关状态存在 ST.pipeLayer / ST.pipeKind 里，切楼层、重建电气都不会被重置。 */
  const PIPE_LAYERS = [
    { k: 'trunk', n: '主干立管' }, { k: 'feed', n: '层进线' }, { k: 'out', n: '箱到桥架' },
    { k: 'corridor', n: '走廊干线' }, { k: 'drop', n: '墙内下引' }, { k: 'room', n: '房间支线' }
  ];
  const PIPE_KINDS = [{ k: 'light', n: '照明' }, { k: 'socket', n: '插座' }, { k: 'power', n: '动力' }];
  function pipeState() {
    if (!ST.pipeLayer) { ST.pipeLayer = {}; PIPE_LAYERS.forEach(x => { ST.pipeLayer[x.k] = true; }); }
    if (!ST.pipeKind) { ST.pipeKind = {}; PIPE_KINDS.forEach(x => { ST.pipeKind[x.k] = true; }); }
    return { layer: ST.pipeLayer, kind: ST.pipeKind };
  }
  function applyPipeFilter() {
    const s = pipeState();
    if (window.BIM.scene && S.conduitFilter) {
      S.conduitFilter({ layer: s.layer, kind: s.kind });
      S.rebuildConduitFilter && S.rebuildConduitFilter();
    }
  }
  function togglePipe(btn) {
    const on = !(window.BIM.scene && S.conduitsOn && S.conduitsOn());
    if (on) {
      const f = S.focus || 0;
      window.BIM.mcp.call('show_conduits', f ? { scope: 'floor', floor: f } : { scope: 'all' });
      applyPipeFilter();
      toast(f ? ('只看 ' + f + 'F 的电管，楼板压到半透明')
        : '看整栋楼的电管，楼体压到 20% 半透明');
    } else {
      window.BIM.mcp.call('show_conduits', { scope: 'off' });
      toast('收起管线');
    }
    if (btn) btn.classList.toggle('on', on);
    paintPipePop();
    return on;
  }
  let pipePop = null, pipeHideT = 0;
  function paintPipePop() {
    if (!pipePop) return;
    const s = pipeState();
    pipePop.querySelectorAll('[data-lay]').forEach(b => {
      b.classList.toggle('off', !s.layer[b.dataset.lay]);
    });
    pipePop.querySelectorAll('[data-knd]').forEach(b => {
      b.classList.toggle('off', !s.kind[b.dataset.knd]);
    });
  }
  function buildPipePop(bar) {
    pipePop = document.createElement('div');
    pipePop.className = 'pipe-pop';
    pipePop.innerHTML =
      '<div class="pp-t">管线图层<i>关掉的层不画，其余照旧</i></div>' +
      '<div class="pp-row">' + PIPE_LAYERS.map(x =>
        '<button data-lay="' + x.k + '" class="on">' + x.n + '</button>').join('') + '</div>' +
      '<div class="pp-t">按分路</div>' +
      '<div class="pp-row">' + PIPE_KINDS.map(x =>
        '<button data-knd="' + x.k + '" class="on">' + x.n + '</button>').join('') + '</div>' +
      '<div class="pp-row pp-all"><button data-all="1">全部显示</button></div>';
    bar.appendChild(pipePop);
    pipePop.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const s = pipeState();
      if (b.dataset.all) {
        PIPE_LAYERS.forEach(x => { s.layer[x.k] = true; });
        PIPE_KINDS.forEach(x => { s.kind[x.k] = true; });
      } else if (b.dataset.lay) {
        s.layer[b.dataset.lay] = !s.layer[b.dataset.lay];
      } else if (b.dataset.knd) {
        s.kind[b.dataset.knd] = !s.kind[b.dataset.knd];
      }
      e.stopPropagation();
      paintPipePop();
      applyPipeFilter();
    });
    /* 悬停才出来：鼠标离开按钮和浮层都给它 260 ms 的回旋余地，
       否则从按钮滑到浮层中间那几像素的缝里就闪没了 */
    const show = () => { clearTimeout(pipeHideT); pipePop.classList.add('show'); paintPipePop(); };
    const hide = () => { clearTimeout(pipeHideT); pipeHideT = setTimeout(() => pipePop.classList.remove('show'), 260); };
    pipePop.addEventListener('mouseenter', show);
    pipePop.addEventListener('mouseleave', hide);
    pipePop._show = show; pipePop._hide = hide;
  }

  function buildToolbar() {
    const bar = $('toolbar');
    bar.innerHTML = '';
    const items = [
      {
        k: 'reset', n: '复位', fn: () => {
          S.isolateRoom(null, false);
          S.setFocus(0);
          S.clearHighlight();
          endFlowVisual();
          finishMode();
          ST.focus = 0;
          paintFloors();
          toast('回到全楼视角');
        }
      },
      {
        k: 'tree', n: '模型树', fn: () => {
          const T = window.BIM.tree;
          if (T) T.toggle();
        }
      },
      {
        k: 'info', n: '属性', fn: () => {
          if (ST.sel) { showProps({ kind: 'equip', data: ST.sel }); return; }
          ST.mode = 'info'; S.mode = 'info';
          setMode('点选构件查看属性', () => { finishMode(); });
          toast('点一下设备、墙体、门或柱梁');
        }
      },
      { k: 'pipe', n: '管线', hover: true, fn: (b) => togglePipe(b) },
      { k: 'equip', n: '设备', fn: openEquip }
    ];
    items.forEach(it => {
      const b = document.createElement('button');
      b.dataset.k = it.k;
      b.innerHTML = ICON[it.k] + '<span>' + it.n + '</span>';
      b.onclick = () => it.fn(b);
      if (it.k === 'pipe') {
        b.classList.toggle('on', !!(window.BIM.scene && S.conduitsOn && S.conduitsOn()));
        b.addEventListener('mouseenter', () => { if (pipePop && pipePop._show) pipePop._show(); });
        b.addEventListener('mouseleave', () => { if (pipePop && pipePop._hide) pipePop._hide(); });
      }
      bar.appendChild(b);
    });
    buildPipePop(bar);
  }

  /* ---------------- 导入自己的 IFC ---------------- */
  function importIfc(file) {
    const rd = new FileReader();
    toast('正在读 IFC，文件大点要等几秒…', 8000);
    rd.onload = () => {
      try {
        const t0 = performance.now();
        const model = window.BIM.ifc.parse(String(rd.result));
        if (!model.rooms.length) throw new Error('没读到房间，可能不是建筑模型');

        ST.placed = []; ST.last = null; ST.sel = null; ST.equipId = 1;
        ST.mode = 'idle'; ST.pending = null;
        ST.doorAsked = {};
        window.BIM_MODEL = model;
        M = model;
        N.setModel(model);
        window.BIM.routes.prepare(model);
        window.BIM.routes.buildTree(model);
        S.setModel(model);
        buildFloors();
        ST.focus = 0; paintFloors();
        ['pProps', 'pCalc', 'pTopo'].forEach(id => { $(id).hidden = true; });
        $('modeChip').hidden = true;

        const ms = Math.round(performance.now() - t0);
        ai('模型换好了：' + model.meta.name + '，' + model.floors.length + ' 层、' + model.rooms.length +
          ' 个房间。放设备、开门、查阀门现在都按这份模型算。',
          '<div class="res ok"><div class="res-top"><span class="k">已导入</span><span class="tag">' + (ms / 1000).toFixed(1) + ' s</span></div>' +
          '<div class="res-grid"><div><i>墙</i><b>' + model.walls.length + ' 面</b></div><div><i>风管</i><b>' + model.ducts.length + ' 段</b></div></div>' +
          '<div class="res-grid"><div><i>阀件</i><b>' + model.valves.length + ' 个</b></div><div><i>门</i><b>' + model.doors.length + ' 樘</b></div></div>' +
          (model.rooms.some(r => r.slab.thk === 0.18) ? '' : '') + '</div>');

        const r0 = model.rooms.filter(r => r.zone !== 'corr')[0] || model.rooms[0];
        if (r0) chips([
          { label: '放台设备到 ' + r0.num, fn: () => send('把空压机放到' + r0.num + '室') },
          { label: '在 ' + r0.num + ' 开个门', fn: () => send('在' + r0.num + '室左边开个门') },
          { label: '回到示例模型', fn: () => location.reload() }
        ]);
      } catch (err) {
        ai('这个文件没读出来：' + (err && err.message ? err.message : '格式不对') + '。换一个 .ifc 文件试试？', null);
      }
    };
    rd.onerror = () => ai('文件读不进来，可能太大了。', null);
    rd.readAsText(file);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    S.init($('cv'));
    // 医院那批重型设备并进型号库，放置/校核/净矩全部复用现有链路
    if (window.BIM.detail && window.BIM.detail.mergeLibrary) window.BIM.detail.mergeLibrary(M);
    // 墙里那些线管要先算出来：开窗/开门/拆墙的校核都要问它，晚一步就会漏判
    if (window.BIM.elec) {
      try {
        window.BIM.elec.build();
        /* 配电箱是真装在墙上的设备，不是"电气视图的附属物" ——
           以前只在 showConduits(true) 里才建，结果平时看楼层根本见不到箱子，
           门洞压在它身上被拦下来时用户眼前什么都没有。
           这里电气数据一算好就把它挂上去，之后只跟楼层聚焦走。 */
        S.rebuildPanels();
      } catch (e) { console.warn('elec build failed', e && e.message); }
    }
    S.onPick = onPick;
    TTS.init();
    buildFloors();
    buildToolbar();
    // 模型树：树上点节点 → 定位 + 右侧属性；三维里点构件 → 树上跟过去
    // 顶部楼层按钮已经去掉，切楼层只剩树这一个入口，所以默认就把它摊开
    const TR = window.BIM.tree;
    if (TR) {
      TR.build();
      TR.open(true);
      const q = $('treeQ');
      if (q) q.addEventListener('input', e => TR.setQuery(e.target.value));
    }
    // 真实感层（吊顶 / 家具 / 流向）自己改了状态要回头通知工具栏
    const dd = window.BIM.detail;
    if (dd) {
      dd.notify = (m, k) => { toast(m, 2600); paintDeco(); };
      dd.onChange = paintDeco;
    }
    S.setXray(ST.xray);
    S.setDuctsVisible(true);

    $('btnMic').onclick = toggleMic;
    const vd = $('btnVoiceDone');
    if (vd) vd.onclick = finishVoice;
    $('btnAI').onclick = openAI;
    $('llmSave').onclick = saveAI;
    $('llmTest').onclick = testAI;
    $('llmModels').onclick = loadModels;
    $('llmEp').addEventListener('keydown', e => { if (e.key === 'Enter') saveAI(); });
    document.querySelectorAll('#llmPresets button').forEach(btn => {
      btn.onclick = () => {
        $('llmEp').value = btn.dataset.ep;
        $('llmModel').value = btn.dataset.model;
        if (btn.dataset.key && !$('llmKey').value.trim()) $('llmKey').value = btn.dataset.key;
        showDiag(null);
        toast('已填好 ' + btn.textContent + '，补上 Key 再点测试连接', 3200);
      };
    });
    $('btnSend').onclick = () => { const v = $('txt').value.trim(); if (v) { $('txt').value = ''; send(v); } };
    $('txt').addEventListener('keydown', e => { if (e.key === 'Enter') { const v = $('txt').value.trim(); if (v) { $('txt').value = ''; send(v); } } });
    const syncSound = () => {
      TTS.on = ST.sound;
      $('btnSound').classList.toggle('off', !ST.sound);
      $('btnSound').title = ST.sound ? '语音播报：开（点一下关掉）' : '语音播报：关（点一下打开）';
    };
    syncSound();                       // 默认关，跟 ST.sound 一致
    $('btnSound').onclick = () => {
      ST.sound = !ST.sound; syncSound();
      if (!ST.sound) {
        TTS.stop();
        // 关键：关播报的同时把闭麦状态一并解除，
        // 否则正在播报时关掉，麦克风还卡在"等播报结束"上
        hush = false; hushUntil = 0; ttsUntil = 0;
        if (listening && rec) { try { rec.start(); } catch (e) { } }
      }
    };
    $('calcDl').onclick = downloadCalc;
    $('fileIfc').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importIfc(f);
    };
    // 工具栏上不再放「导入 / IFC」按钮了，把 .ifc 直接拖到画面里照样能换模型
    const stageEl = $('stage');
    ['dragenter', 'dragover'].forEach(t => stageEl.addEventListener(t, e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }));
    stageEl.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/\.ifc$/i.test(f.name)) importIfc(f);
      else toast('拖进来一个 .ifc 文件才能换模型');
    });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => e.preventDefault());
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
      const id = b.dataset.close;
      $(id).hidden = true;
      if (id === 'pTopo') endFlowVisual();                 // 影响面板一关，流向跟着收
      if (id === 'pCalc') endCalcPlate();                  // 计算书一关，那块蓝板也收掉
      if (id === 'pTree') { const tb = document.querySelector('#toolbar button[data-k="tree"]'); if (tb) tb.classList.remove('on'); }
    });
    $('fileEquip').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          let arr = [];
          const txt = String(rd.result).trim();
          if (txt.startsWith('[') || txt.startsWith('{')) {
            const j = JSON.parse(txt);
            arr = Array.isArray(j) ? j : (j.equipment || []);
          } else {
            arr = txt.split(/\r?\n/).filter(Boolean).map(l => {
              const p = l.split(/[,，\t]/);
              return { name: p[0], weight: +p[1], w: +p[2], d: +p[3], h: +p[4] };
            }).filter(x => x.name && x.weight);
          }
          arr.forEach((x, i) => {
            if (!x.name || !x.weight) return;
            M.equipmentLibrary.push({
              id: 'UP' + i, name: x.name, weight: Math.round(x.weight),
              w: x.w || 1.4, d: x.d || 1.0, h: x.h || 1.5, shape: 'box',
              color: x.color || '#5b8def', note: '上传'
            });
          });
          openEquip();
          toast('已导入 ' + arr.length + ' 台设备');
        } catch (err) { toast('文件格式没看懂，用 JSON 或 CSV'); }
      };
      rd.readAsText(f);
    };

    // 先问本机有没有离线识别（有就直接用它，完全不依赖外网），再申请麦克风
    probeAsr().then(mode => {
      if (mode === 'local') {
        sys('语音：本机离线识别已就绪（' + ((asrInfo && asrInfo.model) || 'vosk') + '），断网也能说话');
      } else if (mode === 'web') {
        sys('语音：本机没有离线模型，暂时用浏览器识别（这需要能访问 Google/微软的识别服务）');
      }
      micPermission().then(st => {
        paintMic();
        if (st === 'granted') { autoStart(); return; }
        if (st === 'prompt' && micPref.auto && !micPref.firstHint) {
          micPref.firstHint = true; saveMicPref();
          setTimeout(() => sys('点一下麦克风允许一次，之后直接说话就行'), 1200);
        }
      });
    });
    paintCtx();
    paintAI();
    autoConnect();
    // 第一次来且没接大模型：提醒一次入口在哪
    let uiPref = {};
    try { uiPref = JSON.parse(localStorage.getItem('aibim.ui.v1') || '{}'); } catch (e) { }
    if (!window.BIM.agent.cfg.on && !uiPref.aiHint) {
      uiPref.aiHint = true;
      try { localStorage.setItem('aibim.ui.v1', JSON.stringify(uiPref)); } catch (e) { }
      setTimeout(() => sys('点右下角「本地理解」可以接上大模型，接上后更会接话和拆步骤'), 1800);
    }

    // 有的浏览器要"用户碰一下"才肯开麦：第一次点击/按键就近开启，不用专门点麦克风
    const wake = ev => {
      if (ev && ev.target && ev.target.closest && ev.target.closest('#btnMic')) return;
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
      if (micState === 'granted' && !listening) startListening(true);
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);

    // 欢迎
    setTimeout(() => {
      ai('我在。可以直接说：把空压机放到 2 楼 202 靠里。');
      chips([
        { label: '空压机放到 2 楼 202 靠里', fn: () => send('把空压机放到2楼202靠里一些') },
        { label: '306 靠走廊开 1.5 米门', fn: () => send('在3楼306靠走廊的位置开一个1.5米宽的门') },
        { label: '关 405 总阀影响谁', fn: () => send('关闭4楼405的阀门会影响哪些房间') },
        { label: '导入自己的 IFC', fn: () => $('fileIfc').click() }
      ]);
      S.setFocus(0);
    }, 320);
  }

  document.addEventListener('DOMContentLoaded', boot);

  /* 给调试/自动化留个口子 */
  /* 把同一套动作登记给工具层：模型、控制台、以后的自动化/MCP 桥都能直接调 */
  if (window.BIM.mcp) {
    const A = window.BIM.agent;
    const kg = v => (v == null || v === '' ? null : Math.round(+v * 1000));   // 工具的"吨" → 内部 kg
    const runTool = async step => {
      step.tool = step.tool || 'mcp';          // 标明"这是工具点名的"，直接执行别等人点
      const st = A.fillStep(step);
      const prev = ST.mute;
      // 循环里一次请求可能连调好几个工具：中间那段别逐条往外说，
      // 最后统一讲一句结论，否则一句话指令会冒出三四条回复。
      ST.mute = loopQuiet ? true : false;
      lastData = null;
      try {
        const ok = await io[st.act](st, { steps: [st] });
        return { ok: ok !== false, say: lastSay, data: lastData };
      } finally {
        ST.mute = prev;
      }
    };
    window.BIM.mcp.bind({
      /* ---- 设备 ---- */
      place_equipment: a => runTool({
        act: 'place', text: '', device: a.device, room: a.room, floor: a.floor,
        count: a.count || 1, pref: a.pref, weight: kg(a.weight), near: a.near,
        /* ★ side 以前在这里被丢掉了 —— 用户说"放到打通后房间的左边"，
           到这一步就没影了，设备永远回中间。打通以后按合并大板的方向必须走这条。 */
        side: a.side || null, sideRel: a.side_rel || null
      }),
      remove_equipment: a => runTool({ act: 'remove', text: '', target: a.target, room: a.room, all: !!a.all }),
      move_equipment: a => runTool({
        act: 'move', text: '', target: a.target, room: a.room, floor: a.floor,
        dir: a.direction, dist: a.distance, pref: a.pref
      }),
      replace_equipment: a => runTool({ act: 'replace', text: '', device: a.device, target: a.target, weight: kg(a.weight) }),
      resize_equipment: a => runTool({
        act: 'resize', text: '', target: a.target, width: a.width, depth: a.depth,
        height: a.height, weight: kg(a.weight)
      }),
      query_equipment: a => runTool({ act: 'info', text: '', target: a.target }),
      query_clearance: a => runTool({ act: 'clearance', text: '', target: a.target, room: a.room, show: a.show !== false }),
      list_devices: a => runTool({ act: 'devices', text: '', room: a.room, floor: a.floor }),
      find_rooms_for_equipment: a => runTool({ act: 'findroom', text: '', device: a.device, floor: a.floor, want: a.count || 3 }),
      suggest_positions: a => runTool({ act: 'suggest', text: '', device: a.device, room: a.room, floor: a.floor, want: a.count || 3, apply: a.apply !== false }),
      show_properties: () => runTool({ act: 'info', text: '' }),
      query_capacity: () => runTool({ act: 'ask', kind: 'capacity', text: '' }),

      /* ---- 门 ---- */
      open_door: a => runTool({
        act: 'door', text: '', room: a.room, floor: a.floor, side: a.side,
        width: a.width, height: a.height, pref: a.pref
      }),
      open_window: a => runTool({
        act: 'window', text: '', room: a.room, floor: a.floor, side: a.side,
        width: a.width, height: a.height, sill: a.sill, pref: a.pref
      }),
      remove_window: a => runTool({ act: 'windowoff', text: '', window: a.window, room: a.room, floor: a.floor }),
      move_window: a => runTool({
        act: 'winmove', text: '', window: a.window, room: a.room, floor: a.floor,
        dir: a.direction, dist: a.distance != null ? Math.abs(+a.distance) : null
      }),
      remove_door: a => runTool({ act: 'dooroff', text: '', door: a.door, room: a.room, floor: a.floor, side: a.side }),
      move_door: a => runTool({
        act: 'doormove', text: '', door: a.door, along: a.along, dist: a.distance,
        side: a.side, room: a.room, floor: a.floor
      }),
      resize_door: a => runTool({
        act: 'doorsize', text: '', door: a.door, width: a.width, height: a.height, room: a.room, floor: a.floor
      }),
      query_window: a => runTool({ act: 'wininfo', text: '', window: a.window, room: a.room, floor: a.floor }),
      /* 窗改尺寸：以前只有"开一扇新的"，点了某扇再想改大小是死路 */
      resize_window: a => runTool({
        act: 'winsize', text: '', window: a.window, width: a.width, height: a.height,
        sill: a.sill, room: a.room, floor: a.floor
      }),
      /* 选中一扇门/窗：高亮 + 写进上下文，之后"这扇门/这扇窗"就指它 */
      select_opening: a => runTool({
        act: 'opening', text: '', kind: a.kind, name: a.name, room: a.room,
        side: a.side, floor: a.floor
      }),
      query_door: a => runTool({ act: 'doorinfo', text: '', door: a.door, room: a.room }),
      list_doors: a => runTool({ act: 'doors', text: '', room: a.room, floor: a.floor }),

      /* ---- 墙：打穿 / 拆墙 ---- */
      open_passage: a => runTool({
        act: 'passage', text: '', room: a.room, floor: a.floor, to: a.to,
        /* 用户说的是"这两间打通"（给了隔壁房号）时，墙只能是两间共用的那一面。
           模型经常顺手再猜一个 side，猜错就变成"打南外墙被拒绝"这种答非所问。
           所以只要 to 在，side 一律不采纳。 */
        side: a.to ? undefined : a.side,
        width: a.width, height: a.height, mode: a.mode === 'cut' ? 'cut' : 'demolish'
      }),

      /* ---- 电路 ---- */
      query_circuits: a => runTool({
        act: 'circuit', text: '', room: a.room, floor: a.floor, scope: a.scope,
        mainSwitch: a.main_switch === true
      }),
      toggle_circuit: a => runTool({
        act: 'circuitset', text: '', circuit: a.circuit, room: a.room, floor: a.floor,
        circuitNo: a.circuit_no, circuitSub: a.circuit_sub, kind: a.kind,
        action: a.action === 'on' ? 'on' : 'off',
        mainSwitch: a.main_switch === true, scope: a.main_switch === true ? 'floor' : undefined
      }),
      query_conduits: a => runTool({ act: 'conduits', text: '', room: a.room, floor: a.floor, side: a.side }),
      focus_floor: a => runTool({ act: 'floorview', text: '', floor: a.floor == null ? 0 : a.floor }),
      view_circuit: a => runTool({
        act: 'circview', text: '', circuit: a.circuit, room: a.room, floor: a.floor,
        circuitNo: a.circuit_no, circuitSub: a.circuit_sub, kind: a.kind
      }),
      show_conduits: a => runTool({ act: 'conduitsview', text: '', scope: a.scope, floor: a.floor }),

      /* ---- 视图 / 拓扑 ---- */
      focus_view: a => runTool({
        act: 'focus', text: '', room: a.room, floor: a.floor, device: a.device,
        only: a.only_this !== false
      }),
      show_all: () => runTool({ act: 'showall', text: '' }),
      set_view: a => runTool({ act: 'view', text: '', floor: a.floor == null ? 0 : a.floor }),
      list_scene: a => runTool({ act: 'scene', text: '', what: a.what || 'all' }),
      toggle_valve: a => runTool({ act: 'valve', text: '', room: a.room, floor: a.floor, valve: a.valve, action: a.action === 'open' ? 'open' : 'close' }),
      query_impact: a => runTool({ act: 'impact', text: '', room: a.room, valve: a.valve }),
      undo_last: () => runTool({ act: 'undo', text: '' })
    });
  }

  window.BIM.app = {
    state: ST, model: () => M, send: send, impact: v => valveImpact(v), tools: () => (window.BIM.mcp || {}).tools,
    /* 调试/自动化用的直入口：绕开对话，直接落一个位置、直接改门 */
    placeAt: (room, dev, x, y, ob) => commitPlaceAt(room, dev, x, y, ob),
    /* 自动化/调试：只算落点和朝向，不落位（与语音路径同一套算法） */
    spotFor: (room, dev, pref) => bestSpotFor(room, dev, pref, null),
    rotOf: (room, dev, x, y) => C.rotOf({ x: x, y: y, room: room.id, rot: null, w: dev.w, d: dev.d }),
    widenDoor: (room, door, w, h) => doWidenDoor(room, door, w, h),
    /* 模型树回调：树只管定位，属性和状态归主控管，免得两套面板打架 */
    onTreePick: hit => { if (hit) showProps(hit); },
    onTreeFloor: lv => {
      ST.focus = lv;
      finishMode();
      paintFloors();
    },
    voice: {
      mode: () => asrMode,
      force: v => { asrMode = v; },                       // 测试用：强制走某条通道
      state: () => ({ listening: listening, sid: asrSid, text: asrText, heard: heardAny, last: lastVoice, armed: !!voiceTimer, busy: !!busy, mode: asrMode }),
      start: () => startListening(false),
      stop: () => stopListening(),
      finish: () => finishVoice()
    }
  };
})();
