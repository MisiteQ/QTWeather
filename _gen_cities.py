# -*- coding: utf-8 -*-
"""生成中国行政区划坐标库 cities_cn.json（省/市/县三级，来源：阿里 DataV GeoAtlas）"""
import json
import os
import urllib.request

URL = "https://datav.aliyun.com/areas_v3/bound/all.json"
# 输出到本仓库 fpk/app/static/cities_cn.json（跟随脚本所在目录，勿写死盘符）
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "fpk", "app", "static", "cities_cn.json")

req = urllib.request.Request(URL, headers={"User-Agent": "QWeather-Builder"})
with urllib.request.urlopen(req, timeout=60) as r:
    raw = json.loads(r.read().decode("utf-8"))

by_adcode = {e["adcode"]: e for e in raw}
entries = []
counts = {}
for e in raw:
    lv = e.get("level")
    if lv not in ("province", "city", "district"):
        continue
    counts[lv] = counts.get(lv, 0) + 1
    parent = by_adcode.get(e.get("parent"))
    # 沿父级链向上找到省份（district -> city -> province）
    prov = ""
    if lv == "province":
        prov = e["name"]
    else:
        p = parent
        while p:
            if p.get("level") == "province":
                prov = p["name"]
                break
            p = by_adcode.get(p.get("parent"))
    entries.append([e["name"], prov, round(e["lat"], 4), round(e["lng"], 4)])

with open(OUT, "w", encoding="utf-8") as f:
    f.write("[" + ",".join(json.dumps(x, ensure_ascii=False) for x in entries) + "]")

import os
print("levels:", counts, "total:", len(entries))
print("size:", os.path.getsize(OUT), "bytes")
# 抽查
for name in ("杭锦后旗", "杭州市", "北京", "深圳"):
    hits = [x for x in entries if x[0] == name or x[0].startswith(name)]
    for h in hits[:3]:
        print(h)
