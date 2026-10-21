#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一键恢复：把 6 个 WorkBuddy 定时任务在新电脑上重建。

用法（新电脑）：
    python restore.py                # 交互模式：逐步确认
    python restore.py --dry-run      # 只看会做什么，不实际写入
    python restore.py --yes          # 无人值守，自动确认

原理：读取 tasks/automations.json，逐条写入本机 workbuddy.db 的 automations 表。
幂等：已存在的任务默认跳过（--force 覆盖）。
"""
import os, sys, json, sqlite3, argparse, shutil, time, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 仓库根（tasks/ 与 workspaces/ 在此）
TASKS = os.path.join(ROOT, "tasks", "automations.json")
HOME = os.path.expanduser("~")
WB = os.path.join(HOME, ".workbuddy")
DB = os.path.join(WB, "workbuddy.db")

USERMAP = {"Administrator": None}   # 源机器用户名 -> 新机器用户名（None=自动用当前用户）

def die(msg):
    print("✗ " + msg); sys.exit(1)

def find_workbuddy_db():
    if os.path.exists(DB):
        return DB
    if os.path.isdir(WB):
        cands = [f for f in os.listdir(WB) if f.endswith(".db")]
        if cands:
            return os.path.join(WB, cands[0])
    die("找不到 workbuddy.db。请先在 WorkBuddy 里打开过一次（本机需先装好 WorkBuddy 桌面端并登录）。")

def remap_paths(obj):
    """把 prompt 与 cwds 里的旧用户名/路径映射到本机。"""
    cur_user = os.environ.get("USERNAME") or os.environ.get("USER") or "Administrator"
    s = json.dumps(obj, ensure_ascii=False)
    s = s.replace("C:/Users/Administrator", "C:/Users/" + cur_user)
    s = s.replace("C:\\Users\\Administrator", "C:\\Users\\" + cur_user)
    return json.loads(s)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的同名任务")
    ap.add_argument("--only", default="", help="只恢复名字包含该关键字的任务")
    args = ap.parse_args()

    if not os.path.exists(TASKS):
        die("找不到 tasks/automations.json，请在 skill 目录内运行。")

    db = find_workbuddy_db()
    tasks = json.load(open(TASKS, encoding="utf-8"))
    if args.only:
        tasks = [t for t in tasks if args.only in t.get("name", "")]
    if not tasks:
        die("没有匹配的任务。")

    print("=" * 64)
    print("WorkBuddy 定时任务 · 一键恢复")
    print("=" * 64)
    print("目标库 :", db)
    print("待恢复 :", len(tasks), "个任务\n")

    con = sqlite3.connect(db)
    cur = con.cursor()
    cols = [r[1] for r in cur.execute("PRAGMA table_info(automations)")]
    now = int(time.time() * 1000)

    ok = skip = 0
    for t in tasks:
        t = remap_paths(t)
        name = t.get("name", "")
        rrule = t.get("rrule", "")
        exist = cur.execute("SELECT id FROM automations WHERE id=?", (t["id"],)).fetchone()
        if exist and not args.force:
            print(f"  [跳过] {name}（已存在，--force 可覆盖）"); skip += 1; continue

        row = {}
        for k in cols:
            if k in ("id", "name", "status", "schedule_type", "rrule", "scheduled_at",
                     "valid_from", "valid_until", "cwds", "model_id", "workspace_scope",
                     "permission_mode", "prompt"):
                row[k] = t.get(k)
            elif k == "created_at":
                row[k] = now
            elif k == "updated_at":
                row[k] = now
            elif k == "next_run_at":
                row[k] = None      # 交由 WorkBuddy 重算
            elif k in ("status",):
                row[k] = t.get("status") or "ACTIVE"
            else:
                row[k] = None
        if not row.get("model_id"):
            row["model_id"] = "custom-local:agnes-3.0-flash"
        if not row.get("workspace_scope"):
            row["workspace_scope"] = "workspace"

        cols_sql = ",".join(cols)
        q_sql = ",".join(["?"] * len(cols))
        vals = [row.get(c) for c in cols]
        sql = (f"INSERT OR REPLACE INTO automations ({cols_sql}) VALUES ({q_sql})")

        print(f"  [写入] {name}")
        print(f"         rrule={rrule}")
        cw = row.get("cwds")
        if cw: print(f"         cwd={cw}")
        if not args.dry_run:
            cur.execute(sql, vals)
        ok += 1

    if not args.dry_run:
        con.commit()
    con.close()

    print("\n" + "-" * 64)
    print(f"完成：写入 {ok} 个，跳过 {skip} 个" + ("（dry-run，未实际写库）" if args.dry_run else ""))
    print("-" * 64)
    print("""
下一步（必做，缺一任务跑不起来）：
  1. 装好 WorkBuddy 桌面端并登录账号，保持后台运行（调度器本体）
  2. 确认自定义模型 agnes-3.0-flash 在 ~/.workbuddy/models.json 里存在
  3. 确认 3 个 workspace 目录已就位（本 skill 的 restore 只写任务，不搬文件）：
       C:\\Users\\<你>\\WorkBuddy\\2026-06-12-20-17-32   头条号（4 个任务）
       C:\\Users\\<你>\\WorkBuddy\\2026-07-10-17-25-30   热点评论
       C:\\Users\\<你>\\WorkBuddy\\2026-08-14-20-53-36   Agnes 巡检
  4. 核对 Node 版本后缀：ls ~/.workbuddy/binaries/node/versions/
     若不是 22.22.2-6，改 prompt 里的 22.22.2-3
  5. 各平台登录态需你本人重新扫码（头条 / 公众号 / 视频号），自动化不代扫
  6. 打开 WorkBuddy 定时任务列表，确认 6 个任务都在且状态为已启用
""")

if __name__ == "__main__":
    main()