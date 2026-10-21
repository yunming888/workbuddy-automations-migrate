# -*- coding: utf-8 -*-
"""
v6: 用 download 事件监听 + goto 导出 xls（v5 的 [B] 路修好）。
"""
import sys, io, os, re, json, urllib.parse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from playwright.sync_api import sync_playwright

ROOT = r"C:\Users\Administrator\WorkBuddy\2026-07-10-17-25-30"
RAW = os.path.join(ROOT, "analytics_raw")
PROFILE = r"C:\Users\Administrator\edge-mp-profile2"
os.makedirs(RAW, exist_ok=True)

def _dyn_ranges():
    """按运行日动态算抓取窗口：d7=近7天，d30=近30天，all=2026-07-01至今。
    支持命令行覆盖结束日：python mp_analytics_v6.py [YYYYMMDD]（默认=今天）。
    每次重跑都刷新到当日，保证逐篇数据不落后于发布日（数据不写死）。"""
    import datetime
    end = datetime.date.today()
    if len(sys.argv) > 1 and re.fullmatch(r"\d{8}", sys.argv[1]):
        end = datetime.date(int(sys.argv[1][:4]), int(sys.argv[1][4:6]), int(sys.argv[1][6:8]))
    f = lambda d: d.strftime("%Y%m%d")
    return [
        ("d7",  f(end - datetime.timedelta(days=6)),  f(end)),
        ("d30", f(end - datetime.timedelta(days=29)), f(end)),
        ("all", "20260701", f(end)),
    ]

RANGES = _dyn_ranges()


def build_url(token, begin, end, ajax=True):
    args = json.dumps({"begin_date": int(begin), "end_date": int(end)}, separators=(",", ":"))
    q = {"action": "query_download", "busi": "3", "tmpl": "19",
         "args": args, "token": token, "lang": "zh_CN"}
    if ajax:
        q["f"] = "json"; q["ajax"] = "1"
    return "https://mp.weixin.qq.com/misc/datacubequery?" + urllib.parse.urlencode(q)


def main():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE, channel="msedge", headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1600, "height": 1000},
            accept_downloads=True,
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        downloads = []
        page.on("download", lambda d: downloads.append(d))

        page.goto("https://mp.weixin.qq.com/", wait_until="domcontentloaded", timeout=90000)
        token = ""
        for _ in range(12):
            page.wait_for_timeout(2500)
            m = re.search(r"token=(\d+)", page.content()) or re.search(r"token=(\d+)", page.url)
            if m:
                token = m.group(1); break
        print("TOKEN:", token)
        if not token:
            ctx.close(); return

        for name, b, e in RANGES:
            print(f"\n##### {name}: {b} ~ {e} #####")
            saved = None
            # 先试无 ajax 参数的原始形态（<a> 标签就是这种）
            for ajax in (False, True):
                url = build_url(token, b, e, ajax=ajax)
                tag = "[原始]" if not ajax else "[ajax]"
                downloads.clear()
                try:
                    page.goto(url, timeout=40000)
                except Exception as ex:
                    pass
                for _ in range(15):
                    page.wait_for_timeout(1000)
                    if downloads:
                        break
                if not downloads:
                    print(f"  {tag} 无下载事件"); continue
                d = downloads[-1]
                tmp = os.path.join(RAW, f"v6_{name}_{b}_{e}{'_ajax' if ajax else ''}.xls")
                try:
                    d.save_as(tmp)
                except Exception as ex:
                    print(f"  {tag} save 失败:", ex); continue
                sz = os.path.getsize(tmp) if os.path.exists(tmp) else 0
                print(f"  {tag} 保存 {os.path.basename(tmp)} = {sz} bytes (建议名 {d.suggested_filename})")
                if sz > 5000:
                    saved = tmp
                    break
            if not saved:
                print("  ✗ 两种方式都没拿到有效 xls")

        ctx.close()

        ctx.close()

main()
