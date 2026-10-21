// 2026-09-23 am：抓「重返学堂·自由组班PK赢现金」活动通知的 release 规则页原文
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
const KEY = '重返学堂';

async function pollText(page, ms = 15000) {
  const t0 = Date.now(); let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2000);
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
  page.setDefaultTimeout(20000);
  const opened = [];
  ctx.on('page', p => { opened.push(p); L('NEW_PAGE=' + p.url()); });

  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await pollText(page, 15000);
  // 点「活动通知」分类
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,span,li,a,button')].filter(e => (e.innerText || '').trim() === '活动通知' && e.children.length <= 2);
    if (els.length) els[els.length - 1].click();
  });
  await page.waitForTimeout(5000);

  // 抓所有 a[href]（含 release 规则页）
  const hrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || '').replace(/\s+/g, ' ');
      out.push({ href: a.getAttribute('href'), text: t.slice(0, 100) });
    });
    return out.slice(0, 60);
  });
  L('HREFS=' + JSON.stringify(hrefs));

  // 真实点击「重返学堂」文本块
  try {
    const el = page.locator('text=' + KEY).first();
    await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await el.click({ timeout: 8000 }).catch(e => L('LOCATOR_CLICK_ERR ' + e.message));
    await page.waitForTimeout(6000);
    L('AFTER_CLICK_URL=' + page.url());
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (/规则|瓜分|大奖|参与|PK|组班|奖学金/.test(t)) L('AFTER_CLICK_TEXT=' + t.slice(0, 2500));
  } catch (e) { L('LOCATOR_ERR ' + e.message); }

  for (const p of opened) {
    try {
      await p.waitForTimeout(6000);
      const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== OPENED ' + p.url() + ' LEN=' + tt.length);
      L(tt.slice(0, 3000));
      await p.screenshot({ path: 'debug/rexue_rule_2026-09-23_am.png' }).catch(() => {});
    } catch (e) { L('OPENED_ERR ' + e.message); }
  }

  fs.writeFileSync('debug/act_rule_0923am.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
