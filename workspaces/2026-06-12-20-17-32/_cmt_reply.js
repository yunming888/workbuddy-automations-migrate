// _cmt_reply.js — 兼容转发层（v1.3，2026-10-17）
//
// 背景：评论回复的实现已迁到 _cmt_reply_v2.js。迁移原因（2026-10-17 实锤事故）：
//   v1 用 document.body.innerText 全局正则「N条回复」取 pre/post，页面任意一条评论的回复数
//   都会被算进来 → 假真 / 假假都出过 → 误判失败后重发 → 重复回复（脚本删不掉，只能人工删）。
//   v2 改为：点开评论详情区隔离操作 + 回复文本逐字校验 + 历史 cmt_replies_*.json 去重。
//
// 为什么保留本文件而不直接改名：三档（am / noon / pm）automation prompt 与历史命令里写死的调用
//   都是 `node _cmt_reply.js <json>`。删文件 → 三档评论全部失联；改三条 prompt → 高成本文案改动。
//   故本文件降级为转发层：调用方零改动即获得 v2 行为。老实现已备份为 _cmt_reply_v1_legacy.js.bak。
//
// 用法（与 v1 完全一致）：node _cmt_reply.js <replies.json>
// 退出码（与 v2 一致）：0 全成功 / 1 部分成功 / 2 参数或 JSON 错误 / 5 全部失败 / 7 页面故障
console.log('[CMT] DEPRECATED _cmt_reply.js → 已转发至 _cmt_reply_v2.js（行为升级，参数不变）');
require('./_cmt_reply_v2.js');
