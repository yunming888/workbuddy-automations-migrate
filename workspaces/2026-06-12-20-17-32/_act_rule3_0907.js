// 2026-09-07 v3：打开活动规则页读原文（取 5万元大奖评选规则 / 参与方式）
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };

const BASE = 'https://api.toutiaoapi.com/magic/eco/runtime/release/';
const PAGES = [
  {
    tag: '上头条聊热点(essay_activity, id=1872664429542409)',
    url: BASE + '6a71b161ec820c074e71257a?appType=newsarticle&should_full_screen=1&hide_nav_bar=1&hide_status_bar=0&magic_page_no=1&magic_source=common&log_pb=' +
      encodeURIComponent(JSON.stringify({
        activity_id: '1872664429542409', activity_name: '上头条 聊热点',
        activity_location: 'message_reaching_staging', entrance: 'message_reaching_staging',
        post_ugc_enter_from: 100000000857, activity_type: 'essay_activity', outer_enter_from: 'message_reaching_staging'
      }))
  },
  { tag: '瓜分8万元(6a7087eddd0222075382276f)', url: BASE + '6a7087eddd0222075382276f?appType=newsarticle&should_full_screen=1&hide_nav_bar=1&hide_status_bar=0&magic_page_no=1&magic_source=common' },
];

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies_edge.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  for (const p of PAGES) {
    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(9000);
      const u = page.url();
      let t = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      L('=== ' + p.tag);
      L('URL=' + u + ' LEN=' + t.length);
      L(t.slice(0, 4000));
      await page.screenshot({ path: 'debug/act_page_' + p.tag.slice(0, 6) + '.png' }).catch(() => {});
    } catch (e) { L('ERR ' + p.tag + ' ' + e.message); }
  }

  fs.writeFileSync('debug/act_rule3_0907.log', LOG.join('\n'), 'utf-8');
  console.log('DONE lines=' + LOG.length);
  await browser.close();
  process.exit(0);
})();
