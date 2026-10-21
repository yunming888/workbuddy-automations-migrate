#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""weekly_report.py —— 读取云端「开店经营台账」，生成每周营收汇总。
用法: python weekly_report.py <open_platform_token> [--days 7]
依赖: WorkBuddy 资料库 skill 的 database/get_database_content.py
输出: 营收周报_YYYYMMDD-YYYYMMDD.md（写入工作区）+ 控制台摘要

汇总口径：
- 窗口：默认最近 7 天（含今天）；--days 可改。
- 成交额：窗口内所有订单金额合计。
- 已收款：窗口内「已完成」订单金额。
- 在途：窗口内「待发货」+「已发货」金额。
- 环比：与上一个等长窗口对比（订单数 / 成交额）。
"""
import sys, os, json, csv, io, subprocess, argparse
from datetime import datetime, timedelta

LIB = r"C:/Users/Administrator/.workbuddy/plugins/cache/workbuddy-builtin/skill-library/0.5.9/database"
DB = "JvOLhq1z3zYmX34G4lCJQo"
GET = os.path.join(LIB, "get_database_content.py")
PY = r"C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe"
WS = os.path.dirname(os.path.abspath(__file__))


def fetch_rows(token):
    r = subprocess.run([PY, GET, "--token-stdin", "--database-id", DB],
                       input=token, capture_output=True, text=True, timeout=30)
    try:
        obj = json.loads(r.stdout)
    except Exception:
        return []
    content = obj.get("content", "")
    reader = csv.reader(io.StringIO(content))
    rows = list(reader)
    if not rows:
        return []
    header = rows[0]
    out = []
    for row in rows[1:]:
        if len(row) < len(header):
            row += [""] * (len(header) - len(row))
        out.append(dict(zip(header, row)))
    return out


def money(v):
    try:
        return float(v)
    except Exception:
        return 0.0


def aggregate(orders, start, end):
    """对 [start, end] 闭区间内的订单做聚合。"""
    st_count = {}
    realized = pending = total = 0.0
    cnt = 0
    sales = {}
    trend = {}
    for o in orders:
        d = (o.get("日期") or "")[:10]
        if not d:
            continue
        try:
            od = datetime.strptime(d, "%Y-%m-%d")
        except Exception:
            continue
        if not (start <= od <= end):
            continue
        cnt += 1
        s = o.get("状态", "待发货")
        st_count[s] = st_count.get(s, 0) + 1
        amt = money(o.get("金额"))
        total += amt
        if s == "已完成":
            realized += amt
        elif s in ("待发货", "已发货"):
            pending += amt
        trend[d] = trend.get(d, 0.0) + amt
        if s != "已取消":
            try:
                items = json.loads(o.get("详情") or "[]")
            except Exception:
                items = []
            for it in items:
                n = it.get("name", "")
                q = int(it.get("qty", 0) or 0)
                sales[n] = sales.get(n, 0) + q
    top = sorted(sales.items(), key=lambda x: -x[1])[:5]
    return dict(cnt=cnt, st_count=st_count, realized=realized,
                pending=pending, total=total, top=top, trend=trend)


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("token", nargs="?")
    ap.add_argument("--days", type=int, default=7)
    args, _ = ap.parse_known_args()
    if not args.token:
        print("用法: python weekly_report.py <token> [--days 7]")
        sys.exit(1)
    token = args.token
    days = max(1, args.days)

    rows = fetch_rows(token)
    products = [r for r in rows if r.get("类型") == "商品"]
    orders = [r for r in rows if r.get("类型") == "订单"]

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    end = today
    start = today - timedelta(days=days - 1)
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)

    cur = aggregate(orders, start, end)
    prev = aggregate(orders, prev_start, prev_end)

    on_sale = sum(1 for p in products if p.get("状态") == "在售")

    aov = (cur["total"] / cur["cnt"]) if cur["cnt"] else 0.0

    def pct(now, before):
        if before == 0:
            return "—" if now == 0 else "+100%↑(基期0)"
        d = (now - before) / before * 100
        return f"{d:+.1f}%"

    # 报告
    lines = []
    lines.append(f"# 云明图书带货店 · 营收周报（{start.strftime('%Y-%m-%d')} ~ {end.strftime('%Y-%m-%d')}）\n")
    lines.append("## 一、本周核心指标")
    lines.append(f"- 在售商品：**{on_sale}** 款")
    lines.append(f"- 订单总数：**{cur['cnt']}** 笔（待发货 {cur['st_count'].get('待发货',0)} / 已发货 {cur['st_count'].get('已发货',0)} / 已完成 {cur['st_count'].get('已完成',0)} / 已取消 {cur['st_count'].get('已取消',0)}）")
    lines.append(f"- 成交额（全部订单）：**¥{cur['total']:.0f}**")
    lines.append(f"- 已收款（已完成）：¥{cur['realized']:.0f}")
    lines.append(f"- 在途金额（待+已发货）：¥{cur['pending']:.0f}")
    lines.append(f"- 客单价：¥{aov:.0f}")
    lines.append("")
    lines.append("## 二、环比上一周期（{p} ~ {q}）".format(
        p=prev_start.strftime('%Y-%m-%d'), q=prev_end.strftime('%Y-%m-%d')))
    lines.append(f"- 订单数：{prev['cnt']} → {cur['cnt']}（{pct(cur['cnt'], prev['cnt'])}）")
    lines.append(f"- 成交额：¥{prev['total']:.0f} → ¥{cur['total']:.0f}（{pct(cur['total'], prev['total'])}）")
    lines.append(f"- 已收款：¥{prev['realized']:.0f} → ¥{cur['realized']:.0f}（{pct(cur['realized'], prev['realized'])}）")
    lines.append("")
    lines.append("## 三、每日成交额趋势")
    for i in range(days):
        d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
        amt = cur["trend"].get(d, 0.0)
        bar = "█" * int(amt / 10) if amt else "·"
        lines.append(f"- {d}: ¥{amt:.0f} {bar}")
    lines.append("")
    lines.append("## 四、热销榜 TOP5（按销量）")
    if cur["top"]:
        for i, (n, q) in enumerate(cur["top"], 1):
            lines.append(f"{i}. {n} — 售出 {q} 件")
    else:
        lines.append("- 本周暂无成交")
    lines.append("")
    lines.append("> 由每周营收汇总自动化生成 · 数据来源：云端「开店经营台账」")

    md = "\n".join(lines)
    out_path = os.path.join(WS, f"营收周报_{start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)

    print(f"已生成 {out_path}")
    print(f"窗口 {start.strftime('%Y-%m-%d')}~{end.strftime('%Y-%m-%d')} | 订单 {cur['cnt']} | 成交额 ¥{cur['total']:.0f} | 已收款 ¥{cur['realized']:.0f}")
    print("热销TOP3: " + "，".join(f"{n}({q})" for n, q in cur["top"][:3]))


if __name__ == "__main__":
    main()
