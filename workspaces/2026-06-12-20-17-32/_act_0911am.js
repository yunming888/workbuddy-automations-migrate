// 2026-09-11 am：打开「你问我答」活动规则页读原文
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const OUT = [];
const L = (...a) => OUT.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8')));
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('https://mp.toutiao.com/profile_v4/activity/task-list', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => /共\s*[\d,]+\s*个创作活动/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 收集所有链接，找含 你问我答 的
  const links = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.indexOf('你问我答') !== -1 || (a.getAttribute('href') || '').indexOf('question') !== -1) {
        out.push({ href: a.getAttribute('href').slice(0, 400), text: t.slice(0, 60) });
      }
    }
    return out.slice(0, 10);
  });
  L('LINKS=' + JSON.stringify(links));

  // 直接点卡片
  let clicked = false;
  try {
    await page.getByText('你问我答', { exact: false }).first().click({ timeout: 8000 });
    clicked = true;
  } catch (e) { L('CLICK_ERR=' + e.message.slice(0, 120)); }
  L('CLICKED=' + clicked);
  await page.waitForTimeout(5000);
  L('AFTER_URL=' + page.url().slice(0, 300));
  // 可能开新页
  const pages = ctx.pages();
  L('PAGES=' + pages.length);
  let target = page;
  if (pages.length > 1) target = pages[pages.length - 1];
  await target.waitForTimeout(3000);
  const t = await target.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('TARGET_URL=' + target.url().slice(0, 300));
  L('RULE_TEXT=' + t.slice(0, 4000));
  await target.screenshot({ path: 'debug/act_niwenwoda_0911am.png' }).catch(() => {});

  fs.writeFileSync('debug/act_2026-09-11_am.log', OUT.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { try { fs.writeFileSync('debug/act_2026-09-11_am.log', OUT.join('\n') + '\nFATAL ' + e.message, 'utf8'); } catch (x) {} process.exit(7); });
