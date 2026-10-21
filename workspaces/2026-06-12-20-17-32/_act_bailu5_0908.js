// 2026-09-08 第七轮：抓完整活动入口 href（不截断）
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
  page.setDefaultTimeout(20000);
  const opened = [];
  ctx.on('page', p => { opened.push(p); L('NEW_PAGE=' + p.url()); });

  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pollText(page, 20000);
  const row = page.locator('.conversation-box', { hasText: '作者成长助手' }).first();
  await row.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
  await row.click({ timeout: 8000 }).catch(e => L('CLICK_ERR ' + e.message));
  await page.waitForTimeout(8000);

  // 找 href 包含 6a9d5f18 或 activity_id=1875588 的 a 标签，抓完整 href
  const href = await page.evaluate(() => {
    const as = [...document.querySelectorAll('a[href]')];
    for (const a of as) {
      const h = a.getAttribute('href') || '';
      if (h.includes('6a9d5f18562e4207bec69f02') || h.includes('1875588942446859')) return h;
    }
    return '';
  }).catch(() => '');
  L('FULL_HREF=' + href);
  fs.writeFileSync('debug/bailu_entry_url_2026-09-08.txt', href, 'utf8');

  fs.writeFileSync('debug/act_bailu5_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu5_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
