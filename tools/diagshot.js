const puppeteer = require('puppeteer-core');
const http = require('http');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mock = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST' }); return res.end(); }
  res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-abc***xyz. You can find your API key at https://platform.example.com/keys', type: 'invalid_request_error' } }));
});
(async () => {
  await new Promise(r => mock.listen(8903, '127.0.0.1', r));
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950, deviceScaleFactor: 2 },
  });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1400);
  await p.evaluate(() => document.getElementById('btnAI').click());
  await p.evaluate(() => {
    document.getElementById('llmEp').value = 'https://api.deepseek.com/v1/chat/completions';
    document.getElementById('llmModel').value = 'deepseek-chat';
    document.getElementById('llmKey').value = 'sk-abc123';
  });
  await p.evaluate(() => {
    BIM.agent.saveCfg({ endpoint: 'http://127.0.0.1:8903/v1', model: 'deepseek-chat', key: 'sk-abc123' });
    document.getElementById('llmEp').value = 'http://127.0.0.1:8903/v1';
  });
  await p.evaluate(() => document.getElementById('llmTest').click());
  await sleep(1200);
  await p.screenshot({ path: 'outputs/ui-6-diag.png', clip: { x: 330, y: 0, width: 330, height: 620 } });
  console.log(await p.evaluate(() => document.getElementById('llmDiag').innerText));
  await b.close(); mock.close();
})();
