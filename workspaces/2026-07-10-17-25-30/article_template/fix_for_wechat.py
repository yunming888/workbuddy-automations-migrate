# -*- coding: utf-8 -*-
"""微信兼容 HTML 自动修复（公众号文章工作流 S8 必跑）

用法:
  python fix_for_wechat.py <article_body.html>

修复项:
1. 去 BOM / 零宽字符等不可见脏字符（微信 API 吞 CSS 的元凶）
2. <div> -> <section>
3. <h1>/<h2>/<h3> -> <p>（补内联样式模拟标题）
4. 去 display:flex 及 align-items/justify-content 等 flexbox 属性
5. 删 class="" 属性、删 <style> 标签、删 HTML 注释
6. 压缩多余空行
输出各修复项计数；有残留未修复的会明确提示。
"""
import io
import os
import re
import sys

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def fix(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        html = f.read()

    stat = {}
    before = html

    # 1. 脏字符
    html = re.sub(r"[\ufeff\u200b\u200c\u200d\ufffe\u00ad]", "", html)
    stat["脏字符"] = len(before) - len(html)

    # 2. div -> section
    def div_sub(m):
        return m.group(0).replace("<div", "<section", 1)
    stat["div->section"], html = _count_sub(
        html, r"</?div\b", lambda h: re.sub(r"<(/?)div\b", r"<\1section", h))

    # 3. h1/h2/h3 -> p（保留原内联样式，没有则补一个标题样式）
    def h_sub(m):
        tag, attrs = m.group(1), m.group(2) or ""
        if "font-weight" not in attrs and "font-size" not in attrs:
            attrs = (attrs.rstrip(" >") + ' style="font-size:17px;font-weight:bold;"').strip()
        return f"<p{attrs}>"
    html, n_h = re.subn(r"<h([1-3])\b([^>]*)>", h_sub, html)
    html, n_he = re.subn(r"</h[1-3]>", "</p>", html)
    stat["h1~h3->p"] = n_h + n_he

    # 4. flexbox
    html, n_flex = re.subn(r"\s*display\s*:\s*flex\s*;?", "", html)
    html, n_ai = re.subn(r"\s*(align-items|justify-content|flex-direction|flex-wrap)\s*:[^;\"]*;?", "", html)
    stat["flexbox"] = n_flex + n_ai

    # 5. class / style 标签 / 注释
    html, n_cls = re.subn(r'\s*class="[^"]*"', "", html)
    html, n_sty = re.subn(r"<style[^>]*>.*?</style>", "", html, flags=re.S | re.I)
    html, n_cmt = re.subn(r"<!--.*?-->", "", html, flags=re.S)
    stat["class 属性"] = n_cls
    stat["<style> 标签"] = n_sty
    stat["HTML 注释"] = n_cmt

    # 6. 空行压缩
    html = re.sub(r"\n{3,}", "\n\n", html).strip()

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)

    # 复查
    left_div = len(re.findall(r"</?div\b", html))
    left_h = len(re.findall(r"</?h[1-3]\b", html))
    left_flex = len(re.findall(r"display\s*:\s*flex", html))
    left_cls = len(re.findall(r'\sclass="', html))

    print("✔ WeChat-safe HTML 已写入:", path)
    for k, v in stat.items():
        print(f"  {k}: {v} 处（已修复）")
    print("  ---- 复查 ----")
    print(f"  残留 <div>: {left_div}")
    print(f"  残留 <h1~h3>: {left_h}")
    print(f"  残留 display:flex: {left_flex}")
    print(f"  残留 class=: {left_cls}")
    if left_div or left_h or left_flex or left_cls:
        print("  ⚠ 仍有残留，请手动检查源码")
        return 1
    print("  ✅ 全部通过")
    return 0


def _count_sub(html, pattern, func):
    n = len(re.findall(pattern, html))
    return n, func(html)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python fix_for_wechat.py <article_body.html>")
        sys.exit(2)
    sys.exit(fix(sys.argv[1]))
