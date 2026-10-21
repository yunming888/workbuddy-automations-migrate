# -*- coding: utf-8 -*-
"""核验当天视频是否真的在列表里（穿 shadow DOM 抓全部文本）"""
import asyncio
import re

from playwright.async_api import async_playwright

PROFILE = r"C:\Users\Administrator\edge-channels-profile"
HOME = "https://channels.weixin.qq.com/platform/"
KWS = ["让故事等一天", "拆掉那块铁皮", "省下一个袋子", "审核中", "已发表", "处理中", "草稿", "发表失败"]


async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE, channel="msedge", headless=False,
            args=["--start-maximized"])
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(HOME, wait_until="domcontentloaded")
        await asyncio.sleep(6)
        try:
            await page.locator("text=内容管理").first.click(timeout=8000)
            await asyncio.sleep(2)
            await page.locator("text=视频").first.click(timeout=8000)
        except Exception as e:
            print("nav warn:", e)
        await asyncio.sleep(10)
        print("URL:", page.url, flush=True)
        await page.screenshot(path="channels_verify_today.png", full_page=False)

        # 抓可见文本 + shadow root 文本
        js = """
        () => {
          let out = [];
          const walk = (root) => {
            root.querySelectorAll('*').forEach(el => {
              if (el.shadowRoot) walk(el.shadowRoot);
              const t = (el.innerText || '').trim();
              if (t && t.length < 200 && el.children.length === 0) out.push(t);
            });
          };
          walk(document);
          return Array.from(new Set(out)).join(' ||| ');
        }
        """
        try:
            txt = await page.evaluate(js)
        except Exception as e:
            txt = "EVAL_ERR " + str(e)
        print("LEN:", len(txt), flush=True)
        print("TEXT:", txt[:3000], flush=True)
        print("--- 关键词计数 ---", flush=True)
        for kw in KWS:
            print(f"{kw}: {txt.count(kw)}", flush=True)
        await asyncio.sleep(3)
        await ctx.close()


asyncio.run(main())
