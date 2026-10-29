# -*- coding: utf-8 -*-
"""由 model.json 生成 IFC4 文件（可在 Revit / BIMvision / IfcOpenShell 中打开）"""
import json, os, math, random, datetime

random.seed(20261026)
CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"

def guid():
    return "".join(random.choice(CHARS) for _ in range(22))

LINES = []
CID = [100]

def nid():
    CID[0] += 1
    return CID[0]

def add(text):
    i = nid()
    LINES.append("#%d=%s;" % (i, text))
    return i

def f(v):
    s = ("%.6f" % v).rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0."

def pt(x, y, z):
    return add("IFCCARTESIANPOINT((%s,%s,%s))" % (f(x), f(y), f(z)))

def direc(x, y, z):
    return add("IFCDIRECTION((%s,%s,%s))" % (f(x), f(y), f(z)))

def ax3(o, axis, ref):
    return add("IFCAXIS2PLACEMENT3D(#%d,#%d,#%d)" % (o, axis, ref))

# ------------------------------------------------------------------ 上下文
person = add("IFCPERSON($,'AIbim',$,$,$,$,$,$)")
org = add("IFCORGANIZATION($,'AIbim 运维系统',$,$,$)")
pao = add("IFCPERSONANDORGANIZATION(#%d,#%d,$)" % (person, org))
app = add("IFCAPPLICATION(#%d,'1.0','AIbim Model Builder','AIBIM')" % org)
owner_hist = add("IFCOWNERHISTORY(#%d,#%d,$,.ADDED.,$,$,$,0)" % (pao, app))

u_len = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
u_area = add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")
u_vol = add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")
u_ang = add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")
u_mass = add("IFCSIUNIT(*,.MASSUNIT.,$,.KILOGRAM.)")
units = add("IFCUNITASSIGNMENT((#%d,#%d,#%d,#%d,#%d))" % (u_len, u_area, u_vol, u_ang, u_mass))

o0 = pt(0, 0, 0)
dz = add("IFCDIRECTION((0.,0.,1.))")
dx = add("IFCDIRECTION((1.,0.,0.))")
wcs = ax3(o0, dz, dx)
ctx = add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#%d,#%d)" % (wcs, dx))
subctx = add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#%d,$,.MODEL_VIEW.,$)" % ctx)

# ------------------------------------------------------------------ 项目结构
proj = add("IFCPROJECT('%s',#%d,'AIbim 滨海科创中心 A 座',$,$,$,$,(#%d),#%d)"
           % (guid(), owner_hist, ctx, units))
site_pl = ax3(o0, dz, dx)
site = add("IFCSITE('%s',#%d,'项目场地',$,$,#%d,$,$,.ELEMENT.,$,$,$,$,$)"
           % (guid(), owner_hist, site_pl))
bld_pl = ax3(o0, dz, dx)
bld = add("IFCBUILDING('%s',#%d,'滨海科创中心 A 座',$,$,#%d,$,$,.ELEMENT.,$,$,$)"
          % (guid(), owner_hist, bld_pl))
add("IFCRELAGGREGATES('%s',#%d,$,$,#%d,(#%d))" % (guid(), owner_hist, proj, site))
add("IFCRELAGGREGATES('%s',#%d,$,$,#%d,(#%d))" % (guid(), owner_hist, site, bld))

M = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "outputs", "model.json"), encoding="utf-8"))

storeys = []
for fl in M["floors"]:
    pl = ax3(pt(0, 0, fl["elev"]), dz, dx)
    s = add("IFCBUILDINGSTOREY('%s',#%d,'%s',$,$,#%d,$,$,.ELEMENT.,%s)"
            % (guid(), owner_hist, fl["name"], pl, f(fl["elev"])))
    storeys.append((fl["level"], s))
add("IFCRELAGGREGATES('%s',#%d,$,$,#%d,(%s))"
    % (guid(), owner_hist, bld, ",".join("#%d" % s for _, s in storeys)))
STOREY = dict(storeys)
CONTENTS = {lv: [] for lv in STOREY}


# ------------------------------------------------------------------ 几何工具
def rect_profile(w, h):
    return add("IFCRECTANGLEPROFILEDEF(.AREA.,$, $,%s,%s)" % (f(w), f(h)))


def box_solid(origin, zdir, xdim, ydim, length):
    """沿 zdir 挤出，截面 xdim(局部X) × ydim(局部Y=竖向)"""
    ox, oy, oz = origin
    zx, zy, zz = zdir
    # 局部 X = up × Z
    xx, xy, xz = 0.0 * zz - 1.0 * zy, 1.0 * zx - 0.0 * zz, 0.0 * zy - 0.0 * zx
    n = math.sqrt(xx * xx + xy * xy + xz * xz) or 1.0
    xx, xy, xz = xx / n, xy / n, xz / n
    p = pt(ox, oy, oz)
    pl = ax3(p, direc(zx, zy, zz), direc(xx, xy, xz))
    prof = rect_profile(xdim, ydim)
    return add("IFCEXTRUDEDAREASOLID(#%d,#%d,#%d,%s)"
               % (prof, pl, dz, f(length)))


def prod_shape(solids):
    rep = add("IFCSHAPEREPRESENTATION(#%d,'Body','SweptSolid',(%s))"
              % (subctx, ",".join("#%d" % s for s in solids)))
    return add("IFCPRODUCTDEFINITIONSHAPE($,$,(#%d))" % rep)


def wall_solids(w):
    (ax_, ay), (bx, by) = w["p1"], w["p2"]
    L = math.hypot(bx - ax_, by - ay)
    ux, uy = (bx - ax_) / L, (by - ay) / L
    t, h, base = w["t"], w["h"], w["base"]
    ops = sorted(w["openings"], key=lambda o: o["at"])
    segs, cur = [], 0.0
    for o in ops:
        s0 = max(0.0, o["at"] - o["w"] / 2)
        s1 = min(L, o["at"] + o["w"] / 2)
        if s0 > cur + 1e-6:
            segs.append((cur, s0, 0.0, h))
        # 洞口上/下
        if o["h"] + o["sill"] < h - 1e-6:
            segs.append((s0, s1, o["sill"] + o["h"], h))
        if o["sill"] > 1e-6:
            segs.append((s0, s1, 0.0, o["sill"]))
        cur = max(cur, s1)
    if cur < L - 1e-6:
        segs.append((cur, L, 0.0, h))
    solids = []
    for s0, s1, z0, z1 in segs:
        if s1 - s0 < 1e-4 or z1 - z0 < 1e-4:
            continue
        origin = (ax_ + ux * s0, ay + uy * s0, base + (z0 + z1) / 2.0)
        solids.append(box_solid(origin, (ux, uy, 0.0), t, z1 - z0, s1 - s0))
    return solids


def pset(name, props, obj, owner):
    pvs = []
    for k, v, typ in props:
        if typ == "real":
            val = "IFCREAL(%s)" % f(v)
        elif typ == "int":
            val = "IFCINTEGER(%d)" % int(v)
        else:
            val = "IFCLABEL('%s')" % str(v).replace("'", "")
        pvs.append(add("IFCPROPERTYSINGLEVALUE('%s',$,%s,$)" % (k, val)))
    ps = add("IFCPROPERTYSET('%s',#%d,'%s',$,(%s))"
             % (guid(), owner, name, ",".join("#%d" % p for p in pvs)))
    add("IFCRELDEFINESBYPROPERTIES('%s',#%d,$,$,(#%d),#%d)" % (guid(), owner, obj, ps))


# ------------------------------------------------------------------ 楼板
for s in M["slabs"]:
    x0, y0, x1, y1 = s["x0"], s["y0"], s["x1"], s["y1"]
    thk = s["thk"]
    sol = box_solid(((x0 + x1) / 2, (y0 + y1) / 2, s["top"] - thk), (0, 0, 1), x1 - x0, y1 - y0, thk)
    sh = prod_shape([sol])
    pl = ax3(pt(0, 0, 0), dz, dx)
    p = add("IFCSLAB('%s',#%d,'%s 楼板',$,$,#%d,#%d,$,.FLOOR.)"
            % (guid(), owner_hist, s["room"], pl, sh))
    CONTENTS[s["floor"]].append(p)
    pset("Pset_SlabCommon", [("板厚", thk * 1000, "real"), ("混凝土强度等级", s["slab"]["grade"], "label"),
                             ("配筋", "%d@%d 双层双向" % (s["slab"]["dia"], s["slab"]["sp"]), "label"),
                             ("楼面活荷载标准值", 0.0, "real")], p, owner_hist)

# ------------------------------------------------------------------ 墙
for w in M["walls"]:
    sol = wall_solids(w)
    if not sol:
        continue
    sh = prod_shape(sol)
    pl = ax3(pt(0, 0, 0), dz, dx)
    p = add("IFCWALLSTANDARDCASE('%s',#%d,'%s',$,$,#%d,#%d,$,.SOLIDWALL.)"
            % (guid(), owner_hist, w["name"], pl, sh))
    CONTENTS[w["floor"]].append(p)

# ------------------------------------------------------------------ 柱 / 梁
for c in M["columns"]:
    sol = box_solid((c["x"], c["y"], c["z"]), (0, 0, 1), c["s"], c["s"], c["h"])
    sh = prod_shape([sol])
    p = add("IFCCOLUMN('%s',#%d,'框架柱 %gx%g',$,$,#%d,#%d,$,.COLUMN.)"
            % (guid(), owner_hist, c["x"], c["y"], ax3(pt(0, 0, 0), dz, dx), sh))
    CONTENTS[c["floor"]].append(p)

for b in M["beams"]:
    (ax_, ay, az) = b["a"]
    (bx, by, bz) = b["b"]
    L = math.hypot(bx - ax_, by - ay)
    ux, uy = (bx - ax_) / L, (by - ay) / L
    sol = box_solid((ax_, ay, az - b["h"] / 2.0), (ux, uy, 0), b["w"], b["h"], L)
    sh = prod_shape([sol])
    p = add("IFCBEAM('%s',#%d,'框架梁 %sx%d',$,$,#%d,#%d,$,.BEAM.)"
            % (guid(), owner_hist, "纵向" if b["axis"] == "x" else "横向", b["h"] * 1000,
               ax3(pt(0, 0, 0), dz, dx), sh))
    CONTENTS[b["floor"]].append(p)

# ------------------------------------------------------------------ 房间空间
for r in M["rooms"]:
    x0, y0, x1, y1 = r["x0"], r["y0"], r["x1"], r["y1"]
    hh = 2.9
    sol = box_solid(((x0 + x1) / 2, (y0 + y1) / 2, r["elev"]), (0, 0, 1), x1 - x0, y1 - y0, hh)
    sh = prod_shape([sol])
    p = add("IFCSPACE('%s',#%d,'%s',$,$,#%d,#%d,'%s',.ELEMENT.,$,$)"
            % (guid(), owner_hist, r["name"], ax3(pt(0, 0, 0), dz, dx), sh, r["use"]))
    CONTENTS[r["floor"]].append(p)
    lx, ly = x1 - x0, y1 - y0
    pset("Pset_SpaceCommon", [("Category", r["use"], "label"), ("GrossPlannedArea", r["area"], "real")], p, owner_hist)
    pset("Pset_AIBIM_RoomLoad", [
        ("房间编号", r["num"], "label"),
        ("楼面活荷载标准值", r["live"], "real"),
        ("板厚", r["slab"]["thk"] * 1000, "real"),
        ("板跨X", lx, "real"), ("板跨Y", ly, "real"),
        ("混凝土强度等级", r["slab"]["grade"], "label"),
        ("配筋", "%d@%d" % (r["slab"]["dia"], r["slab"]["sp"]), "label"),
    ], p, owner_hist)

# ------------------------------------------------------------------ 门窗
for d in M["doors"] + M["windows"]:
    px, py, pz = d["pos"]
    ux, uy = d["dir"]
    base = pz if d["kind"] == "door" else d["pos"][2]
    if d["kind"] == "door":
        origin = (px - ux * d["w"] / 2, py - uy * d["w"] / 2, base + d["h"] / 2.0)
        thk = max(d["t"] * 0.6, 0.05)
        sol = box_solid(origin, (ux, uy, 0), thk, d["h"], d["w"])
        sh = prod_shape([sol])
        p = add("IFCDOOR('%s',#%d,'%s %s',$,$,#%d,#%d,$,%s,%s,$,.DOOR.,.SINGLE_SWING_LEFT.,$)"
                % (guid(), owner_hist, d["name"], "新增门" if d.get("added") else "原有门",
                   ax3(pt(0, 0, 0), dz, dx), sh, f(d["h"]), f(d["w"])))
    else:
        origin = (px - ux * d["w"] / 2, py - uy * d["w"] / 2, base + d["h"] / 2.0)
        sol = box_solid(origin, (ux, uy, 0), 0.03, d["h"], d["w"])
        sh = prod_shape([sol])
        p = add("IFCWINDOW('%s',#%d,'%s 窗',$,$,#%d,#%d,$,%s,%s,$,.WINDOW.,.SINGLE_PANEL.,$)"
                % (guid(), owner_hist, d["name"], ax3(pt(0, 0, 0), dz, dx), sh, f(d["h"]), f(d["w"])))
    CONTENTS[d["floor"]].append(p)

# ------------------------------------------------------------------ 风管 / 阀件
for du in M["ducts"]:
    ax_, ay, az = du["a"]
    bx, by, bz = du["b"]
    L = math.sqrt((bx - ax_) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
    if L < 1e-6:
        continue
    ux, uy, uz = (bx - ax_) / L, (by - ay) / L, (bz - az) / L
    sol = box_solid((ax_, ay, az), (ux, uy, uz), du["w"], du["h"], L)
    sh = prod_shape([sol])
    p = add("IFCDUCTSEGMENT('%s',#%d,'矩形风管 %dx%d',$,$,#%d,#%d,$,.RIGIDSEGMENT.)"
            % (guid(), owner_hist, du["w"] * 1000, du["h"] * 1000, ax3(pt(0, 0, 0), dz, dx), sh))
    CONTENTS[du["floor"]].append(p)

for v in M["valves"]:
    px, py, pz = v["pos"]
    sol = box_solid((px, py, pz), (0, 0, 1), 0.42, 0.42, 0.58)
    sh = prod_shape([sol])
    p = add("IFCVALVE('%s',#%d,'%s',$,$,#%d,#%d,$,.ISOLATING.)"
            % (guid(), owner_hist, v["name"], ax3(pt(0, 0, 0), dz, dx), sh))
    CONTENTS[v["floor"]].append(p)
    pset("Pset_AIBIM_Valve", [("阀门编号", v["id"], "label"), ("阀门类型",
         {"main": "楼层总阀", "zone": "分区阀", "room": "房间支管阀"}.get(v["kind"], "阀门"), "label"),
        ("所在房间", v["room"], "label"), ("状态", "开启", "label")], p, owner_hist)

# ------------------------------------------------------------------ 归属关系
for lv, sid in storeys:
    if CONTENTS[lv]:
        add("IFCRELCONTAINEDINSPATIALSTRUCTURE('%s',#%d,$,$,(%s),#%d)"
            % (guid(), owner_hist, ",".join("#%d" % e for e in CONTENTS[lv]), sid))

TS = datetime.datetime(2026, 10, 26, 15, 0, 0).strftime("%Y-%m-%dT%H:%M:%S")
out = ["ISO-10303-21;", "HEADER;",
       "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
       "FILE_NAME('AIBIM_Haibin_Tower_A.ifc','%s',('AIbim'),('AIbim 运维系统'),'AIbim Model Builder 1.0','AIbim','');" % TS,
       "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;"]
out += LINES
out += ["ENDSEC;", "END-ISO-10303-21;"]

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(base, "outputs", "AIBIM_Haibin_Tower_A.ifc")
open(p, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("IFC written:", p, len(out), "lines", "entities:", len(LINES))
