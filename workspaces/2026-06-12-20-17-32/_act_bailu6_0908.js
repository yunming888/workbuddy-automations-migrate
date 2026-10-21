// 2026-09-08 第八轮：打开白露活动 release 页面，读规则 + 找「去发布/打卡」按钮真实跳转
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

const entryUrl = fs.readFileSync('debug/bailu_entry_url_2026-09-08.txt', 'utf8').trim();

async function pollText(page, ms = 25000) {
  const t0 = Date.now(); let best = '';
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    if (t.length > best.length) best = t;
    if (t.length > 1500) break;
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

  L('GOTO=' + entryUrl.slice(0, 120));
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => L('GOTO_ERR ' + e.message.slice(0, 200)));
  const txt = await pollText(page, 25000);
  L('PAGE_LEN=' + txt.length);
  L('PAGE_TEXT=' + txt.slice(0, 4000));
  await page.screenshot({ path: 'debug/bailu_activity_page_2026-09-08.png', fullPage: true }).catch(() => {});

  // 抓页面上所有 a[href]，特别是去发布/去参与/打卡类
  const hrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const h = a.getAttribute('href') || '';
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (/publish|create|ugc|weitoutiao|article|group|activity|huati|topic/i.test(h) || /发布|参与|打卡|去写|立即/i.test(t)) {
        out.push({ h: h.slice(0, 700), t });
      }
    });
    return out.slice(0, 25);
  }).catch(() => []);
  for (const x of hrefs) L('HREF ' + x.t + ' => ' + x.h);

  // 抓按钮
  const btns = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button,div[class*=btn],div[class*=button],span[class*=btn]').forEach(e => {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 30 && /发布|参与|打卡|去|写/.test(t)) out.push(t);
    });
    return [...new Set(out)].slice(0, 20);
  }).catch(() => []);
  L('BTNS=' + JSON.stringify(btns));

  fs.writeFileSync('debug/act_bailu6_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu6_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
