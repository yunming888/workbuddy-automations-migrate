// 2026-09-23 am：打开「拍同款赢现金」release 规则页抓原文
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
const URL = 'https://api.toutiaoapi.com/magic/eco/runtime/release/6a6b2fa843d2ab0b36030c90?appType=newsarticle&should_full_screen=1&hide_nav_bar=1&hide_status_bar=0&magic_page_no=1&magic_source=common&log_pb=' + encodeURIComponent(JSON.stringify({ activity_id: "1874496471798793", activity_name: "拍同款赢现金", activity_type: "gid", activity_location: "message_reaching_event_notification", entrance: "activity_invite", post_ugc_enter_from: "100000000857" })) + '&should_append_common_param=1';

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies_edge.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);
  const t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(e => 'ERR ' + e.message);
  L('URL=' + page.url());
  L('LEN=' + t.length);
  L(t.slice(0, 4000));
  await page.screenshot({ path: 'debug/paixuan_rule_2026-09-23_am.png', fullPage: true }).catch(() => {});
  fs.writeFileSync('debug/act_pai_0923am.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
