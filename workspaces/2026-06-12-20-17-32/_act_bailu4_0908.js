// 2026-09-08 第六轮：点开「作者成长助手」会话，找白露消息里的活动入口按钮/链接
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
    if (t.length > 1200) break;
  }
  return best;
}

const grabAll = async (p, tag) => {
  const res = await p.evaluate(() => {
    const out = [];
    // 1) 所有 a[href]
    document.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (h && /activity|log_pb|magic|huodong|topic|event/i.test(h)) out.push('A ' + h.slice(0, 500)); });
    // 2) 全局 html 中 release/log_pb 链接
    const html = document.documentElement.outerHTML || '';
    const re = /https?:[^"'\\\s]{10,500}/g; let m;
    while ((m = re.exec(html)) && out.length < 60) {
      const s = m[0].replace(/\\\//g, '/');
      if (/api\.toutiaoapi\.com|magic\/eco|activity|log_pb/.test(s)) out.push('H ' + s.slice(0, 500));
    }
    // 3) 含「参与/打卡/瓜分/白露」的可点元素文本
    document.querySelectorAll('div,span,button,a').forEach(e => {
      const t = (e.innerText || '').trim();
      if (t && t.length < 60 && /参与活动|去参与|打卡|立即参加|马上参与|查看详情|白露|点击参与/.test(t)) out.push('T ' + e.tagName + ' ' + t);
    });
    return [...new Set(out)].slice(0, 80);
  }).catch(() => []);
  for (const r of res) L('[' + tag + '] ' + r);
};

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
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 2000)); await page.waitForTimeout(1200); }

  // 点「作者成长助手」会话行
  try {
    const row = page.locator('.conversation-box', { hasText: '作者成长助手' }).first();
    await row.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await row.click({ timeout: 8000 });
    L('CONV_CLICKED');
  } catch (e) { L('CONV_CLICK_ERR ' + e.message.slice(0, 200)); }
  await page.waitForTimeout(8000);
  L('AFTER_CONV_URL=' + page.url());
  await grabAll(page, 'conv');

  const txt = await page.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
  // 找会话详情里白露相关新文本
  const idx = txt.indexOf('白露');
  if (idx >= 0) L('CONV_TEXT_AROUND=' + txt.slice(Math.max(0, idx - 100), idx + 1200));
  await page.screenshot({ path: 'debug/bailu_conv_2026-09-08.png', fullPage: false }).catch(() => {});

  // 尝试点击会话里的「点击参与活动/去参与」类按钮
  for (const kw of ['点击参与活动', '去参与', '参与活动', '打卡', '查看详情']) {
    try {
      const btn = page.locator('text=' + kw).first();
      if (await btn.count().catch(() => 0) > 0) {
        await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await btn.click({ timeout: 5000 }).catch(() => {});
        L('BTN_CLICKED=' + kw);
        await page.waitForTimeout(8000);
        break;
      }
    } catch (e) { L('BTN_ERR ' + kw + ' ' + e.message.slice(0, 120)); }
  }
  L('FINAL_URL=' + page.url());
  await grabAll(page, 'final');
  for (const p of opened) {
    try {
      await p.waitForTimeout(6000);
      L('=== OPENED ' + p.url());
      const tt = await p.evaluate(() => (document.body.innerText || '').replace(/[ \t]+/g, ' ')).catch(() => '');
      if (/规则|瓜分|参与|红包|活动|打卡|发布/.test(tt)) L(tt.slice(0, 3000));
      await grabAll(p, 'opened');
    } catch (e) { L('OPENED_ERR ' + e.message.slice(0, 150)); }
  }

  fs.writeFileSync('debug/act_bailu4_2026-09-08.log', LOG.join('\n'), 'utf8');
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  console.log('DONE');
  process.exit(0);
})().catch(e => { L('FATAL ' + e.message.slice(0, 200)); try { fs.writeFileSync('debug/act_bailu4_2026-09-08.log', LOG.join('\n'), 'utf8'); } catch (x) {} process.exit(7); });
