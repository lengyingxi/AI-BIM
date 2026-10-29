/* 同源转发验收：页面 + /llm 转发走同一个端口，浏览器不发预检 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PY = 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const ROOT = path.join(__dirname, '..');
const UP = 8061;          // 假上游
const WEBPORT = 8830;     // 同源站点

const seen = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const send = (obj, code) => {
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
      res.end(buf);
    };
    if (req.headers.authorization !== 'Bearer sk-up') return send({ error: { message: 'Invalid token' } }, 401);
    if (req.url === '/v1/models' || req.url === '/models') {
      return send({ object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }, { id: 'deepseek-chat' }] });
    }
    if (req.url === '/v1/chat/completions') {
      return send({ choices: [{ message: { content: JSON.stringify({ reply: '从私域网关来的。', steps: [{ act: 'place', device: '空气压缩机', room: '202', pref: 'inner' }], ctx: { room: '202' } }) } }] });
    }
    return send({ error: { message: 'not found' } }, 404);
  });
});

(async () => {
  await new Promise(r => mock.listen(UP, '127.0.0.1', r));

  const srv = spawn(PY, [path.join(__dirname, 'serve.py'), '--target', `http://127.0.0.1:${UP}/v1`, '--key', 'sk-up', '--port', String(WEBPORT)], { stdio: 'ignore' });
  await sleep(1600);

  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const preflights = [];
  p.on('request', r => { if (r.method() === 'OPTIONS') preflights.push(r.url()); });

  await p.goto(`http://127.0.0.1:${WEBPORT}/index.html`, { waitUntil: 'networkidle2' });
  await sleep(1400);
  const ok = (n, c, e) => console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : ''));

  console.log('\n【1】同源站点 + 转发');
  await p.evaluate(() => document.getElementById('btnAI').click());
  await p.evaluate(() => [...document.querySelectorAll('#llmPresets button')].find(b => /本机直连/.test(b.textContent)).click());
  await sleep(400);
  const ep = await p.evaluate(() => document.getElementById('llmEp').value);
  ok('预设填成相对地址 /llm/v1', ep === '/llm/v1', ep);

  console.log('\n【2】拉模型列表');
  await p.evaluate(() => document.getElementById('llmModels').click());
  await sleep(900);
  const list = await p.evaluate(() => ({
    n: document.querySelectorAll('#llmModelList button').length,
    names: [...document.querySelectorAll('#llmModelList button')].map(b => b.textContent)
  }));
  ok('拿到 3 个模型', list.n === 3, JSON.stringify(list.names));
  if (list.n) {
    await p.evaluate(() => [...document.querySelectorAll('#llmModelList button')].find(b => /gpt-4o-mini/.test(b.textContent)).click());
    await sleep(400);
    ok('点选后填进模型名', (await p.evaluate(() => document.getElementById('llmModel').value)) === 'gpt-4o-mini');
  } else {
    const diag = await p.evaluate(() => document.getElementById('llmDiag').innerText);
    ok('点选后填进模型名', false, '模型列表为空：' + diag.replace(/\n/g, ' | ').slice(0, 120));
  }

  console.log('\n【3】测试连接');
  await p.evaluate(() => document.getElementById('llmTest').click());
  await sleep(1500);
  const t = await p.evaluate(() => ({ chip: document.getElementById('aiTxt').innerText, diag: document.getElementById('llmDiag').innerText.slice(0, 120), cls: document.getElementById('llmDiag').className }));
  ok('连通并切到大模型', /大模型/.test(t.chip), t.chip);
  ok('诊断显示相对地址与 200', /\/llm\/v1\/chat\/completions/.test(t.diag) && /200/.test(t.diag), t.diag.replace(/\n/g, ' | '));

  console.log('\n【4】Key 由服务端注入');
  ok('上游收到注入的 Key', seen.some(s => s.auth === 'Bearer sk-up'), JSON.stringify(seen.map(s => s.auth)));

  console.log('\n【5】真的用网关规划并落地');
  await p.evaluate(() => document.getElementById('pAI').hidden = true);
  await p.type('#txt', '把空压机放到2楼202靠里');
  await p.keyboard.press('Enter');
  await sleep(2200);
  const run = await p.evaluate(() => ({
    src: BIM._lastPlan && BIM._lastPlan.source,
    placed: BIM.app.state.placed.length,
    ai: [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | ').slice(0, 60)
  }));
  ok('走网关并放下设备', run.src === 'llm' && run.placed === 1, JSON.stringify(run));

  console.log('\n【6】全程没有跨域预检');
  ok('浏览器未发出 OPTIONS', preflights.length === 0, JSON.stringify(preflights));

  console.log('\n错误数:', errs.length);
  errs.slice(0, 5).forEach(e => console.log('   ! ' + e));

  await b.close();
  srv.kill();
  mock.close();
})();
