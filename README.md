# workbuddy-automations-migrate

把 WorkBuddy 的 **6 个定时任务**完整迁移到另一台电脑。一个 zip → 一条命令 → 任务全部回来。

## 快速开始（新电脑）

```bash
# 1. 克隆本仓库（GitHub 上搜 workbuddy-automations-migrate）
git clone <repo-url>

# 2. 一键恢复（先预演，确认无误再实跑）
python scripts/restore.py --dry-run
python scripts/restore.py

# 3. 把随包的工作区脚本铺到正确位置
python scripts/deploy_workspaces.py
```

## 为什么不是「拷 workbuddy.db」

WorkBuddy 的定时任务存在 `~/.workbuddy/workbuddy.db`（27MB，含会话历史、日志、缓存）。整个 db 拷过去既臃肿又带一堆无关数据。
本仓库只导出 `automations` 表里那 6 条任务定义（115KB JSON），restore.py 再精准写回新机的 db——干净、幂等、可版本化。

## 6 个任务

| # | 任务 | 触发 | rrule | workspace |
|---|------|------|-------|-----------|
| 1 | 头条号【职场读书】中午12点档发文 | 每天 12:00 | `FREQ=DAILY;BYHOUR=12;BYMINUTE=0` | 2026-06-12 |
| 2 | 头条每日发文·晚6点(pm) | 每天 18:00 | `FREQ=DAILY;BYHOUR=18;BYMINUTE=0` | 2026-06-12 |
| 3 | Agnes 免费 API 巡检与同步 | 每周一 08:00 | `FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0` | 2026-08-14 |
| 4 | 每日热点评论（每天1篇·队列顺延） | 每天 06:10 | `FREQ=DAILY;BYHOUR=6;BYMINUTE=10` | 2026-07-10 |
| 5 | 头条每日发文·早7点(am) | 每天 07:00 | `FREQ=DAILY;BYHOUR=7;BYMINUTE=0` | 2026-06-12 |
| 6 | 头条号数据每3天复盘 | 每 3 天 07:15 | `FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=15` | 2026-06-12 |

完整 prompt 原文（每条几千字的执行规则）都在 `tasks/automations.json`，restore.py 原样写入，不丢失。

## 调度机制（务必理解）

- **调度器 = WorkBuddy 桌面端内置**，不是 Windows 计划任务、不是系统服务
- 任务存 `~/.workbuddy/workbuddy.db` 的 `automations` 表
- **新电脑必须装 WorkBuddy 并保持后台运行**，否则定时永不触发
- 6 个任务都绑定自定义模型 `custom-local:agnes-3.0-flash`（在 `~/.workbuddy/models.json`）

## 恢复后必做清单

- [ ] 装 WorkBuddy 桌面端、登录账号、保持后台运行
- [ ] `~/.workbuddy/models.json` 里有 `agnes-3.0-flash`
- [ ] `python scripts/deploy_workspaces.py` 已把工作区脚本铺到 `C:\Users\<你>\WorkBuddy\` 下
- [ ] `ls ~/.workbuddy/binaries/node/versions/` 核对 Node 版本后缀，与 prompt 里的 `22.22.2-3` 不一致就改
- [ ] Python 用 venv（`envs/default/Scripts/python.exe`），裸版无 PIL
- [ ] 各平台登录态本人重扫（头条 / 公众号 `_mp_login.py` / 视频号 `_channels_login.py`）
- [ ] 打开 WorkBuddy 任务列表确认 6 个都在且已启用

## 安全

仓库内**不含任何凭据**：cookies / keyblob / token / `.env` / sessions / apiKey 全部在打包时剔除。新电脑各自登录，自动化不代扫。

## ⚠️ 避坑

1. 不装 WorkBuddy = 定时全停，别去注册 schtasks
2. 换用户名时 restore.py 会自动把路径里的 `Administrator` 换成当前用户名；特殊情况请核对 `cwds`
3. Node 版本后缀会漂（-3/-6），首次上机务必核对
4. Python 必须 venv，裸版跑 `gen_covers.py` 直接 ModuleNotFoundError
5. `_channels_publish2.py` 才是视频号发布脚本，v1 已作废
6. 若沿用旧 `automation_state.json`，同一天同档会被 (date,slot) 判重跳过，属正常保护

## 目录结构

```
SKILL.md                      skill 说明（供 AI 读取）
README.md                     本文件
tasks/automations.json        6 个任务完整定义（prompt 全文）
scripts/restore.py            一键恢复任务定义到 workbuddy.db
scripts/deploy_workspaces.py  把随包工作区脚本铺到 WorkBuddy 目录
workspaces/                   三个 workspace 的运行必需脚本与规则文档
```

## 来源

源机 `C:\Users\Administrator`，打包于 2026-10-21。任务定义从源机 `workbuddy.db` 的 `automations` 表精确导出（仅这 6 条，未含其余 37 条历史任务）。