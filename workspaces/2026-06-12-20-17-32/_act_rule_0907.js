// 2026-09-07：深挖【热点观察室】活动规则 —— 取话题标签名 / 参与入口 / 参与方式 / 奖励规则
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

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies_edge.json', 'utf-8')));

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  // 监听新开页
  const newPages = [];
  ctx.on('page', p => { newPages.push(p); L('NEW_PAGE_EVENT ' + p.url()); });

  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await pollText(page, 18000);

  // 点「活动通知」分类
  const okTab = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,span,li,a,button')]
      .filter(e => (e.innerText || '').trim() === '活动通知' && e.children.length <= 2);
    if (!els.length) return false;
    els[els.length - 1].click(); return true;
  });
  L('CLICK_TAB_ACT=' + okTab);
  await page.waitForTimeout(6000);
  L('AFTER_TAB_URL=' + page.url());

  // 找到「热点观察室」那条并点击
  const clicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('div,span,li,a,p,td')];
    for (const e of all) {
      const t = (e.innerText || '');
      if (t.includes('热点观察室') && t.length < 400) {
        e.scrollIntoView({ block: 'center' });
        e.click();
        return (t || '').slice(0, 200);
      }
    }
    return null;
  });
  L('CLICKED_ITEM=' + JSON.stringify(clicked));
  await page.waitForTimeout(8000);

  L('URL_AFTER_CLICK=' + page.url());
  let t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('PAGE_AFTER_CLICK LEN=' + t.length);
  L(t.slice(0, 3500));

  // 新开页处理
  for (const p of newPages) {
    try {
      await p.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(6000);
      const u = p.url(); const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== NEWPAGE ' + u + ' LEN=' + tt.length);
      L(tt.slice(0, 3500));
    } catch (e) { L('NEWPAGE_ERR ' + e.message); }
  }

  // 兜底：直接访问常见活动/话题入口
  for (const u of [
    'https://mp.toutiao.com/profile_v4/manage/content/all',
    'https://mp.toutiao.com/profile_v4/weitoutiao/publish',
  ]) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(7000);
      const tt = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== FALLBACK ' + u + ' LEN=' + tt.length);
      L(tt.slice(0, 2000));
    } catch (e) { L('FB_ERR ' + u + ' ' + e.message); }
  }

  fs.writeFileSync('debug/act_rule_0907.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
