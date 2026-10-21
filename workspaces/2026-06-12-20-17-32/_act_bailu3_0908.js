// 2026-09-08 第五轮：抓「作者成长助手 白露」私信卡片的完整 HTML，找可点击活动链接/schema
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
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await page.waitForTimeout(1500); }

  // 抓白露卡片的外层 HTML（截到卡片边界）
  const html = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div')].filter(e => {
      const t = e.innerText || '';
      return /白露到，红包到/.test(t) && t.length < 900 && t.length > 50;
    });
    if (!els.length) return 'NO_CARD';
    const card = els.reduce((a, b) => (a.innerText.length < b.innerText.length ? a : b));
    let h = card.outerHTML;
    // 向上包一层
    let p = card.parentElement;
    if (p && p.outerHTML.length < 30000) h = p.outerHTML;
    return h;
  }).catch(e => 'ERR ' + e.message);
  fs.writeFileSync('debug/bailu_card_2026-09-08.html', html, 'utf8');
  L('HTML_LEN=' + html.length);

  // 从 HTML 里抽所有 URL / schema / 事件
  const urls = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter(e => {
      const t = e.innerText || '';
      return /白露到，红包到/.test(t) && t.length < 900;
    });
    const card = els.reduce((a, b) => (a.innerText.length < b.innerText.length ? a : b));
    let node = card;
    const attrs = new Set();
    for (let i = 0; i < 8 && node; i++) {
      for (const k of node.getAttributeNames ? node.getAttributeNames() : []) {
        const v = node.getAttribute(k);
        if (v && /https?:|sslocal|activity|log_pb|magic|schema|video|detail/i.test(v)) attrs.add(k + '=' + v.slice(0, 500));
      }
      node = node.parentElement;
    }
    // 卡片内所有 a / button / [data-*]
    const kids = [];
    card.querySelectorAll('a[href],button,[data-schema],[data-log]').forEach(e => {
      kids.push(e.tagName + '|' + (e.getAttribute('href') || e.getAttribute('data-schema') || e.getAttribute('data-log') || '').slice(0, 300) + '|' + (e.innerText || '').trim().slice(0, 60));
    });
    return { attrs: [...attrs].slice(0, 30), kids: kids.slice(0, 30) };
  }).catch(() => ({}));
  L('CARD_ATTRS=' + JSON.stringify(urls.attrs, null, 0));
  L('CARD_KIDS=' + JSON.stringify(urls.kids, null, 0));

  fs.writeFileSync('debug/act_bailu3_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu3_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
