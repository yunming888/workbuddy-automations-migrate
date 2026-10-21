// 2026-09-08 第三轮：定位「白露到，红包到」（二十四节气打卡）活动的真实入口
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
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const opened = [];
  ctx.on('page', p => { opened.push(p); L('NEW_PAGE=' + p.url()); });

  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pollText(page, 20000);
  // 滚动加载
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await page.waitForTimeout(1800); }
  const full = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('HAS_BAILU=' + /白露到/.test(full) + ' LEN=' + full.length);
  // 抓「白露」消息卡片里的所有 URL 属性
  const links = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const t = e.innerText || '';
      if (!/白露到|红包到|二十四节气|承露|福气/.test(t) || t.length > 600) continue;
      // 本元素及祖先 5 层内的 url 属性
      let p = e;
      for (let i = 0; i < 6 && p; i++) {
        for (const k of ['href', 'data-url', 'data-href', 'data-schema', 'data-log', 'data-id']) {
          const v = p.getAttribute && p.getAttribute(k);
          if (v && !out.some(o => o.v === v)) out.push({ k, v: String(v).slice(0, 600), tag: p.tagName });
        }
        p = p.parentElement;
      }
    }
    // 页面全部 log_pb/release URL 兜底
    const bodyHtml = document.documentElement.outerHTML || '';
    const ms = bodyHtml.match(/https?:\\?\/\\?\/api\.toutiaoapi\.com[^"'\\\s]{20,400}/g) || [];
    const seen = new Set();
    for (const m0 of ms) {
      const m = m0.replace(/\\\//g, '/');
      if (/activity|log_pb|magic/.test(m) && !seen.has(m.slice(0, 80))) { seen.add(m.slice(0, 80)); out.push({ k: 'html', v: m.slice(0, 600), tag: 'html' }); }
    }
    return out.slice(0, 40);
  }).catch(() => []);
  L('BAILU_LINKS=' + JSON.stringify(links, null, 0));

  fs.writeFileSync('debug/act_bailu_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
