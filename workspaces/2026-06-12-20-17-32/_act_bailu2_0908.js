// 2026-09-08 第四轮：真实鼠标点击「白露到，红包到」消息卡片，捕获打开的新页/URL
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
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await page.waitForTimeout(1800); }

  // 定位「白露到」卡片（取含该文本且尺寸合适的最深层可点容器）
  const cardInfo = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter(e => {
      const t = e.innerText || '';
      if (!/白露到|红包到/.test(t) || t.length > 800) return false;
      const r = e.getBoundingClientRect();
      return r.width > 200 && r.height > 40 && r.width < 1200;
    });
    return els.slice(-6).map(e => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, cls: String(e.className).slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 120) };
    });
  }).catch(() => []);
  L('CARDS=' + JSON.stringify(cardInfo, null, 0));

  // 真实鼠标点击最深那个候选
  let clicked = false;
  for (const c of [...cardInfo].reverse()) {
    if (c.w < 200) continue;
    try {
      await page.mouse.click(c.x, c.y);
      L('CLICKED at ' + c.x + ',' + c.y + ' tag=' + c.tag + ' text=' + c.text);
      clicked = true;
      break;
    } catch (e) { L('CLICK_ERR ' + e.message.slice(0, 150)); }
  }
  await page.waitForTimeout(8000);
  L('AFTER_CLICK_URL=' + page.url());
  const after = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  L('AFTER_CLICK_TEXT_LEN=' + after.length);
  if (/规则|瓜分|参与|红包|活动|打卡/.test(after)) L('AFTER_CLICK_TEXT=' + after.slice(0, 3000));

  // 抓当前页面与所有新页的 release/log_pb URL
  const grabUrls = async (p, tag) => {
    const urls = await p.evaluate(() => {
      const html = document.documentElement.outerHTML || '';
      const out = [];
      const re = /https?:[^"'\\\s]{10,600}/g;
      let m;
      while ((m = re.exec(html)) && out.length < 30) {
        const s = m[0].replace(/\\\//g, '/');
        if (/activity|log_pb|magic|event|huodong|topic/i.test(s)) out.push(s.slice(0, 500));
      }
      return [...new Set(out)];
    }).catch(() => []);
    for (const u of urls) L('URL[' + tag + ']=' + u);
  };
  await grabUrls(page, 'main');
  for (const p of opened) {
    try {
      await p.waitForTimeout(6000);
      L('=== OPENED ' + p.url() + ' LEN=' + ((await p.evaluate(() => (document.body.innerText || '').length)).catch(() => 0)));
      const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      if (/规则|瓜分|参与|红包|打卡|发布/.test(tt)) L(tt.slice(0, 3000));
      await grabUrls(p, 'opened');
      await p.screenshot({ path: 'debug/bailu_opened_' + opened.indexOf(p) + '.png' }).catch(() => {});
    } catch (e) { L('OPENED_ERR ' + e.message.slice(0, 150)); }
  }
  await page.screenshot({ path: 'debug/bailu_after_click.png' }).catch(() => {});

  fs.writeFileSync('debug/act_bailu2_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu2_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
