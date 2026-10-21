# -*- coding: utf-8 -*-
"""按「公众号文章工作流」产出的 HTML 排版，推送到公众号草稿箱（不群发，不消耗额度）

用法:
  python _push_draft.py 001_外卖保温袋            # 只存草稿（不消耗群发额度）
  python _push_draft.py 001_外卖保温袋 --advance  # 存草稿后继续走到扫码页，出码给云明扫

流程：读 articles/<目录>/publish_config.json + article_body.html
      → 去掉本地图片（本地路径无法随 HTML 粘贴进微信，封面走 cover 参数单独上传）
      → publish_core.publish_to_confirm(body_html=..., advance=...) 富文本注入
"""
import asyncio
import datetime
import io
import json
import os
import re
import sys

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE = r"C:\Users\Administrator\WorkBuddy\2026-07-10-17-25-30"
sys.path.insert(0, BASE)
from publish_core import publish_to_confirm  # noqa: E402

# ── 队列护栏（防重复草稿）：advance 前查今天该标题是否已有草稿/记录，advance 后回写 appmsgid ──
QUEUE = os.path.join(BASE, "热点评论", "_publish_queue.json")

def _load_queue():
    if not os.path.exists(QUEUE):
        return None
    try:
        return json.load(open(QUEUE, encoding="utf-8"))
    except Exception:
        return None

def _today_item(title):
    """返回 (今天且标题匹配的队列条目 dict, 队列整体)；无则 (None, 整体)。"""
    q = _load_queue()
    if not q:
        return None, q
    today = datetime.date.today().strftime("%Y-%m-%d")
    for it in q.get("items", []):
        if it.get("title") == title and it.get("scheduled_date") == today:
            return it, q
    return None, q

name = sys.argv[1] if len(sys.argv) > 1 else "001_外卖保温袋"
art_dir = os.path.join(BASE, "articles", name)

cfg = json.load(open(os.path.join(art_dir, "publish_config.json"), encoding="utf-8"))
html = open(os.path.join(art_dir, "article_body.html"), encoding="utf-8").read()

# 去掉正文里的本地图片（<p ...><img ...></p>），图片需先上传素材才能带进微信
html_noimg = re.sub(r'<p style="text-align:center[^>]*>\s*<img[^>]*>\s*</p>', "", html)
html_noimg = re.sub(r"\n{3,}", "\n\n", html_noimg).strip()

title = cfg["title"]

# 封面解析（命名无关 + 自修复，2026-09-18 修复“贴图/封面全篇重复”根因）：
# 历史上每篇封面都叫 cover_final.png → 多篇同名 → 微信素材库按文件名匹配时总命中
# 最早那张(002「拆掉那块」)，导致每篇都绑到同一张图。改成唯一化命名 cover_<NNN>_final.png；
# 若目录里只剩旧命名 cover_final.png，自动改名成唯一名(幂等)，从根上消除同名碰撞。
import glob
_covers_dir = os.path.join(art_dir, "covers")
_nnn = name[:3] if name[:3].isdigit() else None
_unique = os.path.join(_covers_dir, "cover_%s_final.png" % _nnn) if _nnn else None
cover = None
if _unique and os.path.exists(_unique):
    cover = _unique
elif _nnn and os.path.exists(os.path.join(_covers_dir, "cover_final.png")):
    try:
        os.rename(os.path.join(_covers_dir, "cover_final.png"), _unique)  # 自修复：旧通用名→唯一名
        cover = _unique
        print("  封面自修复：cover_final.png → cover_%s_final.png（消除同名碰撞）" % _nnn)
    except Exception:
        cover = os.path.join(_covers_dir, "cover_final.png")
else:
    _cands = sorted(glob.glob(os.path.join(_covers_dir, "cover*.png")))
    cover = _cands[0] if _cands else None

# md 占位：publish_core 需要 md 解析标题，正文随后被 body_html 覆盖
md_path = os.path.join(art_dir, "_draft_stub.md")
with open(md_path, "w", encoding="utf-8") as f:
    f.write("# %s\n\n%s\n" % (title, cfg.get("digest", "")))

do_advance = "--advance" in sys.argv

# ── 护栏①：advance 前查重，防重复新建草稿 ──
if do_advance:
    _it, _q = _today_item(title)
    if _it and _it.get("appmsgid"):
        print("\n  ⚠️ 护栏拦截：今天该标题已有 appmsgid=%s" % _it["appmsgid"])
        print("    铁律「每天只发1篇」—— 若它已群发成功，请改用 _resume_publish.py 复用出码，")
        print("    不要再 --advance 新建第二个草稿（会产生重复发表记录）。")
        print("    若确认它没发出去、要重发，请先在队列删掉该 appmsgid 字段再跑。")
        _user = os.environ.get("FORCE_PUSH_DRAFT", "0")
        if _user != "1":
            print("    已中止（如需强行新建，用 FORCE_PUSH_DRAFT=1 再跑）。")
            sys.exit(2)
        print("    FORCE_PUSH_DRAFT=1，继续新建草稿。")

print("推送草稿：%s  （%s）" % (title, "排版后直出扫码页" if do_advance else "只存草稿"))
print("  HTML 长度：%d（去图后）" % len(html_noimg))
print("  封面：%s" % cover)

res = {}
try:
    res = asyncio.run(publish_to_confirm(
        md_path,
        cover=cover if os.path.exists(cover) else None,
        author=cfg.get("author", "情深意淡"),
        headless=False,
        keep_alive=1800 if do_advance else 0,
        advance=do_advance,          # --advance 才走到扫码页；默认只存草稿
        declare_original=True,
        declare_ai_source=True,
        body_html=html_noimg,
    ))
except Exception as e:
    # 2026-10-12 判例：异常可能发生在「已发表成功」之后的收尾阶段（点了发表→页面跳转→
    # 后续 evaluate 报错）。此时文章其实已经发出去了，绝不能据异常判定「未发」。
    print("\n[warn] publish_to_confirm 抛出异常：%s" % str(e)[:200])
    print("      注：异常不等于未发表，以随后的自动核验为准。")

# ── 护栏②：advance 成功存草稿后，把 appmsgid 回写队列条目（只改 3 个目标键，防误覆盖其它字段）──
if do_advance and res.get("appmsgid") and res.get("saved"):
    _it, _q = _today_item(title)
    if _q is not None:
        tgt = None
        for it in _q.get("items", []):
            if it.get("id") == (_it.get("id") if _it else None):
                tgt = it
                break
        if tgt is not None:
            tgt["appmsgid"] = res["appmsgid"]
            tgt["layout"] = "articles/%s（微信安全HTML当天排版）" % name
            if not res.get("qrcode"):
                old = tgt.get("mp_note", "")
                tgt["mp_note"] = (old +
                    " advance 存草稿 %s 成功但 qrcode=None（限频/弹窗未截码），"
                    "REACHED_DIALOG_NO_QR：可能已群发也可能未发，勿盲目重跑 advance 新建草稿，"
                    "先 _verify_published_today.py 核验近期发表再决定 resume 还是删除。" % res["appmsgid"]).strip()
            with open(QUEUE, "w", encoding="utf-8") as f:
                json.dump(_q, f, ensure_ascii=False, indent=2)
            print("  已回写队列：appmsgid=%s%s" % (res["appmsgid"], "" if res.get("qrcode") else "（未截码，见 mp_note）"))
        else:
            print("  队列未找到今天该标题条目，跳过回写（建议先 _queue.py add）。")

# ── 护栏③：advance 未截到码（含中途抛异常）时，自动核验今天到底发出去没有 ──
# 2026-10-12 事故根因：advance 实已发表但报「未到达扫码页」，叠加旧版核验脚本关键词硬编码
# 恒返回 False → 误判「未发」→ FORCE 重跑 → 产生重复发表记录。
# 这里强制自动核验一次并把结论写进队列 mp_note，杜绝再靠人/靠报错猜。
if do_advance and not res.get("qrcode"):
    try:
        import subprocess
        import time
        # publish 中途抛异常时浏览器可能残留并锁住 profile，导致核验脚本起不来、
        # 护栏③形同虚设（10/12 就是这样）。核验前先清干净。
        try:
            subprocess.run(["taskkill", "/F", "/IM", "msedge.exe"],
                           capture_output=True, timeout=30)
            time.sleep(3)
        except Exception:
            pass
        # 关键词必须用「完整标题原文」：页面 innerText 里是带标点的原标题，
        # 若先去掉标点再截断（如「全隐藏门把手要禁了可」）会匹配不上 → 误判「未发」
        # → 正是 10/12 重复发表事故的成因。这里传完整标题，并带「首段」兜底。
        _cands = [title.strip()]
        _seg = re.split(r"[，,。！？!?：:]", title.strip())[0].strip()
        if _seg and _seg not in _cands:
            _cands.append(_seg)
        _hit, _cnt = False, -1
        for _kw in _cands:
            try:
                _r = subprocess.run(
                    [sys.executable, os.path.join(BASE, "_verify_published_today.py"), _kw],
                    capture_output=True, text=True, timeout=240, encoding="utf-8", errors="ignore")
            except Exception:
                continue
            _out = (_r.stdout or "") + (_r.stderr or "")
            if "keyword hit: True" in _out:
                _hit = True
            # 优先取「今天已发表条数」（排除已删除），回退「今天出现次数」
            _mc = (re.search(r"今天已发表条数[::]\s*(\d+)", _out)
                   or re.search(r"今天出现次数[::]\s*(\d+)", _out))
            if _mc:
                _cnt = int(_mc.group(1))
            print("  [auto-verify] 关键词「%s」→ 命中=%s，今天已发表条数=%s" % (_kw, _hit, _cnt))
            if _hit:
                break
        _it2, _q2 = _today_item(title)
        if _q2 is not None and _it2 is not None:
            for _x in _q2.get("items", []):
                if _x.get("id") == _it2.get("id"):
                    _tag = ("[auto-verify] 已核验：今天已发表（条数%s），勿再重跑 advance、勿 FORCE。" % _cnt
                            if _hit else
                            "[auto-verify] 已核验：今天未发表，可 resume 复用或次日重发。")
                    if _hit and _cnt > 1:
                        _tag += " ⚠️今天多条，疑似重复，需后台删除多余记录。"
                    _x["mp_note"] = (_x.get("mp_note", "") + " " + _tag).strip()
                    break
            with open(QUEUE, "w", encoding="utf-8") as f:
                json.dump(_q2, f, ensure_ascii=False, indent=2)
            print("  [auto-verify] 结论已写入队列 mp_note")
    except Exception as e:
        print("  [auto-verify] 自动核验跳过：%s" % str(e)[:150])

print("\nRESULT:", json.dumps(res, ensure_ascii=False, indent=2))
