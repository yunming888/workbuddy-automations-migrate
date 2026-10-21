// _grab_topic_list.js — 只读：抓微头条发布页「话题」面板的推荐话题（含围观/讨论量），按量降序 + 标 >10万
// 2026-09-29 新增。用途：云明要"按人气 >10万 筛选推荐话题"，桌面端「推荐话题」全量列表入口。
// 用法：node _grab_topic_list.js  （浏览器 cookie 用 toutiao_cookies.json；失败可换 COOKIES_FILE / CDP_PORT）
// 产出：debug/topic_list_<DATE>.log（raw+结构化） + debug/topic_list_<DATE>.json（全量带量）

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./pw_launch.js');

const LOG = [];
function L(...a){ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log('[TOPICLIST]', s); }
const DATE = process.env.DATE || (()=>new Date(Date.now()+8*3600*1000).toISOString().slice(0,10))();
const COOKIES_FILE = process.env.COOKIES_FILE || 'toutiao_cookies.json';
const OUT_LOG = path.join(__dirname, 'debug', 'topic_list_' + DATE + '.log');
const OUT_JSON = path.join(__dirname, 'debug', 'topic_list_' + DATE + '.json');

// 把 "380万" / "755万讨论" / "3.2万人讨论" / "1.5万" 归一成数值（单位：个围观/讨论）
function toNum(s){
  if(!s) return null;
  const m = String(s).match(/([\d.]+)\s*万/);
  if(m) return Math.round(parseFloat(m[1]) * 10000);
  const m2 = String(s).match(/([\d,]+)\s*(?:人在围观|人讨论|讨论|围观|$)/);
  if(m2) return parseInt(m2[1].replace(/,/g,''),10);
  return null;
}

(async () => {
  L('DATE=' + DATE + ' COOKIES=' + COOKIES_FILE + ' CDP_PORT=' + (process.env.CDP_PORT||'9344'));
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  try { await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE,'utf-8'))); L('COOKIES_OK'); }
  catch(e){ L('CK_ERR ' + e.message.slice(0,60)); }
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);

  // 微头条发布页
  const WTP = 'https://mp.toutiao.com/profile_v4/weitoutiao/publish';
  await page.goto(WTP, { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForTimeout(4000);

  // 点工具栏「话题」按钮开面板
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('span,div,button')]
      .filter(e => (e.textContent||'').trim()==='话题' && e.children.length<=2 && (e.offsetParent||e.getBoundingClientRect().width));
    if(els.length){ els[els.length-1].click(); return true; }
    return false;
  }).catch(()=>false);
  L('TOPIC_BTN_CLICKED=' + clicked);
  await page.waitForTimeout(5000);

  // 重载等待：热门话题区常卡在 "加载中..."，循环等它渲染出来（最多 30s）
  // 策略：每 5s 检测一次 body 是否还含 "加载中"；若 3 次仍是，再点一次「热门话题」标签重触发
  let loaded = false;
  for(let attempt=0; attempt<6; attempt++){
    const bodyNow = (await page.evaluate(() => (document.body.innerText||'')).catch(()=>'')) || '';
    const stillLoading = bodyNow.includes('加载中');
    L('LOAD_WAIT attempt=' + attempt + ' still_loading=' + stillLoading);
    if(!stillLoading){ loaded = true; break; }
    // 中间第 2、4 次尝试，再点一次「热门话题」/「推荐」标签重触发异步
    if(attempt===1 || attempt===3){
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('div,span,li,a')]
          .filter(e => { const t=(e.textContent||'').trim(); return (t==='热门话题'||t==='推荐'||t==='最热') && e.offsetParent; });
        if(els.length){ els[0].click(); return true; }
        return false;
      }).catch(()=>false);
      await page.waitForTimeout(5000);
    } else {
      await page.waitForTimeout(5000);
    }
  }
  L('TOPIC_PANEL_LOADED=' + loaded);

  // 面板原文
  const panelText = (await page.evaluate(() => (document.body.innerText||'').replace(/[ \t]+/g,' ')).catch(()=>'')) || '';
  L('PAGE_LEN=' + panelText.length);
  L('PANEL_TEXT=' + panelText.slice(0, 3000));

  // 抓面板里所有"话题候选 + 量"。常见结构：含 #xx# 或话题名 + 「N万讨论/N人在围观/N万」。
  const items = await page.evaluate(() => {
    const out = [];
    // 1) 带 #话题# 的文本块（含推荐话题卡）
    const blocks = document.body.innerText.split('\n').map(s=>s.trim()).filter(Boolean);
    const reTopic = /(^|\s)#([^#\n]{2,40})#|话题[:：]?\s*([^#]{2,40})/g;
    // 2) 候选条目：class 含 topic / 或 li 元素
    const candSels = ['li', '[role=option]', '[class*=topic-item]', '[class*=topicItem]', '[class*=recommend] li', '[class*=list] li'];
    for(const sel of candSels){
      document.querySelectorAll(sel).forEach(el=>{
        const t = (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
        if(t && t.length>=2 && t.length<60) out.push(t);
      });
    }
    return { lines: blocks, cands: out };
  }).catch(()=>({lines:[],cands:[]}));

  // 从文本里抽"话题名 + 量"
  const seen = new Set();
  const parsed = [];
  const scanText = (t) => {
    // 量：N万讨论 / N万人在围观 / N万人 / N万
    const num = toNum(t);
    const tm = t.match(/#([^#\n]{2,40})#/) || t.match(/^#?([一-龥A-Za-z0-9·]{2,30})(?:\s*[（(]\s*([\d.]+)\s*万[\s)）])?/);
    const name = tm ? (tm[1]||tm[2]||'').trim() : '';
    if(name && !seen.has(name)){
      seen.add(name);
      parsed.push({ name, count: num, raw: t.slice(0,60) });
    }
  };
  (items.lines||[]).forEach(scanText);
  (items.cands||[]).forEach(scanText);

  // 排序：有量的按量降序放前；无量按抓取顺序
  const withNum = parsed.filter(p=>p.count!=null).sort((a,b)=>b.count-a.count);
  const noNum = parsed.filter(p=>p.count==null);
  const merged = [...withNum, ...noNum];
  L('PARSED_TOTAL=' + merged.length + ' WITH_COUNT=' + withNum.length);
  merged.forEach((p,i)=> L(`ITEM[${i}] ${p.name} | ${p.count==null?'(无量)':p.count+'('+(p.count>100000?'>10万':'≤10万')+')'} | ${p.raw}`));

  const gt10w = withNum.filter(p=>p.count>100000);
  L('GT_10W_COUNT=' + gt10w.length);
  gt10w.forEach(p=> L('  >10W ' + p.name + '=' + p.count));

  const payload = { date: DATE, fetched_at: new Date().toISOString(), source: WTP, with_count: withNum, no_count: noNum, gt_10w: gt10w.map(p=>p.name), raw_lines: (items.lines||[]).slice(0,200) };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_LOG, LOG.join('\n'));
  L('SAVED ' + OUT_JSON);
  await Promise.race([browser.close(), new Promise(r=>setTimeout(r,5000))]);
  process.exit(0);
})().catch(e => {
  L('FATAL ' + e.message.slice(0,200));
  try { fs.writeFileSync(OUT_LOG, LOG.join('\n') + '\nFATAL ' + e.message); } catch(x){}
  process.exit(3);
});
