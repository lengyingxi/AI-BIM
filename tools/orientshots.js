/* 朝向出图：设备贴着不同的墙放，正面是不是都朝着屋里。
   node tools/orientshots.js */
const puppeteer = require('puppeteer-core');
const OUT = __dirname + '/../outputs/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--use-angle=swiftshader', '--window-size=1440,900']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await sleep(3600);

  await p.evaluate(() => {
    const room = BIM_MODEL.rooms.find(r => r.num === '205');   // 空调机房，空的
    BIM.scene.setFocus(room.floor, false);
    BIM.scene.setCeiling(false);
    document.querySelector('aside.side').style.display = 'none';   // 出图时收起左侧栏
    const tp = document.getElementById('pTree');
    if (tp) tp.style.display = 'none';                             // 模型树也先收起来
  });

  /* ① 近景：机柜靠西墙（正面朝东）、空压机靠南墙（正面朝北），
        人站东北角看过去，两台的操作面都该冲着人 */
  const near = await p.evaluate(() => {
    const room = BIM_MODEL.rooms.find(r => r.num === '205');
    const pick = n => BIM_MODEL.equipmentLibrary.find(d => d.name.indexOf(n) >= 0);
    const put = (dev, pref) => {
      const spot = BIM.app.spotFor(room, dev, pref);
      const E = Object.assign({}, dev, { rot: spot.rot });
      BIM.app.placeAt(room, E, spot.x, spot.y, spot.ob);
      return { n: dev.name, rot: +spot.rot.toFixed(2), at: [+spot.x.toFixed(2), +spot.y.toFixed(2)] };
    };
    const a = put(pick('服务器机柜'), 'wall');
    const c = put(pick('空气压缩'), 'wall');
    BIM.scene.setCam(room.x1 - 0.55, room.elev + 1.85, -(room.y1 - 0.55),
                     room.x0 + 1.9, room.elev + 0.62, -(room.y0 + 1.7));
    return [a, c];
  });
  near.forEach(o => console.log('  近景', JSON.stringify(o)));
  await sleep(1500);
  await p.screenshot({ path: OUT + 'o-1-front.png' });

  /* ② 全景：再补两台靠东墙 / 墙角，四台各朝一面，正面一律朝屋里 */
  const all = await p.evaluate(() => {
    const room = BIM_MODEL.rooms.find(r => r.num === '205');
    const pick = n => BIM_MODEL.equipmentLibrary.find(d => d.name.indexOf(n) >= 0);
    const put = (dev, pref) => {
      const spot = BIM.app.spotFor(room, dev, pref);
      const E = Object.assign({}, dev, { rot: spot.rot });
      BIM.app.placeAt(room, E, spot.x, spot.y, spot.ob);
      return { n: dev.name, rot: +spot.rot.toFixed(2), at: [+spot.x.toFixed(2), +spot.y.toFixed(2)] };
    };
    const out = [put(pick('精密空调'), 'wall'), put(pick('文件柜'), 'corner')];
    // 站在房间西南角高处往下看，四台的正面应该都朝着屋里
    BIM.scene.setCam(room.x0 + 0.3, room.elev + 4.6, -(room.y0 + 0.3),
                     (room.x0 + room.x1) / 2 + 0.3, room.elev + 0.4, -(room.y0 + room.y1) / 2 - 0.4);
    return out;
  });
  all.forEach(o => console.log('  补位', JSON.stringify(o)));
  await sleep(1500);
  await p.evaluate(() => { BIM.scene.root().traverse(o => { if (o.isSprite) o.visible = false; }); });
  await sleep(150);
  await p.screenshot({ path: OUT + 'o-2-top.png' });

  console.log('错误', errs.length ? errs.slice(0, 3) : '无');
  await b.close();
})();
