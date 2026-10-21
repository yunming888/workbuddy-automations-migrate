// 2026-10-03 pm: 抓话题邀请+消息中心(4分类)+截图
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
const LOG = [];
const L = (...a) => { LOG.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
const DATE = process.env.SCAN_DATE || '2026-10-03';
const SLOT = process.env.SCAN_SLOT || 'pm';
const SCAN_LOG = process.env.SCAN_LOG || ('debug/act_scan_' + DATE + '_' + SLOT + '.log');

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

async function clickByLabel(page, label) {
  return await page.evaluate((label) => {
    const els = [...document.querySelectorAll('div,span,li,a,button')]
      .filter(e => (e.innerText || '').trim() === label && e.children.length <= 2);
    if (!els.length) return false;
    els[els.length - 1].click();
    return true;
  }, label);
}

(async () => {
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8')));
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);

  // ---------- 1. 话题邀请 ----------
  const INV = 'https://mp.toutiao.com/profile_v4/personal/message?type=topic_invite';
  await page.goto(INV, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pollText(page, 15000);
  await page.waitForTimeout(3000);
  const invText = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  await page.screenshot({ path: 'invitations_' + DATE + '_' + SLOT + '.png', fullPage: false });
  L('INVITE_TEXT_LEN=' + invText.length);
  L('INVITE_TEXT=' + invText.slice(0, 3000));

  // ---------- 2. 消息中心四分类 ----------
  const MSG = 'https://mp.toutiao.com/profile_v4/personal/message?type=message_letter';
  for (const tab of ['服务通知', '活动通知', '系统通知', '话题邀请']) {
    await page.goto(MSG, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pollText(page, 12000);
    const ok = await clickByLabel(page, tab);
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
    L('MSG_TAB[' + tab + ']_OK=' + ok + ' TEXT_LEN=' + text.length);
    L('MSG_TAB[' + tab + ']_TEXT=' + text.slice(0, 2500));
  }
  await page.screenshot({ path: 'backend_msg_' + DATE + '_' + SLOT + '.png', fullPage: false });
  L('BACKEND_MSG_SCREENSHOT_SAVED');

  await browser.close();
  fs.writeFileSync(SCAN_LOG, LOG.join('\n'));
  console.log('DONE');
})().catch(e => { console.error('ERR ' + e.message); fs.writeFileSync(SCAN_LOG, LOG.join('\n') + '\nFATAL ' + e.message); process.exit(1); });
