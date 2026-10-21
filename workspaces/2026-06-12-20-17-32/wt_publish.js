// [PIPELINE v3.3] 当前版本 3.3（2026-09-08）— 版本记录见 CHANGELOG.md，单一来源见 version.js
// wt_publish.js — 发布一条头条号微头条（原创，带活动话题）。前台运行。
// 用法: node wt_publish.js <content_md> [TOPIC]
// [PUSH v2.2] 外部调用模式（后台推送转发器 push_relay.js 专用）：
//   WT_SLOT=p1 WT_TYPE=wt_push WT_DATE=2026-09-06 node wt_publish.js <md> '#上头条 聊热点#'
//   推送内容的文件名不遵循 *_YYYY-MM-DD_am|pm.md，无法用 ledger._normName 解析，
//   故显式传入 date/slot/type：slot 用 p1..pN 支持一天多条，type='wt_push' 与定时任务
//   的 'wt' 完全隔离 —— 台账、in-progress 锁、每日同内容闸全部按 type 分开算，互不踩踏。
const fs = require('fs');
// v3.6（2026-10-17）：改从 pw_launch 取 chromium（同 auto_publish.js），不再依赖 NODE_PATH 写对。
const { chromium } = require('./pw_launch.js');
const ledger = require('./ledger.js');
const COOKIE_FILE = 'toutiao_cookies.json';
const LOG = [];
function L(...a){ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log('[WT]', s); }
fs.mkdirSync('debug', { recursive: true });
const contentFile = process.argv[2];
let topic = process.argv[3] || '#上头条 聊热点#';
if(!contentFile){ L('NO_CONTENT_FILE'); process.exit(2); }

// === 硬去重闸门（台账级，确定性，不依赖 LLM）===
// 台账已存在该 (date,slot) 微头条记录则跳过；FORCE 不绕过，仅 REPUBLISH=1 放行。
// WT_TYPE：'wt'=定时任务（am/pm 常规微头条），'wt_push'=后台推送转发（p1..pN）。两者台账独立。
const WT_TYPE = process.env.WT_TYPE || 'wt';
const _meta = process.env.WT_SLOT
  ? { date: process.env.WT_DATE || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
      slot: String(process.env.WT_SLOT).toLowerCase() }
  : ledger._normName(contentFile);
// 2026-08-29 加固：文件名解析失败时拒绝发布，避免硬闸门/in-progress 锁静默失效导致重复发。
if(!_meta){
  L('FATAL_BAD_FILENAME 无法从文件名解析 date/slot，拒绝在硬闸门失效状态下发布。file=', contentFile,
    ' 期望形如 *_20260829_am.md 或 *_2026-08-29_am.md');
  process.exit(2);
}
if(process.env.REPUBLISH!=='1' && ledger.ledgerHas(_meta.date, _meta.slot, WT_TYPE)){
  L('LEDGER_SKIP_WT date=', _meta.date, 'slot=', _meta.slot);
  process.exit(0);
}
// 发布进行中锁（2026-08-27 治本加固，防并发双发）
// 锁文件按 type 分开：推送转发与定时任务可并行运行而不互相误判为「重复发布中」
const INPROG_FILE_WT = 'publish_inprogress_' + WT_TYPE + '.json';
function isAliveWt(pid){ try { process.kill(pid,0); return true; } catch(e){ return false; } }
if(_meta && process.env.REPUBLISH!=='1'){
  try {
    let cur=null; try { cur = JSON.parse(fs.readFileSync(INPROG_FILE_WT,'utf-8')); } catch(e){}
    if(cur && cur.date===_meta.date && cur.slot===_meta.slot){
      const ttlOk = (Date.now() - (cur.ts||0)) < 15*60*1000;
      if(isAliveWt(cur.pid) || !ttlOk){
        if(ttlOk){ L('INPROGRESS_SKIP_WT pid=', cur.pid); process.exit(0); }
        else { L('INPROGRESS_STALE_WT 过期占位，覆盖'); }
      }
    }
    fs.writeFileSync(INPROG_FILE_WT, JSON.stringify({ date:_meta.date, slot:_meta.slot, pid:process.pid, ts:Date.now() }));
  } catch(e){ L('inprog_err_wt', e.message.slice(0,40)); }
}
process.on('exit', () => { try { if(fs.existsSync(INPROG_FILE_WT)){ const c=JSON.parse(fs.readFileSync(INPROG_FILE_WT,'utf-8')); if(c && c.pid===process.pid) fs.unlinkSync(INPROG_FILE_WT); } } catch(e){} });

// === 当日同内容硬闸（2026-08-26 加固）===
// 即便 REPUBLISH=1 / SKIP_DEDUP=1，只要“今天(北京时间)已发过完全相同内容”就跳过；仅 FORCE_REPUBLISH=1 放行。
(function(){
  const dg = require('./dedup_guard.js');
  let raw = '';
  try { raw = fs.readFileSync(contentFile,'utf-8').trim(); } catch(e){ return; }
  let body = raw;
  if(/^#\s+/.test(raw.split('\n')[0])) body = raw.split('\n').slice(1).join('\n').trim();
  const text = (body + '\n' + topic).replace(/\n{3,}/g,'\n\n').trim();
  const curHash = dg._fpHash(text);
  let published = [];
  try { published = JSON.parse(fs.readFileSync('published_fingerprints.json','utf-8')); } catch(e){ published = []; }
  const bj = iso => { const t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? '' : new Date(t + 8*3600*1000).toISOString().slice(0,10); };
  const today = bj(new Date().toISOString());
  const dup = published.find(p => (p.hash||'')===curHash && bj(p.time||'')===today);
  if(dup){
    if(process.env.FORCE_REPUBLISH==='1'){ L('TODAY_SAME_CONTENT_OVERRIDE_WT'); }
    else { L('TODAY_SAME_CONTENT_SKIP_WT already_sent_today=', today); process.exit(0); }
  }
})();

(async () => {
  let raw = fs.readFileSync(contentFile,'utf-8').trim();
  // 去掉可能的第一行标题(# 开头) 作为正文
  let body = raw;
  if(/^#\s+/.test(raw.split('\n')[0])) body = raw.split('\n').slice(1).join('\n').trim();
  const text = (body + '\n' + topic).replace(/\n{3,}/g,'\n\n').trim();
  L('content_len=', text.length, 'topic=', topic);

  // 沙箱中 playwright 原生 chromium.launch() 会因 pipe 握手挂死，改用 pw_launch 外部 spawn + connectOverCDP
  const { launchBrowser } = require('./pw_launch.js');
  const browser = await launchBrowser();
  const ctx = browser.contexts()[0];
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); } catch(e){}
    window.chrome = { runtime:{}, loadTimes:()=>{}, csi:()=>{} };
    Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
    Object.defineProperty(navigator,'languages',{get:()=>['zh-CN','zh','en']});
  });
  const page = await ctx.newPage();
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE,'utf-8'));
  await ctx.addCookies(cookies);

  L('goto weitoutiao/publish');
  await page.goto('https://mp.toutiao.com/profile_v4/weitoutiao/publish', { waitUntil:'commit', timeout:30000 });
  await page.waitForTimeout(4000);
  L('url=', page.url().slice(0,80));
  // 2026-09-08 加固：轮询等编辑框渲染（SPA 加载慢时固定 4s 不够，连续 NO_EDITABLE 假失败）
  let _ec = 0;
  for(let _i=0; _i<12; _i++){
    _ec = await page.locator('[contenteditable="true"]').count();
    if(_ec > 0) break;
    await page.waitForTimeout(2000);
  }
  L('editable_poll_count=', _ec);

  // === 话题面板挂载（2026-09-07）：点工具栏「话题」→ 搜索 → 选中候选 ===
  // 背景：微头条工具栏含「话题」按钮（图片/表情/视频/话题/添加更多），点开是搜索面板
  //   （placeholder="搜索话题"），必须选中才算挂上；正文手打 `#xx#` 仅对部分大话题可被
  //   平台识别（如"#上头条 聊热点#"可挂"创作活动"标记），新账号/小话题常常不识别。
  //   该函数失败时回退到原"末尾追加 #xx#"兜底。
  async function attachTopicViaPanel(page, topicTag){
    const name = (topicTag||'').replace(/^#|#$/g,'').trim();
    if(!name) return false;
    try {
      // 1) 点工具栏「话题」按钮
      //    2026-09-08 实测：该按钮（button.syl-toolbar-button）常被工具栏遮挡，
      //    Playwright click 会超时；JS .click() 不受遮挡影响且能正常开面板。
      //    故 JS 优先、Playwright 兜底。
      let clicked = await page.evaluate(()=>{
        const c = [...document.querySelectorAll('span,div,button')]
          .filter(e => (e.textContent||'').trim()==='话题' && e.children.length<=2 && (e.offsetParent||e.getBoundingClientRect().width));
        if(!c.length) return false;
        c[c.length-1].click();
        return true;
      });
      if(!clicked){
        const topicBtn = page.locator('span,div,button').filter({ hasText: /^话题$/ }).last();
        if(await topicBtn.count() > 0){
          clicked = await topicBtn.click({ timeout: 6000 }).then(()=>true).catch(e=>{ L('TOPIC_BTN_CLICK_WARN', e.message.slice(0,60)); return false; });
        }
      }
      if(!clicked){ L('TOPIC_BTN_NOT_FOUND'); return false; }
      await page.waitForTimeout(2500);

      // 2) 搜索框输入关键词
      //    🚨核心修复（2026-09-08）：旧代码用 `e.value = name` + 合成 dispatchEvent，
      //    Vue 监听的是原生 input 事件链路，合成事件经常收不到 → 面板始终无候选
      //    → 连续多次降级 TOPIC_FALLBACK_TEXT。改为 Playwright 真实键盘逐字输入。
      const input = page.locator('input[placeholder*="搜索话题"], textarea[placeholder*="搜索话题"]').first();
      let typed = false;
      if(await input.count() > 0){
        await input.click({ timeout: 6000 }).catch(()=>{});
        await input.fill('').catch(()=>{});
        typed = await input.type(name, { delay: 110 }).then(()=>true).catch(async (e)=>{
          L('TOPIC_TYPE_WARN', e.message.slice(0,60));
          return await input.fill(name).then(()=>true).catch(()=>false);
        });
        if(typed) L('TOPIC_TYPED_REAL_KEYS');
      }
      if(!typed){
        // 兜底：回到旧的 JS 赋值路径
        const r = await page.evaluate((name)=>{
          const ins = [...document.querySelectorAll('input,textarea')]
            .filter(e => /搜索话题/.test(e.getAttribute('placeholder')||'') && (e.offsetParent||e.getBoundingClientRect().width));
          if(!ins.length) return null;
          const e = ins[0];
          e.focus(); e.value = name;
          e.dispatchEvent(new Event('input',{bubbles:true}));
          e.dispatchEvent(new Event('compositionend',{bubbles:true}));
          e.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }, name);
        if(r!==true){ L('TOPIC_INPUT_NOT_FOUND'); return false; }
        L('TOPIC_TYPED_JS_FALLBACK');
      }
      await page.waitForTimeout(4000);

      // 3) 选第一个含 name 的候选（同时给出讨论数便于复核）
      let picked = null;
      const cand = page.locator('li, [role=option], [class*=topic-item], [class*=topicItem]').filter({ hasText: name }).first();
      if(await cand.count() > 0){
        const tx = (await cand.innerText().catch(()=> '') || '').replace(/[ \t]+/g,' ').slice(0,120);
        const ok = await cand.click({ timeout: 6000 }).then(()=>true).catch(e=>{ L('TOPIC_CAND_CLICK_WARN', e.message.slice(0,60)); return false; });
        if(ok) picked = tx;
      }
      if(!picked){
        picked = await page.evaluate((name)=>{
          const sel = ['[class*=modal] li', '[class*=panel] li', '[class*=list] li', '[role=option]', '[class*=topic]:not(.icon)'];
          for(const s of sel){
            const cands = [...document.querySelectorAll(s)];
            for(const c of cands){
              const tx = (c.innerText||'').replace(/[ \t]+/g,' ');
              if(tx.includes(name) && tx.length < 200){
                c.click();
                return tx.slice(0,80);
              }
            }
          }
          return null;
        }, name);
      }
      if(picked) L('TOPIC_PICKED=' + picked);
      else L('TOPIC_CAND_NOT_FOUND');
      await page.waitForTimeout(1500);

      // 4) 最终判定：不靠「点没点到候选」，直接看话题标签有没有真的出现在内容里
      //    2026-09-08 实测：候选 DOM 是自绘虚拟列表，li/[role=option] 全选不中，
      //    但输入后话题确实挂上了（页面出现 `#上头条 聊热点# 755万讨论`）。
      //    旧逻辑只认「点中候选」，导致明明挂上了却报 CAND_NOT_FOUND → 白走 fallback。
      //    🚨2026-09-08 pm 二次修复：先关掉话题面板再判定 —— 面板开着时其「推荐话题卡」
      //    本身就含 `#话题名#`，page 级匹配会把推荐卡误判成"已挂上"（pm 原创微头条
      //    就这样漏挂了活动标签）。Esc 关面板 + 焦点回编辑区，再验；且 page 级只在
      //    搜索框不可见时采信，验不过就走文本兜底（兜底文本已被 am2 实证能亮创作活动徽章）。
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(1200);
      await page.evaluate(()=>{ const ed=document.querySelector('[contenteditable="true"]'); if(ed) ed.focus(); });
      await page.waitForTimeout(800);
      const attached = await page.evaluate((nm)=>{
        const esc = nm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const re = new RegExp('#\\s*' + esc + '\\s*#');
        const ed = document.querySelector('[contenteditable="true"]');
        if(ed && re.test(ed.innerText || '')) return 'body';
        const searchVisible = [...document.querySelectorAll('input,textarea')]
          .some(e => /搜索话题/.test(e.getAttribute('placeholder')||'') && (e.offsetParent||e.getBoundingClientRect().width));
        if(!searchVisible && re.test(document.body.innerText || '')) return 'page';
        return null;
      }, name);
      if(attached){ L('TOPIC_ATTACHED_VERIFIED=' + attached); return true; }
      return false;
    } catch(e){
      L('TOPIC_PANEL_ERR', e.message.slice(0,80));
      return false;
    }
  }

  // 定位正文编辑区 (contenteditable)
  const editable = page.locator('[contenteditable="true"]').first();
  const ec = await editable.count();
  L('contenteditable_count=', ec);
  if(ec===0){ L('NO_EDITABLE'); await page.screenshot({path:'debug/wt_fail.png'}); fs.writeFileSync('debug/wt_publish.log',LOG.join('\n')); await browser.close(); process.exit(3); }
  const box = await editable.boundingBox().catch(()=>null);
  L('edit_box='+JSON.stringify(box));
  if(box){ await page.mouse.click(box.x + box.width/2, box.y + Math.min(box.height/2, 50)); }
  else { await editable.click({ force:true, timeout:8000 }).catch(e=>L('CLICK_EDIT_WARN', e.message.slice(0,60))); }
  await page.waitForTimeout(600);
  // 清空可能存在的占位/旧内容
  await page.keyboard.press('Control+A').catch(()=>{});
  await page.keyboard.press('Delete').catch(()=>{});
  await page.waitForTimeout(300);
  // 输入正文：优先 fill（触发 input 事件），失败回退 focus+键入
  // 2026-09-07：fill 用纯正文（不含末尾 #xx#），话题由下方 attachTopicViaPanel 单独挂载。
  //   失败兜底：把 `\n#xx#` 追加到末尾（旧行为保留）。
  const plainBody = body.replace(/\n{3,}/g,'\n\n').trim();
  try {
    await editable.fill(plainBody);
    L('FILL_OK plainBody_len=', plainBody.length);
  } catch(e){
    L('FILL_FAIL', e.message.slice(0,80));
    await editable.focus().catch(()=>{});
    await page.waitForTimeout(300);
    await page.keyboard.type(plainBody, { delay: 20 });
    L('TYPE_FALLBACK');
  }
  await page.waitForTimeout(1200);

  // === 挂载话题（2026-09-07 新增）===
  const topicOk = await attachTopicViaPanel(page, topic);
  if(topicOk){ L('TOPIC_PANEL_OK'); }
  else {
    L('TOPIC_FALLBACK_TEXT');
    await editable.focus().catch(()=>{});
    await page.keyboard.press('Control+End').catch(()=>{});
    await page.keyboard.type('\n' + topic, { delay: 30 }).catch(e=>L('topic_type_err', e.message.slice(0,60)));
    await page.waitForTimeout(800);
  }
  const charCount = await page.evaluate(()=>{
    const m = document.body.innerText.match(/正文字数[:：]\s*(\d+)/);
    return m? m[1] : '?';
  });
  L('after_type charCount=', charCount);

  // 点击发布
  const pubBtn = page.getByRole('button', { name: /^发布$/ }).first();
  const pc = await pubBtn.count();
  L('publish_btn_count=', pc);
  if(pc===0){ L('NO_PUBLISH_BTN'); await page.screenshot({path:'debug/wt_fail.png'}); fs.writeFileSync('debug/wt_publish.log',LOG.join('\n')); await browser.close(); process.exit(4); }
  await pubBtn.click({ timeout:8000 }).catch(e=>L('PUB_CLICK_WARN', e.message.slice(0,60)));

  // 真发布校验：以"编辑框清空(占位符出现/字数0/正文为空)"为唯一可靠信号。
  // toast 可能是草稿自动保存或陈旧提示，不可信 —— 旧逻辑据此误判成功、却未真发布、还错登台账/指纹。
  let realClear = false;
  for(let pi=0; pi<6; pi++){
    await page.waitForTimeout(2000);
    // 发布后可能弹确认框，先处理
    try {
      const confirmBtn = page.getByRole('button', { name: /确认发布|确定/ }).first();
      if(await confirmBtn.count()){ await confirmBtn.click({timeout:5000}); L('CONFIRM_CLICKED'+pi); }
    } catch(e){}
    const st = await page.evaluate(()=>{
      const t = document.body.innerText;
      const toast = /发布成功|发布完成|已发布/.test(t);
      const editableTxt = ((document.querySelector('[contenteditable="true"]')||{innerText:''}).innerText||'').trim();
      const cleared = /正文字数[:：]\s*0/.test(t) || /有什么新鲜事想告诉大家/.test(t) || editableTxt.length===0;
      const urlOk = !/weitoutiao\/publish/.test(location.href);
      const publishedState = /已发布|发布成功|内容已提交|审核中/.test(t);
      return { toast, cleared, editableLen: editableTxt.length, urlOk, publishedState };
    });
    L('CHECK'+pi+'='+JSON.stringify(st));
    // 成功信号放宽：编辑框清空 或 页面出现"已发布"态 或 已跳离发布页 —— 任一即判真发布，杜绝双向误判
    if(st.cleared || st.publishedState || st.urlOk){ realClear = true; break; }
  }
  L('REAL_CLEAR=', realClear);
  if(realClear && _meta){
    const wtTitle = (raw.split('\n').find(l=>l.trim())||'').replace(/^#\s+/,'').trim().slice(0,60);
    ledger.ledgerAdd(_meta.date, _meta.slot, WT_TYPE, { title: wtTitle, file: contentFile, topic_tag: topic, type: WT_TYPE,
      src: process.env.WT_TYPE === 'wt_push' ? 'push_relay' : 'schedule' });
    // 登记内容指纹，使"当日同内容硬闸"对微头条也生效（修复仅 ledger 挡、SKIP_DEDUP 可绕的漏洞）
    require('./dedup_guard.js').record(wtTitle, text);
    L('LEDGER_FP_WRITTEN');
    fs.writeFileSync('debug/wt_publish.log', LOG.join('\n'));
    await Promise.race([browser.close(), new Promise(r=>setTimeout(r,5000))]);
    L('DONE ok=true');
    process.exit(0);
  } else {
    L('PUB_FAIL_NOT_CLEARED no ledger/fp written');
    await page.screenshot({path:'debug/wt_fail.png'});
    fs.writeFileSync('debug/wt_publish.log', LOG.join('\n'));
    await Promise.race([browser.close(), new Promise(r=>setTimeout(r,5000))]);
    process.exit(5);
  }
})().catch(e=>{ L('FATAL', e.message.slice(0,200)); fs.writeFileSync('debug/wt_publish.log', LOG.join('\n')); process.exit(7); });
