// [PIPELINE v3.5] inspiration_sync.js — 创作灵感·创作活动池 按垂直领域筛选 v1.0（2026-09-10）
// 解决的问题：此前选题只看「话题邀请」，从未进「创作灵感」——那实际是创作活动池
//   （profile_v4/activity/task-list，全站 2800 个活动），可按垂直领域筛选。
//   本脚本把「按本号垂直领域（职场/教育）抓取活动池 + 去重 + 已用标记」固化下来。
//
// 用法：
//   1) 现场抓取（需浏览器，一天一次即可；建议 am 档执行）
//      node inspiration_sync.js --grab
//      node inspiration_sync.js --grab --fields 职场,教育
//      node inspiration_sync.js --grab --date 2026-09-10      # 只影响落盘日志名
//   2) 只读推荐（不联网，读本地池；am/pm 每档选题前必跑）
//      node inspiration_sync.js --check
//      node inspiration_sync.js --check --top 8
//   3) 标记已用（发布成功后回写，避免重复薅同一个活动）
//      node inspiration_sync.js --use --name '你问我答' --slot am
//      node inspiration_sync.js --unuse --name '你问我答'
//   4) 全量列表（含已用）
//      node inspiration_sync.js --list
//
// 退出码：0 正常 / 2 参数或配置错误（fail-loud）
//        / 3 抓取失败（页面没打开或没解析到活动，必须告警，不许当成"没有活动"）
//        / 7 --check 时无可推荐条目（池空或全已用），必须走三级兜底重新检索

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL = path.join(__dirname, 'inspiration_pool.json');
const TASK_URL = 'https://mp.toutiao.com/profile_v4/activity/task-list';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
function has(name) { return process.argv.indexOf('--' + name) !== -1; }

function bjDate(ts) { return new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function bjNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return d.slice(0, 10) + ' ' + d.slice(11, 16);
}
function log(line) {
  console.log(line);
  try { fs.appendFileSync(path.join(__dirname, 'debug', 'inspiration_' + bjDate() + '.log'), line + '\n'); } catch (e) { /* debug 目录缺失不影响主流程 */ }
}

// ——— 池读写（fail-loud：损坏直接退 2，禁止带病运行）———
function loadPool() {
  let raw;
  try {
    raw = fs.readFileSync(POOL, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { _schema: 'inspiration_pool v1.0', fields: ['职场', '教育'], exclude_keys: [], updated_at: '', activities: [] };
    }
    console.log('FATAL_READ_POOL ' + e.message);
    process.exit(2);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.activities)) { console.log('FATAL_BAD_POOL activities 必须是数组'); process.exit(2); }
    if (!Array.isArray(j.fields) || !j.fields.length) { console.log('FATAL_BAD_POOL fields 必须是非空数组（本号垂直领域）'); process.exit(2); }
    j.exclude_keys = Array.isArray(j.exclude_keys) ? j.exclude_keys : [];
    return j;
  } catch (e) {
    console.log('FATAL_PARSE_POOL 活动池配置损坏，禁止带病运行：' + e.message);
    process.exit(2);
  }
}
function savePool(j) {
  const tmp = POOL + '.tmp';
  // v1.2：写盘重试（Windows 下 renameSync 偶发 EPERM/EBUSY——杀毒/索引扫描瞬时占用；旧版直接抛
  // 未捕获异常 = 本次抓取全丢）。3 次退避重试，仍失败才向上抛。
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf-8');
      fs.renameSync(tmp, POOL);
      return;
    } catch (e) { lastErr = e; const wait = 200 * (i + 1); const end = Date.now() + wait; while (Date.now() < end) {} }
  }
  throw lastErr;
}
function mkId(name, desc) {
  return crypto.createHash('md5').update(String(name) + '||' + String(desc)).digest('hex').slice(0, 12);
}

// ——— 解析：' | ' 分隔的活动列表文本 → 结构化 ———
// 形如：名称 | 描述 | 奖金总额 | 20万元 | 3,554 人参与 | 名称2 | 描述2 | 9.3万人参与 …
function parseActivities(flat) {
  const out = [];
  const re = /([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(?:奖金总额\s*\|\s*([^|]+?)\s*\|\s*)?([\d.,]+\s*万?人参与)/g;
  let m;
  while ((m = re.exec(flat))) {
    const name = m[1].trim();
    if (!name || /^共\s*\d+/.test(name)) continue;
    // v1.2（2026-10-17）：识别「已结束」徽章（卡片上 进行中/已结束，此前未捕获 → 秋日打卡季/成都车展等
    // 过期活动一直混在池里可被推荐）。实测页面文本序＝「N万人参与 已结束」，徽章跟在本条参与数之后、
    // 下一条之前 → 只看前向窗口（到下一条「人参与」为止）；后向窗口会把上一条的徽章错算给本条，不用。
    let after = flat.slice(re.lastIndex, re.lastIndex + 30);
    const nj = after.indexOf('人参与'); if (nj !== -1) after = after.slice(0, nj);
    const ended = /已结束/.test(after);
    out.push({ name, desc: m[2].trim(), reward: (m[3] || '').trim(), joinedTxt: m[4].trim(), ended });
  }
  return out;
}
function parseNum(s) {
  const m = String(s).match(/([\d.,]+)\s*(万)?/);
  if (!m) return 0;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(v)) return 0;
  if (m[2]) v *= 10000;
  return Math.round(v);
}
// 截取「共 N 个创作活动」之后、页脚之前的正文
function sliceList(text) {
  const flat = text.replace(/\s*\n\s*/g, ' | ').replace(/\s{2,}/g, ' ');
  const head = flat.search(/共\s*\d+\s*个创作活动/);
  if (head === -1) return null;
  let body = flat.slice(head);
  body = body.slice(body.indexOf('|') + 1);
  const tailMarks = ['关于今日头条', '用户协议'];
  let cut = body.length;
  for (const t of tailMarks) { const i = body.indexOf(t); if (i !== -1 && i < cut) cut = i; }
  body = body.slice(0, cut);
  const pn = body.search(/\|\s*\d{1,3}\s*\|[^|]*$|\d{4,8}\s*\|\s*关于/);
  if (pn !== -1 && /\|\s*\d{1,3}\s*\|/.test(body.slice(pn))) body = body.slice(0, pn);
  return body;
}

// ——— 现场抓取 ———
async function grab(fields) {
  const { launchBrowser } = require('./pw_launch.js');
  let cookies;
  // 2026-09-11：默认改读 toutiao_cookies.json（当前有效登录态），可用 COOKIES_FILE 覆盖回 edge 版
  const COOKIE_FILE = process.env.COOKIES_FILE || 'toutiao_cookies.json';
  try {
    cookies = JSON.parse(fs.readFileSync(path.join(__dirname, COOKIE_FILE), 'utf-8'));
  } catch (e) {
    console.log('FATAL_COOKIES 读 ' + COOKIE_FILE + ' 失败：' + e.message +
      '（若登录态在 edge 版，改跑 COOKIES_FILE=toutiao_cookies_edge.json）');
    process.exit(2);
  }
  const browser = await launchBrowser();
  const results = [];
  try {
    const ctx = browser.contexts()[0];
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // 2026-09-11 实测：等 4s 时 .item-label 还没渲染出来 → 下拉恒判「未找到」。改为显式等选择器 + 等列表标记
    await page.waitForSelector('div.item-label', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => /共\s*[\d,]+\s*个创作活动/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    log('URL=' + page.url());
    const diag = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return { len: t.length, hasFld: t.indexOf('垂直领域') !== -1, lbl: document.querySelectorAll('div.item-label').length, head: t.slice(0, 160).replace(/\s+/g, ' ') };
    }).catch(e => ({ err: e.message.slice(0, 80) }));
    log('DIAG=' + JSON.stringify(diag));
    if (diag && diag.len < 500) { // 疑似空壳页：重载一次再等
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await page.waitForTimeout(7000);
      const d2 = await page.evaluate(() => ({ len: (document.body.innerText || '').length, hasFld: (document.body.innerText || '').indexOf('垂直领域') !== -1 })).catch(() => ({}));
      log('DIAG_RELOAD=' + JSON.stringify(d2));
    }

    for (const field of fields) {
      let txt = '';
      // 展开「垂直领域」下拉并选中该领域（触发器=div.item-label，选项=span.item）
      const opened = await page.evaluate(() => {
        const els = [...document.querySelectorAll('div.item-label')];
        const t = els.find(e => (e.innerText || '').trim() === '垂直领域');
        if (t) { t.click(); return true; }
        // 兜底：最短的以「垂直领域」开头的元素
        let best = null;
        for (const e of document.querySelectorAll('*')) {
          const s = (e.innerText || '').trim();
          if (s.startsWith('垂直领域') && (!best || s.length < best.len)) best = { el: e, len: s.length };
        }
        if (best) { best.el.click(); return true; }
        return false;
      });
      if (!opened) { log('DROPDOWN_NOT_FOUND field=' + field); continue; }
      await page.waitForTimeout(1800);
      let clicked = await page.evaluate((f) => {
        const els = [...document.querySelectorAll('span.item,li,div.item')];
        const t = els.find(e => (e.innerText || '').trim() === f);
        if (t) { t.click(); return true; }
        return false;
      }, field);
      if (!clicked) {
        // Playwright 真点兜底
        try { await page.getByText(field, { exact: true }).first().click({ timeout: 8000 }); clicked = true; } catch (e) { log('CLICK_ERR field=' + field + ' ' + e.message.slice(0, 80)); }
      }
      if (!clicked) { log('FIELD_NOT_FOUND field=' + field); continue; }
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(2000);
      txt = await page.evaluate(() => document.body.innerText);

      const body = sliceList(txt);
      if (!body) { log('NO_LIST_MARKER field=' + field); }
      else {
        const items = parseActivities(body);
        log('FIELD=' + field + ' PARSED=' + items.length);
        for (const it of items) results.push(Object.assign({ field }, it));
      }
      // —— v1.1(2026-10-17): 视频类体裁补抓（页面「体裁类型：文章类|视频类」切换，旧版只抓默认文章类）——
      const vClicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('span,div,li')].filter(e => e.children.length === 0);
        const t = els.find(e => (e.innerText || '').trim() === '视频类');
        if (t) { t.click(); return true; }
        return false;
      });
      if (vClicked) {
        await page.waitForTimeout(4000);
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(2000);
        const vtxt = await page.evaluate(() => document.body.innerText);
        const vbody = sliceList(vtxt);
        if (vbody) {
          const vitems = parseActivities(vbody);
          log('FIELD=' + field + '_VIDEO PARSED=' + vitems.length);
          for (const it of vitems) results.push(Object.assign({ field, video: true }, it));
        } else { log('NO_LIST_MARKER field=' + field + '_VIDEO'); }
        // 切回文章类，避免污染后续领域抓取
        await page.evaluate(() => {
          const els = [...document.querySelectorAll('span,div,li')].filter(e => e.children.length === 0);
          const t = els.find(e => (e.innerText || '').trim() === '文章类');
          if (t) t.click();
        });
        await page.waitForTimeout(2500);
      } else { log('VIDEO_TAB_NOT_FOUND field=' + field); }
      // 复位到「全部」，否则下一个领域的点击会落在旧筛选上
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('div.item-label')];
        const t = els.find(e => (e.innerText || '').trim() === '垂直领域');
        if (t) t.click();
      });
      await page.waitForTimeout(1500);
      const reset = await page.evaluate(() => {
        const els = [...document.querySelectorAll('span.item,li')];
        const t = els.find(e => (e.innerText || '').trim() === '全部');
        if (t) { t.click(); return true; }
        return false;
      });
      if (!reset) {
        try { await page.getByText('全部', { exact: true }).first().click({ timeout: 6000 }); } catch (e) {}
      }
      await page.waitForTimeout(3000);
    }
  } catch (e) {
    log('ERR=' + e.message.slice(0, 200));
  } finally {
    try { await browser.close(); } catch (e) {}
  }
  return results;
}

// ——— 合并进池：新增 / 更新热度，已用标记保持不变 ———
function merge(pool, results, date) {
  let added = 0, updated = 0;
  for (const r of results) {
    if (!r.name) continue;
    const id = mkId(r.name, r.desc);
    const num = parseNum(r.joinedTxt);
    const ex = pool.activities.find(a => a.id === id || (a.name === r.name && a.desc === r.desc));
    if (ex) {
      let touched = false;
      if (ex.joined_num !== num) { ex.joined_num = num; touched = true; }
      if (ex.joinedTxt !== r.joinedTxt) { ex.joinedTxt = r.joinedTxt; touched = true; }
      if (r.reward && ex.reward !== r.reward) { ex.reward = r.reward; touched = true; }
      if (!ex.fields) ex.fields = [];
      if (ex.fields.indexOf(r.field) === -1) { ex.fields.push(r.field); touched = true; }
      if (r.video && !ex.video) { ex.video = true; touched = true; }
      if (r.ended && !ex.ended) { ex.ended = true; touched = true; }
      if (!r.ended && ex.ended) { ex.ended = false; touched = true; } // 活动重新上线则恢复
      if (ex.field && ex.fields.indexOf(ex.field) === -1) ex.fields.push(ex.field);
      ex.last_seen = date;
      if (touched) updated++;
    } else {
      pool.activities.push({
        id, name: r.name, desc: r.desc, reward: r.reward || '',
        fields: [r.field], joinedTxt: r.joinedTxt, joined_num: num,
        video: !!r.video, ended: !!r.ended,
        first_seen: date, last_seen: date,
        used: false, used_at: null, used_slot: null
      });
      added++;
    }
  }
  pool.updated_at = bjNow();
  return { added, updated };
}

// ——— 推荐：未使用 且 不在排除词里；pin 置顶，其余按参与热度降序 ———
function recommend(pool) {
  const pins = Array.isArray(pool.pin) ? pool.pin : [];
  const rank = a => {
    const i = pins.indexOf(a.name);
    return i === -1 ? 999 : i;
  };
  return pool.activities
    .filter(a => !a.used)
    .filter(a => !a.ended) // v1.2：已结束活动永不推荐（此前秋日打卡季/成都车展等过期活动会进 Top10）
    .filter(a => !(pool.exclude_keys || []).some(k => k && (a.name.indexOf(k) !== -1 || a.desc.indexOf(k) !== -1)))
    .sort((x, y) => (rank(x) - rank(y)) || ((y.joined_num || 0) - (x.joined_num || 0)));
}

const date = arg('date') || bjDate();

// ——— 主流程（CommonJS 不支持顶层 await，统一包进 async IIFE）———
// require.main 守卫：被 require 时不执行主流程，方便单测复用解析函数
async function main() {
  // ——— 模式 1：抓取 ———
  if (has('grab')) {
    const fields = (arg('fields') || '').split(/[,，|]/).map(s => s.trim()).filter(Boolean);
    const pool = loadPool();
    const list = fields.length ? fields : pool.fields;
    const results = await grab(list).catch(e => { log('GRAB_THROW=' + e.message.slice(0, 200)); return []; });
    if (!results.length) {
      console.log('GRAB_FAIL 未抓到任何创作活动（页面未打开 / 领域下拉未命中 / 登录态失效）');
      console.log('  处理：①确认 toutiao_cookies_edge.json 有效 ②手动打开 ' + TASK_URL + ' 核对 ③本档改走三级兜底');
      process.exit(3);
    }
    const { added, updated } = merge(pool, results, date);
    // v1.2：解析跌幅告警——页面改版/结构变化会让正则静默少解析（旧版无感知，池子悄悄空掉）。
    // 抓到条数不足池存量的 40% 即告警（fail-early，配合退出码 0 不变，只打 PARSED_DROP_WARN 让执行方警觉）。
    const endedN = pool.activities.filter(a => a.ended).length;
    if (pool.activities.length >= 10 && results.length < pool.activities.length * 0.4) {
      console.log('PARSED_DROP_WARN parsed=' + results.length + ' pool_total=' + pool.activities.length + '（疑似页面改版/结构变化，正则解析量骤降——请人工核对 ' + TASK_URL + '）');
    }
    savePool(pool);
    console.log('--- INSPIRATION GRAB ---');
    console.log('DATE=' + date + ' FIELDS=' + list.join(','));
    console.log('PARSED=' + results.length + ' ADDED=' + added + ' UPDATED=' + updated + ' TOTAL=' + pool.activities.length + ' ENDED=' + endedN);
    const top = recommend(pool).slice(0, 10);
    console.log('RECOMMEND_TOP=' + top.length);
    top.forEach((a, i) => console.log('  ' + (i + 1) + '. [' + (a.fields || []).join('/') + '] ' + a.name + ' | ' + a.desc + ' | ' + (a.reward ? a.reward + ' | ' : '') + a.joinedTxt));
    console.log('GRAB_OK');
    process.exit(0);
  }

  // ——— 模式 2：只读推荐 ———
  if (has('check')) {
    const pool = loadPool();
    const top = recommend(pool);
    const n = parseInt(arg('top') || '10', 10);
    console.log('--- INSPIRATION ---');
    console.log('POOL_UPDATED=' + (pool.updated_at || '从未抓取') + ' TOTAL=' + pool.activities.length + ' USED=' + pool.activities.filter(a => a.used).length);
    console.log('FIELDS=' + (pool.fields || []).join(',') + ' | EXCLUDE=' + (pool.exclude_keys || []).join(','));
    console.log('CANDIDATES=' + top.length);
    top.slice(0, n).forEach((a, i) => console.log('  ' + (i + 1) + '. [' + (a.fields || []).join('/') + '] ' + a.name + ' | ' + a.desc + ' | ' + (a.reward ? a.reward + ' | ' : '') + a.joinedTxt + ' | id=' + a.id));
    if (top.length === 0) {
      console.log('FALLBACK_NEEDED 创作活动池无可推荐条目（从未抓取 / 全部已用 / 全被排除）');
      console.log('  处理：① node inspiration_sync.js --grab ② _grab_publish_suggest.js --write-pool ③ WebSearch 兜底(须标注)');
      process.exit(7);
    }
    console.log('CHECK_OK');
    process.exit(0);
  }

  // ——— 模式 3：标记已用 / 撤销 ———
  if (has('use') || has('unuse')) {
    const pool = loadPool();
    const name = arg('name');
    if (!name) { console.log('FATAL_ARG --use/--unuse 必须带 --name'); process.exit(2); }
    const hit = pool.activities.filter(a => a.name === name || a.id === name);
    if (!hit.length) { console.log('FATAL_NOT_FOUND 池中没有该活动：' + name); process.exit(2); }
    for (const a of hit) {
      if (has('use')) { a.used = true; a.used_at = bjNow(); a.used_slot = arg('slot') || ''; }
      else { a.used = false; a.used_at = null; a.used_slot = ''; }
    }
    savePool(pool);
    console.log((has('use') ? 'USED ' : 'UNUSED ') + hit.length + ' 条：' + name);
    process.exit(0);
  }

  // ——— 模式 4：全量列表 ———
  if (has('list')) {
    const pool = loadPool();
    console.log('--- INSPIRATION LIST ---');
    console.log('TOTAL=' + pool.activities.length + ' UPDATED=' + (pool.updated_at || '从未抓取'));
    recommend(pool).forEach((a, i) => console.log('  [可用] ' + (i + 1) + '. ' + a.name + ' | ' + a.joinedTxt + ' | id=' + a.id));
    pool.activities.filter(a => a.used).forEach(a => console.log('  [已用] ' + a.name + ' | ' + (a.used_slot || '-') + ' | ' + (a.used_at || '')));
    process.exit(0);
  }

  console.log('用法：node inspiration_sync.js --grab [--fields 职场,教育] | --check [--top N] | --use --name "活动名" [--slot am] | --unuse --name "活动名" | --list');
  process.exit(2);
}

module.exports = { parseActivities, sliceList, parseNum, recommend, mkId };
if (require.main === module) main();
