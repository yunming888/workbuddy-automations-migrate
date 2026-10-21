---
name: workbuddy-automations-migrate
description: 一键恢复/迁移 WorkBuddy 定时任务（automation）。当用户说「迁移定时任务」「换电脑恢复定时任务」「定时任务搬家」「恢复 automation」「备份定时任务」时使用。提供 tasks/automations.json 的完整任务定义与 scripts/restore.py 一键重建脚本。
---

# WorkBuddy 定时任务迁移 Skill

把本机 WorkBuddy 的定时任务（automation）完整迁移到另一台电脑。

## 何时使用
- 「把这些定时任务搬到新电脑」
- 「新电脑上恢复定时任务」
- 「备份我的定时任务」
- 「automation 迁移 / 定时任务搬家」

## 核心事实（先读，避免走错路）

| 项 | 结论 |
|---|---|
| 调度器 | **WorkBuddy 桌面端内置调度器**，不是 Windows 任务计划程序/schtasks，也不是系统服务 |
| 任务存哪 | `~/.workbuddy/workbuddy.db` 的 `automations` 表（另有 `automation_runs` / `automation_runtime_state`） |
| 硬前提 | **新电脑必须装 WorkBuddy 桌面端并保持后台运行**，否则定时任务不会被触发 |
| 路径绑定 | 每个任务的 `cwds` 字段存绝对路径（形如 `["C:/Users/<用户名>/WorkBuddy/<workspace>"]`），换用户名必须重映射 |
| 模型绑定 | 6 个任务全部 `model_id=custom-local:agnes-3.0-flash`，依赖 `~/.workbuddy/models.json` 里的自定义模型 |

## 一键恢复（推荐）

```bash
python scripts/restore.py            # 交互模式
python scripts/restore.py --dry-run  # 预演，不写库
python scripts/restore.py --yes      # 无人值守
python scripts/restore.py --force    # 覆盖已存在的同名任务
python scripts/restore.py --only 头条  # 只恢复名字含关键字的
```

脚本会：读 `tasks/automations.json` → 自动把路径里的旧用户名替换成当前用户名 → `INSERT OR REPLACE` 写入本机 `workbuddy.db` 的 `automations` 表 → 打印后续必做事项。**幂等**：已存在的任务默认跳过。

## 恢复后必做（缺一任务都跑不起来）

1. **装 WorkBuddy 桌面端并登录，保持后台运行**（调度器本体）
2. **确认自定义模型存在**：`~/.workbuddy/models.json` 里有 `agnes-3.0-flash`，否则任务用不了模型
3. **workspace 目录就位**（restore 只写任务定义，不搬文件）：
   - `C:\Users\<你>\WorkBuddy\2026-06-12-20-17-32` — 头条号（4 个任务）
   - `C:\Users\<你>\WorkBuddy\2026-07-10-17-25-30` — 每日热点评论
   - `C:\Users\<你>\WorkBuddy\2026-08-14-20-53-36` — Agnes 巡检
4. **核对 Node 版本后缀**：`ls ~/.workbuddy/binaries/node/versions/`。源机是 `22.22.2-6`，但 prompt 文本里写死 `22.22.2-3`，新机若不同要改 prompt
5. **Python 必须用 venv**：`~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（装了 PIL/playwright/xlrd）。裸版 `versions/3.13.12/python.exe` 无 PIL，`gen_covers.py` 会 ModuleNotFoundError
6. **各平台登录态重扫**（本人操作，自动化不代扫）：头条 cookie / 公众号 `_mp_login.py` / 视频号 `_channels_login.py`
7. **打开 WorkBuddy 定时任务列表确认** 6 个任务都在且已启用

## 本 skill 打包的 6 个任务

| # | 任务名 | 触发 | rrule | workspace |
|---|--------|------|-------|-----------|
| 1 | 头条号【职场读书】中午12点档发文 | 每天 12:00 | `FREQ=DAILY;BYHOUR=12;BYMINUTE=0` | 2026-06-12 |
| 2 | 头条每日发文·晚6点(pm) | 每天 18:00 | `FREQ=DAILY;BYHOUR=18;BYMINUTE=0` | 2026-06-12 |
| 3 | Agnes 免费 API 巡检与同步 | 每周一 08:00 | `FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0` | 2026-08-14 |
| 4 | 每日热点评论（每天1篇·队列顺延） | 每天 06:10 | `FREQ=DAILY;BYHOUR=6;BYMINUTE=10` | 2026-07-10 |
| 5 | 头条每日发文·早7点(am) | 每天 07:00 | `FREQ=DAILY;BYHOUR=7;BYMINUTE=0` | 2026-06-12 |
| 6 | 头条号数据每3天复盘 | 每 3 天 07:15 | `FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=15` | 2026-06-12 |

完整 prompt 原文在 `tasks/automations.json`（restore.py 会原样写入）。

## ⚠️ 避坑

1. **不装 WorkBuddy = 定时全停**，别去注册 schtasks/系统服务，那些任务不是系统级调度
2. **换用户名必须重映射路径**——restore.py 已自动处理 `Administrator` → 当前用户名；若你的新机用户名既不是 Administrator 也不是脚本自动识别的，需手动确认 cwds
3. **Node 版本后缀会漂**（-3/-6 随环境变），首次上机务必 `ls` 核对再改 prompt
4. **Python 必须 venv**，裸版无 PIL
5. **登录态必过期**，首次由本人扫码，脚本和 AI 都不代扫
6. **`_channels_publish2.py` 才是视频号发布脚本**，v1 `_channels_publish.py` 已作废
7. **幂等台账 (date,slot) 判重**：若沿用旧 `automation_state.json`，同一天同档会被判重跳过，属正常保护
8. **credentials 不进仓库**：cookies / keyblob / token / .env 均已在打包时剔除，新机各自登录