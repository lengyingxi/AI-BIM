/* AIbim 工具层（MCP 风格）
   把"能对模型做的操作"写成带 schema 的工具，交给大模型直接调用，
   而不是让它自由发挥一段 JSON 步骤——少一层猜，就少一次"听不懂"。

   这一层要覆盖设备与门的两大类增删改查移，加上视图聚焦/隔离，
   并在 T.guide 里写清"什么时候调哪个、参数怎么填"，一起发给模型。

   注意：这些工具跑在 agent.js 的 A.loop 里，一次对话可以连着调好几轮——
   模型看得到每次执行的结果（安全系数、两侧余量、候选位置），
   所以"放不下就换房间""门太窄先拓门"这类要求它能自己拐弯，
   不需要每次都把球踢回给用户。

   用法：
     BIM.mcp.bind({ place_equipment: async (args) => ({ ok:true, say:'…' }), … })
     BIM.mcp.tools                                  // 送给模型的 tools 数组
     BIM.mcp.call('place_equipment', {…})           // 直接调
*/
(function () {
  const B = (window.BIM = window.BIM || {});
  const T = (B.mcp = {});

  const prefEnum = ['corridor', 'door', 'window', 'corner', 'column', 'beam', 'inner', 'center', 'wall'];
  const dirEnum = ['left', 'right', 'front', 'back', 'up', 'down', 'in', 'out', 'east', 'south', 'west', 'north'];
  // 墙也能用"屏幕上哪一边"来指：用户转完镜头说"左边那面墙开个门"，传 left 由系统换算
  const sideEnum = ['west', 'east', 'south', 'north', 'left', 'right', 'front', 'back'];

  /* ---------------- 调用逻辑（和工具一起发给模型，比只给 schema 稳得多） ---------------- */
  T.guide = [
    '【能力范围】你能对模型做的全部操作都在工具里，分三类：',
    '· 设备：增 place_equipment｜删 remove_equipment｜改 resize_equipment｜替换 replace_equipment｜移动 move_equipment｜查 query_equipment、query_clearance、list_devices｜找房 find_rooms_for_equipment｜引导 suggest_positions',
    '· 门：增 open_door｜删 remove_door｜改尺寸 resize_door｜移动 move_door｜查 query_door、list_doors｜选中 select_opening(kind=door)',
    '· 窗：增 open_window｜删 remove_window｜改尺寸 resize_window｜移动 move_window｜查 query_window｜选中 select_opening(kind=window)',
    '· 墙：打通/拆墙 open_passage（mode=cut 打一个洞，mode=demolish 整段拆）｜查墙里埋了什么 query_conduits',
    '· 电：查分路 query_circuits（main_switch=true 报总开关）｜断/合分路 toggle_circuit（main_switch=true 操总开关）',
    '· 视图与拓扑：整体聚焦 focus_floor｜聚焦房间/设备 focus_view｜看管线 show_conduits｜看回路走向 view_circuit｜还原 show_all｜切层 set_view｜读场景 list_scene｜阀门 toggle_valve、query_impact｜撤回 undo_last',
    '【方向语义】用户说的左/右/前/后/上/下 都是他当前屏幕的方向，你只传 left/right/front/back/up/down，系统按相机换算；只有明说东/南/西/北才传 east/south/west/north。选墙的 side 同理——"左边那面墙开个门"就传 left，别自己换算成 west，用户转过镜头之后会开错墙。"开窗"走 open_window，参数和 open_door 一样多一个 sill（窗台高）；用户说落地窗就传 sill=0.1。',
    '【挪窗——上下和左右不是一回事】窗在墙上只有两个自由度，别混：',
    '  · "往上/往下""抬高/降低""窗台高一点" → move_window(direction=up/down)，改的是窗台标高，窗宽窗高不变；',
    '  · "往左/往右""沿着墙挪""挪到墙中间" → move_window(direction=left/right/center)，沿着墙滑；',
    '  · 用户转过镜头之后，"往左"永远是他在屏幕上看到的左——你只传 left，不要自己算成 east/west。',
    '  · 挪不动（压墙角、贴到别的门窗、顶到梁）时系统会返回原因，照实说，并给"往反方向挪 / 抬低一点 / 把窗做矮"这类可选动作，不要硬试。',
    '【门窗可以被"选中"，然后只改这一扇】用户在场景里用鼠标点门或点窗，系统会自动把它选中并高亮（青色取景框）；也可以调 select_opening 主动选中。',
    '  · 选中之后用户说"这扇门/这扇窗"，指的就是它：改尺寸走 resize_door / resize_window，挪位置走 move_door / move_window，**都不传 door/window 编号**，系统会作用在当前选中的那一扇上；',
    '  · ★ 门窗编号会重名（同规格的模型门全都叫 M1021），所以返回里给的是**唯一代号**（M1021-01、M1021-07…）和内部 id。要指定某一扇时，door/window 传这个代号或 id；只传重名的原名，系统不会替你猜，而是返回一组候选让你先问清是哪一扇——"点的是这扇、改的是那扇"就是这么来的；',
    '  · 改尺寸 = 洞口原地变大变小（resize_window 传 width/height/sill），挪位置 = 整扇平移（move_window），这两件事别混着做；',
    '  · 用户说"太窄了搬不进去"→ 先 resize_door 拓到设备需要的宽度，不要说"这扇门改不了"；拓不动会返回两侧余量和卡在哪。',
    '【门只能开在走廊墙和内隔墙上】外墙（kind=ext）既承重又要管防水保温，系统一律不给开，也不会"顺手挪到外墙上去"。用户随便说"开个门"时，系统按 走廊墙 > 内隔墙 的顺序挑；如果他点名的正是外墙，回执里的 side_from 会是被换掉的那一面，照实说"那面是外墙，换成了走廊/内墙那一面"，别说成"开好了"。',
    '【撤门要"恢复原装"】remove_door / 「撤掉这扇门」不只是把门扇拿掉：洞口补回墙上、开门时为了腾位置改道的线管放回原来的走法、被让开的原有门窗装回去，返回里 restored:{conduits, openings} 就是退回去了几根管、几处门窗。回执要讲这三件事，别只说"拆了"。',
    '【"我自己点位置"= 先撤掉刚自动开的那扇，再让用户点】系统在按钮里已经处理好了：点之前会把自动生成的那一扇撤掉，不会在墙上留两扇门。用户点了不满意，说"换个位置"就再走一次 open_door，别叠加。',
    '【墙里埋着线管——开洞前必须先想到这一层】建筑图不画预埋线管，但现场是实打实埋在墙里的。开窗、开门、打穿都会先自动查一遍：',
    '  · 结果里如果出现 conduit_hit（撞到的分路号）、rerouted>0（已改线）、moved>0（顺墙挪位），说明这个洞不是"想开就开"的；',
    '  · 回答时讲清三件事：撞的是哪一路（照明/插座/动力）、怎么处理了（改道多走几米 / 顺墙挪了几米）、备选是什么；',
    '  · 系统会在场景里把冲突线管标红、改线的新走向画成绿色、墙体半透明，你直接引用"红色的管子""绿色的新线"来讲，不要自己编方位；',
    '  · 用户问"这面墙里有没有线"先调 query_conduits，别猜。',
    '【打穿 / 拆墙】"把这间和隔壁打通""这面墙拆了""砸个大洞""做成开放空间"都走 open_passage：',
    '  · ★ 说"打通/打穿/拆了这面墙"→ 默认 mode=demolish，也就是**把这面墙整段去掉**（拆到梁底、两端拆到柱边），不是墙上开个小洞；只有用户明说"打个洞/开个口子/挖个洞"才 mode=cut（默认 1.8 米宽）；',
    '  · 外墙在这栋楼里同时是承重墙，系统会直接拒绝，照实说"承重墙不能拆"，并建议改内隔墙或只开个门，不要反复试；',
    '  · 挖洞（cut）时系统保证上方留过梁（不能挖到顶），above_m 就是留了多少；整面拆（demolish）时 above_m=0，返回里 demolish=true，别再说"上面留了过梁"；',
    '  · 回复里要带上"连通到哪一间"和"还要补什么"（过梁/构造柱/消防分区/隔声），这些都在返回的 warns 里。',
    '【打通以后：两块楼板合并成一块，设备按合并板放、按合并板算】这不是"还在两间房里各放各的"：',
    '  · 打通后 system 会自动把连通的两间当成**一块整板**（中间那道墙不再当支座，跨度按整块板算）。放设备时 room 传任意一间都行，也可以直接说"放这两间中间"，落位默认为合并板正中；',
    '  · 承重返回里会出现 plate：{merged:true, size_m:[长,宽], rooms:[房号…], K, verdict}，这就是**按合并板重新校核**的结果。回复时必须讲"按合并后的 X×Y 米大板校验，安全系数 K"，不要说成单间小板；',
    '  · 用户说"放左边/右边/靠镜头这边"→ 照样传 side（left/right/front/back），系统按**合并后这块大板**的前后左右算，不要说"合并后没有方向感"；',
    '  · 设备放进去但搬不进门时，返回里有 door_pass：{need_w, doors:[{door, id, room, w, h, fit}…]}，列出这块板上**每一间各一扇**的门。把这些门和各自需要的宽度说清楚，让用户自己挑一扇拓（用户原话"可以任意选择一个打通房间其中一个走廊的门进行建议拓宽"），挑定了就把那扇门的 id 传给 resize_door 的 door 参数；不要只盯着设备所在那一间的门。',
    '【配电拓扑——不是"每间房顶上一根照明管"，是四级配电】颜色固定：照明黄 / 插座蓝 / 动力红。',
    '  · 走向：主干立管（电气竖井里，从楼下直通楼上，一条不断）→ 层进线到每层配电箱 AL-层号（贴墙挂在电气间）→ 箱顶六路引上、水平搭到本层桥架 → 走廊干线（吊顶桥架里，沿走廊两侧整段横铺，比支线粗、三条分路分层敷设）→ 房间支线（从走廊在墙里竖向下引，进房间后沿四周墙走一圈）。',
    '  · 所以吊顶里的干线（2.6~3.0 m）普通门洞根本够不着，真正会被开洞撞的是房间支线：贴地的插座管 0.32 m、动力支线 2.35 m；讲冲突时要把这个区别说清楚，别让用户以为"这面墙动不得"。',
    '  · 管线本身是连通的：遇到已有的门窗洞会就近上翻或下翻绕过去再接回来，管段之间、转角处都有弯头/接线盒（画面上是比管身深一档、略大的方头）。用户说"管子断了/中间断开"时，先看是不是没打开电气视图，别顺着说"确实断了"。',
    '  · 配电箱（远端控制箱）是**真装在墙上的设备**，平时看楼层就一直在，不用先打开电气视图；只跟着楼层聚焦显隐（切到 3F 就只留 3F 那只）。用户在看房间、看设备时注意到箱子，照常解释就是，别让他"先去找电气视图"；',
    '  · 用户问"电怎么走的 / 配电怎么分的 / 干线在哪"→ query_circuits，返回里每条分路带 layers（trunk/feed/out/corridor/drop/room 各有几段；out=配电箱出线到桥架那一段），照这个讲路径；',
    '  · 每层一部配电箱，箱门上一排开关是两层控制，别混：最左边那只**总开关（进线断路器）**管整层六路，一断六路一起停、整层房间全黑；右边第 1~6 个手柄是**分路断路器（空开 / 空气开关 / 电闸 / 断路器，说的都是这一排东西，用户用哪个词都按这个理解）**，各管自己那一路。',
    '  · 六路固定是：第1回路=照明1、第2=照明2、第3=插座1、第4=插座2、第5=动力1（空调主机/机房）、第6=动力2（各房间空调末端）。一间房不是六路都供，而是每类归其中一条：南侧房间走 1 号那条、北侧走 2 号那条，动力按机房/末端分。',
    '  · 用户说"总开关 / 总闸 / 总断路器 / 进线开关 / 整层断电 / 这层全停"→ toggle_circuit(main_switch=true)；只有说"第几回路 / 照明 / 插座 / 动力"才是分路，传 circuit_no 或 kind。把总开关当成分路，会变成"说整层黑，实际只停一类"；反过来更糟——用户只想停照明，结果整层被拉闸。',
    '  · 总开关断开时，六个分路手柄**不会跟着动**，还停在合位，只是没电（画面里手柄朝上、指示灯变暗）。别跟用户说"六个分路都被拉下来了"，那是错的。',
    '  · 用户说"把 3 楼照明断电""关掉第 1 回路""拉下第 3 个空开"→ toggle_circuit(action=off)：镜头会先推到该层配电箱，对应的断路器手柄落到断开位（红色），图上只留**本层**管线，回复里给「查看回路影响」气泡，点了只显示本层那一段主干立管 + 本回路支路 + 受影响房间（别的楼层的主干不会一起画出来，别描述成"从楼下一路通到楼上"）；',
    '  · 断电/合闸/查回路时，**每根线管的管身上会走出发光条纹**（贴着管子表面流动的亮纹，不是飘在空中的光点），从这只空开出发，沿主干→层进线→走廊干线→墙内下引→房间支路流过去。用户问"电往哪走""怎么走的"就照这个说：条纹流动的方向就是电流方向。断电的那一路管子会变灰，但条纹照样在跑 —— 条纹说的是"这一路电管到哪儿"，颜色灰不灰说的是"现在有没有电"，两件事分开讲。别说成"管子自己在动"。',
    '  · 回答时说清：这一路带几间房、断了以后哪几间会全黑、哪几间还有别的回路不会断——这些都从返回的 dark_rooms / still_powered 里取，别自己推；',
    '  · 总开关合上以后，之前单独断开的分路**不会自动恢复**，那几间房照样没电。用户问"合了总闸怎么还不亮"，就照这个答，并让他单独合那一路；',
    '  · "这间房有几路电""这层怎么分的"→ query_circuits，只查不动手；问"总开关什么状态"→ query_circuits(main_switch=true)；',
    '  · 分路是工程概念，不要和"阀门/水路"混，水路走 toggle_valve / query_impact。',
    '【"关空开"这种没头没尾的话——是命令，不是查询】用户盯着配电箱说"关闭空开""把电闸关了""空开断开"时，',
    '  · 这是**要你动手**，不是让你列清单：绝不能回一个分路列表了事（那等于没关）。没指明哪一路时直接 toggle_circuit(action=off)：系统会落到本层最相关的那一路，并在回复里说清关的是第几回路、带哪几间房，再补一句"要关别的就说第几路"；',
    '  · 只有带"哪些/几路/什么影响/会不会"这种问法才是查询走 query_circuits；带"把/关/断/停/拉"的是动作走 toggle_circuit；',
    '  · 说了"总开关/总闸/整层"就传 main_switch=true，别落到某一路上。',
    '【楼层、管线、透明度的呈现规矩】这几条是用户明确要求的，别自己改口径：',
    '  · 看某一层（focus_floor，不看管线）→ 本层实心，**别的楼层和顶梁是 50% 半透明，不是隐藏**，整栋楼还看得见；',
    '  · 但看某层**管线/分路/回路走向**时（show_conduits(scope=floor)、view_circuit）→ **别的楼层整层收起**，只留当前楼层，当前楼层的墙、梁、柱压到 **50% 半透明**（不压就看不见墙里的暗管）；',
    '  · 管线只跟楼层有关：聚焦哪层就只画哪层的管。只有用户明说"看所有管线/整栋的管"才用 show_conduits(scope=all)，这时整栋楼压到 **20% 半透明**（楼体仍然画出来）；',
    '  · 看某一路走向用 view_circuit：只画这一路 + 本层主干，管子粗细和接头跟"看所有分路"时完全一样，别再描述成"别的楼层的管子还在"。',
    '【默认值】"一点"≈0.3 米，"半米"=0.5；没说距离给 0.4；没说数量给 1；没说什么门按 1.0×2.1 米。这些不用反问。',
    '【模糊需求】用户说"放得合适一点/你看怎么挪好/不太对"这类模糊话时，先想清楚他大概想改善什么（省地方 / 不挡门 / 靠墙整齐 / 别压梁）：调 suggest_positions，系统会自动挑最合适的位置直接放好并把备选返回，你只需用一句话说明"为什么放这儿"和"还能怎么改"。不要反问"你要放哪"，也不要只给建议不动手。',
    '【拓门】"门太窄搬不进去""门加宽到 1.5 米"都走 resize_door。系统会**分别量门洞左右两侧**还能扩多少，再决定"两侧各扩一半 / 只扩余量大的一侧 / 顺墙让一段"——不会硬按两边对半。三个方案都要过开门校核，过不了就门一个字都不改。回答要讲清：两侧各剩多少、最后往哪边扩了多少、拓完设备能不能过、以及设备在最终位置的安全系数（旁边给"看计算书"的入口）。',
    '【看计算书会亮出对应的板】用户点"看计算书"时，系统会把**这块计算板**在场景里高亮出来：单间就是一间，打通了就是两间一起亮（返回 calc_plate 是亮起的房号、calc_merged 表示是不是合并板）。所以回答里要顺着画面说"亮的这块就是算的那块板"，别再说"整层都算过了"。',
    '【净距】"旁边还有多少空间""离墙多远""够不够检修""周边余量"都走 query_clearance。系统会在楼板上画虚框标出四周，',
    '  你回答时按"左/右/南/北各多少米 + 哪边最窄 + 正面检修面多少"来讲，数字直接用工具返回的，别自己估，也别换算成别的方向。',
    '  用户接着问"那能不能再放一台""挪一下会不会更宽"，就用返回的数字判断，不要重新量一遍。',
    '【上下文】"这台/它/刚才那台"=当前选中的设备；"这个门"=最近开的门；省略房间沿用上下文房间。真的缺房间号才问一句。',
    '【放还是搬——最容易搞错的一条】"把空压机放到 203"没有指代词，就是**在这间新放一台**（place_equipment）；',
    '  只有明确指着已有的那台（"把这个空压机放到 203""把它搬到 203""这台挪到 203"）才是 move_equipment。',
    '  两者结果差很多：一个是多一台，一个是把那台搬走。拿不准的时候，句子里有"这/那/它"才当搬家。',
    '【多轮要接着上文】用户常常不报房号：刚打完洞接着说"放个设备到中间""放台空压机"——他说的就是刚才那间房，打通了就是**那两块合并的板**（落位取合并板正中）。',
    '  · 这种情况 place_equipment **不要传 room**，系统会沿用当前房间；也别反问"放到哪一间"，那正是上下文断了的表现。',
    '  · 同理，刚开过门/窗/改过尺寸，下一句"改宽一点""再挪半米"都是指刚才那一扇，不传 door/window 编号。',
    '【不许自作主张】只能做用户明确要的事：用户没说"开门"就别 open_door，没说"换台小的"就别 resize_equipment，没说"拆"就别 remove_*。',
    '  遇到障碍（门太窄搬不进来、楼板吃不消、位置占不下）时，按这个顺序想办法：① 换方位/换房间（move_equipment、suggest_positions）② 拓现有门（resize_door）③ 停下来把原因和可选方案讲清楚。',
    '  拓门失败、房间放不下这类，属于"要用户拍板"的事，别自己新增门洞或改建筑，把选择权交回去。',
    '【特殊要求怎么接】用户一句话里带多个条件时，全都要满足，别只挑一个好做的：',
    '  · "放到 506 靠窗、别挡门"→ place_equipment(pref=window)，结果里看碰撞和门洞，不满足就再调一次换方位；',
    '  · "挪到靠窗/靠墙/墙角"（说的是已有的那台）→ move_equipment(pref=window/wall/corner)，别用 place 再放一台；',
    '  · "搬到 3 楼去"没说哪间 → 先 find_rooms_for_equipment 找放得下的，再 move_equipment 搬过去；',
    '  · "这间太挤了，收拾一下"→ list_devices 看清有什么，再逐台 move_equipment(pref=wall/corner) 排开；',
    '  · "放不下就算了"→ 试一次就停，把失败原因说清楚，不要反复重试；',
    '  · 用户给的数字（1.5 米、2 吨、0.3 米）一律照用，不要自己改。',
    '【聚焦】改模型之后系统会自动聚焦并淡出无关楼层，不用你再调 focus_view；只有用户明确说"挡住看不清/只看这间/把那层藏起来"时，才调 focus_view 且 only_this=true。',
    '【回答】做完用一两句口语说清"改了什么、结果怎样（安全系数/能不能通行）"，再给一个可选的下一步。不要念参数、不要提工具名。'
  ].join('\n');

  /* ---------------- 工具定义（OpenAI / MCP 通用的 JSON Schema） ---------------- */
  T.tools = [
    /* ================= A. 设备 ================= */
    {
      type: 'function',
      function: {
        name: 'place_equipment',
        description: '【设备·增】把设备放到房间楼板上并做承重校核。用户说"放/摆/安装/搬进来/加一台"时用。返回放置结果、安全系数、还能不能再加。★ 房间已经被打通时（两块板连成一块），承重按**合并后的大板**校核，返回里带 plate:{merged,size_m,rooms,K,verdict}；用户说"放到这两间中间"就传任意一间或把两间房号一起写进 room，落位默认为合并板正中；说"放左边/右边/靠镜头这边"照常传 side，系统按合并大板换算。放得下但搬不进门时返回 door_pass，里面列出这块板上每一间各一扇的门，让用户挑一扇拓。',
        parameters: {
          type: 'object',
          properties: {
            device: { type: 'string', description: '设备名或简称，如"空压机""精密空调"。用设备库里的名字或它的简称' },
            room: { type: 'string', description: '房号如"202"；省略则沿用当前房间' },
            floor: { type: 'integer', description: '楼层；房号已含楼层时可省略' },
            count: { type: 'integer', description: '放几台，1~4，默认 1' },
            pref: { type: 'string', enum: prefEnum, description: '摆放偏好：靠走廊/靠门/靠窗/墙角/靠柱/靠梁/靠里/居中/贴墙' },
            weight: { type: 'number', description: '单台重量（吨），设备库没有这个型号时填' },
            near: { type: 'string', description: '要靠近某个东西时说，如"门""窗""柱子""墙角"' },
            side: { type: 'string', enum: sideEnum, description: '用户指定"放在左边/靠东边墙"时填，left/right/front/back 由系统按当前镜头换算；和 pref 可同时用，side 管哪一面、pref 管贴墙还是居中' }
          },
          required: ['device']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_equipment',
        description: '【设备·删】撤掉设备。用户说"撤掉/删掉/拿掉/不要了/清空这间"时用。默认撤当前这台。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '设备名；省略=当前选中的那台' },
            room: { type: 'string', description: '房号；配合 all=true 可整间清空' },
            all: { type: 'boolean', description: 'true=把这间房里的设备全撤掉' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_equipment',
        description: '【设备·移动】挪设备：① 方向+距离（"往左一点"）② 挪到某个方位（"靠里""贴墙""墙角"）③ 搬到别的房间（给 room，系统会在新房间自动挑最合适的位置并重算承重）。默认操作当前这台。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '设备名；省略=当前这台' },
            direction: { type: 'string', enum: dirEnum, description: '相对方向：left/right/front/back/up/down 按用户屏幕；in/out 往房间里/门口；east/south/west/north 按方位' },
            distance: { type: 'number', description: '挪多远（米）；"一点"0.3、"半米"0.5，没说要给 0.4' },
            pref: { type: 'string', enum: prefEnum, description: '直接挪到某个方位时填（靠里/贴墙/墙角/靠窗/居中）；搬家时填了就在新房间按这个方位放' },
            room: { type: 'string', description: '搬到另一间房时给房号（"把它放到 506"就是这个）；不填=原地挪' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'find_rooms_for_equipment',
        description: '【设备·找位】在某一层里找出真放得下这台设备的房间，按楼板余量排序。用户说"哪间能放""这层哪儿有地方""换个房间"时用。只查不改。',
        parameters: {
          type: 'object',
          properties: {
            device: { type: 'string', description: '设备名；省略=当前这台' },
            floor: { type: 'integer', description: '楼层；省略=当前楼层' },
            count: { type: 'integer', description: '返回几个候选，默认 3' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'replace_equipment',
        description: '【设备·替换】把现场这台换成另一种设备，位置不变；换完重新校核，放不下会自动挪到最近的空位并说明。用户说"换成/改成 XX 设备"时用。',
        parameters: {
          type: 'object',
          properties: {
            device: { type: 'string', description: '换成什么设备（名称或简称）' },
            target: { type: 'string', description: '被替换的那台；省略=当前这台' },
            weight: { type: 'number', description: '新设备单重（吨），库里有就不用填' }
          },
          required: ['device']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'resize_equipment',
        description: '【设备·改】改设备尺寸/重量（"太大了改小一点""加宽到 1.5 米""按 2 吨算"）。改完自动重新校核，碰了就告诉你撞到谁。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '设备名；省略=当前这台' },
            width: { type: 'number', description: '平面长边（米）' },
            depth: { type: 'number', description: '平面短边（米）' },
            height: { type: 'number', description: '高度（米）' },
            weight: { type: 'number', description: '重量（吨）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_equipment',
        description: '【设备·查】查当前（或指定）设备的详情：重量尺寸、所在房间、安全系数、最多可放、周围有没有挡道的。',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string', description: '设备名；省略=当前这台' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_clearance',
        description: '【设备·查】量设备四周净距，并在模型楼板上用虚框把左/右/南/北各多少米标出来（还会指出正面检修面朝哪边、剩多少）。用户问"旁边还有多少空间""离墙多远""够不够检修""周边余量"时用。只量不改。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '设备名；省略=当前这台' },
            room: { type: 'string', description: '房号，可选' },
            show: { type: 'boolean', description: '默认 true=在模型上画虚框；false=只报数字不动画面' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_devices',
        description: '【设备·查】列出已放设备（某间房、某层或全楼）。用户问"这里放了什么/一共几台"时用。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号，可选' },
            floor: { type: 'integer', description: '楼层，可选' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'suggest_positions',
        description: '【设备·引导】用户说不清该放哪（"你看着放""放得合适一点""不太对"）时用：系统会算 2~4 个可行位置，挑最合适的一个直接把设备放上去，其余作为可改选项返回。用户明确只想听建议、不要动手时传 apply=false。',
        parameters: {
          type: 'object',
          properties: {
            device: { type: 'string', description: '要放的设备；省略=当前这台' },
            room: { type: 'string', description: '房号；省略=当前房间' },
            count: { type: 'integer', description: '要几个候选，默认 3' },
            apply: { type: 'boolean', description: '默认 true=挑最好的直接放；false=只给建议不动手' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_properties',
        description: '【设备·查】打开当前设备的属性卡片（query_equipment 的可视化版）。用户说"看看参数/这是啥"时用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_capacity',
        description: '【设备·查】当前房间楼板还能再加几台同类设备（余量、还能放几台）。',
        parameters: { type: 'object', properties: {} }
      }
    },

    /* ================= B. 门 ================= */
    {
      type: 'function',
      function: {
        name: 'open_door',
        description: '【门·增】在某面墙开一个门洞，并判断是否撞到窗/柱/设备/别的门。用户说"开门/开个洞口/加个门"时用。返回门宽门高、能不能开、撞了什么。**门只能开在走廊墙和内隔墙上，外墙一律不开**（承重+防水），点在/说在外墙上会被挡回并换成走廊墙或内墙，回执里的 side_from 就是被换掉的那一面。开完会同时在回执里给"我自己点位置""撤掉这扇门"两个按钮。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' },
            side: { type: 'string', enum: sideEnum, description: '开在哪面墙。用户说的是左/右/前/后就填 left/right/front/back（系统按当前镜头换算成墙）；明说东南西北才填 west/east/south/north；不确定就省略，系统按偏好挑' },
            width: { type: 'number', description: '门宽（米），默认 1.0' },
            height: { type: 'number', description: '门高（米），默认 2.1' },
            pref: { type: 'string', enum: prefEnum, description: '只说"靠走廊"没说哪面墙时填 corridor' }
          },
          required: ['room']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_window',
        description: '【窗·增】在某面墙开一扇窗（含窗框、中梃、玻璃、窗台板），并校核窗垛、窗顶标高、是否撞到别的门窗/柱/风管。用户说"开个窗/加扇窗/这儿开个 1.5 米的窗/落地窗"时用。外墙优先。返回窗宽窗高窗台高、能不能开、撞了什么、给什么提醒。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' },
            side: { type: 'string', enum: sideEnum, description: '开在哪面墙。用户说左/右/前/后就填 left/right/front/back（系统按当前镜头换算）；明说东南西北才填方位；不确定就省略，系统优先挑外墙' },
            width: { type: 'number', description: '窗宽（米），默认 1.5' },
            height: { type: 'number', description: '窗高（米），默认 1.5' },
            sill: { type: 'number', description: '窗台高（米），默认 0.9；落地窗填 0.1' },
            pref: { type: 'string', enum: prefEnum, description: '只说"靠窗/朝南"没说哪面墙时填' }
          },
          required: ['room']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_window',
        description: '【窗·删】拆掉一扇自己开的窗（原有窗只能说明不能拆）。用户说"把这扇窗封了/撤掉这个窗"时用。',
        parameters: {
          type: 'object',
          properties: {
            window: { type: 'string', description: '窗编号；省略=最近开的那扇' },
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_window',
        description: '【窗·改】挪一扇已经开好的窗，整扇平移、窗宽窗高不变。上下=抬降窗台标高，左右前后=沿着墙滑。用户说"把窗往上挪一点/抬高一些/降下来/往左挪半米/挪到墙中间"时用。方向按当前镜头换算（用户说左就填 left，别自己换算成东南西北）。会自动校核压墙角、撞柱、贴上别的门窗、顶到梁；挪不过去会返回卡在哪。返回挪了多少、现在轴位与窗台高、两头离墙角还剩多少。',
        parameters: {
          type: 'object',
          properties: {
            window: { type: 'string', description: '窗编号；省略=最近操作的那扇' },
            room: { type: 'string', description: '房号，可选' },
            floor: { type: 'integer', description: '楼层，可选' },
            direction: {
              type: 'string',
              enum: ['up', 'down', 'left', 'right', 'front', 'back', 'center', 'east', 'south', 'west', 'north'],
              description: 'up/down=抬高或降低窗台；left/right/front/back=沿墙滑（按当前镜头）；center=滑到这段墙的中间；东南西北只有用户明说才用'
            },
            distance: { type: 'number', description: '挪多少米，默认 0.3。用户说"一点"就 0.3，"半米"就 0.5' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_window',
        description: '【窗·查】查某间房或某扇窗的现状：编号、洞口宽高、窗台高、离墙角还剩多少、所在墙与楼层。用户问"这扇窗多大/窗台多高/还有多少余地"时用。只查不改。',
        parameters: {
          type: 'object',
          properties: {
            window: { type: 'string', description: '窗编号；省略则按 room 查' },
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'resize_window',
        description: '【窗·改尺寸】把**已经存在的某一扇窗**改宽/改高/改窗台高，洞口原地不动。用户说"把这扇窗加宽到2米""窗高改成1.2米""窗台抬到1.1米""这个窗太大了缩小点"时用。★ 改位置走 move_window，改尺寸走这个，两者不要混。省略 window 时作用于**用户刚用鼠标点中的那一扇**（点了窗会高亮）。会自动校核压墙角、撞柱、撞梁、贴上别的门窗和管线；开不了会返回卡在哪、并给出能开的尺寸。',
        parameters: {
          type: 'object',
          properties: {
            window: { type: 'string', description: '窗编号；省略=当前点中的那一扇 / 最近操作的那扇' },
            width: { type: 'number', description: '改完的窗宽（米），不改就不传' },
            height: { type: 'number', description: '改完的窗高（米），不改就不传' },
            sill: { type: 'number', description: '改完的窗台高（米），不改就不传' },
            room: { type: 'string', description: '房号，可选' },
            floor: { type: 'integer', description: '楼层，可选' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'select_opening',
        description: '【门窗·选中】把某一扇门或窗选中并高亮，之后说"这扇门/这扇窗"就都指它。用户在场景里点了门或窗（已经自动选中）、或者用户说"选中 306 的门""把 505 那扇窗选出来"时用。返回这扇门/窗的编号、洞口尺寸、窗台高、所在房间。选中之后紧接着可以调 resize_door / move_door / resize_window / move_window，不传门名也会作用在它身上。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['door', 'window'], description: '选门还是选窗' },
            name: { type: 'string', description: '门/窗编号，如 M1021；省略则按 room + side 找' },
            room: { type: 'string', description: '房号' },
            side: { type: 'string', enum: sideEnum, description: '哪面墙上的一扇，可用 left/right/front/back 表示屏幕方向' },
            floor: { type: 'integer', description: '楼层' }
          },
          required: ['kind']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_door',
        description: '【门·删】撤掉一扇门，**墙体恢复成开门之前的样子**：洞口补上、开门时为它改道的线管放回原走法、被它让开的原有门窗装回去。用户说"把这个门撤了/封起来/不要这个门/撤掉这扇门"时用。模型里原有的门点中了也能撤（回执会提醒图纸上会少一道门）。',
        parameters: {
          type: 'object',
          properties: {
            door: { type: 'string', description: '门编号（唯一代号如 M1021-07，或内部 id）；省略=当前选中/最近开的那个' },
            room: { type: 'string', description: '房号；配合 side 用' },
            side: { type: 'string', enum: sideEnum, description: '拆哪面墙上的门，可用 left/right/front/back 表示屏幕方向' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_door',
        description: '【门·移动】门沿墙挪位置（"往左挪一点""挪到墙中间"），也可以换到另一面墙。会重新判断碰撞。',
        parameters: {
          type: 'object',
          properties: {
            door: { type: 'string', description: '门编号；省略=最近开的门' },
            along: { type: 'string', enum: dirEnum.concat(['center']), description: '沿墙往哪挪：left/right 按屏幕方向；center=这面墙的中间' },
            distance: { type: 'number', description: '挪多远（米），默认 0.5' },
            side: { type: 'string', enum: sideEnum, description: '要换到另一面墙时填，可用 left/right/front/back 表示屏幕方向' },
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'resize_door',
        description: '【门·改】改门宽/门高（"加宽到 1.5 米""门矮一点 2 米"）。系统分别量门洞左右两侧余量，自动选"两侧各扩一半 / 只扩余量大的一侧 / 顺墙让一段"，并重新做开门校核；改完把设备的最终安全系数一并给出。**墙里压着线管不算改不了**：系统会按新洞口把线管重新上翻/下翻绕过（回执里 rerouted 就是重新改线的根数），不要说"和管线碰撞所以改不了"。',
        parameters: {
          type: 'object',
          properties: {
            door: { type: 'string', description: '门编号；省略=最近开的门' },
            width: { type: 'number', description: '新门宽（米）' },
            height: { type: 'number', description: '新门高（米）' },
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_door',
        description: '【门·查】查一扇门的详情：哪面墙、宽高、离最近的设备/窗多远、现在能不能通行。',
        parameters: {
          type: 'object',
          properties: {
            door: { type: 'string', description: '门编号；省略=最近开的门' },
            room: { type: 'string', description: '房号' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_doors',
        description: '【门·查】列出一间房（或一层）所有的门，含原有门和自己开的门。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号，可选' },
            floor: { type: 'integer', description: '楼层，可选' }
          }
        }
      }
    },

    /* ================= C. 视图 / 拓扑 ================= */
    {
      type: 'function',
      function: {
        name: 'focus_view',
        description: '【视图】聚焦到某间房/某层/某台设备，并把无关的楼层和别的房间藏起来。用户说"挡住看不清/只看这间/把这层藏起来/带我看看 202"时用。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号' },
            floor: { type: 'integer', description: '楼层' },
            device: { type: 'string', description: '设备名（聚焦到某台设备）' },
            only_this: { type: 'boolean', description: 'true=只显示这一间，别的全藏起来；false=只高亮和取景' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_all',
        description: '【视图】恢复全楼视图，把之前藏起来的都放出来。用户说"回到全楼/都显示出来"时用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'set_view',
        description: '【视图】切到某一层（0=全楼）。只切层不改显隐。',
        parameters: {
          type: 'object',
          properties: { floor: { type: 'integer', description: '楼层号，0 表示全楼' } },
          required: ['floor']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_scene',
        description: '【读场景】拿当前情况：楼层、房间清单、设备库、已放设备、最近开的门、上下文和相机朝向。不确定房号/设备名/"往左是哪边"时先调它。',
        parameters: {
          type: 'object',
          properties: {
            what: { type: 'string', enum: ['all', 'rooms', 'equipment', 'placed', 'doors'], description: '要哪部分，默认 all' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'toggle_valve',
        description: '【拓扑】关掉或打开阀门，并列出受影响的路由与房间。用户说"关阀门/断了/停掉"时用。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '阀门所在房号' },
            floor: { type: 'integer', description: '楼层' },
            valve: { type: 'string', description: '阀门编号，可省略' },
            action: { type: 'string', enum: ['close', 'open'], description: '默认 close' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_impact',
        description: '【拓扑】只查不改：某阀门关掉会影响哪些路由和房间。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号' },
            valve: { type: 'string', description: '阀门编号，可省略' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'undo_last',
        description: '【撤回】撤销上一步对模型的操作（放/挪/换/改/删设备、开门/改门/拆门）。用户说"撤回去/刚才那步不要了/弄错了"时用。',
        parameters: { type: 'object', properties: {} }
      }
    },

    /* ================= E. 墙体：拆墙 / 打穿 ================= */
    {
      type: 'function',
      function: {
        name: 'open_passage',
        description: '【墙·拆/穿】把两间房打通。"打通"= 把这面墙整段去掉（mode=demolish，默认），不是墙上开个小洞；只有用户明说"打个洞/开个口子/挖个洞"才是 mode=cut。会自动判承重（外墙一律拒绝）、查墙内线管；挖洞时线管能改道就改道，整面拆时墙里的线管随墙作废（返回 conduit_hit 里列出，需从吊顶重新敷设）。执行后场景会切到打通视图：被拆的墙 30% 半透明、这块板上被牵涉的分路 50% 半透明（其余分路压暗）、随墙作废的那几段线管按 50% 留在原位并描虚线，两块楼板按一块整板算。返回拆除/洞口尺寸、above_m、连通到哪一间、demolish 是否为 true。★ 用户点明了隔壁房间号（"和 202 打通""这两间连起来"）就传 to、**不要传 side** —— 系统自己取两间共用的那面墙；只有用户指着某一个方向说"这面墙拆了"才传 side。两个都传时 side 会被忽略。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房间号，如"306"；省略则沿用当前房间' },
            to: { type: 'string', description: '要打通到哪一间（有明确隔壁时填，如"307"）' },
            side: { type: 'string', enum: ['south', 'north', 'east', 'west', 'left', 'right', 'front', 'back'], description: '指定哪面墙；left/right/front/back 按当前镜头换算。省略则自动挑一面内隔墙' },
            width: { type: 'number', description: '洞口宽（米）；cut 默认 1.8，demolish 不用传（自动打满这间房在这一段墙上的长度）' },
            height: { type: 'number', description: '洞口高（米）；cut 默认 2.2（最高到墙净高减 0.3），demolish 不用传（自动拆到梁底）' },
            mode: { type: 'string', enum: ['cut', 'demolish'], description: 'demolish=整面拆掉这面墙（默认，"打通"就走这个）；cut=只在墙上开一个洞' },
            floor: { type: 'integer', description: '楼层' }
          },
          required: ['room']
        }
      }
    },

    /* ================= F. 电路：墙内线管 / 分路 ================= */
    {
      type: 'function',
      function: {
        name: 'query_circuits',
        description: '【电·查】查配电：某间房由哪几路电供、某层有哪几条分路、每条带多少间房、现在通还是断、以及这一路的走向（layers 里分主干立管/层进线/走廊干线/墙内下引/房间支线各几段）。用户说"这间有几路电/3 楼照明是哪一路/配电怎么分的/电从哪进来到房间"时用。只查不改。每层六路：照明1、照明2、插座1、插座2、动力1（空调主机）、动力2（房间空调末端）；用户口中的"空开 / 空气开关 / 电闸 / 断路器"就是这六路本身。问"总开关现在什么状态 / 总开关管哪些"时传 main_switch=true，会报这只进线断路器的位置、整层覆盖范围和六路各自的状态。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号；填了就查这间房的分路' },
            floor: { type: 'integer', description: '楼层；不填房间号时列这层全部分路' },
            scope: { type: 'string', enum: ['room', 'floor'], description: 'room=只看这间（默认，有房间号时）；floor=列整层' },
            main_switch: { type: 'boolean', description: 'true = 只报这层配电箱总开关（进线断路器）的状态和整层覆盖范围，不列分路' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'toggle_circuit',
        description: '【电·控】断/合一路电（相当于在配电箱上扳那个分路空开/电闸/空气开关）。每层六路，编号 1~6，固定对应：照明1 / 照明2 / 插座1 / 插座2 / 动力1（空调主机）/ 动力2（房间空调末端）。三种说法都要能接住：① 按编号"关掉 2 楼第 3 个空开"→ circuit_no=3；② 按类别+序号"把 2 楼照明 2 断电"→ kind=light, circuit_sub=2；③ 只说类别"3 楼插座断电"→ kind=socket（默认第 1 条）。执行后镜头会先推到该层配电箱、对应的手柄落到断开位（红色），图上一层之外的东西全部不画（只留本层），管身上有发光条纹从这只空开沿干线、下引、支路一路流向房间；回复里给「查看回路影响」气泡，点了只显示本层主干 + 本回路 + 受影响房间。★ 两层控制别混：说"总开关/总闸/总断路器/进线开关/整层断电/这层全停"时，必须传 main_switch=true —— 那只箱子最左边的进线断路器管整层六路，一断六路一起停；而 circuit_no / kind 指的是右边六个分路手柄，各管自己那一路。断总开关时六个分路手柄不会跟着动（现场就是这样），别把两者说成一回事。',
        parameters: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: '分路编号，如 L3A；省略则按 circuit_no / kind+circuit_sub / room 自动找' },
            circuit_no: { type: 'integer', description: '本层第几个回路（空开），1~6。用户说"第3个空开""第一回路"就填数字' },
            room: { type: 'string', description: '房号（按时找这间房所属的分路）' },
            floor: { type: 'integer', description: '楼层' },
            kind: { type: 'string', enum: ['light', 'socket', 'power'], description: '分路类型：照明/插座/动力' },
            circuit_sub: { type: 'integer', enum: [1, 2], description: '同类里的第几条：用户说"照明2""插座1""动力2"时填 1 或 2；只说类别不填，默认第 1 条' },
            main_switch: { type: 'boolean', description: '★ 总开关（进线断路器）：true = 操作这层配电箱最左边那只总开关，一断整层六路全停。用户说"总开关/总闸/总断路器/进线开关/整层断电/这层全停"时传 true，此时别同时传 circuit_no 或 kind' },
            action: { type: 'string', enum: ['off', 'on'], description: 'off=断电（默认），on=合闸' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_conduits',
        description: '【电·查墙里的管】查某面墙里埋了哪些线管：走向、标高、属于哪条分路、是哪一级（走廊干线 / 房间支线）、现在通不通。用户问"这面墙里有没有线/开洞会不会打到管/墙里埋了什么"时用；也可以在执行 open_passage / open_door / open_window 之前先探一眼。只查不改。场景里只显示这面墙命中的管线，其它全部收起。',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: '房号' },
            side: { type: 'string', enum: ['south', 'north', 'east', 'west', 'left', 'right', 'front', 'back'], description: '哪面墙；按镜头的话填 left 等' },
            floor: { type: 'integer', description: '楼层' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'focus_floor',
        description: '【视图·整体聚焦】把镜头和显隐整体聚焦到某一层，或回到全楼（floor=0）。聚焦后：本层不透明看得清，**本层以上的楼层和顶梁收起**（它们正好挡在这一层和镜头之间），**以下的楼层留 50% 半透明当参照**，管线也只画本层的。用户说"看 3 楼""整体看这层""切到 2 楼""到这层看看""回到全楼/整栋看看"时用。注意它和 focus_view 的分工：focus_view 是聚焦到**某间房/某台设备**并可以把别的藏起来；focus_floor 只管**楼层**这一级，不动房间。',
        parameters: {
          type: 'object',
          properties: {
            floor: { type: 'integer', description: '楼层号；0 = 回到全楼（整栋，全部楼层和管线都画出来）' }
          },
          required: ['floor']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'view_circuit',
        description: '【电·看回路走向】把某一条分路的完整走向单独画出来：本层主干立管 → 层配电箱 → 走廊干线 → 墙内下引 → 房间支线，别的分路整条不画，管身上有流动条纹表示电流方向，受影响的房间会高亮。这一屏**只留当前楼层**，当前楼层的墙、梁、柱 50% 半透明；管子粗细和接头跟"看所有分路"时完全一致。用户说"看看这一路怎么走的""这条线喂哪几间""查看回路""这条路从哪到哪"时用。只画不看状态，不改通断（改通断走 toggle_circuit）。',
        parameters: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: '分路编号，如 L3A' },
            circuit_no: { type: 'integer', description: '本层第几个回路（空开），1~6' },
            room: { type: 'string', description: '房号；按这间房所属的分路来找' },
            floor: { type: 'integer', description: '楼层' },
            kind: { type: 'string', enum: ['light', 'socket', 'power'], description: '分路类型：照明/插座/动力' },
            circuit_sub: { type: 'integer', enum: [1, 2], description: '同类里的第几条（照明2、插座1…）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_conduits',
        description: '【电·看管线】显示或隐藏线管，并决定看哪一层的管。scope=all → 看**所有楼层**的管线，此时整栋楼压到 20% 半透明（楼体仍然画出来，不是不显示）；scope=floor → **只看某一层**（默认当前聚焦层）：别的楼层整层收起，当前楼层的墙、梁、柱压到 50% 半透明；scope=off → 全部收起。用户说"看一下管线/把管子都显示出来/只看这层的管/关了管线"时用。★ 记住：管线只跟楼层有关，聚焦某层时永远只画那层；只有明确说"看所有管线/整栋的管"才用 scope=all。',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['all', 'floor', 'off'], description: 'all=所有楼层（楼体 20% 半透明）；floor=只看某层；off=收起' },
            floor: { type: 'integer', description: '楼层（scope=floor 时用；省略则用当前聚焦层）' }
          },
          required: ['scope']
        }
      }
    }
  ];

  T.names = T.tools.map(t => t.function.name);

  /* ---------------- 注册与调用 ---------------- */
  T.handlers = {};
  T.bind = function (map) { Object.assign(T.handlers, map || {}); return T; };
  T.has = function (name) { return typeof T.handlers[name] === 'function'; };

  T.log = [];        // 最近 20 次调用，诊断面板用

  T.call = async function (name, args) {
    const t0 = Date.now();
    const fn = T.handlers[name];
    if (!fn) {
      const out = { ok: false, say: '这个我暂时做不了（没有工具 ' + name + '）' };
      T.log.push({ name: name, args: args, ok: false, ms: 0 });
      return out;
    }
    try {
      const out = (await fn(args || {})) || {};
      T.log.push({ name: name, args: args, ok: out.ok !== false, ms: Date.now() - t0 });
      if (T.log.length > 20) T.log.shift();
      return out;
    } catch (e) {
      const out = { ok: false, say: '执行出错了：' + (e && e.message ? e.message : e) };
      T.log.push({ name: name, args: args, ok: false, ms: Date.now() - t0, err: String(e) });
      if (T.log.length > 20) T.log.shift();
      return out;
    }
  };

  /* 把工具返回值压成模型能读的一行，别把整棵场景树塞回去 */
  T.brief = function (out) {
    if (!out) return '{"ok":false}';
    const o = { ok: out.ok !== false };
    if (out.say) o.say = String(out.say).slice(0, 160);
    if (out.data) o.data = out.data;
    return JSON.stringify(o);
  };
})();
