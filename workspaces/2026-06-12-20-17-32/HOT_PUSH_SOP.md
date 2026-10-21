# 后台「为我推荐的」流量扶持推送 · 自动化读取 SOP（v1.0，2026-09-29）

> 单一来源：本文件 + `hot_push_grab.js`（读取器）+ `hot_push_state.json`（状态快照）。
> 生效对象：从 **noon 档（12:00）起**，noon / pm 选题第一锚点改为本 SOP 产出的「为我推荐的」。
> 已发布的历史内容**不追溯、不修改**。

---

## 一、术语与锚点定义（先对齐，避免再次混淆）

| 名词 | 是什么 | 在选题里的角色 |
|---|---|---|
| **为我推荐的（本 SOP 对象）** | 后台**消息中心「话题邀请」分类里，小助手主动推 + 带「流量扶持」标记**的卡片，文本特征：`🔥今日话题#xxx#（N万人在围观）… 本次发文将获得小助手流量扶持哦～` | **选题第一锚点**，能抓到就按它写 |
| 选题推荐轮播列表 | 图文发布页正文区下方 `.recommend-list` 的换一换列表（`_grab_publish_suggest.js` 抓） | 仅**补充候选池**，不是"为我推荐的"，不得当作锚点 |
| 流量扶持 | 小助手标记"本次发文将获得流量扶持" | 命中扶持 = 真"为我推荐的"，优先写 |

**一句话判据**：选题 = `hot_push_state.json` 的 `recommended.topic`（带 `support=true`）。

---

## 二、数据读取（何时、怎么读）

**脚本**：`node hot_push_grab.js`（只读、结构化；默认当日北京时间，可用 `--date`/`DATE` 覆盖，`CDP_PORT` 换端口）。

**每档选题前必跑一次**（顺序插入在"抓后台候选池"之后、"选本档话题"之前）：

```
数据复盘(check_backend) → 抓后台候选池(_act_scan / _grab_publish_suggest --write-pool)
  → node hot_push_grab.js            # ← 新增：读"为我推荐的"，落 hot_push_state.json
  → 读 hot_push_state.json 的 recommended.topic 作为选题锚点
  → festival_sync.js --check → topic_sync.js --date <DATE> → 选题/登记六要素
```

**读法**：

```bash
node -e 'const s=require("./hot_push_state.json");console.log("锚点=",s.recommended.topic,"扶持=",s.recommended.support,"围观=",s.recommended.guanwan,"时间=",s.recommended.time,"来源=",s.source)'
```

- `recommended.topic` 非空 且 `support=true` → **直接写它**，不再做垂直度筛选、不做 7 天去重规避（重复靠成稿信息增量解决，见第四节）。
- `all_supported[]` 是当日全部"为我推荐的"卡（多条时一般同题反复推，取最新一条=当前主推）。
- `fetched_at` 是抓取时间戳；选题前**必须现跑一次**，不得用隔夜 state（后台推送会换题）。

---

## 三、解析规则（脚本内部逻辑，供排障）

1. **入口 URL**：`mp.toutiao.com/profile_v4/personal/message?type=topic_invite`，显式点「话题邀请」tab 拉全量历史卡。
2. **卡片切分**：按分隔串「你的专属热议话题速递」切块；命中 0 块时退化用正则抓每个 `🔥今日话题#主题#（…）` 片段。
3. **字段提取**（`parseCard`）：
   - `topic`：`#xxx#` 或 `今日话题#xxx#`。
   - `guanwan`：`N万人在围观` → `380万`。
   - `support`（"为我推荐的"判据）：命中 `流量扶持 | 小助手…发文 | 🔥今日话题` 之一。
   - `time`：`09-29 06:01` / `今日` / `昨日` / `N小时前`。
4. **取最新一条**（`tsKey` 优先级，已修 2026-09-29 排序 bug）：
   `今日(9999) > N小时前(9998−N) > 昨日(9997) > MMDD(按日期升序)`。同题多卡时取最新，避免误把隔日卡当主推。

---

## 四、成稿约束（"为我推荐的"不是照抄）

即便选题锚点=后台主推原文，成稿仍**必须带信息增量**（自己的判断 / 真实经历 / 可核实数据 / 可操作步骤，四选一），不允许把推送原文换个说法复述一遍。数字事件须可核实，人物类热点发稿前单独核实现状，禁编造调研样本量与百分比。全平台发稿前过 humanizer 去 AI 味。

---

## 五、异常处理（退出码即分支）

`hot_push_grab.js` 退出码：

| 退出码 | 含义 | 处置 |
|---|---|---|
| **0** | 成功，抓到 ≥1 张"为我推荐的"卡，`hot_push_state.json` 已更新 | 直接读 `recommended` 选题 |
| **7** | 抓取/解析失败：页面未渲染（PAGE_LEN 过短）/ 无带扶持标记的卡 / 正则未命中 | 走**三级兜底**：①现场重抓（换 `CDP_PORT=9355` 再跑一次）②`_grab_publish_suggest.js --write-pool` ③WebSearch（须标注）；仍无则当日按"无为我推荐"处理，选题退到候选池，**不得编造** |
| **3** | 浏览器 / cookie 失败（launchBrowser 抛错、COOKIES 过期） | 先 `taskkill chrome` 清残留，换 `CDP_PORT=9355` 重试一次；仍 3 → 告警"读取器故障"，选题改走常规抓后台（`_act_scan`），并汇报 cookie 可能要重登 |

**关键分支规则**：
- `PAGE_LEN < 500`（页面没渲染出来）→ 直接退 7，**不误判成"今天没有为我推荐"**。区分"页面失败"（退7，需重抓）与"确实没推"（退0 但 recommended 为空）。
- 无 `support` 标记但有 `#主题#` 卡 → 脚本退化为"最新一条话题邀请卡"（仍属小助手推，标 `source=topic_invite_fallback`），可选题但在汇报里标注"未带扶持标记"。
- **任何情况下不得用已过期节日题、不得凭记忆定题**。读取器失败就兜底，不是就编一条。

---

## 六、与双档同步（noon / pm 不重复）

- `recommended` 只给"写哪条"，不决定"角度/深度/立场"。两档写同一条"为我推荐的"时，靠 `topic_sync.js` 六要素登记 + 差异化矩阵换维度（角度/深度/立场至少换两个），核心观点不得雷同。
- noon 发过后，pm 读 `daily_topic.json` 看 noon 已用的角度/深度；若"为我推荐的"仍是同题，pm 走差异化；若换了题，pm 跟着换。
- 发布后该条"为我推荐的"仍会反复推（如注安连推 20+ 天），**照写不回避**，差异靠信息增量。

---

## 七、状态文件 `hot_push_state.json` 结构

```json
{
  "fetched_at": "ISO 抓取时间戳（选题前须现跑，勿用隔夜）",
  "date": "2026-09-29",
  "source": "topic_invite_support | topic_invite_fallback",
  "recommended": { "topic": "...", "guanwan": "380万", "support": true, "time": "今日", "raw": "…" },
  "all_supported": [ { "topic", "guanwan", "time" } ],
  "_note": "后台『为我推荐的』流量扶持推送快照；见 HOT_PUSH_SOP.md"
}
```

---

## 八、变更与扩展

- 读取器只读，不写选题、不发布；发布仍走 `auto_publish.js` / `wt_publish.js`。
- 后台若改版卡片文案（分隔串/标记词变化），改 `hot_push_grab.js` 的 `extractCards` / `parseCard` 正则即可，SOP 第三、五节同步。
- 新增"为我推荐的"来源（如消息中心其他分类也推扶持）→ 在 `extractCards` 前追加对应页抓取，输出合并进 `all_supported`。
