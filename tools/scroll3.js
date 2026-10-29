const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const say = async (t, w) => { await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(w || 1200); };
  await say('把空压机放到2楼202');
  const q = await p.evaluate(() => BIM.scene.project(9.9, 3.6, 4.5));
  await p.mouse.click(q.x, q.y); await sleep(1500);
  await say('关闭4楼405的通气阀门会影响哪些房间', 1800);
  const m = await p.evaluate(() => {
    const c = document.getElementById('chat');
    const st = getComputedStyle(c);
    const last = [...c.querySelectorAll('.msg')].pop();
    return { top: c.scrollTop, max: c.scrollHeight - c.clientHeight, sh: c.scrollHeight, ch: c.clientHeight, behavior: st.scrollBehavior, lastBottom: Math.round(last.getBoundingClientRect().bottom) };
  });
  console.log(JSON.stringify(m));
  await b.close();
})();
