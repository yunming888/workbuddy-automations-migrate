// 抓取头条后台「评论管理 / 全部」的评论，UTF-8 落盘
// 用法: node _get_comments.js
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');

(async () => {
  const b = await launchBrowser();
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  await ctx.addCookies(JSON.parse(fs.readFileSync('toutiao_cookies.json', 'utf-8')));
  await page.goto('https://mp.toutiao.com/profile_v4/manage/comment/all', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(7000);

  const data = await page.evaluate(() => {
    const root = document.querySelector('.all-comment-v2') || document.body;
    // 每条评论卡片：含"回复"文本且带时间戳
    const cards = [...root.querySelectorAll('div,li')].filter(e => {
      const t = e.innerText || '';
      return t.includes('回复') && /\d+\s*(秒|分钟|小时|天)前|\d{2}-\d{2}\s+\d{2}:\d{2}|\d{4}-\d{2}-\d{2}/.test(t) && t.length < 1200;
    });
    const seen = new Set(); const out = [];
    for (const c of cards) {
      const t = (c.innerText || '').replace(/\n{2,}/g, '\n').trim();
      const key = t.slice(0, 40);
      if (seen.has(key) || t.length < 15) continue;
      seen.add(key);
      out.push(t);
    }
    return { rootText: (document.body.innerText || '').slice(0, 400), cards: out };
  });

  fs.writeFileSync('debug/comments_raw.json', JSON.stringify(data, null, 2), 'utf-8');
  let md = '# 后台评论管理 / 全部\n\n抓到 ' + data.cards.length + ' 条\n\n';
  data.cards.forEach((c, i) => {
    md += '## #' + (i + 1) + '\n\n' + c + '\n\n---\n\n';
  });
  fs.writeFileSync('debug/comments_raw.md', md, 'utf-8');
  console.log('CARDS=' + data.cards.length);
  await Promise.race([b.close(), new Promise(r => setTimeout(r, 5000))]);
  process.exit(0);
})().catch(e => { console.log('FATAL', e.message.slice(0, 200)); process.exit(7); });
