#!/usr/bin/env node
/**
 * jingxuan_sync.js —— 「头条精选」抓取 + 去重判定 + 发送登记（am/pm 两档共用同一套规则）
 * 版本 v1.1（2026-09-12，RC4 根治）
 *   抓取不再只押 innerText 正则。头条精选真正的接口是
 *     https://mp.toutiao.com/bcs/notice/cell/list/?app_id=1231
 *   返回 JSON：{ cells:[ { cell_id, create_time(unix秒), content.body.text } ] }
 *   其中 text 形如「今日大家都在关注：\n📄 条目A\n🧵 条目B\n…」。
 *   （注意：api/msg/v1/list 永远是空 msg_list:[]，别在这条接口上找精选。）
 *   RC4：优先拦截 cell/list 接口读 JSON（稳定、能复抓到被顶出可见区的旧条目→天然解孤儿）；
 *       接口没返回 cell 时回退 innerText 正则（老逻辑），保证可用。
 *   RC3：--check 输出按 push_at 分批，同一 push_at 的兄弟条目本档一并消化（发 n 条），勿只发首条。
 *   跨档让位（am/pm 对冲）：ok=true 但本档没解析到精选 → 退出码 3（NO_JINGXUAN_CROSS_SLOTS），交另一档兜底。
 *
 * 背景：
 *   头条精选由后台「服务通知」推送，基本是每晚 20:00 后推一次，一次含 2 个左右热点。
 *   早晚两个任务都会抓，如果不做跨时段去重，同一条热点会被 am 发一遍、pm 再发一遍。
 *
 * 唯一判定依据（两档完全一致，不许各写一套）：
 *   状态文件 jingxuan_state.json，按「热点指纹 fp」记录是否已发送。
 *   - fp = sha1(条目文本归一化后前 24 字符) 的前 12 位
 *     归一化 = 去 emoji / 去标点 / 去空白；取前 24 字符是为了容忍后半句措辞微调
 *   - 只要该 fp 的 sent === true，任何时段都不再发 → 杜绝重复发送
 *   - 只有真正发布成功后才允许 --mark-sent；发布失败只累加 attempts（上限 3）
 *     → 抓取过但没发出去的条目，下次运行仍会被挑出来 → 杜绝漏发
 *
 * 用法：
 *   node jingxuan_sync.js --check [--slot am|pm]
 *        抓取后台 → 解析条目 → 与状态比对
 *        退出码 0 = 有未发送的新条目（可发，stdout 打印 NEW_JINGXUAN n=... 及条目清单）
 *        退出码 3 = 无新增或全部已发（本次跳过，不发任何内容）
 *        退出码 7 = 抓取失败（告警，不要当成「无新增」静默跳过）
 *   node jingxuan_sync.js --mark-sent --fp <fp> --slot <slot> [--file <file>] [--title <title>]
 *        发布成功后调用，标记 sent=true / sent_at / slot / file。退出码 0；fp 不存在=5
 *   node jingxuan_sync.js --fail --fp <fp>
 *        发布失败时调用，attempts+1（达到 3 次后不再自动重试，汇报里告警）
 *   node jingxuan_sync.js --show
 *        打印当前状态，不开浏览器
 *
 * 依赖：pw_launch.js（connectOverCDP 单 persistent context）、toutiao_cookies.json
 * 日志：debug/jingxuan_sync_<YYYY-MM-DD>.log
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchBrowser } = require('./pw_launch.js');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'jingxuan_state.json');
const COOKIE_FILE = path.join(DIR, 'toutiao_cookies.json');
const MAX_ATTEMPTS = 3;

// ---------- 参数 ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) {
      const k = s.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a[k] = v;
    } else a._.push(s);
  }
  return a;
}

// ---------- 时间 ----------
function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function fmt(d, withTime = true) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
}

// ---------- 状态读写（原子写，三态） ----------
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        _schema: 'jingxuan_state v1.0 (2026-09-08)',
        _desc: '头条精选去重状态。sent=true 的 fp 任何时段都不再发；发布失败只累加 attempts，不置 sent。',
        last_checked_at: null,
        items: {},
      };
    }
    console.error('FATAL state file unreadable: ' + e.message);
    process.exit(9);
  }
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || !s.items) throw new Error('shape');
    return s;
  } catch (e) {
    console.error('FATAL state file corrupted (not overwritten): ' + e.message);
    process.exit(9); // fail-loud，绝不静默重建（会丢掉已发记录→重复发送）
  }
}
function saveState(s) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- 文本处理 ----------
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
function norm(s) {
  return String(s || '')
    .replace(EMOJI_RE, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}
function makeFp(title) {
  return crypto.createHash('sha1').update(norm(title).slice(0, 24)).digest('hex').slice(0, 12);
}

// 精选 cell / innerText 里的 CTA + 尾行噪声（切条目时逐行剔除，避免把「点击下方链接」当条目）
// lead 词共 4 种（后台实测）：今日大家都在关注 / 今日国际热点 / 今日国际局势新动向 / 为你精选两篇深度内容
const FOOTER_RE = /点击下方链接|点击订阅|订阅「头条精选」|打开「头条精选」|发现更多值得|扫码查看详情|今日大家都在关注|今日大家都在看|今日国际热点|今日国际局势新动向|为你精选两篇深度内容|优质内容\s*今日上新|了解国际局势|好内容，值得多想一层|值得多想一层|为你精选/;

// 时间戳行归一：绝对 MM-DD HH:MM 原样；相对 昨日/今天/前天 HH:MM 或 纯 HH:MM 换算成北京日期
function resolvePushAt(rawTs) {
  rawTs = String(rawTs || '').trim();
  const p = (n) => String(n).padStart('0', '2');
  const rel = rawTs.match(/^(昨[日天]|今[日天]|前天)\s+(\d{1,2}:\d{2})/);
  if (rel) {
    const dayOffset = rel[1] === '前天' ? 2 : 1;
    const d = new Date(bjNow().getTime() - dayOffset * 86400000);
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${rel[2]}`;
  }
  const abs = rawTs.match(/(\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
  if (abs) return `${abs[1]} ${abs[2]}`;
  const only = rawTs.match(/(\d{1,2}:\d{2})/);
  if (only) {
    const d = bjNow();
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${only[1]}`;
  }
  return rawTs;
}

// 从「头条精选」里切出各热点条目。兼容两种输入：
//  · API cell text（\n 分隔、带 CTA 尾行）→ 按行切
//  · innerText 单行（emoji 分隔）→ 按 emoji 切
function splitItems(input) {
  const s = String(input || '');
  const candidates = s.includes('\n')
    ? s.split('\n')
    : s.split(/(?=[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u);
  return candidates
    .map((x) => x.replace(EMOJI_RE, '').replace(/^[\s，,。.、]+/, '').trim())
    .filter((x) => !FOOTER_RE.test(x) && norm(x).length >= 6);
}

// ---------- 抓取 ----------
async function pollText(page, ms = 30000) {
  const t0 = Date.now();
  let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (t.length > best.length) best = t;
    if (t.length > 8000) break;
  }
  return best;
}

async function grab() {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  // RC4：拦截「头条精选」真正的接口 bcs/notice/cell/list（api/msg/v1/list 恒为空，别在那找）
  const apiBodies = [];
  await page.on('response', async (resp) => {
    try {
      if (!/\/bcs\/notice\/cell\/list/.test(resp.url())) return;
      apiBodies.push(await resp.text().catch(() => ''));
    } catch (e) {}
  });

  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(5000);

  // 点「服务通知」tab 触发 cell/list（精选在服务通知里）
  await page
    .evaluate(() => {
      const els = Array.from(document.querySelectorAll('li, div, a, span'));
      const el = els.find((e) => (e.innerText || '').trim() === '服务通知');
      if (el) el.click();
    })
    .catch(() => {});
  await page.waitForTimeout(4000);

  // 直接再 fetch 一次（双保险，拿全量 cell）
  const directJson = await page
    .evaluate(async () => {
      try {
        const r = await fetch('https://mp.toutiao.com/bcs/notice/cell/list/?app_id=1231', {
          headers: { accept: 'application/json' },
          credentials: 'include',
        });
        return await r.text();
      } catch (e) {
        return '';
      }
    })
    .catch(() => '');
  if (directJson.startsWith('{')) apiBodies.push(directJson);

  // 解析出含「今日大家都在关注」的精选 cell（text/create_time/cell_id）
  const cells = [];
  for (const raw of apiBodies) {
    let j;
    try { j = JSON.parse(raw); } catch (e) { continue; }
    if (!j || !Array.isArray(j.cells)) continue;
      for (const c of j.cells) {
        const text = c && c.content && c.content.body ? c.content.body.text || '' : '';
        // 精选推送 lead 词共 4 种（后台实测）：今日大家都在关注 / 今日国际热点 / 今日国际局势新动向 / 为你精选两篇深度内容
        if (/今日大家都在关注|今日国际热点|今日国际局势新动向|为你精选两篇深度内容/.test(text)) {
          cells.push({ text, create_time: c.create_time, cell_id: c.cell_id });
        }
      }
  }

  const text = await pollText(page, 15000);
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  // ok：只要「接口拿到精选 cell」或「innerText 够长」其一即可
  return { text, cells, ok: text.length >= 500 || cells.length > 0, api_ok: cells.length > 0 };
}

// RC4：unix 秒 → 北京时间 "MM-DD HH:MM"（与 innerText 推送时间格式对齐，去重不冲突）
function pushAtFromUnix(unix) {
  const d = new Date((Number(unix) || 0) * 1000);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

// RC4：从接口 cell 解析精选条目（复用 splitItems 切多条目）
function parseCells(cells) {
  const out = [];
  for (const c of cells || []) {
    const push_at = pushAtFromUnix(c.create_time);
    for (const title of splitItems(c.text)) {
      out.push({ fp: makeFp(title), title, push_at, raw: c.text.slice(0, 200), src: 'api' });
    }
  }
  return out;
}

// 从消息中心全文里解析出「头条精选」推送及其时间
// 逐行扫描：识别「头条精选」标记行 → 向上找最近的时间戳行（支持 MM-DD HH:MM / 昨|今|前天 HH:MM / 纯 HH:MM）
//           → 向下收集 emoji/📄 开头的条目行，CTA/尾行剔除
function parsePushes(text) {
  const out = [];
  const lines = String(text || '').split('\n').map((s) => s.trim());
  const TS_RE = /^(昨[日天]|今[日天]|前天)?\s*\d{1,2}:\d{2}$|^昨[日天]\s+\d{1,2}:\d{2}$|^今[日天]\s+\d{1,2}:\d{2}$|^前天\s+\d{1,2}:\d{2}$|\d{2}-\d{2}\s+\d{1,2}:\d{2}$/;
  // 时间戳行：匹配 数字-数字 + 数字:数字（绝对）或 昨|今|前天 + 数字:数字（相对）或 纯 数字:数字
  const isTsLine = (s) => /^\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(s) || /^(昨[日天]|今[日天]|前天)?\s+\d{1,2}:\d{2}$/.test(s) || /^\d{1,2}:\d{2}$/.test(s);
  const isJxLine = (s) => /头条精选/.test(s);
  const isTitleLine = (s) => {
    // 条目行：以 emoji 开头或含 0x2000-0x1FAFF，且非 CTA/尾行
    const emojiStart = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(s);
    if (!emojiStart) return false;
    if (FOOTER_RE.test(s)) return false;
    if (s.length < 8) return false;
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!isJxLine(lines[i])) continue;
    // 向上找时间戳（最近 5 行内）
    let tsIdx = -1;
    for (let j = i; j >= Math.max(0, i - 5) && tsIdx === -1; j--) {
      if (j !== i && isTsLine(lines[j])) tsIdx = j;
    }
    const push_at = tsIdx >= 0 ? resolvePushAt(lines[tsIdx]) : '';
    // 向下收集条目行（到下一个 CTA/时间戳/非精选区段结束）
    let collected = 0;
    for (let k = i + 1; k < lines.length && collected < 6; k++) {
      const ln = lines[k];
      if (!ln) continue;
      if (isTitleLine(ln)) {
        for (const title of splitItems(ln)) {
          out.push({ fp: makeFp(title), title, push_at, raw: ln.slice(0, 200) });
          collected++;
        }
      } else if (isTsLine(ln) || /头条精选/.test(ln) || /钱包助手/.test(ln)) {
        break; // 下一推送开始或区段结束
      }
      // 其他（CTA、扫码行）继续忽略，看能否再收条目
    }
  }
  return out;
}

// ---------- 主流程 ----------
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = args['mark-sent'] ? 'mark-sent' : args['fail'] ? 'fail' : args['show'] ? 'show' : 'check';
  const state = loadState();

  if (mode === 'show') {
    const list = Object.values(state.items);
    console.log('LAST_CHECKED=' + (state.last_checked_at || '-'));
    console.log('ITEMS=' + list.length);
    for (const it of list.sort((a, b) => (a.push_at < b.push_at ? 1 : -1))) {
      console.log(
        `  ${it.fp} sent=${it.sent} attempts=${it.attempts || 0} push_at=${it.push_at} slot=${it.slot || '-'} | ${it.title.slice(0, 40)}`
      );
    }
    process.exit(0);
  }

  if (mode === 'mark-sent') {
    const fp = args['fp'];
    if (!fp || fp === true) { console.error('FATAL --fp required'); process.exit(5); }
    const it = state.items[fp];
    if (!it) { console.error('FATAL fp not found: ' + fp); process.exit(5); }
    it.sent = true;
    it.sent_at = fmt(bjNow());
    it.slot = args['slot'] || null;
    it.file = args['file'] || null;
    saveState(state);
    console.log('MARK_SENT fp=' + fp + ' slot=' + (it.slot || '-') + ' at=' + it.sent_at);
    process.exit(0);
  }

  if (mode === 'fail') {
    const fp = args['fp'];
    if (!fp || fp === true) { console.error('FATAL --fp required'); process.exit(5); }
    const it = state.items[fp];
    if (!it) { console.error('FATAL fp not found: ' + fp); process.exit(5); }
    it.attempts = (it.attempts || 0) + 1;
    saveState(state);
    console.log('MARK_FAIL fp=' + fp + ' attempts=' + it.attempts + (it.attempts >= MAX_ATTEMPTS ? ' (不再自动重试，需人工处理)' : ''));
    process.exit(0);
  }

  // ---- check ----
  const slot = args['slot'] || 'am';
  const { text, ok, cells, api_ok } = await grab();
  const logDir = path.join(DIR, 'debug');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  fs.writeFileSync(
    path.join(logDir, `jingxuan_sync_${fmt(bjNow(), false)}.log`),
    'GRAB_OK=' + ok + '\nAPI_OK=' + (api_ok ? 1 : 0) + '\nAPI_CELLS=' + cells.length + '\nLEN=' + text.length + '\n' + text.slice(0, 8000),
    'utf-8'
  );
  if (!ok) {
    console.error('FATAL 抓取失败（接口无精选 cell 且页面太短 len=' + text.length + '）—— 不要当成「无新增」');
    process.exit(7);
  }

  // RC4：接口 cell 为主（稳定、能复抓被顶出可见区的旧条目），innerText 正则兜底
  let pushes = parseCells(cells);
  let src = 'api';
  if (!pushes.length) {
    pushes = parsePushes(text);
    src = 'innerText';
  }

  if (!pushes.length) {
    // ok=true 但没解析到精选 = 当晚 20:00 批次此刻尚未推 / 已被顶出 → 跨档让位（am/pm 对冲）
    console.log('NO_JINGXUAN_CROSS_SLOTS —— ' + src + ' 解析不到「头条精选」；本档让位交给另一档兜底，不发、不告警');
    process.exit(3);
  }

  const now = fmt(bjNow());
  for (const p of pushes) {
    const cur = state.items[p.fp];
    if (!cur) {
      state.items[p.fp] = { fp: p.fp, title: p.title, push_at: p.push_at, first_seen_at: now, sent: false, sent_at: null, slot: null, file: null, attempts: 0 };
    } else {
      cur.title = p.title;
      cur.push_at = p.push_at;
    }
  }
  state.last_checked_at = now;
  saveState(state);

  const pending = pushes
    .map((p) => state.items[p.fp])
    .filter((it) => !it.sent && (it.attempts || 0) < MAX_ATTEMPTS);

  if (!pending.length) {
    console.log('NO_NEW_JINGXUAN —— 本次抓取到的精选条目全部已发送（或重试次数超限），跳过，不发任何内容');
    for (const p of pushes) console.log('  SEEN ' + p.fp + ' sent=' + state.items[p.fp].sent + ' | ' + p.title.slice(0, 40));
    process.exit(3);
  }

  // RC3：按 push_at 分批，同批兄弟条目本档一并消化（消除 f61ff498b587 类孤儿）
  const batches = {};
  for (const it of pending) (batches[it.push_at] = batches[it.push_at] || []).push(it);
  const batchKeys = Object.keys(batches).sort();

  console.log('NEW_JINGXUAN batches=' + batchKeys.length + ' n=' + pending.length + ' slot=' + slot + ' src=' + src);
  for (const k of batchKeys) {
    const items = batches[k];
    console.log('BATCH push_at=' + k + ' count=' + items.length + '（同批本档一并消化：微头条 slot 依次取 ' + slot + '(…pm3/am2…) 或按 am2/am3/pm2/pm3 顺延）');
    for (const it of items) {
      console.log('  FP=' + it.fp);
      console.log('  TITLE=' + it.title);
      console.log('  ATTEMPTS=' + (it.attempts || 0));
    }
    console.log('  ---');
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL ' + (e && e.message ? e.message.slice(0, 200) : e));
  process.exit(7);
});
