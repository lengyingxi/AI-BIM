const path=require('path');const root=path.join(__dirname,'..');
global.window=global;
require(path.join(root,'web/data/model-data.js'));
require(path.join(root,'web/js/nlp.js'));
const N=window.BIM.nlp;
const cases=[
 '门放在靠走廊的位置，3楼306',
 '在3楼306左边开一个1.5米宽的门',
 '3楼306开个双开门',
 '在306室开一个一米二的门',
 '帮我开个2.4米宽的门在405',
 '把空压机放到2楼202靠里一些',
 '空压机放到2楼202靠窗',
 '2楼203的设备靠柱子放',
 '把设备摆到202正中间',
 '关掉4楼405的阀门',
 '关闭4楼405的通气阀门',
 '打开3楼306的阀门',
 '把消防水泵放到1楼101靠墙',
 '在2楼202放两台服务器机柜',
 '我要在306靠走廊的墙上开个门洞，宽1.8米'
];
cases.forEach(c=>{
  const p=N.parse(c);
  console.log(c.padEnd(34), '→', p.intent, '| room', p.room?p.room.num:'-', '| side', p.side||'-', '| pref', p.pref||'-',
    p.intent==='door'?('| w '+p.width+' h '+p.doorH):'', p.intent==='place'?('| dev '+(p.device?p.device.name:'-')):'');
});

console.log('--- 走廊作为房间 ---');
['4楼走廊放台空压机','把设备放到3楼走廊','2楼楼梯间放个机柜'].forEach(c=>{
  const p=N.parse(c);
  console.log(c.padEnd(24),'→',p.intent,'| room',p.room?p.room.num+'('+p.room.zone+')':'-','| pref',p.pref||'-');
});
