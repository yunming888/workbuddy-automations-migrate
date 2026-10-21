// 2026-09-08 am：扫活动通知+服务通知，抓全部活动入口（log_pb 法），逐个打开规则页读原文
// 目标活动：热点观察室（已知=上头条聊热点）/ 作者互动季 / 白露（二十四节气）等
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

async function pollText(page, ms = 20000) {
  const t0 = Date.now(); let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (t.length > best.length) best = t;
    if (t.length > 900) break;
  }
  return best;
}

async function clickByLabel(page, label) {
  return await page.evaluate((label) => {
    const els = [...document.querySelectorAll('div,span,li,a,button')]
      .filter(e => (e.innerText || '').trim() === label && e.children.length <= 2);
    if (!els.length) return false;
    els[els.length - 1].click();
    return true;
  }, label);
}

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  const MSG = 'https://mp.toutiao.com/profile_v4/personal/message?type=message_letter';

  // ---------- 1. 逐分类抓文本 + 收集活动入口 ----------
  const entries = []; // {tab, text, urls:[...]}
  for (const tab of ['活动通知', '服务通知', '系统通知']) {
    await page.goto(MSG, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pollText(page, 15000);
    const ok = await clickByLabel(page, tab);
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    const urls = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (/api\.toutiaoapi\.com\/magic|activity_id|log_pb|\/pages\//.test(h)) {
          out.push({ href: h.slice(0, 500), text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 80) });
        }
      }
      // 兜底：所有元素上找 data-url/data-href
      for (const e of document.querySelectorAll('*')) {
        for (const k of ['data-url', 'data-href']) {
          const v = e.getAttribute && e.getAttribute(k);
          if (v && /magic|activity|log_pb/.test(v)) out.push({ href: k + ':' + v.slice(0, 500), text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 80) });
        }
      }
      return out.slice(0, 30);
    }).catch(() => []);
    L('TAB[' + tab + ']_OK=' + ok + ' TEXT_LEN=' + text.length);
    L('TAB[' + tab + ']_TEXT=' + text.slice(0, 2600));
    L('TAB[' + tab + ']_URLS=' + JSON.stringify(urls));
    entries.push({ tab, text, urls });
  }

  // ---------- 2. 从 log_pb / href 还原可打开的规则页 URL ----------
  const ruleUrls = [];
  for (const e of entries) {
    for (const u of e.urls) {
      let href = u.href.startsWith('data-') ? u.href.split(':').slice(1).join(':') : u.href;
      if (/^data-/.test(u.href)) continue;
      if (href.startsWith('//')) href = 'https:' + href;
      if (!/^https?:/.test(href)) continue;
      ruleUrls.push({ tab: e.tab, href, text: u.text });
    }
  }
  // 也从全文里正则捞 release 链接
  for (const e of entries) {
    const re = /https?:\\?\/\\?\/api\.toutiaoapi\.com[^\s"'\\]+|https?:\/\/api\.toutiaoapi\.com[^\s"'\\]+/g;
    const m = (e.text || '').match(re);
    if (m) m.forEach(h => ruleUrls.push({ tab: e.tab + '(regex)', href: h.replace(/\\\//g, '/'), text: '' }));
  }
  L('RULE_URLS=' + JSON.stringify(ruleUrls.slice(0, 20)));

  // ---------- 3. 打开每个规则页读原文 ----------
  const seen = new Set();
  let idx = 0;
  for (const r of ruleUrls.slice(0, 8)) {
    idx++;
    const key = r.href.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await page.goto(r.href, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(5000);
      const t = await pollText(page, 20000);
      L('=== RULE_PAGE_' + idx + ' [' + r.tab + '] ' + page.url().slice(0, 150));
      L('RULE_TEXT_' + idx + '=' + t.slice(0, 3000));
      await page.screenshot({ path: 'debug/act_rule_' + idx + '_0908am.png' }).catch(() => {});
    } catch (e) { L('RULE_PAGE_' + idx + '_ERR=' + e.message.slice(0, 100)); }
  }

  fs.writeFileSync('debug/act_scan_2026-09-08_am.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_scan_2026-09-08_am.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
