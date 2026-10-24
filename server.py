# -*- coding: utf-8 -*-
"""EarthOnline 本地服务器:静态 web/ + /api/* 数据接口。"""
import json
import mimetypes
import os
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import api

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

# 图层刷新周期(秒)
TTL = {
    "earthquakes": 120,
    "wildfires": 600,
    "typhoons": 600,
    "hurricanes": 900,
    "alerts": 180,
    "aurora": 300,
    "iss": 15,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默
        pass

    # ------------------------------------------------------------ helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype=None, cache=True):
        if not os.path.isfile(path):
            self._json({"ok": False, "error": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache and ctype.startswith(("image/", "font/", "application/javascript")):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api(self, key, fetch, ttl, sample=None):
        try:
            self._json(api.serve(key, fetch, ttl, sample))
        except Exception:
            traceback.print_exc()
            self._json({"mode": "error", "data": None, "error": "internal"}, 500)

    # ------------------------------------------------------------ routing
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            self._route_api(path[5:], parse_qs(parsed.query))
            return

        if path == "/":
            path = "/index.html"
        # 阻止目录穿越(含 Windows 反斜杠变体)
        full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(WEB_DIR + os.sep):
            self._json({"ok": False, "error": "forbidden"}, 403)
            return
        self._file(full)

    def _route_api(self, name, qs):
        if name == "earthquakes":
            self._api("earthquakes", api.fetch_earthquakes, TTL["earthquakes"], "earthquakes.json")
        elif name == "volcanoes":
            self._json({"mode": "live", "data": api.fetch_volcanoes()})
        elif name == "wildfires":
            self._api("wildfires", api.fetch_wildfires, TTL["wildfires"], "wildfires.json")
        elif name == "typhoons":
            self._api("typhoons", api.fetch_typhoons, TTL["typhoons"], "typhoons.json")
        elif name == "hurricanes":
            self._api("hurricanes", api.fetch_hurricanes, TTL["hurricanes"], "hurricanes.json")
        elif name == "alerts":
            self._api("alerts", api.fetch_alerts, TTL["alerts"], "alerts.json")
        elif name == "aurora":
            self._api("aurora", api.fetch_aurora, TTL["aurora"], "aurora.json")
        elif name == "iss":
            self._api("iss", api.fetch_iss, TTL["iss"], "iss.json")
        elif name == "weather":
            try:
                lon = float((qs.get("lon") or ["0"])[0])
                lat = float((qs.get("lat") or ["0"])[0])
                cur = api.fetch_weather(lon, lat)
                code = cur.get("weather_code")
                self._json(
                    {
                        "mode": "live",
                        "data": {
                            "temp": cur.get("temperature_2m"),
                            "feels": cur.get("apparent_temperature"),
                            "wind": cur.get("wind_speed_10m"),
                            "wind_dir": cur.get("wind_direction_10m"),
                            "humidity": cur.get("relative_humidity_2m"),
                            "cloud": cur.get("cloud_cover"),
                            "is_day": cur.get("is_day"),
                            "code": code,
                            "text": api.WMO_CODES.get(code, "未知"),
                            "time": cur.get("time"),
                        },
                    }
                )
            except Exception as exc:
                self._json({"mode": "error", "data": None, "error": str(exc)}, 200)
        elif name == "countries":
            self._file(os.path.join(api.DATA_DIR, "countries.geo.json"), "application/geo+json")
        else:
            self._json({"ok": False, "error": "unknown api"}, 404)


def make_server(port=0):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return srv


if __name__ == "__main__":
    # 无窗口模式:只用浏览器打开 http://127.0.0.1:8080
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = make_server(port)
    print(f"Earth Online 已启动 → http://127.0.0.1:{srv.server_address[1]}")
    print("Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
