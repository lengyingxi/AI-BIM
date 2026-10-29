# -*- coding: utf-8 -*-
"""
AIbim 运维系统 —— 建筑信息模型生成器
生成一份"可计算、可交互、可导出 IFC"的真实办公建筑模型：
  - 5 层现浇钢筋混凝土框架结构，标准层 33.0m x 15.6m
  - 9 个房间 + 走廊 + 楼梯间，楼板按房间独立建模（可单板验算）
  - 每层一套全新风系统（AHU + 走廊干管 + 分区阀 + 房间支管阀）
输出：
  web/data/model-data.js   给浏览器用的模型数据
  outputs/model.json       中间数据（供 IFC 生成器使用）
"""
import json, math, os

# ---------------------------------------------------------------- 基本参数
GRID_X = [0.0, 6.6, 13.2, 19.8, 26.4, 33.0]
Y_S, Y_CS, Y_CN, Y_N = 0.0, 6.6, 9.0, 15.6          # 南房间 / 走廊南 / 走廊北 / 北房间
FLOOR_H = {1: 4.5, 2: 3.9, 3: 3.9, 4: 3.9, 5: 3.9}
ELEV = {1: 0.0, 2: 4.5, 3: 8.4, 4: 12.3, 5: 16.2}
ROOF_ELEV = 20.1
COL_SIZE = 0.6
BEAM_W, BEAM_H = 0.3, 0.7

# 板配筋库（C30 / HRB400）
def slab(thk, dia, sp, cover=20):
    return dict(thk=thk, dia=dia, sp=sp, cover=cover, fc=14.3, ft=1.43, fy=360,
                grade="C30", steel="HRB400",
                asx=round(math.pi / 4 * dia ** 2 * 1000 / sp, 1),
                asy=round(math.pi / 4 * dia ** 2 * 1000 / sp, 1))

SLAB_STD   = slab(0.18, 12, 150)   # 常规办公 180 厚
SLAB_ARC   = slab(0.18, 12, 125)   # 档案室 5.0kN/m2
SLAB_PLANT = slab(0.20, 14, 150)   # 空调机房 7.0kN/m2
SLAB_CORR  = slab(0.12, 8, 150)    # 走廊 单向板
SLAB_STAIR = slab(0.15, 10, 150)   # 楼梯间

# 房间定义：序号, 区域, x0, x1, 名称, 活荷载标准值 kN/m2, 板参数
ROOM_DEFS = [
    (1, "south", 0.0, 6.6,  "开放办公区", 2.0, SLAB_STD),
    (2, "south", 6.6, 13.2, "洽谈室",     2.0, SLAB_STD),
    (3, "south", 13.2, 19.8, "档案室",    5.0, SLAB_ARC),
    (4, "south", 19.8, 26.4, "办公室",    2.0, SLAB_STD),
    (5, "south", 26.4, 33.0, "空调机房",  7.0, SLAB_PLANT),
    (6, "north", 0.0, 6.6,  "办公室",     2.0, SLAB_STD),
    (7, "north", 6.6, 13.2, "会议室",     2.0, SLAB_STD),
    (8, "north", 13.2, 19.8, "茶水间",    2.0, SLAB_STD),
    (9, "north", 19.8, 26.4, "值班室",    2.0, SLAB_STD),
]
CORE_DEF = (26.4, 33.0, 9.0, 15.6, "楼梯间", 3.5, SLAB_STAIR)

EQUIP_LIB = [
    dict(id="EQ-01", name="空气压缩机",   weight=1800, w=2.0, d=1.2, h=1.6, shape="box",  color="#4f7df3", note="含减振底座"),
    dict(id="EQ-02", name="UPS 电源柜",   weight=1200, w=1.6, d=0.9, h=2.0, shape="rack", color="#5b8def", note="双列并柜"),
    dict(id="EQ-03", name="精密空调机组", weight=900,  w=1.8, d=0.9, h=1.95, shape="box", color="#7c6cf0", note="上送风"),
    dict(id="EQ-04", name="消防水泵机组", weight=2400, w=2.2, d=1.4, h=1.5, shape="pump", color="#e08b3c", note="含控制柜"),
    dict(id="EQ-05", name="服务器机柜",   weight=800,  w=0.6, d=1.2, h=2.0, shape="rack", color="#4aa9c9", note="单柜满载"),
    dict(id="EQ-06", name="文件柜组",     weight=420,  w=2.0, d=0.5, h=1.8, shape="box",  color="#8b9aae", note="三组并排"),
    dict(id="EQ-07", name="实验台",       weight=350,  w=2.4, d=0.9, h=0.85, shape="box", color="#57b894", note="含试剂架"),
    dict(id="EQ-08", name="医用离心机",   weight=600,  w=1.2, d=0.8, h=1.2, shape="pump", color="#d4805f", note="运行时振动"),
    dict(id="EQ-09", name="新风机组",     weight=1500, w=2.6, d=1.1, h=1.8, shape="box",  color="#5f6b7a", note="吊装/落地"),
    dict(id="EQ-10", name="柴油发电机组", weight=3200, w=3.2, d=1.5, h=2.0, shape="box",  color="#c25b5b", note="应急电源"),
    dict(id="EQ-11", name="风冷冷水机组", weight=4500, w=3.4, d=1.8, h=2.1, shape="box",  color="#3f7fbf", note="屋面/设备层"),
    dict(id="EQ-12", name="干式变压器",   weight=3800, w=2.4, d=1.6, h=2.2, shape="rack", color="#5f6f8f", note="含防护外壳"),
]

rooms_out, walls_out, slabs_out, cols_out, beams_out = [], [], [], [], []
ducts_out, valves_out, doors_out, wins_out = [], [], [], []


def wall_id(lv, i):
    return "W-%dF-%03d" % (lv, i)


# ---------------------------------------------------------------- 建墙
def build_walls(lv, elev, wall_h):
    """返回该层墙体列表（含门窗洞口），并回填房间 sides 映射"""
    walls = []

    def add(kind, p1, p2, t, rooms_, name):
        walls.append(dict(id=wall_id(lv, len(walls) + 1), floor=lv, kind=kind,
                          p1=list(p1), p2=list(p2), t=t, h=round(wall_h, 3),
                          base=elev, rooms=rooms_, name=name, openings=[]))
        return walls[-1]

    # ---- 外围护墙（250 厚）
    w_s = add("ext", (0, Y_S), (33.0, Y_S), 0.25, [], "南外墙")
    w_n = add("ext", (0, Y_N), (33.0, Y_N), 0.25, [], "北外墙")
    w_w = add("ext", (0, Y_S), (0, Y_N), 0.25, [], "西外墙")
    w_e = add("ext", (33.0, Y_S), (33.0, Y_N), 0.25, [], "东外墙")
    # ---- 走廊两侧隔墙（200 厚）
    c1 = add("corr", (0, Y_CS), (33.0, Y_CS), 0.20, [], "南侧走廊隔墙")
    c2 = add("corr", (0, Y_CN), (33.0, Y_CN), 0.20, [], "北侧走廊隔墙")
    # ---- 房间隔墙（200 厚）
    for x in (6.6, 13.2, 19.8, 26.4):
        add("part", (x, Y_S), (x, Y_CS), 0.20, [], "南区内隔墙")
    for x in (6.6, 13.2, 19.8, 26.4):
        add("part", (x, Y_CN), (x, Y_N), 0.20, [], "北区内隔墙")

    return walls, dict(s=w_s, n=w_n, w=w_w, e=w_e, c1=c1, c2=c2)


def bound_wall(walls, room, side):
    """按房间边界找对应墙"""
    x0, y0, x1, y1 = room["x0"], room["y0"], room["x1"], room["y1"]
    for w in walls:
        (ax, ay), (bx, by) = w["p1"], w["p2"]
        if side in ("west", "east"):
            x = x0 if side == "west" else x1
            if abs(ax - x) < 1e-6 and abs(bx - x) < 1e-6:
                lo, hi = min(ay, by), max(ay, by)
                if lo <= y0 + 1e-6 and hi >= y1 - 1e-6:
                    return w["id"]
        else:
            y = y0 if side == "south" else y1
            if abs(ay - y) < 1e-6 and abs(by - y) < 1e-6:
                lo, hi = min(ax, bx), max(ax, bx)
                if lo <= x0 + 1e-6 and hi >= x1 - 1e-6:
                    return w["id"]
    return None


def add_opening(walls, wid, kind, at, ow, oh, sill, name):
    for wl in walls:
        if wl["id"] == wid:
            wl["openings"].append(dict(kind=kind, at=round(at, 3), w=ow, h=oh, sill=sill, name=name))
            return


# ---------------------------------------------------------------- 主循环
for lv in (1, 2, 3, 4, 5):
    elev = ELEV[lv]
    wall_h = round(FLOOR_H[lv] - 0.18, 3)
    walls, WREF = build_walls(lv, elev, wall_h)

    # ---- 房间
    floor_rooms = []
    for idx, zone, xa, xb, use, live, sl in ROOM_DEFS:
        y0, y1 = (Y_S, Y_CS) if zone == "south" else (Y_CN, Y_N)
        num = "%d%02d" % (lv, idx)
        r = dict(id=num, floor=lv, num=num, name=num + " " + use, use=use, live=live,
                 x0=round(xa, 3), y0=y0, x1=round(xb, 3), y1=y1,
                 area=round((xb - xa) * (y1 - y0), 2), zone=zone,
                 elev=elev, slab=sl)
        r["sides"] = {s: bound_wall(walls, r, s) for s in ("west", "east", "south", "north")}
        floor_rooms.append(r)

    # 走廊
    r = dict(id="%d00" % lv, floor=lv, num="%d00" % lv, name="%d00 走廊" % lv, use="走廊", live=2.5,
             x0=0.0, y0=Y_CS, x1=33.0, y1=Y_CN, area=round(33.0 * 2.4, 2), zone="corr",
             elev=elev, slab=SLAB_CORR)
    r["sides"] = dict(west=WREF["w"]["id"], east=WREF["e"]["id"], south=WREF["c1"]["id"], north=WREF["c2"]["id"])
    floor_rooms.append(r)

    # 楼梯间
    cx0, cx1, cy0, cy1, cuse, clive, csl = CORE_DEF
    r = dict(id="%d10" % lv, floor=lv, num="%d10" % lv, name="%d10 楼梯间" % lv, use="楼梯间", live=clive,
             x0=cx0, y0=cy0, x1=cx1, y1=cy1, area=round((cx1 - cx0) * (cy1 - cy0), 2), zone="core",
             elev=elev, slab=csl)
    r["sides"] = {s: bound_wall(walls, r, s) for s in ("west", "east", "south", "north")}
    floor_rooms.append(r)

    # ---- 门窗洞口
    for rr in floor_rooms:
        if rr["zone"] == "south":
            xc = (rr["x0"] + rr["x1"]) / 2
            add_opening(walls, rr["sides"]["north"], "door", xc - 1.8, 1.0, 2.1, 0.0, "M1021")
            add_opening(walls, rr["sides"]["south"], "window", xc, 1.8, 1.8, 0.9, "C1818")
        elif rr["zone"] == "north":
            xc = (rr["x0"] + rr["x1"]) / 2
            add_opening(walls, rr["sides"]["south"], "door", xc + 1.8, 1.0, 2.1, 0.0, "M1021")
            add_opening(walls, rr["sides"]["north"], "window", xc, 1.8, 1.8, 0.9, "C1818")
        elif rr["zone"] == "core":
            add_opening(walls, rr["sides"]["south"], "door", 29.7, 1.5, 2.1, 0.0, "M1521")
    # 西外墙：楼梯间采光窗 + 首层主入口
    add_opening(walls, WREF["w"]["id"], "window", 10.2, 1.8, 1.8, 0.9, "C1818")
    if lv == 1:
        add_opening(walls, WREF["w"]["id"], "door", Y_CS + 1.2, 2.4, 2.6, 0.0, "M2426")
    else:
        add_opening(walls, WREF["w"]["id"], "window", Y_CS + 1.2, 1.8, 1.8, 0.9, "C1818")

    # ---- 回填墙所属房间（按房间边界邻接，而非墙中点）
    wmap = {w["id"]: w for w in walls}
    for rr in floor_rooms:
        for side, wid in rr["sides"].items():
            if wid and wid in wmap and rr["id"] not in wmap[wid]["rooms"]:
                wmap[wid]["rooms"].append(rr["id"])

    # ---- 门 / 窗 独立构件（供属性查询与碰撞判断）
    for w in walls:
        (ax, ay), (bx, by) = w["p1"], w["p2"]
        L = math.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / L, (by - ay) / L
        for op in w["openings"]:
            px, py = ax + ux * op["at"], ay + uy * op["at"]
            rec = dict(id="%s-%s-%d" % (lv and "D" or "D", w["id"], op["at"] * 100),
                       kind=op["kind"], floor=lv, wall=w["id"], name=op["name"],
                       pos=[round(px, 3), round(py, 3), round(elev + op["sill"], 3)],
                       w=op["w"], h=op["h"], sill=op["sill"], rooms=w["rooms"],
                       dir=[round(ux, 3), round(uy, 3)], t=w["t"])
            if op["kind"] == "door":
                doors_out.append(rec)
            else:
                wins_out.append(rec)

    # ---- 楼板（每房间一块，可单板验算）
    for rr in floor_rooms:
        slabs_out.append(dict(id="S-" + rr["id"], floor=lv, room=rr["id"],
                              x0=rr["x0"], y0=rr["y0"], x1=rr["x1"], y1=rr["y1"],
                              top=round(elev, 3), thk=rr["slab"]["thk"], slab=rr["slab"]))

    # ---- 柱 / 梁
    for gx in GRID_X:
        for gy in (Y_S, Y_CS, Y_CN, Y_N):
            cols_out.append(dict(id="C-%d-%g-%g" % (lv, gx * 10, gy * 10), floor=lv,
                                 x=round(gx, 3), y=round(gy, 3), z=elev,
                                 s=COL_SIZE, h=round(FLOOR_H[lv] - 0.18, 3)))
    for gy in (Y_S, Y_CS, Y_CN, Y_N):
        beams_out.append(dict(id="BX-%d-%g" % (lv, gy * 10), floor=lv, axis="x",
                              a=[0.0, gy, elev + wall_h], b=[33.0, gy, elev + wall_h],
                              w=BEAM_W, h=BEAM_H))
    for gx in GRID_X:
        beams_out.append(dict(id="BY-%d-%g" % (lv, gx * 10), floor=lv, axis="y",
                              a=[gx, Y_S, elev + wall_h], b=[gx, Y_N, elev + wall_h],
                              w=BEAM_W, h=BEAM_H))

    # ---- 机电：新风系统（干管 + 分区阀 + 支管 + 支管阀）
    zk = round(elev + 2.45, 3)
    ahu_x, ahu_y = 30.2, 3.3
    trunk_y = 7.8
    # AHU 出口 → 走廊
    ducts_out.append(dict(id="DU-%d-1" % lv, floor=lv, a=[ahu_x, ahu_y + 0.9, zk], b=[ahu_x, trunk_y, zk], w=0.7, h=0.45))
    # 走廊干管
    ducts_out.append(dict(id="DU-%d-2" % lv, floor=lv, a=[ahu_x, trunk_y, zk], b=[1.6, trunk_y, zk], w=0.7, h=0.45))

    branch_info = []
    for rr in floor_rooms:
        if rr["zone"] in ("south", "north") and int(rr["num"][-2:]) != 5:
            xc = (rr["x0"] + rr["x1"]) / 2
            if rr["zone"] == "south":
                a, b = [xc, trunk_y, zk], [xc, 5.3, zk]
            else:
                a, b = [xc, trunk_y, zk], [xc, 10.3, zk]
            ducts_out.append(dict(id="DU-%d-B%s" % (lv, rr["num"]), floor=lv, a=a, b=b, w=0.45, h=0.3))
            branch_info.append((rr["id"], xc))

    # 阀件
    V = valves_out
    def valve(vid, name, room, pos, parent, serves, kind="branch"):
        V.append(dict(id=vid, floor=lv, name=name, room=room, pos=[round(p, 3) for p in pos],
                      parent=parent, serves=serves, kind=kind, open=True))

    v_main = "V%d00" % lv
    valve(v_main, "%dF 新风总阀" % lv, "%d05" % lv, [ahu_x, 5.9, zk], "AHU-%d" % lv, [], "main")
    v_e = "V%dE" % lv
    valve(v_e, "%dF 东区阀" % lv, "%d%02d" % (lv, 4), [24.9, trunk_y, zk], v_main, [], "zone")
    v_w = "V%dW" % lv
    valve(v_w, "%dF 西区阀" % lv, "%d%02d" % (lv, 3), [17.4, trunk_y, zk], v_main, [], "zone")
    for rid, xc in branch_info:
        parent = v_e if xc > 19.8 else v_w
        valve("V%dB%02d" % (lv, int(rid[-2:])), "%s 支管阀" % rid, rid, [xc, 7.2, zk], parent, [rid], "room")

    # 修正 v_main 位置：位于 405 机房内的支管上
    for v in V:
        if v["id"] == v_main:
            v["pos"] = [ahu_x, 5.9, zk]

    rooms_out.extend(floor_rooms)
    walls_out.extend(walls)


# ---------------------------------------------------------------- 汇总
model = dict(
    meta=dict(name="滨海科创中心 A 座", subtitle="标准办公楼层 · 现浇钢筋混凝土框架结构",
              system="AIbim 运维系统", floors=5, roof=ROOF_ELEV,
              area=round(33.0 * 15.6 * 5, 1),
              standards=["GB 50009-2012", "GB 50010-2010", "GB 50068-2018", "GB 50292-2015"],
              span=dict(x=GRID_X, y=[Y_S, Y_CS, Y_CN, Y_N]),
              note="结构安全等级二级，设计使用年限 50 年"),
    floors=[dict(level=lv, name="%dF" % lv, elev=ELEV[lv], height=FLOOR_H[lv]) for lv in (1, 2, 3, 4, 5)],
    rooms=rooms_out, walls=walls_out, slabs=slabs_out, columns=cols_out,
    beams=beams_out, doors=doors_out, windows=wins_out,
    ducts=ducts_out, valves=valves_out, equipmentLibrary=EQUIP_LIB,
    materials=dict(concrete="C30", steel="HRB400", deadFinish=1.5, deadUnit=25.0),
)

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(base, "web", "data"), exist_ok=True)
os.makedirs(os.path.join(base, "outputs"), exist_ok=True)

with open(os.path.join(base, "outputs", "model.json"), "w", encoding="utf-8") as f:
    json.dump(model, f, ensure_ascii=False, indent=1)

with open(os.path.join(base, "web", "data", "model-data.js"), "w", encoding="utf-8") as f:
    f.write("/* 由 build_model.py 生成 —— 滨海科创中心 A 座 BIM 数据 */\n")
    f.write("window.BIM_MODEL = ")
    json.dump(model, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print("rooms=%d walls=%d slabs=%d doors=%d windows=%d ducts=%d valves=%d cols=%d beams=%d"
      % (len(rooms_out), len(walls_out), len(slabs_out), len(doors_out), len(wins_out),
         len(ducts_out), len(valves_out), len(cols_out), len(beams_out)))
