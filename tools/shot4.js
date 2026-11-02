/* 只看"断电 → 点查看回路影响"这一屏：
   ③ 配电箱前聚焦 + 断路器落到 off      ④ 点气泡后只剩主干 + 本回路 + 影响房间
   用法：SITE=http://127.0.0.1:8899 node tools/shot4.js */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8899';
const OUT = 'outputs';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 900 }
  });
  const p = await b.newPage();
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2400);
  await p.evaluate(() => { const t = document.querySelector('[data-close="pTree"]'); if (t) t.click(); });
  await p.evaluate(() => { if (BIM.detail && BIM.detail.setCeiling) BIM.detail.setCeiling(false); });

  await p.evaluate(() => BIM.app.send('把2楼第1回路断电'));
  await sleep(2600);
  await p.screenshot({ path: OUT + '/p3_panel_off.png' });

  const ok = await p.evaluate(() => {
    const t = [].slice.call(document.querySelectorAll('.chips button')).filter(x => /查看回路影响/.test(x.textContent))[0];
    if (!t) return false; t.click(); return true;
  });
  await sleep(2200);
  await p.screenshot({ path: OUT + '/p4_impact.png' });
  console.log('点击气泡 ' + ok + '，两张图已更新');
  await b.close();
})();
