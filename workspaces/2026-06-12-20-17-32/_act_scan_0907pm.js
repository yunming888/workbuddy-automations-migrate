// 2026-09-07 pm 追加：扫描后台消息中心全部分类 tab + 活动/创作灵感入口
// 目的：确认「头条精选 / 活动通知（热点点评）」两个板块是否有真实素材
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

async function pollText(page, ms = 25000) {
  const t0 = Date.now(); let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (t.length > best.length) best = t;
    if (t.length > 800) break;
  }
  return best;
}

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies_edge.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const MSG = 'https://mp.toutiao.com/profile_v4/personal/message?type=message_letter';
  await page.goto(MSG, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await pollText(page, 20000);
  L('MSG_URL=' + page.url());

  // 列出消息中心所有可见分类标签
  const tabs = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('div,span,li,a,button')) {
      const t = (e.innerText || '').trim();
      if (!t || t.length > 12) continue;
      if (e.children.length > 2) continue;
      if (/消息|通知|活动|私信|评论|粉丝|点赞|互动|系统|精选/.test(t)) out.push(t);
    }
    return [...new Set(out)];
  });
  L('TABS=' + JSON.stringify(tabs));

  // 逐个点分类标签，抓文本
  for (const tab of tabs) {
    try {
      const ok = await page.evaluate((label) => {
        const els = [...document.querySelectorAll('div,span,li,a,button')]
          .filter(e => (e.innerText || '').trim() === label && e.children.length <= 2);
        if (!els.length) return false;
        els[els.length - 1].click(); return true;
      }, tab);
      if (!ok) { L('TAB_SKIP=' + tab); continue; }
      await page.waitForTimeout(5000);
      const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== TAB ' + tab + ' URL=' + page.url() + ' LEN=' + t.length);
      L(t.slice(0, 2200));
    } catch (e) { L('TAB_ERR=' + tab + ' ' + e.message); }
  }

  // 直接访问创作灵感 / 活动页
  for (const u of [
    'https://mp.toutiao.com/profile_v4/creative/inspiration',
    'https://mp.toutiao.com/profile_v4/manage/activity',
    'https://mp.toutiao.com/profile_v4/personal/message?type=message_system',
  ]) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(6000);
      const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== URL ' + u + ' LEN=' + t.length);
      L(t.slice(0, 1800));
    } catch (e) { L('URL_ERR=' + u + ' ' + e.message); }
  }

  fs.writeFileSync('debug/act_2026-09-07_pm.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
