// [PIPELINE v3.2] 当前版本 3.2（2026-09-07）— 版本记录见 CHANGELOG.md，单一来源见 version.js
// topic_sync.js — 当日双档（am/pm）选题状态同步器 v1.0（2026-09-06）
// 目的：让「上午/下午两档选题同步推进、互不遗漏、同题必做差异化」成为机制，而不是靠每次回忆。
// 数据文件：daily_topic.json（days[date] = { am:{...}, pm:{...}, candidates:[...] }）
//
// 用法：
//   1) 读当日状态（选题前必做）
//      node topic_sync.js --date 2026-09-07
//   2) 写入/覆盖本档记录（发稿前必做；同题连推时脚本会做差异化自检）
//      node topic_sync.js --date 2026-09-07 --slot pm \
//        --topic '#中级注册安全工程师证书值得考吗#' \
//        --source '后台消息现场抓取 09-07 11:21' \
//        --heat '373万围观+官方流量扶持' \
//        --core '含金量不是喊出来的，是《安全生产法》27/97条倒逼出来的' \
//        --angle 原因背景 --depth L1 --stance 亲历者 \
//        --title '含金量不是喊出来的' --diff 'am讲怎么考(L2方法)，pm讲为什么必须考(L1判断)'
//   3) 写候选池（am 执行时把后台高热条目按热度降序写进去，供 pm 取用，防止漏发）
//      node topic_sync.js --date 2026-09-07 --candidates 'A话题|B话题|C话题'
//
// 退出码：0 正常 / 2 参数不全或 JSON 损坏（fail-loud，绝不静默跳过）/ 3 差异化自检未过

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'daily_topic.json');

// —— 枚举约束：写错直接拒绝，避免后面按错值排重 ——
const ANGLES = ['事件经过', '各方反应', '原因背景', '影响趋势', '争议焦点'];
const DEPTHS = ['L1', 'L2', 'L3'];
const STANCES = ['亲历者', '旁观者', '反方', '受益人', '决策者'];

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf-8');
  } catch (e) {
    // 文件不存在 = 首启，不是损坏（2026-09-06 push_state 同款坑，别再误判 corrupt）
    if (e.code === 'ENOENT') return { _schema: 'daily_topic v1.0', days: {} };
    console.log('FATAL_READ ' + e.message);
    process.exit(2);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.days) { console.log('FATAL_BAD_JSON'); process.exit(2); }
    return j;
  } catch (e) {
    console.log('FATAL_PARSE daily_topic.json 损坏，禁止带病运行：' + e.message);
    process.exit(2);
  }
}

function save(j) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf-8');
  fs.renameSync(tmp, FILE);
}

function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const date = arg('date') || bjNow();
const slot = arg('slot');
const db = load();
if (!db.days[date]) db.days[date] = {};
const day = db.days[date];

// —— 模式一：只读 ——
if (!slot) {
  const cands = arg('candidates');
  if (cands) {
    day.candidates = cands.split('|').map(s => s.trim()).filter(Boolean);
    save(db);
    console.log('CANDIDATES_SAVED ' + day.candidates.length + ' 条');
    process.exit(0);
  }
  console.log('DATE=' + date);
  console.log('CANDIDATES=' + JSON.stringify(day.candidates || [], null, 0));
  for (const s of Object.keys(day)) {
    if (s === 'candidates') continue;
    const r = day[s];
    console.log('SLOT[' + s + '] topic=' + r.topic + ' | angle=' + r.angle + ' | depth=' + r.depth + ' | stance=' + r.stance);
    console.log('   core=' + (r.core || ''));
    console.log('   title=' + (r.title || ''));
    console.log('   diff=' + (r.diff || ''));
  }
  const used = Object.keys(day).filter(s => s !== 'candidates');
  console.log('DONE_SLOTS=' + JSON.stringify(used));

  // —— 节日/时令主题时效性（跨天自动下线，过期主题不得再用于选题）——
  // 复用 festival_sync.js --check（dryRun，不落盘）：报告当日生效/已下线节日，并检测候选池是否残留过期条目
  // execSync 必须声明在父作用域：下面 FESTIVAL / INSPIRATION 两个 try 块都要用
  const { execSync } = require('child_process');
  try {
    const out = execSync('"' + process.execPath + '" "' + path.join(__dirname, 'festival_sync.js') + '" --date ' + date + ' --check',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('--- FESTIVAL ---');
    process.stdout.write(out);
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).trim();
    console.log('--- FESTIVAL ---');
    if (out) console.log(out);
    if (e.status === 7) {
      console.log('WARN_FESTIVAL_FALLBACK 候选池过滤后为空：必须重新检索①现场抓取→②_grab_publish_suggest→③WebSearch；禁止沿用过期节日主题，禁止置空发布。');
    } else if (e.status) {
      console.log('WARN_FESTIVAL_EXIT=' + e.status + '（节日配置异常，按 fail-loud 处理，先修配置再选题）');
    }
  }

  // —— 创作灵感·创作活动池（按垂直领域筛选后的可用活动；只读本地池，不联网）——
  // 这是除「话题邀请」之外的第二个官方流量池，池里 2800 个活动，选题时必须一并看。
  // 退出码 7=池空/全已用 → 需 --grab 或走三级兜底；这里只警告不阻断（它是补充池，不是主池）。
  try {
    const out2 = execSync('"' + process.execPath + '" "' + path.join(__dirname, 'inspiration_sync.js') + '" --check --top 5',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('--- INSPIRATION ---');
    process.stdout.write(out2);
  } catch (e2) {
    const out2 = ((e2.stdout || '') + (e2.stderr || '')).trim();
    console.log('--- INSPIRATION ---');
    if (out2) console.log(out2);
    if (e2.status === 7) {
      console.log('WARN_INSPIRATION_EMPTY 创作活动池无可推荐条目：先 node inspiration_sync.js --grab 抓取；抓不到再走 ②_grab_publish_suggest ③WebSearch。');
    } else if (e2.status) {
      console.log('WARN_INSPIRATION_EXIT=' + e2.status + '（活动池配置异常，按 fail-loud 处理）');
    }
  }
  process.exit(0);
}

// —— 模式二：写本档 ——
const rec = {
  topic: arg('topic'),
  source: arg('source'),
  heat: arg('heat') || '',
  core: arg('core'),
  angle: arg('angle'),
  depth: (arg('depth') || '').toUpperCase(),
  stance: arg('stance'),
  title: arg('title') || '',
  diff: arg('diff') || '',
  updated_at: bjNow() + ' ' + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16)
};

// fail-loud：必填项一个都不能少（保护性 if 静默跳过 = 事故温床，2026-09-05 教训）
const miss = ['topic', 'source', 'core', 'angle', 'depth', 'stance'].filter(k => !rec[k]);
if (miss.length) {
  console.log('FATAL_MISSING_FIELD ' + miss.join(',') + ' —— 六大要素缺一不可，拒绝登记');
  process.exit(2);
}
if (!ANGLES.includes(rec.angle)) { console.log('FATAL_BAD_ANGLE 可选：' + ANGLES.join(' / ')); process.exit(2); }
if (!DEPTHS.includes(rec.depth)) { console.log('FATAL_BAD_DEPTH 可选：' + DEPTHS.join(' / ')); process.exit(2); }
if (!STANCES.includes(rec.stance)) { console.log('FATAL_BAD_STANCE 可选：' + STANCES.join(' / ')); process.exit(2); }

// —— 差异化自检：同题连推时，另一档已存在则必须换角度或换深度 ——
const others = Object.keys(day).filter(s => s !== 'candidates' && s !== slot);
for (const os of others) {
  const o = day[os];
  if (o.topic && o.topic === rec.topic) {
    const sameAngle = o.angle === rec.angle;
    const sameDepth = o.depth === rec.depth;
    if (sameAngle && sameDepth) {
      console.log('FATAL_NO_DIFF 与 ' + os + ' 档同题且角度/深度全同（' + rec.angle + '/' + rec.depth + '）。');
      console.log('  必须至少换一项：角度可选 ' + ANGLES.filter(a => a !== o.angle).join(' / '));
      console.log('  深度可选 ' + DEPTHS.filter(d => d !== o.depth).join(' / '));
      console.log('  并请填 --diff 说明两篇差异点与递进关系。');
      process.exit(3);
    }
    if (!rec.diff) {
      console.log('WARN_NEED_DIFF 同题连推，--diff 为空。汇报里必须说明两篇差异点与递进关系。');
    }
  }
}

day[slot] = rec;
save(db);
console.log('SAVED slot=' + slot + ' angle=' + rec.angle + ' depth=' + rec.depth + ' stance=' + rec.stance);
console.log('DAY_STATE=' + JSON.stringify(Object.keys(day).filter(s => s !== 'candidates')));
