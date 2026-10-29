/* 大模型接入诊断：把常见的"填了 Key 还是连不上"逐条复现并验证自动纠正 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE = 'http://127.0.0.1:8823';
const PORT = 8901, PORT_NOCORS = 8902;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

function json(res, code, obj, cors) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, cors ? CORS : {});
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
const okBody = content => ({ choices: [{ message: { role: 'assistant', content: content } }] });

const hits = [];
const mock = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(b); } catch (e) { }
    hits.push({ url: req.url, auth: req.headers.authorization, body: j });

    if (req.url === '/badkey/chat/completions') {
      if (req.headers.authorization !== 'Bearer sk-good')
        return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, true);
      return json(res, 200, okBody('连接正常'), true);
    }
    if (req.url === '/nopath/chat/completions' || req.url.indexOf('/nopath/') === 0) {
      return json(res, 404, { error: { message: 'Not Found' } }, true);
    }
    if (req.url.indexOf('/plain/') === 0) {          // 只有补上 /v1 才通
      if (req.url === '/plain/v1/chat/completions') return json(res, 200, okBody('{"reply":"好的","steps":[{"act":"ask"}]}'), true);
      return json(res, 404, { error: { message: 'Not Found' } }, true);
    }
    if (req.url === '/nojson/chat/completions') {
      if (j.response_format)
        return json(res, 400, { error: { message: 'response_format is not supported for this model' } }, true);
      return json(res, 200, okBody(JSON.stringify({ reply: '好的', steps: [{ act: 'ask' }] })), true);
    }
    if (req.url === '/maxtok/chat/completions') {
      if (j.max_tokens != null)
        return json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, true);
      return json(res, 200, okBody('{"ok":true,"reply":"好的"}'), true);
    }
    return json(res, 200, okBody(JSON.stringify({
      reply: '好的。', steps: [{ act: 'place', device: '空气压缩机', room: '202', pref: 'inner' }], ctx: { room: '202' }
    })), true);
  });
});

/* 故意不带 CORS 头：模拟服务商不允许浏览器直连 */
const noCors = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(okBody('不该被浏览器读到')));
});

(async () => {
  await new Promise(r => mock.listen(PORT, '127.0.0.1', r));
  await new Promise(r => noCors.listen(PORT_NOCORS, '127.0.0.1', r));

  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(1400);

  const ok = (n, c, e) => console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : ''));
  const cfg = (endpoint, model, key) => p.evaluate((ep, m, k) => {
    BIM.agent.saveCfg({ endpoint: ep, model: m, key: k, timeout: 6000 });
    return BIM.agent.cfg.endpoint;
  }, endpoint, model, key);
  const test = () => p.evaluate(async () => {
    const r = await BIM.agent.test();
    return { r, d: BIM.agent.diag, cfg: BIM.agent.cfg.endpoint };
  });

  console.log('\n【1】贴了完整接口地址（最常见的坑）');
  const ep1 = await cfg(`http://127.0.0.1:${PORT}/v1/chat/completions`, 'mock', 'sk-good');
  const t1 = await test();
  ok('地址被纠正到 /v1 这一层', ep1 === `http://127.0.0.1:${PORT}/v1`, ep1);
  ok('能连上', t1.r.ok, JSON.stringify(t1.r).slice(0, 90));
  ok('实际请求地址正确', t1.d.url === `http://127.0.0.1:${PORT}/v1/chat/completions`, t1.d.url);

  console.log('\n【2】少写协议头 / 结尾多斜杠');
  const ep2 = await cfg(`127.0.0.1:${PORT}/v1///`, 'mock', 'sk-good');
  const t2 = await test();
  ok('自动补 http:// 并去掉多余斜杠', ep2 === `http://127.0.0.1:${PORT}/v1`, ep2);
  ok('能连上', t2.r.ok, t2.r.msg || '');

  console.log('\n【3】Key 写错');
  await cfg(`http://127.0.0.1:${PORT}/badkey`, 'mock', 'sk-wrong');
  const t3 = await test();
  ok('报 401', /401/.test(t3.r.err || ''), t3.r.err);
  ok('原因是 Key', /Key/.test(t3.r.hint || ''), t3.r.hint);
  ok('带出对方原话', /Incorrect API key/.test(t3.d.body || ''), (t3.d.body || '').slice(0, 60));

  console.log('\n【4】地址写到错的路径');
  await cfg(`http://127.0.0.1:${PORT}/nopath`, 'mock', 'sk-good');
  const t4 = await test();
  ok('报 404 并指向 /v1', /404/.test(t4.r.err || '') && /\/v1/.test(t4.r.hint || ''), JSON.stringify(t4.r));

  console.log('\n【4b】地址漏了 /v1 —— 自动补一层');
  await cfg(`http://127.0.0.1:${PORT}/plain`, 'mock', 'sk-good');
  const t4b = await test();
  ok('自动补 /v1 后连通', t4b.r.ok, t4b.r.msg || '');
  ok('提示补了 /v1', /\/v1/.test(t4b.d.note || ''), t4b.d.note);
  ok('配置被就地纠正', /\/plain\/v1$/.test(t4b.cfg), t4b.cfg);

  console.log('\n【5】服务商不允许浏览器直连（跨域被拦）');
  await cfg(`http://127.0.0.1:${PORT_NOCORS}/v1`, 'mock', 'sk-good');
  const t5 = await test();
  ok('识别为连不上/跨域', /连不上|跨域/.test(t5.r.hint || t5.r.err || ''), (t5.r.hint || t5.r.err || '').slice(0, 80));

  console.log('\n【6】模型不支持强制 JSON —— 现在走工具调用，绕开这个参数');
  await cfg(`http://127.0.0.1:${PORT}/nojson`, 'mock', 'sk-good');
  await p.type('#txt', '把空压机放到2楼202');
  await p.keyboard.press('Enter');
  await sleep(2500);
  const t6 = await p.evaluate(() => ({ src: BIM._lastPlan && BIM._lastPlan.source, d: BIM.agent.diag }));
  ok('仍然走通大模型', t6.src === 'llm', JSON.stringify(t6.src));
  ok('没再因为 response_format 报错（工具模式下不传它）', !/response_format/.test(t6.d.note || ''), t6.d.note || '（无降级提示）');

  console.log('\n【7】模型要 max_completion_tokens —— 自动换名');
  await cfg(`http://127.0.0.1:${PORT}/maxtok`, 'mock', 'sk-good');
  const t7 = await test();
  ok('仍然连通', t7.r.ok, t7.r.msg || '');
  ok('提示已换参数名', /max_completion_tokens/.test(t7.d.note || ''), t7.d.note);

  console.log('\n【8】面板里能看见诊断');
  await cfg(`http://127.0.0.1:${PORT}/badkey`, 'mock', 'sk-bad');
  await p.evaluate(() => document.getElementById('btnAI').click());
  await sleep(300);
  await p.evaluate(() => document.getElementById('llmTest').click());
  await sleep(1200);
  const ui = await p.evaluate(() => {
    const d = document.getElementById('llmDiag');
    return { hidden: d.hidden, cls: d.className, txt: d.innerText.replace(/\n+/g, ' | ').slice(0, 160) };
  });
  ok('诊断框展开且是失败态', !ui.hidden && /bad/.test(ui.cls), JSON.stringify(ui));
  ok('写清了请求地址和 401', /POST /.test(ui.txt) && /401/.test(ui.txt), ui.txt);

  console.log('\n【9】连上后真的用大模型理解');
  await cfg(`http://127.0.0.1:${PORT}/v1`, 'mock', 'sk-good');
  await p.evaluate(() => document.getElementById('pAI').hidden = true);
  await p.type('#txt', '把空压机放到2楼202');
  await p.keyboard.press('Enter');
  await sleep(2200);
  const used = await p.evaluate(() => ({
    src: BIM._lastPlan && BIM._lastPlan.source,
    ok: BIM.agent.llmState.ok,
    chip: document.getElementById('aiTxt').innerText,
    placed: BIM.app.state.placed.length
  }));
  ok('走的是大模型', used.src === 'llm' && used.ok === true, JSON.stringify(used));
  ok('设备也放下了', used.placed === 1, 'placed=' + used.placed);

  console.log('\n【10】Azure OpenAI 的地址形态');
  const az = await p.evaluate(async () => {
    const orig = window.fetch;
    let cap = null;
    window.fetch = async (url, opt) => {
      cap = { url: String(url), headers: opt.headers, body: JSON.parse(opt.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"steps":[{"act":"ask"}]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    BIM.agent.saveCfg({ endpoint: 'https://res.openai.azure.com/openai/deployments/dep1', model: 'dep1', key: 'az-key' });
    const r = await BIM.agent.test();
    const url2 = BIM.agent.urlOf();
    window.fetch = orig;
    return { ok: r.ok, url: cap && cap.url, header: cap && cap.headers, body: cap && cap.body, url2: url2 };
  });
  ok('自动补上 /chat/completions 与 api-version',
    /\/openai\/deployments\/dep1\/chat\/completions\?api-version=/.test(az.url || ''), az.url);
  ok('用 api-key 头而不是 Bearer', az.header && az.header['api-key'] === 'az-key' && !az.header.Authorization,
    JSON.stringify(az.header));
  ok('同地址不会重复拼', az.url === az.url2, az.url2);

  console.log('\n【11】跨域被拦时，用本地转发兜住');
  const { spawn } = require('child_process');
  const py = 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';
  const proxy = spawn(py, [path.join(__dirname, 'llm_proxy.py'), '--target', `http://127.0.0.1:${PORT}/v1`, '--key', 'sk-good', '--port', '8790'], { stdio: 'ignore' });
  await sleep(1500);
  await cfg('http://127.0.0.1:8790/v1', 'mock', 'proxy');
  const t11 = await test();
  ok('经本地转发连通', t11.r.ok, t11.r.msg || t11.r.err);
  const lastHit = hits[hits.length - 1] || {};
  ok('Key 由转发注入，页面不用带真 Key', lastHit.auth === 'Bearer sk-good', String(lastHit.auth));
  proxy.kill();

  console.log('\n错误数:', errs.length);
  errs.slice(0, 5).forEach(e => console.log('   ! ' + e));
  await b.close();
  mock.close(); noCors.close();
})();
