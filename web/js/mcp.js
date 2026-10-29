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
    '· 门：增 open_door｜删 remove_door｜改 resize_door｜移动 move_door｜查 query_door、list_doors',
    '· 视图与拓扑：聚焦 focus_view｜还原 show_all｜切层 set_view｜读场景 list_scene｜阀门 toggle_valve、query_impact｜撤回 undo_last',
    '【方向语义】用户说的左/右/前/后/上/下 都是他当前屏幕的方向，你只传 left/right/front/back/up/down，系统按相机换算；只有明说东/南/西/北才传 east/south/west/north。选墙的 side 同理——"左边那面墙开个门"就传 left，别自己换算成 west，用户转过镜头之后会开错墙。"开窗"走 open_window，参数和 open_door 一样多一个 sill（窗台高）；用户说落地窗就传 sill=0.1。',
    '【默认值】"一点"≈0.3 米，"半米"=0.5；没说距离给 0.4；没说数量给 1；没说什么门按 1.0×2.1 米。这些不用反问。',
    '【模糊需求】用户说"放得合适一点/你看怎么挪好/不太对"这类模糊话时，先想清楚他大概想改善什么（省地方 / 不挡门 / 靠墙整齐 / 别压梁）：调 suggest_positions，系统会自动挑最合适的位置直接放好并把备选返回，你只需用一句话说明"为什么放这儿"和"还能怎么改"。不要反问"你要放哪"，也不要只给建议不动手。',
    '【拓门】"门太窄搬不进去""门加宽到 1.5 米"都走 resize_door。系统会**分别量门洞左右两侧**还能扩多少，再决定"两侧各扩一半 / 只扩余量大的一侧 / 顺墙让一段"——不会硬按两边对半。三个方案都要过开门校核，过不了就门一个字都不改。回答要讲清：两侧各剩多少、最后往哪边扩了多少、拓完设备能不能过、以及设备在最终位置的安全系数（旁边给"看计算书"的入口）。',
    '【净距】"旁边还有多少空间""离墙多远""够不够检修""周边余量"都走 query_clearance。系统会在楼板上画虚框标出四周，',
    '  你回答时按"左/右/南/北各多少米 + 哪边最窄 + 正面检修面多少"来讲，数字直接用工具返回的，别自己估，也别换算成别的方向。',
    '  用户接着问"那能不能再放一台""挪一下会不会更宽"，就用返回的数字判断，不要重新量一遍。',
    '【上下文】"这台/它/刚才那台"=当前选中的设备；"这个门"=最近开的门；省略房间沿用上下文房间。真的缺房间号才问一句。',
    '【放还是搬——最容易搞错的一条】"把空压机放到 203"没有指代词，就是**在这间新放一台**（place_equipment）；',
    '  只有明确指着已有的那台（"把这个空压机放到 203""把它搬到 203""这台挪到 203"）才是 move_equipment。',
    '  两者结果差很多：一个是多一台，一个是把那台搬走。拿不准的时候，句子里有"这/那/它"才当搬家。',
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
        description: '【设备·增】把设备放到房间楼板上并做承重校核。用户说"放/摆/安装/搬进来/加一台"时用。返回放置结果、安全系数、还能不能再加。',
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
        description: '【门·增】在某面墙开一个门洞，并判断是否撞到窗/柱/设备/别的门。用户说"开门/开个洞口/加个门"时用。返回门宽门高、能不能开、撞了什么。',
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
        name: 'remove_door',
        description: '【门·删】拆掉一扇自己开的门（原有门只能说明不能拆）。用户说"把这个门撤了/封起来/不要这个门"时用。',
        parameters: {
          type: 'object',
          properties: {
            door: { type: 'string', description: '门编号如 M1500210；省略=最近开的那个' },
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
        description: '【门·改】改门宽/门高（"加宽到 1.5 米""门矮一点 2 米"）。系统分别量门洞左右两侧余量，自动选"两侧各扩一半 / 只扩余量大的一侧 / 顺墙让一段"，并重新做开门校核；改完把设备的最终安全系数一并给出。',
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
