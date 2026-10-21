# -*- coding: utf-8 -*-
"""
热点评论 · 发布队列管理
每天只发 1 篇；逾期未发的自动顺延到下一个空闲日期。

用法（python 用 C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe）：
  next                     查看今天该发哪篇（先自动做顺延），无则输出 NONE
  done <id>                标记已发布
  add <file> <title> <event> [date]   入队（date 默认排到队尾空闲日）
  list                     列出全部条目
"""
import json
import os
import sys
import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
QFILE = os.path.join(BASE, "_publish_queue.json")
DATEFMT = "%Y-%m-%d"


def load():
    with open(QFILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save(data):
    data["updated"] = datetime.date.today().strftime(DATEFMT)
    with open(QFILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def shift(data, today):
    """把逾期未发的条目顺延到最近的空闲日期，返回是否有变动。"""
    changed = False
    pending = [i for i in data["items"] if i["status"] == "pending"]
    pending.sort(key=lambda x: (x["scheduled_date"], x.get("order", 999)))
    taken = set()
    for it in pending:
        d = datetime.datetime.strptime(it["scheduled_date"], DATEFMT).date()
        if d >= today and it["scheduled_date"] not in taken:
            taken.add(it["scheduled_date"])
            continue
        # 逾期或与其他 pending 撞期：往后找空位
        while d < today or d.strftime(DATEFMT) in taken:
            d += datetime.timedelta(days=1)
        it["scheduled_date"] = d.strftime(DATEFMT)
        taken.add(it["scheduled_date"])
        changed = True
    return changed


def cmd_next():
    today = datetime.date.today()
    data = load()
    if shift(data, today):
        save(data)
    for it in data["items"]:
        if it["status"] == "pending" and it["scheduled_date"] == today.strftime(DATEFMT):
            print(json.dumps(it, ensure_ascii=False))
            return 0
    print("NONE")
    return 0


def cmd_done(arg):
    data = load()
    for it in data["items"]:
        if it["id"] == arg:
            it["status"] = "done"
            it["published_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
            save(data)
            print("OK marked done:", it["id"], it["title"])
            return 0
    print("NOT_FOUND", arg)
    return 1


def cmd_add(arg):
    parts = arg.split("|")
    if len(parts) < 3:
        print("用法: add <file>|<title>|<event>[|<date>]")
        return 1
    file_, title, event = parts[0].strip(), parts[1].strip(), parts[2].strip()
    date = parts[3].strip() if len(parts) > 3 and parts[3].strip() else None
    today = datetime.date.today()
    data = load()
    if not date:
        taken = {i["scheduled_date"] for i in data["items"] if i["status"] == "pending"}
        d = today
        while d.strftime(DATEFMT) in taken:
            d += datetime.timedelta(days=1)
        date = d.strftime(DATEFMT)
    ymd = date.replace("-", "")
    n = sum(1 for i in data["items"] if i["id"].startswith(ymd)) + 1
    data["items"].append({
        "id": "%s-%02d" % (ymd, n),
        "order": max([i.get("order", 0) for i in data["items"]] or [0]) + 1,
        "file": file_,
        "title": title,
        "event": event,
        "scheduled_date": date,
        "status": "pending",
        "published_at": None,
    })
    save(data)
    print("OK added:", date, title)
    return 0


def cmd_list():
    data = load()
    for it in data["items"]:
        print("%-14s %s  %-6s  %s" % (it["id"], it["scheduled_date"], it["status"], it["title"]))
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    sys.exit({"next": cmd_next, "done": lambda: cmd_done(arg),
              "add": lambda: cmd_add(arg), "list": cmd_list}.get(cmd, lambda: 1)())
