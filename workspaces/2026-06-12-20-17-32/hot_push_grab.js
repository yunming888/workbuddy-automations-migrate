// hot_push_grab.js — 后台「为我推荐的」流量扶持推送 结构化读取器
// 2026-09-29 新增。配套 SOP：HOT_PUSH_SOP.md。
//
// 职责：只读抓取后台消息中心「话题邀请」分类里、平台**小助手主动推 + 带「流量扶持」标记**
//       的那类卡片（即"为我推荐的"），解析出 主题/围观数/是否扶持/时间戳，落 hot_push_state.json
//       供 noon / pm 档读取"当前最新一条为我推荐的"，作为选题第一优先级锚点。
//
// 与 _grab_publish_suggest.js 的区别（避免再次混淆）：
//   · 本脚本 = 后台消息中心「话题邀请」小助手推送（"为我推荐的"，带流量扶持）→ 选题第一锚点。
//   · _grab_publish_suggest = 发布页正文下方"选题推荐轮播列表" → 只是补充候选池，不是"为我推荐的"。
//
// 用法：
//   node hot_push_grab.js                 # 抓取并写入 hot_push_state.json（当日）
//   node hot_push_grab.js --date 2026-09-29
//   CDP_PORT=9355 node hot_push_grab.js   # 抓取失败(ECONNRESET)时换端口重试一次
//
// 退出码（异常处理，见 SOP 第五节）：
//   0 = 成功，抓到 >=1 张"为我推荐的"卡（hot_push_state.json 已更新）
//   7 = 抓取/解析失败：页面未渲染 / 无带扶持标记的卡 / 正则未命中 → 调用方走三级兜底
//   3 = 浏览器或 cookie 失败（launchBrowser 抛错）
//
// 环境变量：
//   DATE        覆盖当日（北京时间）
//   CDP_PORT    覆盖 CDP 端口（默认 9344；失败重试换 9355）
//   COOKIES_FILE 默认 toutiao_cookies.json（可用 toutiao_cookies_edge.json 兜底）

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./pw_launch.js');

const LOG = [];
function L(...a){ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log('[HOTPUSH]', s); }

const DATE = process.env.DATE || (()=>new Date(Date.now()+8*3600*1000).toISOString().slice(0,10))();
const COOKIES_FILE = process.env.COOKIES_FILE || 'toutiao_cookies.json';
const STATE_FILE = path.join(__dirname, 'hot_push_state.json');
const STATE_LOG = path.join(__dirname, 'debug', 'hot_push_' + DATE + '.log');

// 解析单张卡片文本 → 结构化字段。cardText 是"一张卡"的片段（含主题 + 围观 + 扶持措辞 + 时间戳）。
function parseCard(cardText){
  const out = { topic:null, guanwan:null, support:false, time:null, raw:cardText };
  // 主题：#xxx# 或 「今日话题#xxx#」
  const tm = cardText.match(/#([^#\s]{2,40})#/) || cardText.match(/今日话题[：:]?\s*([^（#\n]{2,40}?)(?:\s*（|\s*在围观|\s*👆|\s*$)/);
  if (tm) out.topic = tm[1].trim();
  // 围观数：N万人在围观 / N人在围观
  const gm = cardText.match(/(\d+(?:\.\d+)?)\s*万?人在围观/);
  if (gm) out.guanwan = gm[1] + (cardText.includes('万人在') ? '万' : '');
  // 流量扶持标记（"为我推荐的"判据）：小助手 + 流量扶持 / 🔥今日话题
  out.support = /流量扶持|小助手.*(?:发文|邀请)|🔥今日话题/.test(cardText);
  // 时间戳：09-29 06:01 / 昨日 07:40 / 1 小时前
  const km = cardText.match(/(\d{2}-\d{2})\s+(\d{2}:\d{2})/) || cardText.match(/(昨日|今日|今日|(\d+)\s*小时前)/);
  if (km) {
    // 修正：原 `(km[1]||'') + ' ' + (km[2]||'') || km[0]` 因两组拼接恒为非空串，
    // "N小时前" 分支的 km[1]=整个匹配("7 小时前")、km[2]="7"，拼出畸形 "7 小时前 7"。
    // 现按「命中组」显式取：MM-DD+H:MM 用两组拼接；相对时间(今日/昨日/N小时前)直接用整个匹配 km[0]。
    if (/^\d{2}-\d{2}/.test(km[1] || '')) out.time = (km[1] + ' ' + km[2]).replace(/\s+/g, ' ').trim();
    else out.time = km[0].trim();
  }
  return out;
}

// 从整个话题邀请页 innerText 切出"卡片序列"。卡片以「你的专属热议话题速递」开头，以日期戳结尾。
function extractCards(pageText){
  const cards = [];
  // 先按"你的专属热议话题速递"切块；若无则按主题#直接正则
  let blocks = pageText.split(/你的专属热议话题速递/g).slice(1);
  if (blocks.length === 0){
    // 兜底：直接抓每个「🔥今日话题#xxx#」片段
    const re = /🔥今日话题#([^#]+)#\s*（[^）]*）[\s\S]{0,200}?/g;
    let m;
    while ((m = re.exec(pageText)) !== null) cards.push(parseCard(m[0]));
    return cards.filter(c => c.topic);
  }
  for (const b of blocks){
    // 每块内取第一个 #主题# + 其后 200 字符
    const seg = b.slice(0, 400);
    const c = parseCard(seg);
    if (c.topic) cards.push(c);
  }
  return cards;
}

(async () => {
  L('DATE=' + DATE + ' COOKIES=' + COOKIES_FILE + ' CDP_PORT=' + (process.env.CDP_PORT||'9344'));
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  try { await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE,'utf-8'))); L('COOKIES_OK'); }
  catch(e){ L('CK_ERR ' + e.message.slice(0,60)); }
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);

  // ① 话题邀请页（消息中心左栏即含"话题邀请"最新条）
  const INV = 'https://mp.toutiao.com/profile_v4/personal/message?type=topic_invite';
  await page.goto(INV, { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForTimeout(8000);
  // ② 显式点「话题邀请」tab 拉全量历史卡
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,span,li,a,button')]
      .filter(e => (e.innerText||'').trim() === '话题邀请' && e.children.length<=2);
    if (els.length) els[els.length-1].click();
  }).catch(()=>{});
  await page.waitForTimeout(6000);

  const text = (await page.evaluate(() => (document.body.innerText||'').replace(/[ \t]+/g,' ')).catch(()=> '')) || '';
  L('PAGE_LEN=' + text.length);
  if (text.length < 500){
    L('PARSE_FAIL page too short / not rendered');
    await browser.close(); fs.writeFileSync(STATE_LOG, LOG.join('\n')); process.exit(7);
  }

  const cards = extractCards(text);
  L('CARDS=' + cards.length);
  cards.forEach((c,i)=> L('CARD['+i+'] topic=' + c.topic + ' guanwan=' + c.guanwan + ' support=' + c.support + ' time=' + c.time));

  // "为我推荐的" = 带流量扶持标记的卡；取时间最新一条为主推
  const supported = cards.filter(c => c.support && c.topic);
  if (supported.length === 0){
    // 无显式扶持标记时，退化为"最新一条带#主题#的卡"（仍在话题邀请分类=小助手推）
    const latest = cards.filter(c => c.topic).slice(0,1);
    if (latest.length){
      L('NO_SUPPORT_FLAG fallback latest=' + latest[0].topic + ' guanwan=' + latest[0].guanwan);
      writeState({ recommended: latest[0], all: cards, source:'topic_invite_fallback', fetched_at: Date.now() });
      await browser.close(); fs.writeFileSync(STATE_LOG, LOG.join('\n')); process.exit(0);
    }
    L('PARSE_FAIL no topic card found');
    await browser.close(); fs.writeFileSync(STATE_LOG, LOG.join('\n')); process.exit(7);
  }

  // 时间戳归一（09-29 06:01 / 今日 / 昨日 / N小时前）→ 取最新。
  // 优先级：今日(9999) > N小时前(9998-N) > 昨日(9997) > MM-DD(按 MMDD 升序，越大越新)。
  const tsKey = (c) => {
    const t = (c.time||'').trim();
    if (/^今日/.test(t)) return '9999';
    const hm = t.match(/(\d+)\s*小时前/);
    if (hm) return String(9998 - Math.min(+hm[1], 9));
    if (/^昨日/.test(t)) return '9997';
    const d = t.match(/(\d{2})-(\d{2})/);
    if (d) return d[1] + d[2]; // MMDD
    return '0000';
  };
  supported.sort((a,b)=> tsKey(b).localeCompare(tsKey(a)));
  const recommended = supported[0];
  L('RECOMMENDED topic=' + recommended.topic + ' guanwan=' + recommended.guanwan + ' time=' + recommended.time);
  writeState({ recommended, all: cards, source:'topic_invite_support', fetched_at: Date.now() });
  await browser.close();
  fs.writeFileSync(STATE_LOG, LOG.join('\n'));
  process.exit(0);
})().catch(e => {
  L('FATAL ' + e.message.slice(0,200));
  try { fs.writeFileSync(STATE_LOG, LOG.join('\n') + '\nFATAL ' + e.message); } catch(x){}
  process.exit(3);
});

function writeState(payload){
  const rec = payload.recommended || {};
  const state = {
    fetched_at: new Date(payload.fetched_at).toISOString(),
    date: DATE,
    source: payload.source,
    recommended: {
      topic: rec.topic || null,
      guanwan: rec.guanwan || null,
      support: !!rec.support,
      time: rec.time || null,
      raw: (rec.raw||'').slice(0,200)
    },
    all_supported: (payload.all||[]).filter(c=>c.support).map(c=>({topic:c.topic, guanwan:c.guanwan, time:c.time})),
    _note: '后台"为我推荐的"流量扶持推送快照。选题第一锚点；见 HOT_PUSH_SOP.md。'
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  L('STATE_WRITTEN ' + STATE_FILE);
}
