// 2026-09-08 第二轮：定位「作者互动季」「白露承露接出好运气」
// A. 消息中心主列表抓「白露到红包到/二十四节气/作者互动季」消息内的链接
// B. 微头条发布页话题面板搜「作者互动季」「白露」，抓候选（讨论量）
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
  const MSG = 'https://mp.toutiao.com/profile_v4/personal/message?type=message_letter';

  // ---------- A. 消息中心全文链接扫描 ----------
  await page.goto(MSG, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pollText(page, 15000);
  // 向下滚动加载更多历史
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(2000);
  }
  const fullText = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('HAS_BAILU_MSG=' + /白露到/.test(fullText) + ' HAS_HUDONGJI=' + /互动季/.test(fullText));
  const links = await page.evaluate(() => {
    const out = [];
    // 找含目标关键词的元素，向上找最近的带链接祖先
    for (const e of document.querySelectorAll('*')) {
      const t = e.innerText || '';
      if (!/白露|互动季|节气|红包到/.test(t) || t.length > 600) continue;
      let p = e;
      for (let i = 0; i < 5 && p; i++) {
        if (p.tagName === 'A' && p.getAttribute('href')) { out.push({ href: p.getAttribute('href').slice(0, 600), text: t.replace(/\s+/g, ' ').slice(0, 120) }); break; }
        const du = p.getAttribute && (p.getAttribute('data-url') || p.getAttribute('data-href'));
        if (du) { out.push({ href: du.slice(0, 600), text: t.replace(/\s+/g, ' ').slice(0, 120) }); break; }
        p = p.parentElement;
      }
    }
    return out.slice(0, 20);
  }).catch(() => []);
  L('KEYWORD_LINKS=' + JSON.stringify(links));

  // ---------- B. 话题面板搜索 ----------
  await page.goto('https://mp.toutiao.com/profile_v4/weitoutiao/publish', { waitUntil: 'domcontentloaded', timeout: 45000 });
  let ec = 0;
  for (let i = 0; i < 12; i++) { ec = await page.locator('[contenteditable="true"]').count(); if (ec) break; await page.waitForTimeout(2000); }
  L('EDITABLE=' + ec);
  if (ec) {
    // 打开话题面板
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('span,div,button')]
        .filter(e => (e.textContent || '').trim() === '话题' && e.children.length <= 2 && (e.offsetParent || e.getBoundingClientRect().width));
      if (c.length) c[c.length - 1].click();
    });
    await page.waitForTimeout(2500);

    for (const kw of ['作者互动季', '白露', '白露承露']) {
      const input = page.locator('input[placeholder*="搜索话题"], textarea[placeholder*="搜索话题"]').first();
      if (await input.count() === 0) { L('INPUT_GONE'); break; }
      await input.click({ timeout: 6000 }).catch(() => {});
      await input.fill('').catch(() => {});
      await input.type(kw, { delay: 100 }).catch(() => {});
      await page.waitForTimeout(4000);
      // 面板候选：从输入框往上找祖先容器里的小文本块
      const cands = await page.evaluate(() => {
        const e = [...document.querySelectorAll('input,textarea')].find(x => /搜索话题/.test(x.getAttribute('placeholder') || ''));
        if (!e) return null;
        let cur = e, best = e;
        for (let i = 0; i < 8 && cur.parentElement; i++) { cur = cur.parentElement; if ((cur.innerText || '').length > (best.innerText || '').length && (cur.innerText || '').length < 2500) best = cur; }
        const items = [];
        for (const c of best.querySelectorAll('li,div,p,span')) {
          const tx = (c.innerText || '').replace(/[ \t]+/g, ' ').trim();
          if (tx && tx.length <= 80 && /讨论|话题|万/.test(tx)) items.push(tx);
        }
        return { panelText: (best.innerText || '').replace(/[ \t]+/g, ' ').slice(0, 1200), items: [...new Set(items)].slice(0, 20) };
      }).catch(() => null);
      L('SEARCH[' + kw + ']=' + JSON.stringify(cands));
    }
  }

  fs.writeFileSync('debug/act_probe2_2026-09-08_am.log', LOG.join('\n'), 'utf8');
  // 🚨 绝不发布
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_probe2_2026-09-08_am.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
