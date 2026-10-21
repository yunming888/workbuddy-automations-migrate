// delete_dupes.js — 删除头条后台“全部内容”里指定标题的重复篇（保留 KEEP 篇，删 DEL 篇）。
// 2026-08-26 修正：用 Playwright 真实点击（locator.click），不再用 page.evaluate 的 JS click，React 受控组件才能响应。
const fs = require('fs');
const { launchBrowser } = require('./pw_launch.js');
// 2026-08-28 参数化：由环境变量传入，避免每次硬改代码；默认行为保持与原验证版一致。
//   TITLE=标题 DEL=删除几篇 KEEP=保留几篇 SKIP_GENERATED=1(跳过"由文章生成"微头条, 只删图文)
const COOKIE_FILE = 'toutiao_cookies.json';
const TITLE = process.env.TITLE || 'AI啥都会，唯独抄不走你这一样：读这本就懂';
const KEEP = parseInt(process.env.KEEP || '1', 10);
const DEL = parseInt(process.env.DEL || '2', 10);
const SKIP_GENERATED = process.env.SKIP_GENERATED === '1';
const LOG = [];
const L = (...a)=>{ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log(s); };

(async()=>{
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE,'utf-8'));
  await ctx.addCookies(cookies);
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all', { waitUntil:'domcontentloaded', timeout:40000 });
  for(let w=0;w<12;w++){
    await page.waitForTimeout(2500);
    const n = await page.evaluate(()=>document.body.innerText.length).catch(()=>0);
    const hit = await page.evaluate((t)=>document.body.innerText.includes(t), TITLE).catch(()=>false);
    L('WAIT'+w, 'bodyLen='+n, 'hasTitle='+hit);
    if(hit) break;
  }
  const dbg = await page.evaluate(()=>({url:location.href, len:document.body.innerText.length, head:document.body.innerText.slice(0,300)})).catch(()=>({url:'ERR'}));
  L('DIAG', JSON.stringify(dbg));
  await page.screenshot({path:'debug/del_before.png', fullPage:true});

  // 统计：SKIP_GENERATED=1 时只算"图文"(含"已发布"且不含"由文章生成")，避免误删平台自动生成的微头条
  const countTitle = async () => page.evaluate(({t, skip}) => {
    const cards = [...document.querySelectorAll('div,li,article,section')]
      .filter(e => (e.innerText||'').includes(t) && (e.innerText||'').includes('更多'));
    let n = 0; let seen = new Set();
    for(const c of cards){
      const txt = c.innerText||'';
      if(skip && (txt.includes('由文章生成') || !txt.includes('已发布'))) continue;
      // 去重：外層容器与内层会重复计数，取最内层卡片
      const key = (c.innerText||'').slice(0,120);
      if(seen.has(key)) continue;
      seen.add(key); n++;
    }
    return n;
  }, {t: TITLE, skip: SKIP_GENERATED});
  L('before_count=', await countTitle(), 'skipGenerated=', SKIP_GENERATED);

  let deleted = 0;
  for(let i=0;i<DEL;i++){
    try{
      // 找到包含目标标题和“更多”按钮的卡片；SKIP_GENERATED 时只取图文(含"已发布"、不含"由文章生成")
      let cards = page.locator('div,li,article,section').filter({ hasText: TITLE }).filter({ hasText: '更多' });
      if(SKIP_GENERATED) cards = cards.filter({ hasNotText: '由文章生成' }).filter({ hasText: '已发布' });
      const card = cards.first();
      if(!await card.count()){ L('step'+i+' NO_CARD'); break; }
      const more = card.locator('button,span,a,[role="button"]').filter({ hasText: /^更多$/ }).first();
      if(!await more.count()){ L('step'+i+' NO_MORE'); break; }
      await more.scrollIntoViewIfNeeded();
      await more.click({force:true, timeout:5000});
      L('step'+i+' more=CLICKED');
      await page.waitForTimeout(1200);

      // 下拉菜单里的“删除作品”（在 body 下的 portal 里，通常外层是 div/li；点外层容器更稳）
      const delMenu = page.locator('div,li').filter({ hasText: /^删除作品$/ }).first();
      const delItems = page.locator('button,span,a,[role="menuitem"]').filter({ hasText: /删除作品/ });
      if(await delMenu.count()){
        await delMenu.click({force:true, timeout:5000});
        L('step'+i+' del=CLICKED_MENU');
      } else if(await delItems.count()){
        await delItems.first().click({force:true, timeout:5000});
        L('step'+i+' del=CLICKED_ITEM');
      } else { L('step'+i+' del=NO_DEL_ITEM'); }
      await page.waitForTimeout(1500);
      await page.screenshot({path:'debug/del_step'+i+'.png'});

      // 确认弹窗
      const confirm = page.locator('button,[role="button"]').filter({ hasText: /^(确定|删除|确认|确认删除)$/ }).first();
      if(!await confirm.count()){ L('step'+i+' confirm=NO_CONFIRM'); }
      else {
        await confirm.click({force:true, timeout:5000});
        L('step'+i+' confirm=CLICKED');
      }
      await page.waitForTimeout(3000);
      await page.screenshot({path:'debug/del_after'+i+'.png', fullPage:true});
      deleted++;
      await page.reload({ waitUntil:'commit' }).catch(()=>{});
      await page.waitForTimeout(3000);
      L('step'+i+' after_count=', await countTitle());
    }catch(e){ L('step'+i+' ERR', e.message.slice(0,120)); }
  }
  L('DELETED=', deleted, 'KEEP=', KEEP);
  fs.writeFileSync('debug/delete_dupes.log', LOG.join('\n'));
  await Promise.race([browser.close(), new Promise(r=>setTimeout(r,5000))]);
  L('DONE');
  process.exit(0);
})().catch(e=>{ L('FATAL', e.message.slice(0,200)); fs.writeFileSync('debug/delete_dupes.log', LOG.join('\n')); process.exit(7); });
