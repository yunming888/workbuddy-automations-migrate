// 2026-09-07 v2：定位【热点观察室】活动规则 + 活动话题标签名
// A. 抓活动通知条目里的真实链接（a[href] / 可点击元素），真实鼠标点击并捕获新页
// B. 微头条发布页 → 话题面板 → 搜「热点观察室」，取标签名与讨论量
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

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
  page.setDefaultTimeout(15000);
  const opened = [];
  ctx.on('page', p => { opened.push(p); L('NEW_PAGE=' + p.url()); });

  // ---------- A. 活动通知链接 ----------
  await page.goto('https://mp.toutiao.com/profile_v4/personal/message?type=message_letter', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await pollText(page, 15000);
  // 点「活动通知」分类
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,span,li,a,button')].filter(e => (e.innerText || '').trim() === '活动通知' && e.children.length <= 2);
    if (els.length) els[els.length - 1].click();
  });
  await page.waitForTimeout(5000);

  const hrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || '').replace(/\s+/g, ' ');
      if (/热点观察室|观察室|活动|参与/.test(t) || /activity|huati|topic/i.test(a.getAttribute('href') || '')) {
        out.push({ href: a.getAttribute('href'), text: t.slice(0, 120) });
      }
    });
    // 兜底：抓含「热点观察室」的元素链上所有可点属性
    document.querySelectorAll('*').forEach(e => {
      const t = (e.innerText || '');
      if (t.includes('热点观察室') && t.length < 500) {
        const attrs = ['data-url', 'data-href', 'data-schema', 'data-log', 'href'];
        for (const k of attrs) { const v = e.getAttribute && e.getAttribute(k); if (v) out.push({ href: k + '=' + v, text: t.slice(0, 80) }); }
      }
    });
    return out.slice(0, 40);
  });
  L('HREFS=' + JSON.stringify(hrefs));

  // 真实鼠标点击「热点观察室」文本块
  try {
    const el = page.locator('text=热点观察室').first();
    await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await el.click({ timeout: 8000 }).catch(e => L('LOCATOR_CLICK_ERR ' + e.message));
    await page.waitForTimeout(6000);
    L('AFTER_LOCATOR_CLICK_URL=' + page.url());
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (/规则|瓜分|大奖|参与方式|活动/.test(t)) L('AFTER_CLICK_TEXT=' + t.slice(0, 2500));
  } catch (e) { L('LOCATOR_ERR ' + e.message); }

  for (const p of opened) {
    try {
      await p.waitForTimeout(5000);
      const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== OPENED ' + p.url() + ' LEN=' + tt.length);
      L(tt.slice(0, 2500));
    } catch (e) { L('OPENED_ERR ' + e.message); }
  }

  // ---------- B. 微头条话题面板搜「热点观察室」 ----------
  for (const kw of ['热点观察室', '热点']) {
    try {
      await page.goto('https://mp.toutiao.com/profile_v4/weitoutiao/publish', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(7000);
      await page.evaluate(() => { const ed = document.querySelector('div[contenteditable="true"]'); if (ed) ed.focus(); });
      await page.keyboard.type('参与热点观察室活动');
      await page.waitForTimeout(1200);
      const okT = await page.evaluate(() => {
        const els = [...document.querySelectorAll('div,span,button')].filter(e => (e.innerText || '').trim() === '话题');
        if (!els.length) return false; els[els.length - 1].click(); return true;
      });
      L('KW=' + kw + ' TOPIC_BTN=' + okT);
      await page.waitForTimeout(4000);
      const inputs = await page.$$('input');
      for (const inp of inputs) {
        const ph = await inp.getAttribute('placeholder').catch(() => '');
        if (ph && /话题|搜索/.test(ph)) { await inp.click().catch(() => {}); await inp.type(kw).catch(() => {}); L('TYPED ph=' + ph); break; }
      }
      await page.waitForTimeout(5000);
      const res = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('[class*=topic],[class*=panel],[class*=modal],[class*=list]')]
          .map(e => (e.innerText || '').replace(/\n+/g, ' | ').trim()).filter(s => s.length > 10 && s.length < 900);
        return [...new Set(cands)].slice(0, 8).join(' /// ');
      }).catch(() => '');
      L('KW=' + kw + ' PANEL=' + res.slice(0, 1800));
      await page.screenshot({ path: 'debug/topic_panel_' + encodeURIComponent(kw) + '.png' }).catch(() => {});
    } catch (e) { L('KW_ERR ' + kw + ' ' + e.message); }
  }

  fs.writeFileSync('debug/act_rule2_0907.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
