# -*- coding: utf-8 -*-
"""公众号后台重新登录：打开 mp.weixin.qq.com，人工扫码，登录成功后自动退出。
用法: python _mp_login.py   （headless=False，会弹出浏览器窗口）
"""
import asyncio
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from playwright.async_api import async_playwright

CFG = json.load(open(os.path.join(BASE, "publish_config.json"), encoding="utf-8"))["wechat_mp"]
PROFILE = CFG.get("profile_dir", r"C:\Users\Administrator\edge-mp-profile2")
TIMEOUT = 600  # 等待扫码秒数


async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            channel="msedge",
            headless=False,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto("https://mp.weixin.qq.com/", wait_until="domcontentloaded")
        print("[login] 浏览器已打开，请扫码登录", flush=True)

        for i in range(TIMEOUT // 5):
            await asyncio.sleep(5)
            try:
                url = page.url
                html = await page.content()
            except Exception:
                continue
            if "token=" in url or "cgi-bin/home" in url:
                m = re.search(r"token=(\d+)", url)
                print("[login] OK 已登录 token=%s url=%s" % (m.group(1) if m else "?", url), flush=True)
                await ctx.close()
                return 0
            if "扫码" not in html and "二维码" not in html and "loginpage" not in url:
                # 兜底：页面不再是登录页也认为成功
                print("[login] 疑似已登录 url=%s" % url, flush=True)
                await ctx.close()
                return 0
            if i % 6 == 0:
                print("[login] 等待扫码中... url=%s" % url[:80], flush=True)

        print("[login] TIMEOUT 未检测到登录成功", flush=True)
        await ctx.close()
        return 1


sys.exit(asyncio.run(main()))
