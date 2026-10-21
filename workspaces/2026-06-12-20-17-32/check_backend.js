const fs = require('fs');
// v1.3（2026-10-17）：改从 pw_launch 取 chromium（同 auto_publish.js），不再依赖 NODE_PATH 写对。
const { chromium } = require('./pw_launch.js');
const LOG = 'debug/cb.log';
function w(s) { try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} console.log(s); }
(async () => {
  fs.writeFileSync(LOG, 'START ' + Date.now() + '\n');
  let browser;
  try {
    w('launching...');
    const { launchBrowser } = require('./pw_launch.js');
    browser = await launchBrowser();
    w('launched');
    const ctx = browser.contexts()[0];
    const cookies = JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8'));
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    w('goto backend...');
    await page.goto('https://mp.toutiao.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000);
    // 点击左侧"作品管理"进入文章列表
    try {
      await page.click('text=作品管理', { timeout: 8000 });
      w('clicked 作品管理');
    } catch (e) { w('click_作品管理_err=' + e.message.slice(0, 60)); }
    await page.waitForTimeout(4000);
    const url = page.url(); const title = await page.title();
    w('URL=' + url + ' TITLE=' + title);
    const isLogin = /login|passport/.test(url) || /登录/.test(title);
    if (isLogin) { w('RESULT=NOT_LOGGED_IN'); await page.screenshot({ path: 'debug/backend_check.png' }); await browser.close(); return; }
    // 截图1：全页
    await page.screenshot({ path: 'debug/backend_full.png', fullPage: true });
    // 提取文章卡片
    const data = await page.evaluate(() => {
      const main = document.querySelector('[class*="content"],[class*="main"],[class*="list-wrap"],[class*="table"]') || document.body;
      const bt = main.innerText;
      // 文章行/卡片
      const rows = [...document.querySelectorAll('tr,[class*="row"],[class*="article-item"],[class*="card"]')]
        .map(e => (e.innerText || '').trim().replace(/\s+/g, ' '))
        .filter(t => t.length > 6 && t.length < 300)
        .slice(0, 40);
      // 所有可见文本中的文章特征
      const hasArticles = /\d{4}-\d{2}-\d{2}|审核|已发布|草稿|推荐量|阅读量|发布时间/.test(bt);
      const emptyHint = /暂无|没有内容|空空|还没有|您还没有|暂无数据/.test(bt);
      return { bt: bt.slice(0, 1200), rows, hasArticles, emptyHint };
    });
    w('HAS_ARTICLES=' + data.hasArticles);
    w('EMPTY_HINT=' + data.emptyHint);
    w('BODY=' + data.bt.replace(/\n/g, ' | '));
    w('ROWS=' + data.rows.length);
    data.rows.forEach((t, i) => w('ROW' + i + '=' + t.slice(0, 120)));
    // 截图2：视口
    await page.screenshot({ path: 'debug/backend_check.png' });
    w('DONE');
  } catch (e) { w('ERR=' + e.message.slice(0, 200)); }
  finally { if (browser) await browser.close().catch(() => {}); w('CLOSED'); }
})();
