/* 大模型配置的自动跟随 / 自动纠错回归
   背景：页面把配置存在 localStorage，早期逻辑"存过就不再接管"，
        结果网关那边模型一换（qwen3.8-max 挂了回落 27b），页面还拿旧名字发请求，
        每条 500 do_request_failed，用户看到的就是"大模型对接坏了"。
   另一个真实踩坑：把网页上显示的相对路径 /llm/v1 当成绝对地址拼到域名后面，
        模型名还填成了 newapi_channel_conn（网关的渠道探测占位名，根本不能聊天）。

   本用例覆盖四种情形：
   ① 干净浏览器                → 自动接上服务端当前模型，并标记 auto
   ② 旧版记录(无 auto)存旧模型  → 启动即纠正
   ③ 新版记录(auto:true)存旧模型→ 启动即纠正
   ④ 指向自家网关但填错(占位模型名 + 地址多一层) → 启动即纠正，且能连通
   ⑤ 别家接口                  → 一律不碰
*/
const puppeteer = require('puppeteer-core');
const http = require('http');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE = process.env.SITE || 'http://127.0.0.1:8823';
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const KEY = 'aibim.llm.v1';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

function getCfg() {
  return new Promise((res, rej) => {
    http.get(SITE + '/llm-config', r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function open(b, seed) {
  const p = await b.newPage();
  if (seed) await p.evaluateOnNewDocument((k, s) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch (e) { }
  }, KEY, seed);
  await p.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  return p;
}
const cfgOf = p => p.evaluate(k => {
  const A = window.BIM.agent;
  return { ep: A.cfg.endpoint, model: A.cfg.model, on: A.cfg.on, touched: A.touched(), ls: localStorage.getItem(k) };
}, KEY);

(async () => {
  let gw;
  try { gw = await getCfg(); } catch (e) { console.log('取不到 /llm-config，跳过（要用 tools/serve.py 启动页面）'); process.exit(0); }
  if (!gw || !gw.model) { console.log('/llm-config 没配模型，跳过'); process.exit(0); }
  const origin = (gw.target || '').replace(/\/[^/]+$/, '');      // https://host
  const wrong = origin + '/llm/v1';                              // 页面上的相对路径被当成绝对地址
  console.log('服务端：' + gw.endpoint + ' · ' + gw.model + '  上游 ' + origin);
  console.log('可用模型：' + (gw.models || []).join(' / '));

  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1400, height: 900 },
  });

  console.log('\n【1】干净浏览器 —— 自动接上');
  let p = await open(b, null);
  let c = await cfgOf(p);
  ok('模型跟服务端一致', c.model === gw.model, c.model);
  ok('地址用服务端的相对路径', c.ep === gw.endpoint, c.ep);
  ok('记下了"这是自动接上的"', /"auto":true/.test(c.ls || ''), c.ls);
  ok('touched() 为假，之后还能继续跟', c.touched === false, String(c.touched));
  await p.close();

  console.log('\n【2】旧版记录（无 auto 字段）存着旧模型');
  p = await open(b, { endpoint: gw.endpoint, model: 'old-model-not-exist', key: '', timeout: 60000 });
  c = await cfgOf(p);
  ok('启动就纠正成服务端模型', c.model === gw.model, c.model);
  await p.close();

  console.log('\n【3】新版记录 auto:true 存着旧模型');
  p = await open(b, { endpoint: gw.endpoint, model: 'old-model-not-exist', key: '', timeout: 60000, auto: true });
  c = await cfgOf(p);
  ok('启动就纠正成服务端模型', c.model === gw.model, c.model);
  await p.close();

  console.log('\n【4】指向自家网关但填错：占位模型名 + 地址多一层 /llm');
  p = await open(b, { endpoint: wrong, model: 'newapi_channel_conn', key: 'sk-fake', timeout: 12000 });
  c = await cfgOf(p);
  ok('地址改回相对路径', c.ep === gw.endpoint, c.ep);
  ok('模型换成能聊天的', c.model === gw.model, c.model);
  const t = await p.evaluate(async () => window.BIM.agent.test());
  ok('改完真能连通', t.ok === true, t.ok ? t.ms + 'ms' : (t.err || ''));
  await p.close();

  console.log('\n【5】别家的接口 —— 不许动');
  p = await open(b, { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: 'sk-test', timeout: 12000 });
  c = await cfgOf(p);
  ok('地址原样', c.ep === 'https://api.openai.com/v1', c.ep);
  ok('模型原样', c.model === 'gpt-4o-mini', c.model);
  ok('仍算"用户手填"', c.touched === true, String(c.touched));
  await p.close();

  await b.close();
  console.log(fail ? '\n结果：' + fail + ' 处失败' : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
