# -*- coding: utf-8 -*-
"""复用草稿箱已有草稿直接走群发（出扫码页），不新建草稿

用法:
  python _resume_publish.py <md草稿路径或文件名> <appmsgid> [封面路径]

适用于：已用 _push_draft.py 把排版稿存进草稿箱后，第二天只需群发的场景。
"""
import asyncio
import io
import json
import os
import sys

if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE = r"C:\Users\Administrator\WorkBuddy\2026-07-10-17-25-30"
sys.path.insert(0, BASE)
from publish_core import publish_to_confirm  # noqa: E402
import publish_runner as PR  # noqa: E402

art = sys.argv[1]
appmsgid = sys.argv[2]
cover = sys.argv[3] if len(sys.argv) > 3 else None

if not os.path.isabs(art):
    draft_dir = os.path.join(BASE, PR.load_config()["wechat_mp"].get("draft_dir", ""))
    art = os.path.join(draft_dir, art)
if cover and not os.path.isabs(cover):
    cover = os.path.join(BASE, cover)

print("复用草稿 appmsgid=%s 群发：%s" % (appmsgid, art))
res = asyncio.run(publish_to_confirm(
    art,
    cover=cover,
    headless=False,
    keep_alive=1800,
    advance=True,                # 保存后继续走到扫码页
    declare_original=True,
    declare_ai_source=True,
    resume_appmsgid=appmsgid,    # 关键：复用已有草稿，不新建
))
print("\nRESULT:", json.dumps(res, ensure_ascii=False, indent=2))
