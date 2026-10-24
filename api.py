# -*- coding: utf-8 -*-
"""EarthOnline 数据层:抓取实时地球数据,带缓存与离线样本回退。"""
import gzip
import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.request
import zipfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
SAMPLE_DIR = os.path.join(DATA_DIR, "samples")
CACHE_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "EarthOnline", "cache"
)
UA = "EarthOnline/1.0 (desktop earth dashboard; contact: earth.online@example.com)"

_locks = {}
_locks_guard = threading.Lock()
_mem = {}          # key -> (ts, payload)
_mem_lock = threading.Lock()


def _lock_for(key):
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def http_get(url, timeout=20, headers=None, binary=False):
    hdr = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw if binary else raw.decode("utf-8", "replace")


def get_json(url, timeout=20, headers=None):
    return json.loads(http_get(url, timeout=timeout, headers=headers))


def _read_sample(name):
    path = os.path.join(SAMPLE_DIR, name)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def _save_cache(key, payload):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(os.path.join(CACHE_DIR, key + ".json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        pass


def _load_cache(key):
    path = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def serve(key, fetch, ttl, sample_name=None):
    """统一入口:内存 TTL -> 抓取(失败落盘缓存/离线样本)。"""
    now = time.time()
    with _mem_lock:
        entry = _mem.get(key)
    if entry and now - entry[0] < ttl:
        return {"mode": "mem", "data": entry[1]}

    lk = _lock_for(key)
    with lk:
        with _mem_lock:
            entry = _mem.get(key)
        if entry and time.time() - entry[0] < ttl:
            return {"mode": "mem", "data": entry[1]}
        try:
            data = fetch()
            ts = time.time()
            with _mem_lock:
                _mem[key] = (ts, data)
            _save_cache(key, data)
            return {"mode": "live", "data": data}
        except Exception as exc:  # 网络失败 -> 缓存 -> 离线样本
            stale = _load_cache(key)
            if stale is not None:
                return {"mode": "stale", "data": stale, "error": str(exc)}
            if sample_name:
                sample = _read_sample(sample_name)
                if sample is not None:
                    return {"mode": "offline", "data": sample, "error": str(exc)}
            return {"mode": "error", "data": None, "error": str(exc)}


# ---------------------------------------------------------------- 各数据源

def fetch_earthquakes():
    """USGS 最近一周 M2.5+ 全球地震。"""
    feat = get_json(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson"
    )["features"]
    out = []
    for f in feat:
        p = f.get("properties") or {}
        c = (f.get("geometry") or {}).get("coordinates") or [0, 0, 0]
        out.append(
            {
                "id": f.get("id"),
                "mag": p.get("mag"),
                "place": p.get("place") or "",
                "time": p.get("time"),
                "lon": c[0],
                "lat": c[1],
                "depth": c[2],
                "url": p.get("url") or "",
                "tsunami": bool(p.get("tsunami")),
                "alert": p.get("alert"),
            }
        )
    out.sort(key=lambda x: x["time"] or 0, reverse=True)
    return out


def fetch_volcanoes():
    path = os.path.join(DATA_DIR, "volcanoes.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def fetch_wildfires():
    """NASA EONET 开放野火事件。"""
    j = get_json(
        "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&limit=300"
    )
    out = []
    for e in j.get("events", []):
        geoms = e.get("geometry") or []
        if not geoms:
            continue
        g = geoms[0]
        t = g.get("type")
        coords = g.get("coordinates")
        lon = lat = None
        if t == "Point":
            lon, lat = coords[0], coords[1]
        elif t == "Polygon" and coords and coords[0]:
            ring = coords[0]
            lon = sum(p[0] for p in ring) / len(ring)
            lat = sum(p[1] for p in ring) / len(ring)
        elif t == "LineString" and coords:
            lon = sum(p[0] for p in coords) / len(coords)
            lat = sum(p[1] for p in coords) / len(coords)
        if lon is None:
            continue
        out.append(
            {
                "id": e.get("id"),
                "title": e.get("title") or "",
                "lon": lon,
                "lat": lat,
                "date": (e.get("properties") or {}).get("date"),
                "category": ((e.get("categories") or [{}])[0]).get("title") or "Wildfire",
            }
        )
    return out


def fetch_typhoons():
    """日本气象厅 台风情报(含预报路径)。"""
    tcs = get_json("https://www.jma.go.jp/bosai/typhoon/data/targetTc.json")
    out = []
    for t in tcs:
        tc_id = t.get("tropicalCyclone")
        if not tc_id:
            continue
        specs = get_json(
            f"https://www.jma.go.jp/bosai/typhoon/data/{tc_id}/specifications.json"
        )
        name_en = name_jp = tc_id
        category = t.get("category") or ""
        track = []
        current = None
        for part in specs:
            if isinstance(part, dict) and part.get("part") == "title":
                nm = part.get("name") or {}
                name_en = nm.get("en") or name_en
                name_jp = nm.get("jp") or name_jp
                category = (part.get("category") or {}).get("en") or category
                continue
            if not isinstance(part, dict):
                continue
            pos = part.get("position") or {}
            deg = pos.get("deg")
            if not deg or len(deg) != 2:
                continue
            adv = part.get("advancedHours")
            if adv is None:
                continue
            entry = {
                "hours": adv,
                "lat": deg[0],
                "lon": deg[1],
                "pressure": part.get("pressure"),
                "wind_ms": ((part.get("maximumWind") or {}).get("sustained") or {}).get("m/s"),
                "gust_ms": ((part.get("maximumWind") or {}).get("gust") or {}).get("m/s"),
                "cat": (part.get("category") or {}).get("en"),
                "valid": ((part.get("validtime") or {}).get("UTC")),
            }
            track.append(entry)
            if adv == 0:
                current = entry
        if not track:
            continue
        out.append(
            {
                "id": tc_id,
                "number": t.get("typhoonNumber"),
                "name": name_en,
                "name_jp": name_jp,
                "category": category,
                "issue": t.get("issue"),
                "current": current or track[0],
                "track": track,
            }
        )
    return out


def _discover_nhc_storms():
    html = http_get("https://www.nhc.noaa.gov/gis/")
    return sorted(set(re.findall(r"((?:al|ep|cp)\d{6})_5day_latest\.zip", html, re.I)))


def fetch_hurricanes():
    """美国 NHC 飓风 5 天预报(zip 内含 shapefile)。"""
    import shapefile

    storms = []
    for sid in _discover_nhc_storms():
        try:
            blob = http_get(
                f"https://www.nhc.noaa.gov/gis/forecast/archive/{sid}_5day_latest.zip",
                binary=True,
                timeout=30,
            )
        except Exception:
            continue
        zf = zipfile.ZipFile(io.BytesIO(blob))
        names = zf.namelist()

        def _shp(suffix):
            for n in names:
                if n.lower().endswith(suffix):
                    return shapefile.Reader(
                        shp=io.BytesIO(zf.read(n)),
                        shx=io.BytesIO(zf.read(n[:-4] + ".shx")),
                        dbf=io.BytesIO(zf.read(n[:-4] + ".dbf")),
                    )
            return None

        pts_r = _shp("_pts.shp")
        pgn_r = _shp("_pgn.shp")
        lin_r = _shp("_lin.shp")
        if pts_r is None:
            continue
        fields = [f[0] for f in pts_r.fields[1:]]
        fcsts = []
        name = "Storm"
        for i in range(len(pts_r)):
            rec = dict(zip(fields, pts_r.record(i)))
            fcsts.append(
                {
                    "hours": rec.get("TAU"),
                    "lat": float(rec.get("LAT")),
                    "lon": float(rec.get("LON")),
                    "wind_kt": rec.get("MAXWIND"),
                    "pressure": None if rec.get("MSLP") in (None, 9999) else rec.get("MSLP"),
                    "cat": rec.get("STORMTYPE") or rec.get("TCDVLP"),
                    "valid": rec.get("VALIDTIME"),
                    "label": rec.get("DATELBL"),
                }
            )
            name = rec.get("STORMNAME") or name
        fcsts.sort(key=lambda x: x["hours"] or 0)
        cone = []
        if pgn_r is not None and len(pgn_r):
            sh = pgn_r.shape(0)
            cone = [[round(x, 4), round(y, 4)] for x, y in sh.points]
        track_line = []
        if lin_r is not None and len(lin_r):
            track_line = [
                [round(x, 4), round(y, 4)] for x, y in lin_r.shape(0).points
            ]
        storms.append(
            {
                "id": sid,
                "name": name,
                "basin": (fcsts[0].get("cat") and sid[:2].upper()) or sid[:2].upper(),
                "forecast": fcsts,
                "cone": cone,
                "track_line": track_line,
            }
        )
    return storms


def fetch_alerts():
    """美国 NWS 严重天气警报(带多边形几何)。"""
    j = get_json(
        "https://api.weather.gov/alerts/active?severity=Extreme,Severe",
        headers={"Accept": "application/geo+json"},
        timeout=30,
    )
    out = []
    for f in j.get("features", [])[:250]:
        p = f.get("properties") or {}
        geom = f.get("geometry")
        rings = []
        if geom and geom.get("type") == "Polygon":
            for ring in geom.get("coordinates", []):
                if len(ring) > 2:
                    rings.append([[round(x, 4), round(y, 4)] for x, y in ring])
        elif geom and geom.get("type") == "MultiPolygon":
            for poly in geom.get("coordinates", []):
                for ring in poly:
                    if len(ring) > 2:
                        rings.append([[round(x, 4), round(y, 4)] for x, y in ring])
        out.append(
            {
                "id": p.get("id"),
                "event": p.get("event") or "",
                "severity": p.get("severity") or "",
                "urgency": p.get("urgency") or "",
                "headline": p.get("headline") or "",
                "area": p.get("areaDesc") or "",
                "sender": p.get("senderName") or "",
                "sent": p.get("sent"),
                "expires": p.get("expires"),
                "instruction": (p.get("instruction") or "")[:600],
                "description": (p.get("description") or "")[:400],
                "rings": rings[:6],
            }
        )
    return out


def _kp_of(row, *keys):
    """从 NOAA 返回的行中取 Kp 数值(兼容 dict 与历史 list 格式)。"""
    if isinstance(row, dict):
        for key in keys + ("Kp", "kp", "k_index"):
            if row.get(key) is not None:
                try:
                    return float(row[key])
                except (TypeError, ValueError):
                    pass
        return None
    if isinstance(row, (list, tuple)) and len(row) >= 2:
        try:
            return float(row[1])
        except (TypeError, ValueError):
            return None
    return None


def fetch_aurora():
    """NOAA 行星 Kp 指数(极光强度)。观测为 dict 列表 {'time_tag','Kp',...},
    预报为 dict 列表 {'time_tag','kp','observed',...}。"""
    k = get_json("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
    fc = get_json(
        "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"
    )
    series = []
    if isinstance(k, list):
        for row in k:
            if isinstance(row, dict) and row.get("time_tag") is None:
                continue
            kp = _kp_of(row, "Kp", "kp")
            t = row.get("time_tag") if isinstance(row, dict) else (
                row[0] if isinstance(row, (list, tuple)) and row else None
            )
            if t is not None and kp is not None:
                series.append({"t": t, "kp": kp})
    forecast = []
    if isinstance(fc, list):
        for row in fc:
            if not isinstance(row, dict):
                continue
            kp = _kp_of(row, "kp", "Kp")
            t = row.get("time_tag")
            if t is None or kp is None:
                continue
            forecast.append(
                {"t": t, "kp": kp, "predicted": row.get("observed") == "predicted"}
            )
    # 当前值:取观测序列最新一条;若观测为空则用预报中的最新实测值
    latest = series[-1]["kp"] if series else None
    if latest is None:
        observed = [r["kp"] for r in forecast if not r.get("predicted")]
        latest = observed[-1] if observed else None
    return {"kp": latest, "series": series[-12:], "forecast": forecast[:27]}


def fetch_iss():
    """国际空间站实时位置 + 未来 90 分钟轨迹点。"""
    now = int(time.time())
    cur = get_json("https://api.wheretheiss.at/v1/satellites/25544")
    stamps = [now + d for d in range(0, 5401, 90)]
    path = []
    for i in range(0, len(stamps), 30):  # API 每次最多 30 个时间点
        chunk = ",".join(str(s) for s in stamps[i : i + 30])
        rows = get_json(
            f"https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps={chunk}"
        )
        for r in rows:
            path.append({"lat": r["latitude"], "lon": r["longitude"], "t": r["timestamp"]})
    return {"now": cur, "path": path}


def fetch_weather(lon, lat):
    """点击地点天气(Open-Meteo)。"""
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat:.4f}&longitude={lon:.4f}"
        "&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,"
        "relative_humidity_2m,weather_code,cloud_cover,is_day"
        "&timezone=auto"
    )
    j = get_json(url, timeout=15)
    return j.get("current") or {}


WMO_CODES = {
    0: "晴", 1: "基本晴朗", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
    51: "毛毛雨(小)", 53: "毛毛雨", 55: "毛毛雨(大)", 56: "冻毛毛雨", 57: "冻毛毛雨(大)",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨(大)",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨", 81: "强阵雨", 82: "暴阵雨", 85: "阵雪", 86: "强阵雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
}
