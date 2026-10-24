# -*- coding: utf-8 -*-
"""EarthOnline — 实况地球桌面客户端入口。"""
import os
import sys
import threading

# 必须在导入 webview 之前指定 GUI 后端(优先 EdgeChromium/WebView2)
os.environ.setdefault("PYWEBVIEW_GUI", "edgechromium")

import webview

from server import make_server


def resource_path(*parts):
    """兼容 PyInstaller onefile 打包后的资源路径。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def main():
    # 打包后 web/data 在 _MEIPASS 下,server/api 依赖 BASE_DIR,这里做重定向
    if getattr(sys, "frozen", False):
        import server as server_mod
        import api as api_mod
        server_mod.WEB_DIR = resource_path("web")
        server_mod.BASE_DIR = resource_path()
        api_mod.DATA_DIR = resource_path("data")
        api_mod.SAMPLE_DIR = resource_path("data", "samples")

    srv = make_server(0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    class Api:
        def open_external(self, url):
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                import webbrowser
                webbrowser.open(url)

        def close(self):
            for w in webview.windows:
                w.destroy()

    webview.settings["ALLOW_FILE_URLS"] = False
    webview.create_window(
        "Earth Online — 实况地球",
        f"http://127.0.0.1:{port}/",
        width=1440, height=900,
        min_size=(960, 640),
        background_color="#02060f",
        text_select=False,
        easy_drag=False,
        js_api=Api(),
    )
    try:
        webview.start(gui="edgechromium", debug=False)
    except Exception:
        # WebView2 不可用时退回默认后端
        webview.start()
    srv.shutdown()


def _log_crash():
    """无控制台时把异常写入日志,便于排查。"""
    import time
    import traceback
    try:
        logdir = os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "EarthOnline"
        )
        os.makedirs(logdir, exist_ok=True)
        with open(os.path.join(logdir, "crash.log"), "a", encoding="utf-8") as f:
            f.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
            f.write(traceback.format_exc())
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        _log_crash()
        raise
