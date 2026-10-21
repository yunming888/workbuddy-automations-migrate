# -*- coding: utf-8 -*-
"""数字叠加封面生成器：为头条【职场读书】生成 1200x800(3:2) 高CTR封面
用法: python gen_covers.py  → 输出 covers/cover_*.png
可复用模板：改 TOPICS 列表即可换主题；文字/数字/配色全部像素级可控，无 AI 乱码。
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 800
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'covers')
os.makedirs(OUT, exist_ok=True)

FNUM = r'C:\Windows\Fonts\arialbd.ttf'      # 数字粗体
FCN = r'C:\Windows\Fonts\Dengb.ttf'          # 等线粗体(中文)
FALLBACK = r'C:\Windows\Fonts\arial.ttf'

def F(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.truetype(FALLBACK, size)

def has_cjk(s):
    """字符串是否含中日韩字符"""
    for ch in s:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0xF900 <= cp <= 0xFAFF:
            return True
    return False

def pick_num_font(s, f_ascii, f_cn):
    """字符串含中文→用中文粗体；纯数字/ASCII→用 arialbd（更粗更醒目）"""
    return f_cn if has_cjk(s) else f_ascii

def hgrad(top, bottom):
    """垂直渐变背景"""
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    return img

def glow_circle(draw, cx, cy, r, color):
    """半透明光晕装饰"""
    for rr in range(r, 0, -6):
        a = int(18 * (1 - rr / r))
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=color + (a,))

def text_center(draw, cx, y, txt, font, fill, shadow=None):
    """水平居中绘制(带可选阴影)"""
    b = draw.textbbox((0, 0), txt, font=font)
    tw, th = b[2] - b[0], b[3] - b[1]
    x = cx - tw / 2 - b[0]
    if shadow:
        draw.text((x + 3, y + 3 + th * 0), txt, font=font, fill=shadow)
    draw.text((x, y), txt, font=font, fill=fill)
    return th

def tag_bar(draw, cx, y, txt, font, fg, bg):
    """顶部小标签胶囊"""
    b = draw.textbbox((0, 0), txt, font=font)
    tw, th = b[2] - b[0], b[3] - b[1]
    padx, pady = 26, 10
    x0 = cx - tw / 2 - padx
    draw.rounded_rectangle([x0, y - pady, x0 + tw + padx * 2, y + th + pady], radius=24, fill=bg)
    draw.text((x0 + padx, y), txt, font=font, fill=fg)

def build(name, topics, bg_top, bg_bottom, num_color, accent):
    img = hgrad(bg_top, bg_bottom)
    draw = ImageDraw.Draw(img, 'RGBA')
    glow_circle(draw, W * 0.12, H * 0.22, 220, accent)
    glow_circle(draw, W * 0.88, H * 0.8, 260, accent)

    f_tag = F(FCN, 34)
    f_num = F(FNUM, 170)
    f_num_s = F(FNUM, 120)
    f_hook = F(FCN, 66)
    f_sub = F(FCN, 38)
    f_small = F(FCN, 30)

    # 顶部标签
    tag_bar(draw, W // 2, 46, '职场读书 · 头条号', f_tag, (20, 20, 28), (255, 255, 255, 230))

    # 主数字(含中文则自动用中文字体,避免 arialbd 缺字成方框)
    main_num, main_size = topics[0], f_num
    if has_cjk(main_num):
        main_size = F(FCN, 170 if len(main_num) <= 4 else 130)
    elif len(main_num) > 6:
        main_size = f_num_s
    text_center(draw, W // 2, 210, main_num, main_size, num_color, shadow=(0, 0, 0, 160))

    # 高亮分隔条
    bw = 90
    draw.rounded_rectangle([W // 2 - bw, 470, W // 2 + bw, 478], radius=4, fill=accent)

    # 中文钩子(主)
    text_center(draw, W // 2, 500, topics[1], f_hook, (255, 255, 255), shadow=(0, 0, 0, 140))

    # 副标
    if len(topics) > 2 and topics[2]:
        text_center(draw, W // 2, 620, topics[2], f_sub, (225, 225, 225), shadow=(0, 0, 0, 120))

    # 底部水印提示
    text_center(draw, W // 2, 742, '关注我，职场进阶不迷路', f_small, (170, 170, 175))
    return img

def build_compare(name, left, right, tag_line, bg_top, bg_bottom, l_color, r_color):
    """左右对比型封面"""
    img = hgrad(bg_top, bg_bottom)
    draw = ImageDraw.Draw(img, 'RGBA')
    glow_circle(draw, W * 0.25, H * 0.35, 200, l_color)
    glow_circle(draw, W * 0.75, H * 0.35, 200, r_color)

    f_tag = F(FCN, 34)
    f_num = F(FNUM, 120)
    f_num_cn = F(FCN, 130)  # 中文数字(若含 CJK 字符)
    f_txt = F(FCN, 52)
    f_vs = F(FNUM, 90)
    f_sub = F(FCN, 40)
    f_small = F(FCN, 30)

    tag_bar(draw, W // 2, 46, '职场读书 · 头条号', f_tag, (20, 20, 28), (255, 255, 255, 230))

    # 左右数字(含 CJK 自动用中文字体,避免 arialbd 缺字成方框)
    text_center(draw, W * 0.25, 260, left[0], f_num_cn if has_cjk(left[0]) else f_num, l_color, shadow=(0, 0, 0, 150))
    text_center(draw, W * 0.75, 260, right[0], f_num_cn if has_cjk(right[0]) else f_num, r_color, shadow=(0, 0, 0, 150))
    text_center(draw, W * 0.25, 400, left[1], f_txt, (255, 255, 255), shadow=(0, 0, 0, 130))
    text_center(draw, W * 0.75, 400, right[1], f_txt, (255, 255, 255), shadow=(0, 0, 0, 130))

    # 中间 VS
    text_center(draw, W // 2, 320, 'VS', f_vs, (255, 200, 40), shadow=(0, 0, 0, 160))

    # 分隔条
    draw.rounded_rectangle([W // 2 - 90, 528, W // 2 + 90, 536], radius=4, fill=(255, 200, 40))

    text_center(draw, W // 2, 560, tag_line, f_sub, (255, 255, 255), shadow=(0, 0, 0, 130))
    text_center(draw, W // 2, 742, '关注我，职场进阶不迷路', f_small, (170, 170, 175))
    return img

TOPICS = [
    # (文件名, 构建函数, 参数...)
    ('cover_35sui.png', build,
     ('35岁', '被裁还是翻身？', '书比加班更保命'),
     (18, 20, 34), (70, 12, 20), (255, 80, 80), (255, 160, 60)),
    ('cover_ai700.png', build,
     ('700人', 'AI两个月就裁了', '读书才是真底气'),
     (12, 18, 34), (30, 10, 60), (255, 200, 40), (160, 90, 255)),
    ('cover_salary.png', build_compare,
     ('12.8万', '裁员', '105万', '抢人', '35岁，别慌',),
     (16, 20, 34), (40, 10, 12), (255, 90, 90), (80, 200, 130)),
    ('cover_dushu.png', build,
     ('3000→30000', '我靠读书翻了十倍', '职场人自救指南'),
     (10, 26, 20), (8, 40, 30), (90, 230, 150), (80, 200, 120)),
]

# ---- CLI 色板 ----
PALETTES = {
    'red':    ((18, 20, 34), (70, 12, 20),  (255, 80, 80),  (255, 160, 60)),
    'gold':   ((12, 18, 34), (30, 10, 60),  (255, 200, 40), (160, 90, 255)),
    'salary': ((16, 20, 34), (40, 10, 12),  (255, 90, 90),  (80, 200, 130)),
    'green':  ((10, 26, 20), (8, 40, 30),   (90, 230, 150), (80, 200, 120)),
    'blue':   ((10, 16, 34), (8, 30, 60),   (90, 170, 255), (80, 160, 255)),
    'orange': ((34, 22, 10), (60, 30, 8),   (255, 170, 60), (255, 200, 40)),
}

def cli():
    import argparse
    ap = argparse.ArgumentParser(description='生成数字叠加封面(1200x800)')
    ap.add_argument('--layout', choices=['normal', 'compare'], default='normal')
    ap.add_argument('--num', help='主数字(如 35岁/700人/12.8万)')
    ap.add_argument('--hook', help='中文钩子句(如 被裁还是翻身？)')
    ap.add_argument('--sub', help='副标(如 书比加班更保命)')
    ap.add_argument('--num2', help='[compare] 右数字')
    ap.add_argument('--hook2', help='[compare] 右文字')
    ap.add_argument('--color', choices=PALETTES.keys(), default='red')
    ap.add_argument('--out', default=os.path.join(OUT, 'cover_daily.png'))
    a = ap.parse_args()

    bg1, bg2, nc, ac = PALETTES[a.color]
    if a.layout == 'compare':
        assert a.num and a.hook and a.num2 and a.hook2, 'compare 布局需 --num/--hook/--num2/--hook2'
        tag = a.sub or '职场人，别慌'
        img = build_compare(a.out, (a.num, a.hook), (a.num2, a.hook2), tag, bg1, bg2, nc, ac)
    else:
        assert a.num and a.hook, 'normal 布局需 --num/--hook'
        img = build(a.out, (a.num, a.hook, a.sub or ''), bg1, bg2, nc, ac)
    img.save(a.out, 'PNG')
    print('OK', a.out)

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        cli()
    else:
        for fname, fn, args, bg1, bg2, nc, ac in TOPICS:
            if fn is build_compare:
                # args = (左数字, 左文字, 右数字, 右文字, 底部结论)
                img = fn(fname, (args[0], args[1]), (args[2], args[3]), args[4], bg1, bg2, nc, ac)
            else:
                img = fn(fname, args, bg1, bg2, nc, ac)
            p = os.path.join(OUT, fname)
            img.save(p, 'PNG')
            print('OK', p)
        print('DONE', len(TOPICS), 'covers ->', OUT)
