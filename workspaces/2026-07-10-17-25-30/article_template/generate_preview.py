# -*- coding: utf-8 -*-
"""本地预览：把 {imgN} 占位符替换成 base64 data URI，输出单文件 preview.html

用法:
  cd articles/NNN_xxx/
  python generate_preview.py

铁律：
- 替换的是占位符本体 {imgN}，不是 <img src="{imgN}"> 整串
- 图片宽度超过 1080 先缩放，避免 base64 过大导致预览面板空白
- 输出必须带 <meta charset="UTF-8">
"""
import base64
import io
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COMICS = os.path.join(BASE_DIR, "comics")
COVERS = os.path.join(BASE_DIR, "covers")
MAXW = 1080


def find_img(ph):
    """按 封面(img0) / 正文漫画(imgN) 找文件"""
    cands = []
    if ph == 0:
        # 命名无关：封面可能是 cover_final.png 或唯一化后的 cover_<NNN>_final.png，这里 glob 全部 cover png
        cands = [os.path.join(COVERS, f) for f in (os.listdir(COVERS) if os.path.isdir(COVERS) else [])
                  if f.lower().endswith(".png") and f.lower().startswith("cover")]
        cands.append(os.path.join(COMICS, "img0.png"))
    else:
        cands = [os.path.join(COMICS, f"img{ph}.png"),
                 os.path.join(COMICS, f"img{ph}.jpg")]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def main():
    src = os.path.join(BASE_DIR, "article_body.html")
    with open(src, "r", encoding="utf-8") as f:
        html = f.read()

    phs = sorted(set(int(x) for x in re.findall(r"\{img(\d+)\}", html)))
    missing = []
    for ph in phs:
        token = f"{{img{ph}}}"
        fpath = find_img(ph)
        if not fpath or Image is None:
            html = html.replace(token, f"[图片 img{ph} 缺失]")
            missing.append(ph)
            continue
        im = Image.open(fpath).convert("RGB")
        if im.width > MAXW:
            im = im.resize((MAXW, int(im.height * MAXW / im.width)))
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        html = html.replace(token, "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())

    out = os.path.join(BASE_DIR, "preview.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write('<!DOCTYPE html>\n<meta charset="UTF-8">\n' + html)
    size_mb = os.path.getsize(out) / 1024 / 1024
    print(f"[OK] preview.html 已生成 → {out}（{size_mb:.2f} MB，base64 内嵌）")
    if missing:
        print("  缺失占位符:", missing)
    if size_mb > 10:
        print("  ⚠ 体积过大，预览面板可能空白，请缩小图片")


if __name__ == "__main__":
    main()
