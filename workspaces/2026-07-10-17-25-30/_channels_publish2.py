# -*- coding: utf-8 -*-
"""视频号发布器 v2（修假成功）
用法:
  python _channels_publish2.py <视频.mp4> <描述> <短标题> [--cover 封面png] --post
封面: 不传 --cover 时自动找视频同目录的 cover.png（_channels_factory 会生成）。
      上传成功则用定制封面（标题各异 → 封面不重复）；定位不到控件就退回平台自动抽帧，不阻塞发表。
改进点（相对 v1）:
  1. 上传等待不再 60 秒盲退：穿透 shadow DOM 抓状态，最长等 20 分钟，
     必须看到「上传中/取消上传」出现再消失（或出现完成标志）才算传完。
  2. 发表后必须等 URL 离开 /post/create 或出现成功提示，否则报 FAIL。
  3. 封面：支持 --cover / 自动 cover.png，发表前上传定制封面，避免平台抽帧导致封面重复。
"""
import asyncio
import os
import subprocess
import sys

from playwright.async_api import async_playwright

BASE = os.path.dirname(os.path.abspath(__file__))
PROFILE = r"C:\Users\Administrator\edge-channels-profile"
POST_URL = "https://channels.weixin.qq.com/platform/post/create"
LOGIN_TIMEOUT = 150   # 自动登录预检最长等待秒（复用 profile cookie 通常 30s 内成功）
AUTO_LOGIN = os.environ.get("CHANNELS_AUTO_LOGIN", "1") == "1"


def ensure_login():
    """发表前自动登录预检：复用 profile cookie 刷新登录态，通常 30s 内成功、无需人工扫码。

    2026-10-12 加：原实现检测到未登录就直接退出等人工跑 _channels_login.py，
    导致无人值守时段发不出去。现在发表前先自动跑一次登录刷新。
    cookie 真失效时会等满 LOGIN_TIMEOUT 返回 False —— 那种情况只能人工扫码（物理限制）。
    """
    if not AUTO_LOGIN:
        return None
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(BASE, "_channels_login.py")],
            capture_output=True, text=True, timeout=LOGIN_TIMEOUT,
            encoding="utf-8", errors="ignore")
        out = (r.stdout or "") + (r.stderr or "")
        ok = ("OK 已登录" in out) or (r.returncode == 0 and "TIMEOUT" not in out)
        print("[v2] 登录预检：%s"
              % ("OK（复用 profile，无需扫码）" if ok else "未成功（可能需人工扫码）"), flush=True)
        return ok
    except subprocess.TimeoutExpired:
        print("[v2] 登录预检超时（>%ss），继续尝试发表" % LOGIN_TIMEOUT, flush=True)
        return False
    except Exception as e:
        print("[v2] 登录预检跳过：%s" % str(e)[:120], flush=True)
        return False

SHADOW_JS = """
() => {
  let out = [];
  const walk = (root) => {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
      const t = (el.innerText || '').trim();
      if (t && t.length < 300) out.push(t);
    });
  };
  walk(document);
  return Array.from(new Set(out)).join(' ||| ');
}
"""

BUSY = ["上传中", "取消上传", "转码中", "处理中", "视频处理中"]
DONE_HINT = ["重新上传", "更换视频", "修改封面", "重新选择", "删除视频"]


async def shadow_text(page):
    try:
        return await page.evaluate(SHADOW_JS)
    except Exception:
        try:
            return await page.inner_text("body")
        except Exception:
            return ""


async def main():
    video = os.path.abspath(sys.argv[1])
    desc = sys.argv[2]
    short_title = sys.argv[3]
    # 可选 --cover <png>：不传则用视频同目录的 cover.png（_channels_factory 生成）
    cover = None
    for i, a in enumerate(sys.argv):
        if a == "--cover" and i + 1 < len(sys.argv):
            cover = sys.argv[i + 1]
    if not cover:
        cover = os.path.join(os.path.dirname(video), "cover.png")
    if cover and not os.path.exists(cover):
        cover = None

    # 发表前先自动刷新视频号登录态（复用 profile，无需人工扫码）
    ensure_login()

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE, channel="msedge", headless=False,
            args=["--start-maximized"])
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(POST_URL, wait_until="domcontentloaded")
        await asyncio.sleep(5)
        if "login" in page.url:
            print("[v2] 未登录，先跑 _channels_login.py")
            await ctx.close()
            return 1

        print("[1/5] 上传:", os.path.basename(video), flush=True)
        async with page.expect_file_chooser(timeout=15000) as fc_info:
            for sel in ['text=/上传时长/', '[class*="upload"]', 'text=/大小不超过/']:
                try:
                    await page.click(sel, timeout=3000)
                    break
                except Exception:
                    continue
        fc = await fc_info.value
        await fc.set_files(video)
        print("[1/5] 文件已选择，开始等待上传", flush=True)

        # 2. 等上传：最长 20 分钟
        started = False
        finished = False
        for i in range(120):          # 120 * 10s = 20min
            await asyncio.sleep(10)
            txt = await shadow_text(page)
            busy = [k for k in BUSY if k in txt]
            done = [k for k in DONE_HINT if k in txt]
            if busy:
                if not started:
                    started = True
                    print(f"[2/5] 上传已开始({(i+1)*10}s) 标志={busy}", flush=True)
                continue
            if started and not busy:
                finished = True
                print(f"[2/5] 上传标志消失，判定传完({(i+1)*10}s) done标志={done}", flush=True)
                break
            if not started and done:
                started = True
                finished = True
                print(f"[2/5] 直接检测到完成标志({(i+1)*10}s) {done}", flush=True)
                break
            if (i + 1) % 6 == 0:
                print(f"[2/5] 等待中 {(i+1)*10}s busy={busy} done={done}", flush=True)
        if not finished:
            print("[2/5] 上传超时（20分钟），退出不发表")
            await page.screenshot(path="channels_v2_timeout.png")
            await ctx.close()
            return 1

        await asyncio.sleep(5)

        # 3. 描述
        print("[3/5] 填描述", flush=True)
        filled = False
        for sel in ['[contenteditable="plaintext-only"]', 'div[contenteditable="true"]',
                    '[contenteditable="true"]', '[contenteditable]']:
            try:
                el = page.locator(sel).first
                await el.click(timeout=2500)
                await el.type(desc, delay=10)
                filled = True
                print("[3/5] 填入:", sel, flush=True)
                break
            except Exception:
                continue
        if not filled:
            print("[3/5] 描述框没找到")

        # 4. 短标题
        # ⚠️坑(2026-09-23)：视频号短标题有字数下限——实测 5 字（如「锅洗了拖把」）会校验不过、
        #    发表按钮点了也不提交；8 字（「吓人的是那俩半月」）正常 POSTED_OK。
        #    故前置校验：纯汉字 且 长度≥6，不合格就拦下不发表，避免白跑 4 次。
        cn_chars = sum(1 for c in short_title if '\u4e00' <= c <= '\u9fff')
        if len(short_title) < 6:
            print(f"[4/5] ⚠️ 短标题「{short_title}」仅 {len(short_title)} 字（需≥6字），发表将被平台校验拦下。"
                  f"请改短标题为 ≥6 字后重发，避免假成功。", flush=True)
            await page.screenshot(path="channels_v2_shorttitle_blocked.png", full_page=False)
            await ctx.close()
            return 3
        if cn_chars != len(short_title):
            # 允许数字/空格，但半角小数点/英文符号会静默置灰（9/20 踩坑），提示一下
            print(f"[4/5] 注意：短标题「{short_title}」含非纯汉字字符，可能触发校验置灰，"
                  f"建议改纯汉字。", flush=True)
        print("[4/5] 填短标题:", short_title, flush=True)
        try:
            el = page.locator('input[placeholder*="短标题"]').first
            await el.click(timeout=3000)
            await el.fill(short_title)
            print("[4/5] 短标题已填", flush=True)
        except Exception:
            print("[4/5] 短标题框没找到")

        # 4b. 封面（防御式）：有 cover.png 才尝试上传，失败仅告警不阻塞
        if cover:
            print("[4b] 上传封面:", os.path.basename(cover), flush=True)
            uploaded = False
            try:
                for sel in ['text=修改封面', 'text=更换封面', 'text=上传封面',
                            '[class*="cover"]', 'text=/封面/']:
                    try:
                        async with page.expect_file_chooser(timeout=4000) as fc2:
                            await page.locator(sel).first.click(timeout=4000)
                        fc2v = await fc2.value
                        await fc2v.set_files(cover)
                        uploaded = True
                        print("[4b] 封面已上传 via", sel, flush=True)
                        break
                    except Exception:
                        continue
            except Exception:
                pass
            if not uploaded:
                print("[4b] 封面控件未定位到，退回平台自动抽帧（不阻塞发表）", flush=True)
            else:
                await asyncio.sleep(3)

        await asyncio.sleep(2)
        await page.screenshot(path="channels_v2_filled.png", full_page=False)

        # 5. 发表 —— 视频「秒传」时服务端仍在转码，发表按钮会 CSS 置灰（无 disabled 属性，
        #    is_enabled() 会误报 True → 空点）。改做「轮询按钮真实视觉状态，等真正解禁再点」。
        print("[5/5] 检查发表按钮状态", flush=True)
        btn = page.get_by_role("button", name="发表")
        n = await btn.count()
        print("[5/5] 发表按钮命中数:", n, flush=True)
        b = btn.first

        async def probe_button():
            try:
                return await b.evaluate("""el => {
                  const cs = getComputedStyle(el);
                  return {
                    op: cs.opacity,
                    pe: cs.pointerEvents,
                    dis: el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled')==='true',
                    cls: el.className || '',
                    color: cs.color
                  };
                }""")
            except Exception as e:
                return {"err": str(e)[:80]}

        # 等按钮真正解禁（视频转码窗口）：最多 20 分钟。只在「解禁 且 尚未点过」时点一次。
        clicked = False
        for w in range(80):          # 80 * 15s = 20min
            st = await probe_button()
            if st and st.get("err"):
                print(f"[5/5] 探测异常: {st['err']}", flush=True)
            active = bool(st and not st.get("dis") and st.get("pe") != "none" and float(st.get("op", 0)) > 0.7)
            if w % 4 == 0:
                print(f"[5/5] 按钮@{w*15}s active={active} op={st.get('op') if st else '?'} "
                      f"dis={st.get('dis') if st else '?'} cls={str(st.get('cls'))[:46] if st else '?'}", flush=True)
            if active and not clicked:
                try:
                    await b.scroll_into_view_if_needed(timeout=5000)
                    await b.click(timeout=8000)
                    clicked = True
                    print(f"[5/5] 按钮已解禁，点击发表 @ {w*15}s", flush=True)
                    # 点主按钮后接二次确认弹层（确认/确定/继续发表）
                    await asyncio.sleep(3)
                    for confirm_nm in ["确认", "确定", "继续发表", "提交"]:
                        try:
                            cbtn = page.get_by_role("button", name=confirm_nm)
                            if await cbtn.count():
                                cb = cbtn.last
                                await cb.scroll_into_view_if_needed(timeout=2000)
                                if await cb.is_visible() and await cb.is_enabled():
                                    await cb.click(timeout=4000)
                                    print(f"[5/5] 已点二次确认「{confirm_nm}」", flush=True)
                        except Exception:
                            continue
                except Exception as e:
                    print(f"[5/5] 点击异常: {str(e)[:120]}", flush=True)
                break
            await asyncio.sleep(15)
        if not clicked:
            print("[5/5] 20分钟内发表按钮始终置灰（视频仍在转码/校验未过），不点（避免假成功）", flush=True)
            await page.screenshot(path="channels_v2_blocked.png", full_page=False)
            await ctx.close()
            return 3

        # 等结果：URL 离开 create 页 或 出现成功/审核/处理中标志（最多 12min，转码可能慢）
        ok = False
        for i in range(72):          # 72 * 10s = 12min
            await asyncio.sleep(10)
            url = page.url
            txt = await shadow_text(page)
            if "post/create" not in url:
                print(f"[5/5] URL 已跳转 -> {url} ({(i+1)*10}s)", flush=True)
                ok = True
                break
            if any(k in txt for k in ["发表成功", "已发表", "审核中", "发布成功", "处理中", "转码中"]):
                print(f"[5/5] 页面出现成功/处理中标志 ({(i+1)*10}s)", flush=True)
                ok = True
                break
            if any(k in txt for k in ["发表失败", "发布失败", "驳回", "校验失败", "标题不能包含", "视频无法"]):
                print(f"[5/5] 页面出现失败标志 -> 中止: ", " ".join(
                    [s for s in txt.split("|||") if any(k in s for k in ["失败", "驳回", "不能包含", "无法"])][:4]), flush=True)
                break
            if (i + 1) % 6 == 0:
                print(f"[5/5] 等待发表结果 {(i+1)*10}s url={url}", flush=True)

        await page.screenshot(path="channels_v2_post.png", full_page=False)
        print("RESULT:", "POSTED_OK" if ok else "FAIL_未确认发表", flush=True)
        await ctx.close()
        return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
