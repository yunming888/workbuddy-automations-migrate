// 2026-09-14 am: 只抓「活动通知」分类的活动卡片(a[href] 带 activity/log_pb)，判断有无可发 am3
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const L = (...a) => { console.log(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
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
  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(2000); const t = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0); if (t > 500) break; }
  await page.waitForTimeout(3000);
  const ok = await clickByLabel(page, '活动通知');
  await page.waitForTimeout(5000);
  const data = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/[ \t]+/g, ' ');
    const urls = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (/api\.toutiaoapi\.com\/magic|activity_id|log_pb|\/pages\//.test(h)) urls.push({ h: h.slice(0, 200), t: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 80) });
    }
    return { txtLen: txt.length, head: txt.slice(0, 1500), urls: urls.slice(0, 20) };
  }).catch(() => ({}));
  L('ACT_TAB_OK=' + ok);
  L('ACT_HEAD=' + data.head);
  L('ACT_URLS=' + JSON.stringify(data.urls));
  await page.screenshot({ path: 'debug/act_notify_2026-09-14_am.png' }).catch(() => {});
  await browser.close();
  L('DONE');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
