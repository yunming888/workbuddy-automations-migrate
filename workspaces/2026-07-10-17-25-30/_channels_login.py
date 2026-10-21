# -*- coding: utf-8 -*-
"""视频号助手登录：打开 https://channels.weixin.qq.com，人工扫码，登录后自动退出。
独立 profile: C:\\Users\\Administrator\\edge-channels-profile（与公众号 edge-mp-profile2 分开）
用法: python _channels_login.py
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

PROFILE = r"C:\Users\Administrator\edge-channels-profile"
URL = "https://channels.weixin.qq.com/"
TIMEOUT = 600


async def main():
    os.makedirs(PROFILE, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            channel="msedge",
            headless=False,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded")
        print("[channels] 浏览器已打开，请用微信扫码登录视频号助手", flush=True)

        for i in range(TIMEOUT // 5):
            await asyncio.sleep(5)
            try:
                url = page.url
                text = await page.inner_text("body")
            except Exception:
                continue
            # 只认 URL：登录页文案里本来就有"内容管理/发表视频"，不能用文本判断
            logged = ("channels.weixin.qq.com" in url) and ("login.html" not in url)
            if logged:
                print("[channels] OK 已登录 url=%s" % url, flush=True)
                await ctx.close()
                return 0
            if i % 6 == 0:
                print("[channels] 等待扫码中... url=%s" % url[:90], flush=True)

        print("[channels] TIMEOUT 未检测到登录成功", flush=True)
        await ctx.close()
        return 1


sys.exit(asyncio.run(main()))
