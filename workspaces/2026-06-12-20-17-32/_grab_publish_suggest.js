// _grab_publish_suggest.js — 从图文发布页「选题推荐」列表抓平台推荐话题
// 2026-09-07 接入。背景：图文发布页正文区下方有 .recommend-list .list .topic 推荐话题列表（含"换一换"），
//   与后台消息中心的"话题邀请"互不重叠，可作为第三个热点来源（去重后合并入 daily_topic.candidates）。
//
// 用法：
//   1) 只看，不写入：
//      node _grab_publish_suggest.js
//   2) 抓取并写入当日候选池（追加，去重）：
//      node _grab_publish_suggest.js --write-pool --date 2026-09-07
//
// 输出：
//   stdout：每行一个话题或 JSON 汇总
//   debug/grab_publish_suggest_<DATE>.log：完整日志

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./pw_launch.js');
const COOKIE_FILE = 'toutiao_cookies_edge.json';

const LOG = [];
function L(...a){ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log('[SUG]', s); }

function arg(name){ const i=process.argv.indexOf('--'+name); return i!==-1 && process.argv[i+1] && !process.argv[i+1].startsWith('--') ? process.argv[i+1] : null; }
function bjNow(){ return new Date(Date.now()+8*3600*1000).toISOString().slice(0,10); }
const DATE = arg('date') || bjNow();
const WRITE_POOL = process.argv.includes('--write-pool');

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  try { await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIE_FILE,'utf-8'))); } catch(e){ L('CK_ERR '+e.message.slice(0,60)); }
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto('https://mp.toutiao.com/profile_v4/graphic/publish', { waitUntil:'domcontentloaded', timeout:45000 });
  // 等正文区与推荐列表渲染
  const t0 = Date.now(); let text = '';
  while (Date.now() - t0 < 50000) {
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => ({
      hasEditor: !!document.querySelector('.ProseMirror'),
      hasRecommend: !!document.querySelector('.recommend-list .list .topic'),
      len: document.body.innerText.length
    })).catch(() => ({hasEditor:false, hasRecommend:false, len:0}));
    if (r.hasEditor && r.hasRecommend) break;
    text = (await page.evaluate(() => document.body.innerText).catch(()=>'')) || text;
  }
  const allRounds = [];
  // 多轮抓取（点击"换一换"取更多话题）
  for (let round = 0; round < 3; round++) {
    const cur = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.recommend-list .list .topic .text').forEach(e => {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 60 && !out.includes(t)) out.push(t);
      });
      return out;
  });
    allRounds.push(...cur);
    L('ROUND ' + round + ' picked ' + cur.length + ' (累计 ' + allRounds.length + ')');
    // 尝试点"换一换"
    const clicked = await page.evaluate(() => {
      const c = [...document.querySelectorAll('span,div,button')].filter(e => /换一换|换一换$/.test((e.textContent||'').trim()) && e.children.length<=2);
      if (!c.length) return false;
      c[c.length-1].click();
      return true;
    });
    if (!clicked) { L('NO_MORE_REFRESH'); break; }
    await page.waitForTimeout(2500);
  }
  const seen = new Set();
  const merged = [];
  for (const t of allRounds) {
    const k = t.replace(/^#|#$/g, '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(k);
  }
  L('TOTAL_UNIQ=' + merged.length);
  L('TOPICS=' + JSON.stringify(merged));

  if (WRITE_POOL && merged.length) {
    const FILE = path.join(__dirname, 'daily_topic.json');
    let db = { days: {} };
    try { db = JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!db.days[DATE]) db.days[DATE] = {};
    const day = db.days[DATE];
    const old = Array.isArray(day.candidates) ? day.candidates : [];
    // 旧条目用"中文名是否包含"去重
    const added = [];
    for (const t of merged) {
      const exists = old.some(x => (x||'').replace(/#|\s/g, '').includes(t.replace(/\s/g, '')));
      if (exists) continue;
      old.push(t + '(选题推荐·平台)');
      added.push(t);
    }
    day.candidates = old;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmp, FILE);
    L('POOL_WRITTEN date=' + DATE + ' added=' + added.length + ' total=' + old.length);
  }

  fs.writeFileSync('debug/grab_publish_suggest_' + DATE + '.log', LOG.join('\n'));
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/grab_publish_suggest_' + DATE + '.log', LOG.join('\n')); } catch (x) {} process.exit(7); });