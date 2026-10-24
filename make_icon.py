# -*- coding: utf-8 -*-
"""生成 EarthOnline 应用图标 icon.ico(深蓝底 + 青色辉光地球)。"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

S = 512  # 超采样画布


def draw_icon(size=256):
    # --- 超采样绘制 ---
    SS = 2
    W = S * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = 18 * SS
    # 圆角深蓝底
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=W // 4, fill=(4, 10, 24, 255))
    # 外圈辉光(用多次描边模拟)
    cx = cy = W // 2
    r = W // 2 - pad
    for i, a in enumerate((18, 34, 60, 110)):
        d.ellipse([cx - r - i * 6 * SS, cy - r - i * 6 * SS,
                   cx + r + i * 6 * SS, cy + r + i * 6 * SS],
                  outline=(74, 217, 255, a), width=4 * SS)

    # 地球体(径向渐变感:先填深蓝,再叠亮部)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(8, 34, 66, 255))
    # 昼光高光(左上)
    grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for i in range(60):
        t = i / 60
        rr = int(r * (1.05 - t * 0.55))
        alpha = int(26 * (1 - t))
        gd.ellipse([cx - r * 0.62 - rr, cy - r * 0.72 - rr,
                    cx - r * 0.62 + rr, cy - r * 0.72 + rr],
                   fill=(90, 200, 255, alpha))
    img = Image.alpha_composite(img, grad)
    d = ImageDraw.Draw(img)

    # 经纬线
    line = (74, 217, 255, 200)
    thin = (74, 217, 255, 120)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=line, width=5 * SS)
    # 纬线(椭圆)
    for fy in (-0.55, 0.0, 0.55):
        ry = r * (1 - abs(fy) * 0.0)  # 半径随纬度缩放
        y = cy + fy * r
        rx = r * math.sqrt(max(0.0, 1 - fy * fy))
        d.ellipse([cx - rx, y - rx * 0.30, cx + rx, y + rx * 0.30], outline=thin, width=4 * SS)
    # 经线(竖向椭圆)
    for fx in (-0.55, 0.0, 0.55):
        x = cx + fx * r
        ry = r
        rx = r * math.sqrt(max(0.0, 1 - fx * fx))
        d.ellipse([x - rx * 0.30, cy - ry, x + rx * 0.30, cy + ry], outline=thin, width=4 * SS)
    # 中央垂直/水平子午线加强
    d.line([cx, cy - r, cx, cy + r], fill=line, width=5 * SS)
    d.line([cx - r, cy, cx + r, cy], fill=line, width=5 * SS)

    # 事件光点(红/橙/绿 = 地震/火山/极光)
    import random
    random.seed(7)
    for col, n in (((255, 61, 109, 255), 5), ((255, 140, 60, 255), 6), ((80, 255, 160, 255), 3)):
        for _ in range(n):
            ang = random.uniform(0, math.tau)
            rad = random.uniform(0.15, 0.88) * r
            x = cx + math.cos(ang) * rad
            y = cy + math.sin(ang) * rad
            if (x - cx) ** 2 + (y - cy) ** 2 <= (r * 0.96) ** 2:
                pr = random.randint(6, 13) * SS
                d.ellipse([x - pr * 1.9, y - pr * 1.9, x + pr * 1.9, y + pr * 1.9],
                          fill=col[:3] + (46,))
                d.ellipse([x - pr, y - pr, x + pr, y + pr], fill=col)

    # 顶部青色渐变弧(品牌感)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=200, end=340,
          fill=(143, 233, 255, 255), width=7 * SS)

    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    icon = draw_icon(256)
    ico_path = os.path.join(base, "icon.ico")
    icon.save(ico_path, format="ICO",
              sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("written:", ico_path, os.path.getsize(ico_path))


if __name__ == "__main__":
    main()
