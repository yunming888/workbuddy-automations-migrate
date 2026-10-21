#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把随包的工作区脚本铺到新电脑的 WorkBuddy 目录。

用法：
    python deploy_workspaces.py            # 交互：逐个确认
    python deploy_workspaces.py --yes      # 全自动
    python deploy_workspaces.py --dry-run  # 预演

安全：已存在的同名文件默认不覆盖（--overwrite 才覆盖）；绝不动凭据类文件。
"""
import os, sys, shutil, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 仓库根
SRC = os.path.join(ROOT, "workspaces")
HOME = os.path.expanduser("~")
DEST_ROOT = os.path.join(HOME, "WorkBuddy")

# 凭据类：永不部署
DENY = ("cookie", "token", "keyblob", ".key", "secret", ".env", "credential", "session_state")

def is_denied(name):
    low = name.lower()
    return any(d in low for d in DENY)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(SRC):
        print("✗ 找不到 workspaces/ 目录"); sys.exit(1)

    print("=" * 60)
    print("工作区脚本部署  ->  " + DEST_ROOT)
    print("=" * 60)

    total_c = total_s = 0
    for ws in sorted(os.listdir(SRC)):
        src_ws = os.path.join(SRC, ws)
        if not os.path.isdir(src_ws):
            continue
        dst_ws = os.path.join(DEST_ROOT, ws)
        print(f"\n[{ws}] -> {dst_ws}")
        if not args.yes and not args.dry_run:
            if not sys.stdin.isatty():
                print("   （非交互，自动跳过；加 --yes 执行）"); continue
            if input("   部署到这个目录？[Y/n] ").strip().lower() == "n":
                print("   跳过"); continue
        if not args.dry_run:
            os.makedirs(dst_ws, exist_ok=True)
        c = s = 0
        for dp, dn, fn in os.walk(src_ws):
            dn[:] = [d for d in dn if d != "__pycache__"]
            rel_dir = os.path.relpath(dp, src_ws)
            for f in fn:
                if is_denied(f):
                    continue
                src_f = os.path.join(dp, f)
                dst_f = os.path.join(dst_ws, rel_dir, f) if rel_dir != "." \
                        else os.path.join(dst_ws, f)
                exists = os.path.exists(dst_f)
                if exists and not args.overwrite:
                    s += 1; total_s += 1
                else:
                    c += 1; total_c += 1
                    if not args.dry_run:
                        os.makedirs(os.path.dirname(dst_f), exist_ok=True)
                        shutil.copy2(src_f, dst_f)
        print(f"   新建/覆盖 {c} 个，跳过(已存在) {s} 个")

    print("\n" + "-" * 60)
    print(f"完成：新建/覆盖 {total_c} 个，跳过 {total_s} 个" +
          ("（dry-run 未实际写盘）" if args.dry_run else ""))
    print("-" * 60)
    if not args.dry_run:
        print("""
后续：
  1. python scripts/restore.py        # 恢复 6 个定时任务定义
  2. 打开 WorkBuddy 任务列表确认已启用
  3. 各平台登录态由本人重新扫码（头条 / 公众号 / 视频号）
""")

if __name__ == "__main__":
    main()