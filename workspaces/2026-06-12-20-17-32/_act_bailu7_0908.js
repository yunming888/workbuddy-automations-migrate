// 2026-09-08 第九轮：白露活动页 → 点「规则」tab 读参与方式 + 找打卡/去发布按钮真实跳转
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

const entryUrl = fs.readFileSync('debug/bailu_entry_url_2026-09-08.txt', 'utf8').trim();

async function pollText(page, ms = 20000) {
  const t0 = Date.now(); let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (t.length > best.length) best = t;
    if (t.length > 800) break;
  }
  return best;
}

const dumpState = async (page, tag) => {
  const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('[' + tag + '_URL] ' + page.url());
  L('[' + tag + '_TEXT] ' + t.slice(0, 3000));
};

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies_edge.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const opened = [];
  ctx.on('page', p => { opened.push(p); L('NEW_PAGE=' + p.url()); });

  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => L('GOTO_ERR ' + e.message.slice(0, 200)));
  await pollText(page, 20000);

  // 点「规则」
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div,span,button,a,li')].filter(e => (e.innerText || '').trim() === '规则' && (e.innerText || '').length < 10);
    if (!els.length) return 'NO_RULE_TAB';
    const el = els[els.length - 1];
    el.click();
    return 'CLICKED ' + el.tagName;
  }).catch(e => 'ERR ' + e.message);
  L('RULE_TAB=' + clicked);
  await page.waitForTimeout(6000);
  await dumpState(page, 'AFTER_RULE');
  await page.screenshot({ path: 'debug/bailu_rule_tab_2026-09-08.png', fullPage: false }).catch(() => {});

  // 找「打卡/去发布/去参与/立即参与」按钮或链接，抓其 href / 祖先链接
  const act = await page.evaluate(() => {
    const out = { links: [], btns: [] };
    document.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40) out.links.push({ t, h: (a.getAttribute('href') || '').slice(0, 900) });
    });
    // 全元素扫描固定文案按钮
    document.querySelectorAll('div,span,button,a').forEach(e => {
      const t = (e.innerText || '').trim();
      if (t && t.length < 24 && /打卡|去发布|去参与|发布内容|立即参与|马上参与|写一写|参与活动/.test(t)) {
        let p = e, chain = [];
        for (let i = 0; i < 5 && p; i++) {
          const h = p.getAttribute && p.getAttribute('href');
          if (h) chain.push('A:' + h.slice(0, 900));
          p = p.parentElement;
        }
        out.btns.push({ t, tag: e.tagName, chain: chain.join(' | ') });
      }
    });
    return out;
  }).catch(() => ({}));
  L('LINKS=' + JSON.stringify((act.links || []).slice(0, 25), null, 0));
  L('ACT_BTNS=' + JSON.stringify((act.btns || []).slice(0, 25), null, 0));

  // 兜底：若有明确的「打卡/发布」按钮则真实点击
  for (const kw of ['打卡', '去发布', '去参与', '参与活动', '发布']) {
    try {
      const loc = page.locator('text=' + kw).first();
      if (await loc.count().catch(() => 0) > 0) {
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await loc.click({ timeout: 5000 }).catch(() => {});
        L('BTN_CLICKED=' + kw);
        await page.waitForTimeout(7000);
        await dumpState(page, 'AFTER_BTN_' + kw);
        break;
      }
    } catch (e) { L('BTN_ERR ' + kw + ' ' + e.message.slice(0, 120)); }
  }

  // 汇总新开页面
  for (const p of opened) {
    try {
      await p.waitForTimeout(5000);
      const u = p.url();
      L('=== OPENED ' + u);
      if (/publish|create|weitoutiao|article/.test(u)) {
        const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
        L('PUBLISH_PAGE_TEXT=' + tt.slice(0, 1500));
        await p.screenshot({ path: 'debug/bailu_opened_publish_2026-09-08.png', fullPage: false }).catch(() => {});
      }
    } catch (e) { L('OPENED_ERR ' + e.message.slice(0, 150)); }
  }

  fs.writeFileSync('debug/act_bailu7_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu7_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
