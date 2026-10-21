// [PIPELINE v3.4] festival_sync.js — 节日/时令主题时效性控制器 v1.0（2026-09-10）
// 解决：节日主题只在当天有效，过期必须自动下线，不得继续出现在创作灵感候选池。
//
// 用法：
//   1) 看今天生效的节日主题（选题前先看）
//      node festival_sync.js --today
//      node festival_sync.js --date 2026-09-11 --today
//   2) 剔除候选池里的过期节日主题（跨天切换时执行；下线=隐藏，不置空）
//      node festival_sync.js --prune
//   3) 自检：今天有无节日？过滤后候选池是否空？（空=需走兜底）
//      node festival_sync.js --check
//
// 退出码：0 正常 / 2 配置损坏或参数错误（fail-loud） / 7 过滤后候选池为空，必须走兜底重新检索

const fs = require('fs');
const path = require('path');

const FEST = path.join(__dirname, 'festival_topics.json');
const TOPIC = path.join(__dirname, 'daily_topic.json');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
// 无值开关（--today / --prune / --check）用 has()，不能用 arg()（arg 只取带值参数）
function has(name) { return process.argv.indexOf('--' + name) !== -1; }

// —— 日期判断：一律北京时间(UTC+8)，与 topic_sync.js 的 bjNow() 完全同口径 ——
function bjDate(ts) {
  return new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function endOf(item) { return addDays(item.date, (item.window_days || 1) - 1); }
function isActive(item, date) { return date >= item.date && date <= endOf(item); }
function isExpired(item, date) { return date > endOf(item); }

function loadFest() {
  let raw;
  try {
    raw = fs.readFileSync(FEST, 'utf-8');
  } catch (e) {
    // 没有节日配置 = 正常状态（不是损坏），按"无节日主题"处理
    if (e.code === 'ENOENT') return { _schema: 'festival_topics v1.0', items: [] };
    console.log('FATAL_READ_FEST ' + e.message);
    process.exit(2);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.items)) { console.log('FATAL_BAD_FEST items 必须是数组'); process.exit(2); }
    return j;
  } catch (e) {
    console.log('FATAL_PARSE_FEST 节日配置损坏，禁止带病运行：' + e.message);
    process.exit(2);
  }
}

function saveFest(j) {
  const tmp = FEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf-8');
  fs.renameSync(tmp, FEST);
}

function loadTopicDb() {
  try {
    return JSON.parse(fs.readFileSync(TOPIC, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    console.log('FATAL_READ_TOPIC ' + e.message);
    process.exit(2);
  }
}

const date = arg('date') || bjDate();
const fest = loadFest();
const hasToday = has('today');
const doPrune = has('prune');
const check = has('check');

// —— 模式 1：列出今天生效的节日主题 ——
if (hasToday) {
  const act = fest.items.filter(it => isActive(it, date));
  console.log('DATE=' + date + ' (BJ/UTC+8)');
  console.log('ACTIVE_FESTIVALS=' + act.length);
  for (const it of act) {
    console.log('  [' + it.id + '] ' + it.name + ' | 窗口 ' + it.date + '~' + endOf(it));
    (it.topics || []).forEach((t, i) => console.log('    - ' + t));
    if (it.note) console.log('    note: ' + it.note);
  }
  const expired = fest.items.filter(it => isExpired(it, date));
  console.log('EXPIRED_FESTIVALS=' + expired.length);
  for (const it of expired) console.log('  已下线: [' + it.id + '] ' + it.name + '（窗口止于 ' + endOf(it) + '）');
  process.exit(0);
}

// —— 模式 2/3：剔除候选池中的过期节日主题 ——
function pruneCandidates(verbose, dryRun) {
  const db = loadTopicDb();
  if (!db || !db.days || !db.days[date]) {
    if (verbose) console.log('NO_DAY_RECORD date=' + date + '（当日尚无候选池，无需过滤）');
    return { removed: [], kept: [], noRecord: true };
  }
  const day = db.days[date];
  const cands = day.candidates || [];
  const expired = fest.items.filter(it => isExpired(it, date));

  // 收集所有"已过期节日"的匹配关键词
  const keys = [];
  for (const it of expired) {
    keys.push(it.name);
    (it.match_keys || []).forEach(k => keys.push(k));
  }
  const hit = c => keys.some(k => k && String(c).includes(k));
  const removed = cands.filter(hit);
  const kept = cands.filter(c => !hit(c));

  // dryRun（--check）只报告不落盘，避免在 topic_sync 只读模式里产生写副作用
  if (!dryRun) {
    day.candidates = kept;
    if (removed.length) {
      const tmp = TOPIC + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
      fs.renameSync(tmp, TOPIC);
    }
  }
  if (verbose) {
    console.log('DATE=' + date + ' (BJ/UTC+8)');
    console.log('EXPIRED_FESTIVALS=' + expired.length);
    console.log('REMOVED=' + removed.length);
    removed.forEach(r => console.log('  下线(隐藏): ' + r));
    console.log('KEPT=' + kept.length);
    kept.forEach(k => console.log('  保留: ' + k));
  }
  // 同时把已过节的条目标记 expired（审计留痕），并在有 annual 时自动续到下一年
  // —— 状态留痕与次年续期：仅在「按真实当天」运行时执行 ——
  // 显式传 --date（测试/补跑）时只做剔除，绝不写状态、绝不续期，避免污染真实配置
  if (dryRun || arg('date') !== null) {
    if (verbose) {
      console.log(dryRun
        ? 'DRY_RUN=1 仅报告，未写入候选池（--check 模式，供只读场景调用）'
        : 'SKIP_ROLL 检测到显式 --date：仅执行剔除，跳过状态留痕与次年续期（防测试污染）');
    }
    return { removed, kept, noRecord: false, rolled: 0 };
  }

  // 已过节的条目标记 expired（审计留痕，原条目永不改写）；有 annual 则【追加】下一年的空壳条目
  // 用追加而非改写：避免误用未来日期执行时把当年配置推走，导致当天主题失效
  const toAppend = [];
  for (const it of fest.items) {
    if (isExpired(it, date)) {
      it.status = 'expired';
      if (it.annual) {
        const nextYear = String(parseInt(it.date.slice(0, 4), 10) + 1);
        const nextDate = nextYear + '-' + it.annual;
        const dup = fest.items.some(x => x.date === nextDate && x.name === it.name)
          || toAppend.some(x => x.date === nextDate && x.name === it.name);
        if (!dup) {
          toAppend.push({
            id: it.id.replace(/_\d{4}$/, '') + '_' + nextYear,
            name: it.name, date: nextDate, window_days: it.window_days || 1,
            annual: it.annual, match_keys: it.match_keys || [],
            topics: [], source: '', status: 'scheduled',
            note: '由上一年条目自动续期生成，topics 为空——届时须重新检索当年素材，不得沿用旧内容。',
            rolled_from: it.id
          });
          if (verbose) console.log('ROLLED [' + it.id + '] → 新增 ' + nextDate + '（topics 留空，届时重新检索）');
        }
      }
    } else if (isActive(it, date)) {
      it.status = 'active';
    }
  }
  if (toAppend.length) { fest.items.push(...toAppend); saveFest(fest); }
  return { removed, kept, noRecord: false, rolled: toAppend.length };
}

if (doPrune) {
  const r = pruneCandidates(true, false);
  if (r.noRecord) process.exit(0);
  if (r.kept.length === 0) {
    console.log('FALLBACK_NEEDED 候选池已空 —— 必须重新检索，禁止沿用过期节日主题，禁止置空发布。');
    console.log('  兜底顺序：① 现场抓取创作灵感/话题邀请 → ② _grab_publish_suggest.js --write-pool → ③ WebSearch 兜底(须标注)');
    process.exit(7);
  }
  console.log('PRUNE_OK kept=' + r.kept.length);
  process.exit(0);
}

if (check) {
  const act = fest.items.filter(it => isActive(it, date));
  console.log('DATE=' + date + ' (BJ/UTC+8)');
  console.log('ACTIVE_FESTIVALS=' + act.length);
  act.forEach(it => console.log('  生效: ' + it.name + '（' + it.date + '~' + endOf(it) + '）'));
  const r = pruneCandidates(false, true);
  if (r.noRecord) { console.log('CHECK_WARN 当日无候选池记录'); process.exit(0); }
  console.log('CANDIDATES_AFTER_PRUNE=' + r.kept.length);
  if (r.kept.length === 0) {
    console.log('FALLBACK_NEEDED 过滤后候选池为空 → 走三级兜底重新检索');
    process.exit(7);
  }
  console.log('CHECK_OK');
  process.exit(0);
}

console.log('用法：node festival_sync.js --today | --prune | --check [--date YYYY-MM-DD]');
process.exit(2);
