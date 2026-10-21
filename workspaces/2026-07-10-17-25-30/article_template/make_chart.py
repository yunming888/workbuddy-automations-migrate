# -*- coding: utf-8 -*-
"""正文配图：72 小时对照实验数据条（Pillow 画，中文不乱码）
说明：本号是民生评论，不走漫画；用一张干净的数据图代替，比豆包出图快且可控。
"""
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

W, H = 1080, 700
BG = (250, 250, 247)
ORANGE = (227, 93, 40)
DARK = (26, 26, 46)
GREY = (120, 120, 130)


def font(size, bold=True):
    for p in (r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
              r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

f_title = font(46)
f_label = font(34, bold=False)
f_num = font(38)
f_note = font(28, bold=False)

d.text((70, 56), "72 小时后，同一批蔬菜的甲醛含量", font=f_title, fill=DARK)
d.line([(70, 130), (1010, 130)], fill=(225, 225, 218), width=2)

# 条形
bar_x, bar_top, bar_h, gap = 70, 190, 110, 60
max_w = 700

rows = [
    ("外卖保温袋", "高出 3~5 倍", max_w, ORANGE),
    ("食品级保鲜袋", "基准值", int(max_w * 0.24), (150, 170, 190)),
]

for i, (name, note, bw, color) in enumerate(rows):
    y = bar_top + i * (bar_h + gap)
    d.rectangle([bar_x, y, bar_x + bw, y + bar_h], fill=color)
    d.text((bar_x, y - 46), name, font=f_label, fill=DARK)
    d.text((bar_x + bw + 24, y + bar_h // 2 - 22), note, font=f_num, fill=color)

d.line([(70, 500), (1010, 500)], fill=(225, 225, 218), width=2)
d.text((70, 530), "数据来源：半岛晨报 2026-09-09 报道的对照实验；", font=f_note, fill=GREY)
d.text((70, 572), "央视新闻、中国经济网综合报道（2026-09-07）", font=f_note, fill=GREY)
d.text((70, 630), "制图：公众号变现实战", font=f_note, fill=(190, 190, 195))

os.makedirs("comics", exist_ok=True)
out = os.path.join("comics", "img1.png")
img.save(out)
print("[OK] 配图已生成:", os.path.abspath(out))
