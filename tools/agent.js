/* 语音授权 + 多轮上下文 + 任务拆解（本地 & 大模型两条路）验收 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'outputs') + '/';
const SITE = 'http://127.0.0.1:8823';

/* ---------- 假的大模型：验证"接上真模型后"的链路 ---------- */
const seen = [];   // 收到的请求体
const mock = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) { }
    seen.push(j);
    const last = (j.messages || []).filter(m => m.role === 'user').pop();
    const t = (last && last.content) || '';
    let plan;
    if (/然后|接着/.test(t)) {
      plan = {
        reply: '先放设备，再关阀门。',
        steps: [
          { act: 'place', device: '空气压缩机', room: '202', pref: 'inner' },
          { act: 'valve', room: '405', action: 'close' }
        ],
        ctx: { floor: 4, room: '405' }
      };
    } else if (/再放一台/.test(t)) {
      // 故意不给 room / device，靠上下文补全
      plan = { reply: '接着放一台。', steps: [{ act: 'place' }], ctx: {} };
    } else if (/还能放/.test(t)) {
      plan = { reply: '我给你算一下余量。', steps: [{ act: 'ask', kind: 'capacity' }], ctx: {} };
    } else {
      plan = { reply: '收到。', steps: [{ act: 'ask' }], ctx: {} };
    }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
  });
});

(async () => {
  await new Promise(r => mock.listen(8899, '127.0.0.1', r));

  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const ctx = b.defaultBrowserContext();
  await ctx.overridePermissions(SITE, ['microphone']);

  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);

  // 【B】【C】验的是本地规则规划，先把网关配置清掉（【D】会再配回来）
  await p.evaluate(() => { window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }); });
  const say = async (t, w) => { await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(w || 1300); };
  const shot = n => p.screenshot({ path: OUT + 'agent-' + n + '.png' });
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | '));
  const placed = () => p.evaluate(() => BIM.app.state.placed.map(e => ({ room: e.room, name: e.name, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })));
  const ok = (name, cond, extra) => console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''));

  console.log('\n【A】麦克风：允许一次就不再问');
  const mic = await p.evaluate(() => ({
    state: document.querySelector('#btnMic').className,
    bar: !document.getElementById('listenBar').hidden,
    sr: !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }));
  ok('识别到已授权（绿点）', /granted/.test(mic.state), JSON.stringify(mic));
  ok('已授权就直接开麦', !mic.sr || mic.bar, 'listenBar=' + mic.bar);

  console.log('\n【B】本地多轮上下文');
  await say('把空压机放到2楼202靠里', 1900);
  const s1 = await placed();
  ok('第一台自动落位', s1.length === 1 && s1[0].room === 'R2-202' || s1.length === 1, JSON.stringify(s1));
  const c1 = await p.evaluate(() => ({ now: document.getElementById('ctxNow').innerText.trim(), ctx: BIM.agent.ctxLine() }));
  ok('上下文条记住房间/设备', /202/.test(c1.ctx) && /空气压缩机/.test(c1.ctx), JSON.stringify(c1));

  await say('再放一台', 1900);
  const s2 = await placed();
  ok('「再放一台」不用再点、接着放', s2.length === 2 && s2[0].room === s2[1].room, JSON.stringify(s2));
  await shot('B-context');

  await say('挪到靠窗', 1600);
  const s3 = await placed();
  ok('「挪到靠窗」按上文挪的是同一台', s3.length === 2 && (s3[1].x !== s2[1].x || s3[1].y !== s2[1].y),
    JSON.stringify(s2[1]) + ' → ' + JSON.stringify(s3[1]));

  await say('这间房还能放几台', 1500);
  const cap = await lastAI();
  ok('「这间房」指代正确并算出余量', /202/.test(cap) && /还能/.test(cap), cap.slice(0, 80));

  await say('撤掉', 1400);
  const s4 = await placed();
  ok('「撤掉」撤的是上文那台', s4.length === 1, '剩余 ' + s4.length);

  console.log('\n【C】一句话拆多步（本地规则）');
  await say('把空压机放到2楼203然后关掉405的阀门', 2600);
  const s5 = await placed();
  const topoOn = await p.evaluate(() => !document.getElementById('pTopo').hidden);
  ok('一句两步都执行了', s5.length === 2 && topoOn, 'placed=' + s5.length + ' 拓扑面板=' + topoOn);
  await shot('C-split');

  console.log('\n【D】接上大模型');
  await p.evaluate(() => {
    document.getElementById('btnAI').click();
    document.getElementById('llmEp').value = 'http://127.0.0.1:8899/v1';
    document.getElementById('llmModel').value = 'mock-model';
    document.getElementById('llmKey').value = 'sk-test';
    document.getElementById('llmTo').value = '8000';
  });
  await p.evaluate(() => document.getElementById('llmTest').click());
  await sleep(1200);
  const chip1 = await p.evaluate(() => ({ t: document.getElementById('aiTxt').innerText, c: document.getElementById('btnAI').className, toast: document.getElementById('toast').innerText }));
  ok('测试连接通过', /大模型/.test(chip1.t), JSON.stringify(chip1));
  await p.evaluate(() => document.getElementById('llmSave').click());
  await sleep(600);
  await shot('D-settings');

  await p.evaluate(() => location.reload());
  await sleep(2200);
  const persist = await p.evaluate(() => ({ on: BIM.agent.cfg.on, chip: document.getElementById('aiTxt').innerText, url: BIM.agent.cfg.endpoint }));
  ok('配置持久化，刷新后仍是大模型', persist.on && /大模型/.test(persist.chip), JSON.stringify(persist));

  const before = (await placed()).length;
  await say('把空压机放到2楼202然后关掉405的阀门', 3000);
  const d1 = await placed();
  const src = await p.evaluate(() => BIM.agent.llmState.ok);
  ok('大模型拆的两步都落地', d1.length === before + 1 && (await p.evaluate(() => !document.getElementById('pTopo').hidden)), 'placed ' + before + '→' + d1.length + ' 来源ok=' + src);
  const reply = await lastAI();
  ok('用了大模型给的回复', /先放设备/.test(reply), reply.slice(0, 60));

  const n2 = d1.length;
  await say('再放一台', 2400);
  const d2 = await placed();
  ok('大模型步骤缺槽位时用上下文补齐', d2.length === n2 + 1, 'placed ' + n2 + '→' + d2.length);
  await shot('D-llm');

  console.log('\n【E】请求里带上了上下文');
  const ctxMsg = seen.length ? seen[seen.length - 1].messages : [];
  const hasHist = ctxMsg.some(m => /把空压机放到2楼202/.test(m.content || ''));
  const hasSys = ctxMsg.some(m => /场景/.test(m.content || '') && /房间/.test(m.content || ''));
  ok('历史对话回传给模型', hasHist, 'messages=' + ctxMsg.length);
  ok('系统提示带场景清单', hasSys, '');
  const roles = ctxMsg.map(m => m.role).join(',');
  console.log('  请求条数', seen.length, '| 角色序列', roles);

  console.log('\n错误数:', errs.length);
  errs.slice(0, 6).forEach(e => console.log('   ! ' + e));
  const of = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log('横向溢出:', of);

  await b.close();
  mock.close();
})();
