#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""daily_report.py —— 读取云端「开店经营台账」，生成每日营收简报。
用法: python daily_report.py <open_platform_token>
依赖: WorkBuddy 资料库 skill 的 database/get_database_content.py
输出: 营收日报_YYYY-MM-DD.md（写入工作区）+ 控制台摘要
"""
import sys, os, json, csv, io, subprocess
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


def main():
    if len(sys.argv) < 2:
        print("用法: python daily_report.py <token>")
        sys.exit(1)
    token = sys.argv[1]
    rows = fetch_rows(token)
    products = [r for r in rows if r.get("类型") == "商品"]
    orders = [r for r in rows if r.get("类型") == "订单"]

    today = datetime.now()
    today_s = today.strftime("%Y-%m-%d")
    week_ago = today - timedelta(days=6)

    def money(v):
        try:
            return float(v)
        except Exception:
            return 0.0

    # 订单状态统计
    st_count = {}
    realized = 0.0      # 已完成（已收款）
    pending_total = 0.0  # 待发货+已发货（未最终收款）
    for o in orders:
        s = o.get("状态", "待发货")
        st_count[s] = st_count.get(s, 0) + 1
        amt = money(o.get("金额"))
        if s == "已完成":
            realized += amt
        elif s in ("待发货", "已发货"):
            pending_total += amt

    on_sale = sum(1 for p in products if p.get("状态") == "在售")

    # 近7日订单趋势
    trend = {}
    for o in orders:
        d = (o.get("日期") or "")[:10]
        if d >= week_ago.strftime("%Y-%m-%d"):
            trend[d] = trend.get(d, 0) + money(o.get("金额"))

    # 热销榜（按商品名汇总销量）
    sales = {}
    for o in orders:
        if o.get("状态") == "已取消":
            continue
        try:
            items = json.loads(o.get("详情") or "[]")
        except Exception:
            items = []
        for it in items:
            n = it.get("name", "")
            q = int(it.get("qty", 0) or 0)
            sales[n] = sales.get(n, 0) + q
    top = sorted(sales.items(), key=lambda x: -x[1])[:5]

    # 组装报告
    lines = []
    lines.append(f"# 云明图书带货店 · 营收日报（{today_s}）\n")
    lines.append("## 一、核心指标")
    lines.append(f"- 商品在售数：**{on_sale}** 款")
    lines.append(f"- 订单总数：**{len(orders)}** 笔（待发货 {st_count.get('待发货',0)} / 已发货 {st_count.get('已发货',0)} / 已完成 {st_count.get('已完成',0)} / 已取消 {st_count.get('已取消',0)}）")
    lines.append(f"- 已收款营收（已完成）：**¥{realized:.0f}**")
    lines.append(f"- 在途金额（待+已发货）：¥{pending_total:.0f}")
    lines.append("")
    lines.append("## 二、近 7 日成交额趋势")
    for i in range(6, -1, -1):
        d = (week_ago + timedelta(days=i)).strftime("%Y-%m-%d")
        amt = trend.get(d, 0.0)
        bar = "█" * int(amt / 10) if amt else "·"
        lines.append(f"- {d}: ¥{amt:.0f} {bar}")
    lines.append("")
    lines.append("## 三、热销榜 TOP5")
    if top:
        for i, (n, q) in enumerate(top, 1):
            lines.append(f"{i}. {n} — 售出 {q} 件")
    else:
        lines.append("- 暂无成交")
    lines.append("")
    lines.append("> 由每日营收简报自动化生成 · 数据来源：云端「开店经营台账」")

    md = "\n".join(lines)
    out_path = os.path.join(WS, f"营收日报_{today_s}.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)

    # 控制台摘要
    print(f"已生成 {out_path}")
    print(f"在售商品 {on_sale} | 订单 {len(orders)} | 已收款 ¥{realized:.0f} | 在途 ¥{pending_total:.0f}")
    print("热销TOP3: " + "，".join(f"{n}({q})" for n, q in top[:3]))


if __name__ == "__main__":
    main()
