# -*- coding: utf-8 -*-
"""抓取各数据源样本存入 data/samples/,供断网回退。"""
import json
import os
import sys

import api

os.makedirs(api.SAMPLE_DIR, exist_ok=True)

TARGETS = [
    ("earthquakes.json", api.fetch_earthquakes),
    ("wildfires.json", api.fetch_wildfires),
    ("typhoons.json", api.fetch_typhoons),
    ("hurricanes.json", api.fetch_hurricanes),
    ("alerts.json", api.fetch_alerts),
    ("aurora.json", api.fetch_aurora),
    ("iss.json", api.fetch_iss),
]

failed = []
for name, fn in TARGETS:
    try:
        data = fn()
        path = os.path.join(api.SAMPLE_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        n = len(data) if isinstance(data, (list, dict)) else "?"
        print(f"OK {name}: {n}")
    except Exception as exc:
        failed.append(name)
        print(f"FAIL {name}: {exc}")

sys.exit(1 if failed else 0)
