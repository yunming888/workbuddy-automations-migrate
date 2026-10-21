# -*- coding: utf-8 -*-
"""
流量监测与复盘（与「每日热点评论」任务绑定，非独立定时任务）

职责：每次每日任务执行时调用，分析当前流量波动 + 对近 3 天流量做结构化复盘，
      定位下滑环节/原因 + 给出重点调整方向，结果附加到任务输出中。

数据源（全部复用现有，不新建抓取）：
  - analytics_raw/records_parsed_v*.json   逐篇阅读明细（T+1 抓取，可能有断档）
  - analytics_raw/full_dimension_summary.json  渠道结构 HHI + 涨粉趋势
  - 热点评论/_publish_queue.json            发布事实（实时，近 3 天发了哪些篇）

铁律：
  - 只基于已抓到的真实数据，缺的用「暂无数据」占位，绝不编数字。
  - 数据断档（逐篇明细截止日 vs 发布日 的间隔）要如实标注，避免把「没抓到数据」误判成「流量崩了」。
  - 完读率/首次分享率样本量小时标注「噪声大，趋势仅供参考」。

用法：
  python _traffic_review.py            # 复盘日 = 今天
  python _traffic_review.py 20260918  # 指定复盘日
输出：
  热点评论/_traffic_review/YYYYMMDD_流量复盘.md   结构化复盘（人读）
  热点评论/_traffic_review/YYYYMMDD_流量复盘.json  结构化数据（机读/追踪）
  stdout 打印可嵌入任务输出的摘要块
"""
import glob
import json
import os
import re
import sys
import datetime

ROOT = r"C:\Users\Administrator\WorkBuddy\2026-07-10-17-25-30"
RAW = os.path.join(ROOT, "analytics_raw")
QPATH = os.path.join(ROOT, "热点评论", "_publish_queue.json")
OUTDIR = os.path.join(ROOT, "热点评论", "_traffic_review")

OBS_N = 3    # 观察期天数（近 3 天）
BASE_N = 4    # 基线期天数（前 4 天，与观察期合计 7 天）
GAP_WARN_DAYS = 3  # 逐篇数据截止日落后发布日超过 N 天 → 判数据断档


def _parse_args_date(argv):
    if len(argv) > 1 and re.fullmatch(r"\d{8}", argv[1]):
        return datetime.date(int(argv[1][:4]), int(argv[1][4:6]), int(argv[1][6:8]))
    return datetime.date.today()


def latest_per_article_json():
    """找最新的逐篇明细 json（文件名带 8 位日期者取日期最大，否则按 mtime）。"""
    cands = glob.glob(os.path.join(RAW, "records_parsed_v*.json"))
    if not cands:
        cands = glob.glob(os.path.join(RAW, "records_parsed.json"))
    if not cands:
        return None, None
    dated, undated = [], []
    for p in cands:
        m = re.search(r"(\d{8})\.json$", p)
        (dated if m else undated).append((m.group(1) if m else None, p))
    if dated:
        dated.sort(key=lambda x: x[0])
        return dated[-1][1], "dated:" + dated[-1][0]
    best = max(undated, key=lambda x: os.path.getmtime(x[1]))
    return best[1], "mtime"


def parse_latest_xls():
    """找最新的 v6_all_*.xls 并解析成逐篇明细（字段映射与 _recalc_v2 一致）。
    返回 {'path','records','cutoff'}；无 xls 或缺 xlrd → records=[] 并记 err。
    必须用带 xlrd 的 venv python 跑本脚本（managed 裸版无 xlrd）。"""
    cands = glob.glob(os.path.join(RAW, "v6_all_*.xls"))
    if not cands:
        return {"path": None, "records": [], "cutoff": None, "err": "no v6_all xls"}
    cands.sort(key=lambda p: os.path.getmtime(p))
    p = cands[-1]
    try:
        import xlrd
    except Exception as ex:
        return {"path": p, "records": [], "cutoff": None, "err": "no xlrd: %s" % ex}
    try:
        wb = xlrd.open_workbook(p)
        sh = wb.sheet_by_index(0)
        hdr = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
        IDX = {h: i for i, h in enumerate(hdr)}
        if "总阅读人数" not in IDX:
            return {"path": p, "records": [], "cutoff": None, "err": "bad header"}
    except Exception as ex:
        return {"path": p, "records": [], "cutoff": None, "err": "open fail: %s" % ex}

    def col(r, name):
        if name not in IDX:
            return 0
        v = sh.cell_value(r, IDX[name])
        if isinstance(v, str):
            v = v.strip()
            if v in ("", "-", "--"):
                return 0
            try:
                return float(v)
            except Exception:
                return 0
        return float(v) if v is not None else 0

    rows = []
    for r in range(1, sh.nrows):
        title = str(sh.cell_value(r, 0)).strip()
        if not title:
            continue
        dstr = str(sh.cell_value(r, IDX["发表时间"])).strip() if "发表时间" in IDX else ""
        try:
            d = datetime.datetime.strptime(dstr, "%Y%m%d").date()
        except Exception:
            continue
        rows.append({
            "date": d.strftime("%Y-%m-%d"), "title": title,
            "read": int(col(r, "总阅读人数")), "read_cnt": int(col(r, "总阅读次数")),
            "share_p": int(col(r, "总分享人数")), "share_c": int(col(r, "总分享次数")),
            "follow": int(col(r, "阅读后关注人数")), "sent": int(col(r, "送达人数")),
            "msg_read": int(col(r, "公众号消息阅读次数")),
            "open_rate": col(r, "送达阅读率"), "first_share": int(col(r, "首次分享次数")),
            "share_read": int(col(r, "分享产生阅读次数")),
            "first_share_rate": col(r, "首次分享率"),
            "read_per_share": col(r, "每次分享带来阅读次数"),
            "finish": col(r, "阅读完成率"),
        })
    cutoff = max(x["date"] for x in rows) if rows else None
    return {"path": p, "records": rows, "cutoff": cutoff, "err": None}


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def aggregate_by_date(records):
    """按 date 聚合逐篇明细 → {date: {read, sent, open_rate, finish_avg, fshare_avg, follow, n}}"""
    by = {}
    for r in records:
        d = str(r.get("date", "")).strip()
        if not d:
            continue
        e = by.setdefault(d, {"read": 0, "sent": 0, "finish": [], "fshare": [], "follow": 0, "n": 0})
        e["read"] += int(r.get("read", 0) or 0)
        e["sent"] = max(e["sent"], int(r.get("sent", 0) or 0))
        e["follow"] += int(r.get("follow", 0) or 0)
        e["n"] += 1
        if "finish" in r:
            e["finish"].append(float(r.get("finish", 0) or 0))
        if "first_share_rate" in r:
            e["fshare"].append(float(r.get("first_share_rate", 0) or 0))
    for e in by.values():
        e["open_rate"] = round(e["read"] / e["sent"], 4) if e["sent"] else 0.0
        e["finish_avg"] = round(sum(e["finish"]) / len(e["finish"]), 4) if e["finish"] else 0.0
        e["fshare_avg"] = round(sum(e["fshare"]) / len(e["fshare"]), 4) if e["fshare"] else 0.0
        del e["finish"], e["fshare"]
    return by


def period_metrics(by, dates):
    """对若干 date 求区间指标均值。"""
    rows = [by[d] for d in dates if d in by]
    if not rows:
        return None
    n = len(rows)
    tot_read = sum(r["read"] for r in rows)
    tot_sent = sum(r["sent"] for r in rows)
    tot_follow = sum(r["follow"] for r in rows)
    return {
        "days": n,
        "avg_daily_read": round(tot_read / n, 2),
        "open_rate": round(tot_read / tot_sent, 4) if tot_sent else 0.0,
        "finish_avg": round(sum(r["finish_avg"] for r in rows) / n, 4),
        "fshare_avg": round(sum(r["fshare_avg"] for r in rows) / n, 4),
        "daily_follow": round(tot_follow / n, 2),
        "low_sample": any(r["n"] <= 1 for r in rows),
    }


def pct_change(base, obs):
    if not base:
        return None  # 基线为 0，无法算变化率
    return round((obs - base) / base * 100, 1)


STAGE_NAMES = {
    "avg_daily_read": "曝光→阅读（总阅读量）",
    "open_rate": "阅读→打开（点击率）",
    "finish_avg": "打开→完读（留存）",
    "fshare_avg": "完读→分享（传播）",
    "daily_follow": "分享→涨粉（转化）",
}
STAGE_ACTIONS = {
    "avg_daily_read": "总阅读下滑：触达不够。优先走搜一搜冷启动（篇内埋关键词/长尾词）+ 热点选题贴合当日搜索词；推荐流量占比高的号别依赖被动推送。",
    "open_rate": "打开率下滑：标题/封面点击不足。下篇标题加更强钩子（数字反差/痛点前置），封面主视觉换更高对比度。",
    "finish_avg": "完读率下滑：内容留存差。正文压缩到 800 字内、加小标题分段、开头 3 句给到干货，减少套话。",
    "fshare_avg": "分享率下滑：传播动力弱。结尾加可转发的金句/观点站队点，选题挑有争议、值得转的。",
    "daily_follow": "涨粉停滞：关注转化弱。文末加关注钩子（系列预告/下一篇悬念），热点评论线用「系列化」留住读者。",
}
GAP_ACTION = "数据断档：逐篇阅读明细落后于发布日（T+1 未抓取），上面下滑幅度含「没抓到数据」的噪声，不能直接当真实流量下滑。先跑 mp_analytics_v6.py 导出 datacube xls 补齐再判趋势。"


def main():
    review_date = _parse_args_date(sys.argv)
    rd = review_date.strftime("%Y-%m-%d")
    # 复盘日往前 3 天日历（含当日）=「近 3 天」
    cal_last3 = [(review_date - datetime.timedelta(days=i)).strftime("%Y-%m-%d") for i in (0, 1, 2)]
    cal_last3.sort()

    # ---- 逐篇明细：优先用最新 v6_all_*.xls（比 json 新鲜，需 xlrd），无则回退 json ----
    xls = parse_latest_xls()
    pa_json, pa_json_src = latest_per_article_json()
    json_records = load_json(pa_json) or []
    if xls["records"] and (not json_records or (xls["cutoff"] or "9999") >=
                           (max((r.get("date", "") for r in json_records), default="") or "0")):
        records, pa_path, pa_src = xls["records"], os.path.basename(xls["path"]), "v6_all xls"
        if xls.get("err"):
            pa_src += "（解析失败）"
    else:
        records, pa_path, pa_src = json_records, pa_json, pa_json_src
    by = aggregate_by_date(records)
    dates_sorted = sorted(by.keys())
    data_cutoff = dates_sorted[-1] if dates_sorted else None

    # 观察期锚定到「近 3 天日历」；因逐篇数据 T+1，近 3 天可能还没抓到
    obs_have = [d for d in cal_last3 if d in by]
    if obs_have:
        obs_dates, trend_ref = sorted(obs_have), False
    else:
        # 近 3 天无逐篇数据 → 退用「最近有数据的 3 天」作历史趋势参考（非近 3 天）
        obs_dates = dates_sorted[-OBS_N:] if len(dates_sorted) >= OBS_N else dates_sorted
        trend_ref = True
    # 基线期 = 观察期之前的 BASE_N 天
    _idx = {d: i for i, d in enumerate(dates_sorted)}
    if obs_dates:
        _i0 = min(_idx[d] for d in obs_dates)
        base_dates = dates_sorted[max(0, _i0 - BASE_N):_i0]
    else:
        base_dates = []
    obs_m = period_metrics(by, obs_dates)
    base_m = period_metrics(by, base_dates) if base_dates else None

    # 数据断档判断
    gap_days = None
    q = load_json(QPATH) or {}
    published_dates = sorted({i.get("published_at", "")[:10] for i in q.get("items", []) if i.get("published_at")})
    latest_pub = published_dates[-1] if published_dates else None
    if data_cutoff and latest_pub:
        d1 = datetime.date.fromisoformat(data_cutoff)
        d2 = datetime.date.fromisoformat(latest_pub)
        gap_days = (d2 - d1).days

    # ---- 下滑环节定位 ----
    drops = []
    if obs_m and base_m:
        for key in ["avg_daily_read", "open_rate", "finish_avg", "fshare_avg", "daily_follow"]:
            chg = pct_change(base_m.get(key) or 0, obs_m.get(key) or 0)
            drops.append({
                "stage": key,
                "stage_name": STAGE_NAMES[key],
                "base": base_m.get(key),
                "obs": obs_m.get(key),
                "change_pct": chg,  # None = 基线为 0 无法算
                "noisy": key in ("finish_avg", "fshare_avg") and obs_m.get("low_sample"),
            })
        # 主要下滑环节 = 跌幅最大且非噪声优先（噪声的降权：noisy 需跌幅 > 30% 才算主因）
        valid = [d for d in drops if d["change_pct"] is not None
                 and (d["change_pct"] < 0 or not d["noisy"])]
        valid = [d for d in valid if (d["change_pct"] < 0)]
        primary = None
        if valid:
            primary = sorted(valid, key=lambda d: (d["noisy"], d["change_pct"]))[0]

    # ---- 近 3 天发布事实（日历）----
    pub_last3 = []
    for i in q.get("items", []):
        d = (i.get("published_at") or "")[:10] or i.get("scheduled_date", "")
        if d in cal_last3 and i.get("status") == "done":
            der = i.get("derivatives", {}) or {}
            pub_last3.append({
                "date": d,
                "title": i.get("title"),
                "appmsgid": i.get("appmsgid"),
                "channel": "公众号",
                "channels": bool(der.get("channels_published")),
                "channels_at": der.get("channels_published_at"),
            })
    pub_last3.sort(key=lambda x: x["date"])

    # ---- 渠道结构 + 涨粉 ----
    dim = load_json(os.path.join(RAW, "full_dimension_summary.json")) or {}
    channel_struct = dim.get("channels", {})
    hhi = dim.get("hhi")
    follow = dim.get("follow", {})
    total_fans = follow.get("total_fans")
    follow_src = follow.get("follow_source", {})

    # ---- 调整方向（规则化，绑定数字）----
    actions = []
    if gap_days and gap_days > GAP_WARN_DAYS:
        actions.append(GAP_ACTION)
    if primary:
        actions.append(STAGE_ACTIONS[primary["stage"]].replace("下滑", "下滑（%s）" % primary["stage_name"]))
        actions[-1] = ("【主因·%s，%s→%s，%s%%】%s" % (
            primary["stage_name"], primary["base"], primary["obs"],
            ("%.1f" % primary["change_pct"]), STAGE_ACTIONS[primary["stage"]]))
    if channel_struct:
        top = sorted(channel_struct.items(), key=lambda x: -x[1])
        top_name, top_pct = top[0][0], top[0][1]
        if hhi and hhi > 0.5:
            actions.append("【渠道集中】HHI=%.2f（偏高），%s 占 %.1f%%，单一渠道依赖强。"
                           "埋搜一搜词 + 系列化选题，把推荐之外的入口做厚。" % (hhi, top_name, top_pct))
    if total_fans is not None and total_fans <= 20:
        actions.append("【涨粉薄弱】总粉 %s（%s 占 100%% 来自%s）。热点评论线用系列钩子（上/下集预告）做留存，别互推。"
                       % (total_fans, total_fans, (follow_src.get("src") or "文章页")))
    if not actions:
        actions.append("无明显单一环节下滑：维持当前节奏，继续靠热点评论新线积累搜一搜入口。")

    caveats = []
    if gap_days and gap_days > GAP_WARN_DAYS:
        caveats.append("逐篇阅读明细截至 %s，发布事实截至 %s，间隔 %d 天（数据断档）；近 3 天（%s）逐篇阅读尚未抓取。"
                       % (data_cutoff, latest_pub, gap_days, "、".join(cal_last3)))
    if trend_ref:
        caveats.append("近 3 天（%s）逐篇阅读暂无数据（T+1 未抓取）；下面逐篇/下滑环节用的是「最近有数据的 3 天 %s」作历史趋势参考，非真实近 3 天。"
                       % ("、".join(cal_last3), "、".join(obs_dates)))
    if obs_m and obs_m.get("low_sample"):
        caveats.append("观察期样本量小（单日仅 1 篇），完读率/首次分享率噪声大，趋势仅供参考。")
    if not base_m:
        caveats.append("数据不足 7 天，无完整基线期，下滑对比仅供参考。")
    if data_cutoff and data_cutoff < cal_last3[-1]:
        _n = (datetime.date.fromisoformat(cal_last3[-1]) - datetime.date.fromisoformat(data_cutoff)).days
        caveats.append("逐篇明细 T+1：截至 %s（落后复盘日 %d 天），最近 %d 天的逐篇阅读要等次日 datacube 抓取才完整；今天刚发的篇，阅读数尚未进数据。"
                       % (data_cutoff, _n, min(_n, OBS_N)))

    # ---- 渲染 ----
    os.makedirs(OUTDIR, exist_ok=True)
    stem = "流量复盘"
    md_path = os.path.join(OUTDIR, "%s_%s.md" % (review_date.strftime("%Y%m%d"), stem))
    js_path = os.path.join(OUTDIR, "%s_%s.json" % (review_date.strftime("%Y%m%d"), stem))

    out = {
        "review_date": rd,
        "data_sources": {
            "per_article": os.path.basename(pa_path) if pa_path else None,
            "per_article_src": pa_src,
            "per_article_cutoff": data_cutoff,
            "publish_queue": latest_pub,
            "gap_days": gap_days,
            "obs_dates": obs_dates,
            "base_dates": base_dates,
        },
        "publish_last3": pub_last3,
        "per_day_metrics": [
            {"date": d, **by[d]} for d in obs_dates
        ],
        "obs": obs_m,
        "base": base_m,
        "drops": drops,
        "primary_drop": primary["stage_name"] if primary else None,
        "channel_structure": channel_struct,
        "hhi": hhi,
        "follow": {"total_fans": total_fans, "source": follow_src},
        "actions": actions,
        "caveats": caveats,
    }
    with open(js_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    md = []
    md.append("# 流量复盘 · %s（近 3 天）\n" % rd)
    md.append("## 数据源与缺口\n")
    md.append("- 逐篇阅读明细：`%s`（截至 %s，%s）" % (
        os.path.basename(pa_path) if pa_path else "暂无", data_cutoff, pa_src or ""))
    md.append("- 发布事实：`_publish_queue.json`（实时，截至 %s）" % latest_pub)
    md.append("- 渠道/涨粉：`full_dimension_summary.json`")
    for c in caveats:
        md.append("- ⚠️ %s" % c)
    md.append("")

    md.append("## 一、发布节奏（近 3 天日历 %s）\n" % "、".join(cal_last3))
    if pub_last3:
        md.append("| 日期 | 篇名 | 公众号 | 视频号 |")
        md.append("|---|---|---|---|")
        for p in pub_last3:
            md.append("| %s | %s | %s | %s |" % (
                p["date"], p["title"], p["appmsgid"] or "—",
                ("已发 " + str(p["channels_at"])) if p["channels"] else "未发"))
    else:
        md.append("暂无已完成的近 3 天发布记录。")
    md.append("")

    md.append("## 二、逐篇阅读表现（观察期 %s）\n" % "、".join(obs_dates) if obs_dates else "")
    if out["per_day_metrics"]:
        md.append("| 日期 | 总阅读 | 打开率 | 完读率 | 首次分享率 | 涨粉 |")
        md.append("|---|---|---|---|---|---|")
        for d in out["per_day_metrics"]:
            md.append("| %s | %s | %s | %s | %s | %s |" % (
                d["date"], d["read"], d["open_rate"], d["finish_avg"], d["fshare_avg"], d["follow"]))
    else:
        md.append("观察期暂无逐篇数据。")
    md.append("")

    _on = obs_m.get("days") if obs_m else 0
    _bn = base_m.get("days") if base_m else 0
    md.append("## 三、下滑环节定位（观察期 %d 天 vs 基线 %d 天）\n" % (_on, _bn))
    if drops:
        md.append("| 环节 | 基线 | 近3天 | 变化 | 备注 |")
        md.append("|---|---|---|---|---|")
        for d in drops:
            note = "噪声大" if d.get("noisy") else ""
            chg = ("%.1f%%" % d["change_pct"]) if d["change_pct"] is not None else "基线为0"
            md.append("| %s | %s | %s | %s | %s |" % (
                d["stage_name"], d["base"], d["obs"], chg, note))
        md.append("\n**主要下滑环节：%s**" % (primary["stage_name"] if primary else "无明显单一环节"))
    else:
        md.append("数据不足，无法定位。")
    md.append("")

    md.append("## 四、渠道结构 & 涨粉\n")
    if channel_struct:
        md.append("- 渠道占比（HHI=%s）：%s" % (
            hhi, "、".join("%s %.1f%%" % (k, v) for k, v in
                           sorted(channel_struct.items(), key=lambda x: -x[1]))))
    if total_fans is not None:
        md.append("- 总粉丝 %s；%s" % (total_fans,
                     ("%s 占 %s%%" % (follow_src.get("src"), follow_src.get("pct")) if follow_src else "来源未知")))
    md.append("")

    md.append("## 五、后续重点调整方向\n")
    for i, a in enumerate(actions, 1):
        md.append("%d. %s" % (i, a))
    md.append("")
    md.append("## 六、与今日发布关联\n")
    if pub_last3:
        md.append("今日/近 3 天发布的 %s 逐篇阅读 %s（T+1 抓取，未出则明日复盘自动纳入）。" % (
            "、".join(p["title"] for p in pub_last3),
            "暂未出" if (data_cutoff and data_cutoff < cal_last3[-1]) else "已纳入"))
    else:
        md.append("无今日发布关联。")
    md.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    # ---- stdout 摘要块（供嵌入任务输出）----
    print("=== 流量复盘 %s（近 3 天）===" % rd)
    print("主要下滑环节：%s" % (primary["stage_name"] if primary else "无明显单一环节"))
    for d in drops:
        if d["change_pct"] is not None:
            print("  %s: %s → %s (%+.1f%%)%s" % (
                d["stage_name"], d["base"], d["obs"], d["change_pct"],
                " [噪声]" if d.get("noisy") else ""))
    for c in caveats:
        print("  ⚠️ %s" % c)
    print("调整方向:")
    for i, a in enumerate(actions, 1):
        print("  %d. %s" % (i, a))
    print("[复盘文件] %s" % md_path)
    print("[数据文件] %s" % js_path)


if __name__ == "__main__":
    main()
