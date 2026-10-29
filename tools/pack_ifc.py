# -*- coding: utf-8 -*-
"""把生成的 IFC 以 base64 内嵌到 web/data/ifc-data.js，保证离线也能下载"""
import base64, os

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(base, "outputs", "AIBIM_Haibin_Tower_A.ifc")
dst = os.path.join(base, "web", "data", "ifc-data.js")

b = open(src, "rb").read()
b64 = base64.b64encode(b).decode("ascii")
open(dst, "w", encoding="utf-8", newline="\n").write('window.BIM_IFC_B64="' + b64 + '";\n')
# 同时留一份实体文件给预览服务器
asr = os.path.join(base, "web", "assets")
os.makedirs(asr, exist_ok=True)
open(os.path.join(asr, "AIBIM_Haibin_Tower_A.ifc"), "wb").write(b)
print("ifc bytes:", len(b), "b64:", len(b64), "->", dst)
