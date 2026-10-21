# -*- coding: utf-8 -*-
"""封面生成（Pillow 兜底版，无需 playwright / 无外部模板依赖）

用法:
  python generate_cover.py "封面短标题" "副标题" --tag "标签" --size 1080x460

封面标题铁律：≤10 个中文字符（最好 6-8 字），必须单独设置，不能照抄文章标题。
尺寸默认 1080x460（公众号头条 2.35:1；skill 文档写的 900x500 会被微信裁切，已改）。
输出: covers/cover_final.png
"""
import argparse
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

FONT_CANDS = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def load_font(size, bold=True):
    for i, p in enumerate(FONT_CANDS):
        if not os.path.exists(p):
            continue
        if not bold and i == 0:
            continue
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def gradient(size, c1, c2):
    w, h = size
    base = Image.new("RGB", size, c1)
    top = Image.new("RGB", size, c2)
    mask = Image.new("L", (w, h))
    md = ImageDraw.Draw(mask)
    for y in range(h):
        md.line([(0, y), (w, y)], fill=int(255 * y / max(h - 1, 1)))
    return Image.composite(top, base, mask)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("title", help="封面短标题（≤10 字）")
    ap.add_argument("subtitle", nargs="?", default="")
    ap.add_argument("--tag", default="")
    ap.add_argument("--size", default="1080x460")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    w, h = (int(x) for x in a.size.lower().split("x"))
    if len(a.title) > 10:
        print(f"⚠ 封面标题 {len(a.title)} 字，超过 10 字会溢出，建议缩短")

    img = gradient((w, h), (26, 26, 46), (22, 33, 62))
    d = ImageDraw.Draw(img)

    # 左侧橙色竖条
    d.rectangle([0, 0, max(12, w // 90), h], fill=(227, 93, 40))

    # 标签（右上小字）
    if a.tag:
        f_tag = load_font(int(h * 0.075), bold=False)
        tw = d.textlength(a.tag, font=f_tag)
        d.text((w - tw - int(w * 0.045), int(h * 0.16)), a.tag,
               font=f_tag, fill=(227, 93, 40))

    # 主标题
    f_main = load_font(int(h * 0.26), bold=True)
    d.text((int(w * 0.075), int(h * 0.26)), a.title, font=f_main, fill=(255, 255, 255))

    # 副标题
    if a.subtitle:
        f_sub = load_font(int(h * 0.10), bold=False)
        d.text((int(w * 0.078), int(h * 0.60)), a.subtitle, font=f_sub, fill=(190, 190, 200))

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    covers = os.path.join(os.path.dirname(os.path.abspath(__file__)), "covers")
    os.makedirs(covers, exist_ok=True)
    # 唯一化命名：按所在文章目录编号(如 008_跨省看病→008)输出 cover_<NNN>_final.png，
    # 避免多篇共用同名 cover_final.png 导致微信素材库按名匹配时误选旧封面(贴图重复根因)。
    _adir = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
    _nnn = _adir[:3] if _adir[:3].isdigit() else None
    out = a.out or (os.path.join(covers, "cover_%s_final.png" % _nnn)
                     if _nnn else os.path.join(covers, "cover_final.png"))
    img.save(out)
    print("[OK] 封面已生成:", os.path.abspath(out), f"{w}x{h}")


if __name__ == "__main__":
    main()
