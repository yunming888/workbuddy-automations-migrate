
// [PIPELINE v3.3] 当前版本 3.3（2026-09-08）— 版本记录见 CHANGELOG.md，单一来源见 version.js
const fs = require('fs');
// v3.6（2026-10-17）：改从 pw_launch 取 chromium —— 原先直接 require('playwright') 依赖 NODE_PATH
// 写对，而三档 prompt 里写的 NODE_PATH 目录在本机并不存在，会在第 4 行直接 MODULE_NOT_FOUND。
// pw_launch v1.2 会在常规解析失败时自动定位 playwright，行为不变、向后兼容。
const { chromium } = require('./pw_launch.js');
const ledger = require('./ledger.js');

const COOKIE_FILE = 'toutiao_cookies.json';
// 参数约定：
//   推荐：node auto_publish.js <md文件路径>
//   兼容：node auto_publish.js <标题> <md文件路径>（旧双参数调用）
let TITLE, CONTENT_FILE;
if (process.argv[3]) {
  // 旧双参数兼容
  TITLE = process.argv[2];
  CONTENT_FILE = process.argv[3];
} else {
  CONTENT_FILE = process.argv[2] || 'toutiao_article_001_fengkou.md';
}
const COVER_FILE = process.env.COVER || 'cover.png'; // 封面文件可配置：COVER=xxx.png 调 gen_covers.py 生成后传入
const LOG = [];
function L(...a){ const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '); LOG.push(s); console.log(s); }

function clean(md){
  let s = md;
  const cut = s.indexOf('写在最后');
  if(cut>0) s = s.slice(0, cut);
  // 🚨 2026-09-07：头条图文发布页无「话题」组件，正文里手打 `#xx#` 是纯文本、永不点亮。
  //   显式把井号话题标签替换为纯文本，避免无效占位、避免读者误以为点了能跳转；
  //   关键词仍保留，由算法语义识别归属。匹配规则：井号前后为空白/标点/行首行尾（中文标点全覆盖）。
  s = s.replace(/(?<=^|[\s\u3000：：，,。!?;；、\n])#([^#\n]{1,30})#(?=$|[\s\u3000：：，,。!?;；、\n])/gm, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g,'')
       .replace(/【IMG[^\]]*】/g,'')
       .replace(/【PRODUCT[^\]]*】/g,'')
       .replace(/^#{1,6}\s+/gm,'')
       .replace(/\*\*([^*]+)\*\*/g,'$1')
       .replace(/^\s*[-*]\s+/gm,'')
       .replace(/<[^>]+>/g,'')
       .replace(/\n{3,}/g,'\n\n')
       .trim();
  return s;
}

const TITLE_SEL = 'textarea[placeholder*="标题"]';
const EDITOR = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const LOGIN  = 'https://mp.toutiao.com/auth/page/login?redirect_url=JTJGcHJvZmlsZV92NCUyRmdyYXBoWMlMkZwdWJsaXNo';

// === 发布进行中锁 + 原子登记（2026-08-27 治本加固，彻底杜绝重复发）===
// 根因：此前发布动作(点确认发布)无条件执行，成功判定只决定"是否记录"不决定"是否发布"。
//       一旦成功判定假阴性→已发布却没记录→下次运行又点发布→重复(8/27 凌晨 4 篇)。
// 修复：①启动即原子占位 in-progress 锁，结束/异常均清理，挡并发/二次确认循环；
//      ②在"真正点确认发布"那一刻**立即**原子登记 ledger+lock+指纹(幂等)，
//        而非等抓到 code:0 才记——同一篇只要点过一次，台账立刻认领，后续重试全被 LEDGER_SKIP 拦住。
const INPROG_FILE = 'publish_inprogress.json';
function isAlive(pid){ try { process.kill(pid,0); return true; } catch(e){ return false; } }
// 原子写锁文件（同目录 .tmp → rename）
function _writeInprog(obj){
  const tmp = INPROG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
  fs.renameSync(tmp, INPROG_FILE);
}
function claimInProgress(date, slot){
  // 2026-09-06 加固：原实现 `catch(e){}` 静默吞掉「锁文件损坏/不可读」，
  // 于是 cur=null → 直接覆盖别人的锁 → 并发双发。现在严格区分：
  //   文件不存在 = 无占位（正常）；读失败/解析失败 = 并发状态不可知 → fail-loud 拒绝发布。
  let cur = null;
  try {
    cur = JSON.parse(fs.readFileSync(INPROG_FILE, 'utf-8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error('[INPROG_FAIL_LOUD] 锁文件不可读/损坏，并发闸门状态未知，拒绝发布：' + String(e.message || '').slice(0, 120));
      return false; // 宁可不发，也不冒重复发的风险
    }
  }
  try {
    // 同 date/slot 且有存活占位(或过期占位)→ 跳过；加 15 分钟 TTL 防僵尸锁(Windows 上 pid 存活检测不可靠)
    if(cur && cur.date===date && cur.slot===slot){
      const ttlOk = (Date.now() - (cur.ts||0)) < 15*60*1000;
      if(isAlive(cur.pid) || !ttlOk){
        if(ttlOk){ console.log('[INPROGRESS_SKIP] pid=', cur.pid, 'date=', cur.date, 'slot=', cur.slot); return false; }
        else { console.log('[INPROGRESS_STALE] 过期占位，覆盖 date=', cur.date, 'slot=', cur.slot); }
      }
    }
    _writeInprog({ date, slot, pid: process.pid, ts: Date.now() });
    return true;
  } catch(e){
    // 占位失败同样拒绝发布（无法保证并发互斥）
    console.error('[INPROG_FAIL_LOUD] 占位失败，拒绝发布：' + String(e.message || '').slice(0, 120));
    return false;
  }
}
function releaseInProgress(){
  try { if(fs.existsSync(INPROG_FILE)){ const c=JSON.parse(fs.readFileSync(INPROG_FILE,'utf-8')); if(c && c.pid===process.pid) fs.unlinkSync(INPROG_FILE); } }
  catch(e){ console.error('[INPROG_RELEASE_WARN] 清理锁失败（有 15 分钟 TTL 兜底，但请检查）：' + String(e.message||'').slice(0,120)); }
}
process.on('exit', releaseInProgress);
// 原子登记：点确认发布后立即调用，幂等(ledgerAdd/record 内部已去重)。
function markPublishedNow(title, date, slot, contentFile, topic){
  try { fs.writeFileSync('published.lock', 'title='+title+'\ntime='+new Date().toISOString()+'\nstatus=published\n'); console.log('[LOCK_WRITTEN_NOW]'); } catch(e){ console.log('[lock_err]', e.message.slice(0,40)); }
  require('./dedup_guard.js').record(title, '');
  ledger.ledgerAdd(date, slot, 'art', { title, file: contentFile, topic: topic||'', type:'art' });
  console.log('[LEDGER_WRITTEN_NOW] date=', date, 'slot=', slot);
}

(async () => {
  // 幂等保护：已发布过同一篇则跳过，避免重复发布（FORCE=1 可强制重发）
  const LOCK_FILE = 'published.lock';
  if(process.env.FORCE!=='1' && fs.existsSync(LOCK_FILE)){
    const lock = fs.readFileSync(LOCK_FILE,'utf-8');
    const lt = (lock.match(/title=(.*)/)||[])[1]||'';
    if(lt && lt===TITLE){ L('ALREADY_PUBLISHED_SKIP title=', TITLE); process.exit(0); }
    else L('LOCK_EXISTS_DIFFERENT_TITLE', lt);
  }
  // === 硬去重闸门（台账级，确定性，不依赖 LLM）===
  // 若台账已存在该 (date,slot) 图文记录，则绝不发布。FORCE=1 不再绕过（避免重复发送）；
  // 仅当显式设置 REPUBLISH=1 时才放行（用于确需对同篇重发的极少数场景）。
  // 2026-09-06：与 wt_publish.js 的 WT_SLOT 对称，支持外部槽位（am/pm 之外的加发档，如 pm2）。
  // 加发档文件名 *_pm2.md 无法被 _normName 的纯字母正则解析，必须显式传 ART_SLOT（+可选 ART_DATE）。
  const _meta = process.env.ART_SLOT
    ? { date: process.env.ART_DATE || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
        slot: String(process.env.ART_SLOT).toLowerCase() }
    : ledger._normName(CONTENT_FILE);
  // 2026-08-29 加固：文件名解析失败时绝不"带病继续跑"。
  // 此前 _meta 为 null 会让台账硬闸门 / in-progress 锁 / 发布后登记 三处 `if(_meta && ...)` 全部静默跳过，
  // 等于"已发布却没登记"，下次重跑必然重复发。现在解析不出 date/slot 直接拒绝发布。
  if(!_meta){
    L('FATAL_BAD_FILENAME 无法从文件名解析 date/slot，拒绝在硬闸门失效状态下发布。file=', CONTENT_FILE,
      ' 期望形如 *_20260829_am.md 或 *_2026-08-29_am.md');
    process.exit(2);
  }
  if(process.env.REPUBLISH!=='1' && ledger.ledgerHas(_meta.date, _meta.slot, 'art')){
    L('LEDGER_SKIP date=', _meta.date, 'slot=', _meta.slot, 'title=', TITLE);
    process.exit(0);
  }
  // 发布进行中锁：挡并发/二次确认循环双发(仅当 _meta 解析成功时)
  if(_meta && process.env.REPUBLISH!=='1'){ if(!claimInProgress(_meta.date, _meta.slot)){ process.exit(0); } }
  const raw = fs.readFileSync(CONTENT_FILE,'utf-8');
  // 若未通过旧双参数传入标题，自动从 md 首行 `# 标题` 提取
  if (!process.argv[3]) {
    const m = raw.match(/^#\s+(.+)$/m);
    TITLE = m ? m[1].trim() : '';
    if (!TITLE) { L('ERR_NO_TITLE_IN_MD file=', CONTENT_FILE); process.exit(1); }
  }
  const body = clean(raw);

  // 内容级去重闸门（逻辑见 dedup_guard.js，与 dedup.py 算法一致；FORCE=1 也拦重复/近似，SKIP_DEDUP=1 可显式覆盖）
  require('./dedup_guard.js').guard(TITLE, body);

  // === 当日同内容硬闸（2026-08-26 加固：杜绝今晚“一次发3条重复”再现）===
  // 即便调用方同时加了 REPUBLISH=1 / SKIP_DEDUP=1，只要“今天(北京时间)已发过完全相同内容(指纹相同)”就直接跳过，
  // 不再依赖人工是否记得关掉绕过参数。仅当显式设置 FORCE_REPUBLISH=1 时才放行（极少用，用于确要重发同篇的明确场景）。
  (function todaySameContentGuard(title, bodyText){
    const dg = require('./dedup_guard.js');
    const curHash = dg._fpHash(title + '\n' + bodyText);
    let published = [];
    // 2026-10-09 修复：损坏/解析失败不再静默吞成空库（旧 catch→published=[] 会让当日同内容闸静默失效、重复发）。
    // 对齐 ledger.js fail-loud 哲学：ENOENT=首启（空库放行）；读失败/解析失败/结构非法=拒绝发布。
    try {
      const _fpRaw = fs.readFileSync('published_fingerprints.json','utf-8');
      const _fpJ = JSON.parse(_fpRaw);
      if (!Array.isArray(_fpJ)) throw new Error('指纹库不是数组：' + typeof _fpJ);
      published = _fpJ;
    } catch (e) {
      if (e && e.code === 'ENOENT') { /* 首启 */ }
      else { L('DEDUP_FAIL_LOUD published_fingerprints.json 损坏或不可读，拒绝在去重闸门失效状态下发布：' + e.message); process.exit(3); }
    }
    const bj = iso => { const t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? '' : new Date(t + 8*3600*1000).toISOString().slice(0,10); };
    const today = bj(new Date().toISOString());
    const dup = published.find(p => (p.hash||'')===curHash && bj(p.time||'')===today);
    if(dup){
      if(process.env.FORCE_REPUBLISH==='1'){ L('TODAY_SAME_CONTENT_OVERRIDE title=', title); }
      else { L('TODAY_SAME_CONTENT_SKIP already_sent_today=', today, 'title=', title); process.exit(0); }
    }
  })(TITLE, body);
  // 正文去掉与标题重复的首段（标题单独填到标题栏，避免正文重复标题）
  let bodyEditor = body;
  if(bodyEditor.startsWith(TITLE)) bodyEditor = bodyEditor.slice(TITLE.length).replace(/^\s*\n+/, '');
  L('body_len=', body.length);

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
  await page.setViewportSize({width:1280,height:900});
  const _api = [];
  const _reqBody = [];
  const _reqSave = [];   // 每条 /article/publish 请求的 save 参数：'1'=草稿保存 '0'=实际发布
  const _reqHeaders = [];
  // 拦截publish POST：完整记录body（不限长度）+ 单独记录headers（用于诊断tt-anti-token是否由SDK自动注入）
  page.on('request', r => { const u=r.url(); const m=r.method(); if(/article\/publish/.test(u) && m==='POST'){ let b=null; try{ b=r.postData(); _reqBody.push(b?b:'(no postData)'); }catch(e){ _reqBody.push('bodyErr:'+e.message.slice(0,80)); } let sv='?'; try{ const mm=(b||'').match(/[?&]save=(\d+)/); sv=mm?mm[1]:'?'; }catch(e){} _reqSave.push(sv); try{ _reqHeaders.push(JSON.stringify(r.headers())); }catch(e2){} } if(/article|publish|post|content|draft|submit/i.test(u)) _api.push({m, u}); });
  const _resp = [];
  // 2026-10-07 根因修复：编辑器 DOM(ProseMirror) 与 autosave 模型失步时，真发布(save=0)请求体 content
  // 会是旧草稿的短正文(实测 33 字)而非当篇正文(实测 1016 字) → 平台回 7050「保存失败」，最终只落成 33 字草稿。
  // 网络层兜底：EXPECTED_BODY_* 在正文输入后填充；route 里对 save=0 请求若 content 明显偏短即注入完整正文并校正 content_word_cnt。
  let EXPECTED_BODY_HTML='';   // 当篇正文 HTML（逐段 <p>…</p> 拼接），供网络层强制注入
  let EXPECTED_BODY_LEN=0;     // 当篇正文字数(去空白)，偏短判定阈值用
  // ---- 提交闸门(2026-08-28 加固) ----
  // 事故：同一次运行点了两次"确认发布"→平台收到 2 篇。原因是二段点击的守卫用 gotOk(依赖 async 响应监听)，
  // 响应体来不及解析时 gotOk=false → 又点一次。现改为：一旦捕获真实发布成功(code:0 且非草稿保存)，
  // 在网络层直接 abort 后续所有 publish 请求，物理阻断第 2 次提交，不再依赖任何内存标志或时序。
  const GATE = { locked:false, okCount:0, blocked:0 };
  const _gateIsDraft = (u, body) => /[?&]save=1(&|$)/.test(u||'') || /[?&]save=1(&|$)/.test(body||'');
  try{
    await page.route('**/mp/agw/article/publish**', async route => {
      const req = route.request();
      let body=''; try{ body = req.postData()||''; }catch(e){}
      if(GATE.locked && !_gateIsDraft(req.url(), body)){
        GATE.blocked++;
        L('[GATE_BLOCKED] 已发布成功, 阻断重复 publish #'+GATE.blocked);
        try{ return await route.abort('blockedbyclient'); }catch(e){ return; }
      }
      // ---- 正文毒化/失步网络层兜底(2026-10-07) ----
      // 编辑器 DOM(ProseMirror) 与 autosave 模型失步时，save=0(真发)与 save=1(草稿保存/实际建卡) 的 content
      // 都可能是旧草稿短正文(实测 33~34 字)。实测这些坏运行里「真正在后台建卡的请求」是 save=1 那条 code:0。
      // 因此对 save=0 与 save=1 都注入：若 content 字数(去标签去空白) < 当篇正文的 50%，强制注入完整正文并校正 content_word_cnt。
      try{
        const sv=(body.match(/[?&]save=(\d+)/)||[])[1];
        if((sv==='0'||sv==='1') && EXPECTED_BODY_LEN>0){
          const curContent=(body.match(/content=([^&]*)/)||[])[1]||'';
          let curText=''; try{ curText=decodeURIComponent(curContent).replace(/<[^>]+>/g,'').replace(/\s/g,''); }catch(e){ curText=curContent.replace(/<[^>]+>/g,'').replace(/\s/g,''); }
          if(curText.length < EXPECTED_BODY_LEN*0.5){
            body = body.replace(/content=[^&]*/, 'content='+encodeURIComponent(EXPECTED_BODY_HTML));
            body = body.replace(/content_word_cnt%22%3A\d+/g, 'content_word_cnt%22%3A'+EXPECTED_BODY_LEN);
            L('[BODY_GUARD] save='+sv+' 正文失步: 期望'+EXPECTED_BODY_LEN+' 实际'+curText.length+' → 已注入完整正文');
          } else {
            L('[BODY_GUARD_OK] save='+sv+' 正文完整 len='+curText.length);
          }
        }
      }catch(e){ L('[body_guard_err]', (e&&e.message?e.message:'').slice(0,60)); }
      // ---- 广告开关·网络层强制保障(2026-08-29 加固) ----
      // 实测结论：article_ad_type=3 表示「投放广告赚收益」，=2 表示「不投放广告」，平台默认即 3。
      // 但页面 radio 的 DOM checked 状态不可靠（编辑已发布文章时发布设置区不回填，显示未选中），
      // 脚本若据此判断再去点击，反而可能把广告切到「不投放广告」。
      // 因此在网络层做最终校正：无论页面怎么抖，真正发给平台的请求一定是 article_ad_type=3。
      try{
        let nb = body;
        if(nb){
          const m = nb.match(/article_ad_type=(\d+)/);
          if(m && m[1] !== '3'){
            nb = nb.replace(/article_ad_type=\d+/g, 'article_ad_type=3');
            L('[AD_FORCED] article_ad_type ' + m[1] + ' -> 3 (强制投放广告赚收益)');
          } else if(m){
            L('[AD_OK] article_ad_type=3');
          } else {
            nb = nb + '&article_ad_type=3';
            L('[AD_INJECTED] 请求体缺 article_ad_type，已注入 =3');
          }
          const ce = nb.match(/claim_exclusive=(\d+)/);
          L('[CLAIM_EXCLUSIVE_IN_REQ]=' + (ce ? ce[1] : 'MISSING'));
          if(nb !== body){ try{ return await route.continue({ postData: nb }); }catch(e){} }
        }
      }catch(e){ L('[ad_force_err]', (e&&e.message?e.message:'').slice(0,60)); }
      try{ return await route.continue(); }catch(e){ return; }
    });
    L('[GATE_ROUTE_READY]');
  }catch(e){ L('[GATE_ROUTE_ERR]', (e&&e.message?e.message:'').slice(0,80)); }
  // 2026-10-01 修：平台对「空封面的保存类请求」也返回 code:0(message=保存成功)，旧逻辑据此锁 GATE，
  // 会把后续「带封面的真发布」全 abort → 实际停成草稿。锁定条件收紧：必须该次请求体 pgc_feed_covers 非空。
  page.on('response', async r => { const u=r.url(); if(/article\/publish/.test(u)){ const idx=_resp.length; const sv=_reqSave[idx]!==undefined?_reqSave[idx]:'?'; const rb=(idx<_reqBody.length?_reqBody[idx]:'')||''; try{ const b=await r.text(); let code=null; try{ code=JSON.parse(b).code; }catch(e){} const hasCover=/pgc_feed_covers=%5B%7B/.test(rb); if(code===0 && String(sv)!=='1' && !/[?&]save=1(&|$)/.test(u)){ if(hasCover){ if(!GATE.locked){ GATE.locked=true; L('[GATE_LOCKED] 捕获真实发布成功 code:0+带封面, 后续 publish 将被阻断'); } GATE.okCount++; L('[GATE_PUB] code:0 非草稿 有封面, 记为真发布'); } else { L('[GATE_SKIP] code:0 但请求体封面为空(pgc_feed_covers=[]), 判为草稿保存, 不锁 GATE'); } } _resp.push({status:r.status(), snip:b.slice(0,800), code, reqSave:sv, hasCover}); }catch(e){ _resp.push({status:r.status(), snip:'<no_body>', reqSave:sv}); } } });

  // ---- 1. 尝试已有 cookie ----
  let loggedIn = false;
  if(fs.existsSync(COOKIE_FILE)){
    try{
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE,'utf-8'));
      await ctx.addCookies(cookies);
      await page.goto(EDITOR, { waitUntil:'commit', timeout:30000 });
      await page.waitForSelector(TITLE_SEL, { timeout:60000 }); // 2026-09-14: 编辑器 SPA 渲染需 ~16s+，原 8s 常误判失效走扫码
      loggedIn = true;
      L('OLD_COOKIES_VALID');
    }catch(e){ L('OLD_COOKIES_INVALID'); loggedIn=false; }
  }

  // ---- 2. 扫码登录 ----
  if(!loggedIn){
    L('NEED_QR_LOGIN');
    await page.goto(LOGIN, { waitUntil:'commit', timeout:30000 });
    try{ await page.getByText('扫码登录').first().click({timeout:3000,force:true}); }catch(e){}
    await page.waitForTimeout(2500);
    // 截二维码
    try{
      const qr = page.locator('canvas').first();
      if(await qr.count()) await qr.screenshot({path:'debug/qr.png'});
      else await page.screenshot({path:'debug/qr.png'});
    }catch(e){ await page.screenshot({path:'debug/qr.png'}).catch(()=>{}); }
    L('QR_READY scan with phone');
    const t0 = Date.now();
    while(Date.now()-t0 < 180000){
      await page.waitForTimeout(3000);
      const u = page.url();
      if(!/auth\/page\/login/.test(u)){ loggedIn=true; break; }
      const bt = await page.evaluate(()=>document.body.innerText).catch(()=>'');
      if(/退出登录|创作中心|发布文章|工作台/.test(bt)){ loggedIn=true; break; }
    }
    if(!loggedIn){ L('QR_TIMEOUT'); await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]); process.exit(11); }
    const newCookies = await ctx.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(newCookies,null,2));
    L('COOKIES_SAVED count=', newCookies.length);
    await page.goto(EDITOR, { waitUntil:'commit', timeout:30000 });
    await page.waitForSelector(TITLE_SEL, { timeout:60000 }); // 2026-09-14: SPA 渲染 ~16s+，原 20s 偏紧
    L('EDITOR_READY_AFTER_QR');
  }

  // ---- 3. 填表 ----
  for(let i=0;i<3;i++){
    try{ await page.keyboard.press('Escape'); }catch(e){}
    try{ const b=page.getByText(/我知道了|立即体验|关闭/); if(await b.count()) await b.first().click({timeout:2000,force:true}); }catch(e){}
    await page.waitForTimeout(400);
  }
  let draftRestored=false;
  // 2026-10-07 增：SKIP_RESTORE=1 时不点「继续编辑/恢复草稿」，强制从空白编辑器开始，
  // 根治「发布页残留旧稿载入→键盘输入进 ProseMirror DOM 但 form content 字段仍绑旧值→正文被污染错配」。
  // 默认（不传）行为不变。
  if(process.env.SKIP_RESTORE==='1'){
    L('SKIP_RESTORE on: 不载入残留草稿，从空白编辑器开始');
  } else {
    for(const t of ['继续编辑','恢复草稿']){
      try{ const b=page.getByText(t); if(await b.count()){ await b.first().click({timeout:2000,force:true}); draftRestored=true; L('restored',t); break; } }catch(e){}
    }
  }
  const ta = page.locator(TITLE_SEL);
  const existing = (await ta.inputValue().catch(()=>''))||'';
  // 始终检查标题长度：草稿恢复后标题可能为空，必须补填
  if(existing.length < 2){
    await ta.evaluate((el,v)=>{
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      try{ setter.call(el,''); }catch(e){ el.value=''; }
      el.dispatchEvent(new Event('input',{bubbles:true}));
      try{ setter.call(el,v); }catch(e){ el.value=v; }
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }, TITLE).catch(async()=>{ try{ await ta.fill(TITLE,{force:true}); }catch(e){} });
  }
  L('title_len=', (await ta.inputValue().catch(()=>'')).length);

  const pm = page.locator('.ProseMirror').first();
  await pm.scrollIntoViewIfNeeded().catch(()=>{});
  await pm.click({force:true}).catch(()=>{});
  await page.keyboard.press('Control+Home').catch(()=>{});
  // ⚠️ 2026-08-29 修复：keyboard.insertText 单次上限约 1450 字，超长正文被静默截断
  //    （实测 2079→1431、1903→1438、1686→1452，结尾动作/金句/提问全丢，读者看到半截文章；
  //     旧兜底阈值 <100 才补输，1438 远大于 100 → 从未触发，缺陷被长期掩盖）。
  //    改为：按段落逐段输入 + 全文字数校验 + 断点续输。
  const _paras = bodyEditor.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const _want = bodyEditor.replace(/\s/g,'').length;
  const _typeFrom = async (from) => {
    for(let k=from;k<_paras.length;k++){
      await page.keyboard.insertText(_paras[k]);
      await page.keyboard.press('Enter');
    }
  };
  await page.waitForTimeout(500);   // 等焦点稳定，否则首段可能整段丢失
  await _typeFrom(0);
  await page.waitForTimeout(900);
  let pmText=(await pm.innerText().catch(()=>''))||'';
  let _got = pmText.replace(/\s/g,'').length;
  if(_got < _want*0.97){
    // 按“前缀匹配”定位断点：能定位就从中途补，定位不到就整篇清空重输（避免首段丢失/内容重复）
    const flat = pmText.replace(/\s/g,'');
    let acc='', idx=0;
    for(let k=0;k<_paras.length;k++){
      const p=_paras[k].replace(/\s/g,'');
      if(flat.startsWith(acc+p)){ acc+=p; idx=k+1; } else break;
    }
    if(idx<=0){
      L('BODY_RETRY_FULL got=', _got, 'want=', _want);
      await pm.click({force:true}).catch(()=>{});
      await page.keyboard.press('Control+a').catch(()=>{});
      await page.keyboard.press('Delete').catch(()=>{});
      await page.waitForTimeout(400);
      await _typeFrom(0);
    } else {
      L('BODY_RETRY_FROM para=', idx, 'got=', _got, 'want=', _want);
      await pm.click({force:true}).catch(()=>{});
      await page.keyboard.press('Control+End').catch(()=>{});
      await _typeFrom(idx);
    }
    await page.waitForTimeout(900);
    pmText=(await pm.innerText().catch(()=>''))||'';
    _got = pmText.replace(/\s/g,'').length;
  }
  L('body_filled_len=', _got, 'want=', _want, 'BODY_OK=', _got >= _want*0.97);
  // 2026-10-07：捕获当篇正文用于网络层毒化兜底。逐段 <p>…</p>，转义 &, <, > 防注入。
  const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  EXPECTED_BODY_HTML = _paras.map(p=>'<p>'+_esc(p)+'</p>').join('');
  EXPECTED_BODY_LEN = _want;
  L('BODY_CAPTURED htmlLen=', EXPECTED_BODY_HTML.length, 'expectWords=', EXPECTED_BODY_LEN);

  // ---- 3.5 选“单图”→上传封面 ----
  const selCover = await page.evaluate(() => {
    const radio = document.querySelector('.article-cover input[value="2"]') || document.querySelector('input[value="2"]');
    if(radio){ try{ radio.click(); }catch(e){} return 'selected 单图'; }
    return 'NO_RADIO2';
  });
  L('COVER_SEL=', selCover);
  await page.waitForTimeout(1500);

  const upTrigger = await page.evaluate(() => {
    const ac = document.querySelector('.article-cover');
    if(!ac) return 'NO_ARTICLE_COVER';
    const els=[...ac.querySelectorAll('div,span,button,[role="button"]')].filter(e=>e.offsetWidth>10&&e.offsetHeight>10);
    const hit=els.find(e=>/上传|添加|点击|\+/.test(e.textContent||'') || /upload|add|plus|uploader/i.test((e.className||'').toString()));
    if(hit){ try{hit.click();}catch(e){} return 'up:'+(hit.textContent||'').trim().slice(0,16)+' cls='+(hit.className||'').toString().slice(0,30); }
    return 'NO_UP_TRIGGER html='+ac.outerHTML.slice(0,500);
  });
  L('COVER_UP=', upTrigger);
  await page.waitForTimeout(1500);

  const fiInfo = await page.evaluate(() => [...document.querySelectorAll('input[type="file"]')].map((f,i)=>({i, vis:!!(f.offsetParent), top:Math.round(f.getBoundingClientRect().top), cls:(f.className||'').toString().slice(0,30)})));
  L('FILE_INPUTS=', fiInfo);
  let pickIdx=-1;
  const cand = fiInfo.filter(x=>x.vis && x.top<600);
  if(cand.length) pickIdx=cand[0].i; else if(fiInfo.some(x=>x.vis)) pickIdx=fiInfo.find(x=>x.vis).i;
  if(pickIdx>=0){
    const fi = page.locator('input[type="file"]').nth(pickIdx);
    await fi.setInputFiles(COVER_FILE).catch(e=>L('cover set err', e.message.slice(0,80)));
    L('COVER_SET_DONE idx='+pickIdx);
    let coverAttached=false;
    for(let k=0;k<15;k++){
      await page.waitForTimeout(1000);
      const st = await page.evaluate(() => {
        const imgs=[...document.querySelectorAll('.article-cover img')].map(i=>i.src);
        if(imgs.some(s=>s&&s.length>10)) return {ok:true, imgs:imgs.slice(0,3)};
        const modal=[...document.querySelectorAll('[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="crop"],[class*="Crop"],[role="dialog"]')].filter(e=>e.offsetWidth>10&&e.offsetHeight>10);
        const btns=[...document.querySelectorAll('button,[role="button"]')].filter(e=>e.offsetWidth>10&&e.offsetHeight>10&&/确定|完成|保存|使用|裁剪/.test(e.textContent||''));
        if(btns.length){ try{btns[0].click();}catch(e){} return {crop:btns[0].textContent.trim().slice(0,16)}; }
        return {none:true};
      });
      if(st.ok){ coverAttached=true; L('COVER_ATTACHED', st.imgs); break; }
      if(st.crop) L('CROP_CONFIRM', st.crop);
    }
    if(!coverAttached){ const dbg=await page.evaluate(()=>[...document.querySelectorAll('.article-cover')].map(e=>e.outerHTML.slice(0,500))); L('COVER_NOT_ATTACHED', dbg); }
  } else { L('NO_VISIBLE_COVER_INPUT'); }

  // ---- 3.6.5 等封面真正进入受控组件状态 ----
  // 关键修复（2026-08-26）：单图封面上传后 DOM 里能看到 <img>，但 React 内部封面状态(pgc_feed_covers)会滞后，
  // 导致发布请求 pgc_feed_covers=[] → 服务端回 7050 保存失败。这里轮询“捕获到的 publish 请求体里是否出现封面”，
  // 一旦出现非空 pgc_feed_covers（%5B%7B = [{），说明组件状态已同步，再点发布才不会缺封面。
  let coverInState=false;
  for(let ci=0; ci<25; ci++){
    await page.waitForTimeout(1000);
    if(_reqBody.some(b=>b && /pgc_feed_covers=%5B%7B/.test(b))){ coverInState=true; break; }
  }
  L('COVER_IN_STATE=', coverInState, 'reqBodyCount=', _reqBody.length);
  // 兜底：即便未捕获到带封面的请求体，也强制再触发一次草稿保存（编辑一个无害字符）以固化封面状态
  if(!coverInState){
    await page.evaluate(()=>{ const ta=document.querySelector('textarea[placeholder*="标题"]'); if(ta){ try{ const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(ta, ta.value); ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){} } }).catch(()=>{});
    await page.waitForTimeout(2500);
    for(let ci=0; ci<10; ci++){ await page.waitForTimeout(1000); if(_reqBody.some(b=>b && /pgc_feed_covers=%5B%7B/.test(b))){ coverInState=true; break; } }
    L('COVER_IN_STATE_AFTER_FALLBACK=', coverInState);
  }

  // ---- 3.7 发布设置：投放广告 + 声明首发（2026-08-25 修正）----
  // 实测发布页DOM（2026-08-26 更新）：
  // - 投放广告是 radio，选项：投放广告赚收益 / 不投放广告。注意"封面三图"radio 也复用 value=3，
  //   脚本已改按 label 文字"投放广告赚收益"精确匹配，避免误点封面导致广告分成归零。
  // - 声明首发是 checkbox，文案为"头条首发"，默认未勾选，必须勾选才享首发激励分成。
  // - 原创声明已并入"作品声明"区域，无单独"原创"勾选框，无需处理。
  async function ensureOption(label){
    if(label==='ad'){
      // 修复 2026-08-26：按文字"投放广告赚收益"精确匹配，不再依赖 value=3
      // 因为"封面三图"radio 也复用 value=3，按 value 匹配可能误点封面，导致广告分成归零。
      const findAdLabel = () => {
        return [...document.querySelectorAll('label')].find(l => {
          const t = (l.innerText || '').replace(/\s+/g, '');
          return t.includes('投放广告赚收益') && l.querySelector('input[type="radio"]');
        });
      };
      const before = await page.evaluate(() => {
        const target = (() => {
          return [...document.querySelectorAll('label')].find(l => {
            const t = (l.innerText || '').replace(/\s+/g, '');
            return t.includes('投放广告赚收益') && l.querySelector('input[type="radio"]');
          });
        })();
        if(!target) return {found:false, reason:'no_ad_label'};
        const input=target.querySelector('input[type="radio"]');
        const visual=target.querySelector('.byte-radio-inner')?.classList?.contains('checked')||false;
        return {found:true, checked:!!(input&&input.checked), visual};
      });
      L('AD_BEFORE',JSON.stringify(before));
      if(before.found && (!before.checked || !before.visual)){
        // 2026-08-26 修复：先展开"发文设置"发布设置区，再用 Playwright 真实点击 + input change 兜底。
        // 受控组件（React/Vue）仅靠 page.evaluate 的 DOM click 可能只改了 visual class，
        // 没同步到组件内部状态，导致发布后广告分成实际未开启。
        try{
          const settingBtn = page.locator('button,div,span,a').filter({ hasText: /发文设置|发布设置/ }).first();
          if(await settingBtn.count()){
            const expanded = await settingBtn.evaluate(el => (el.getAttribute('aria-expanded')==='true') || [...el.classList].some(c=>/expand|open|active|down/.test(c))).catch(()=>false);
            if(!expanded){ await settingBtn.click({force:true}).catch(()=>{}); await page.waitForTimeout(600); }
          }
        }catch(e){ L('ad_expand_err', e.message.slice(0,40)); }
        try{
          const label = page.locator('label').filter({ hasText: '投放广告赚收益' }).first();
          if(await label.count()){
            await label.scrollIntoViewIfNeeded();
            await label.click({force:true});
            await page.waitForTimeout(400);
            await label.locator('input[type="radio"]').evaluate(el => { el.focus(); el.click(); el.dispatchEvent(new Event('change',{bubbles:true})); }).catch(()=>{});
            await page.waitForTimeout(300);
          }
        }catch(e){ L('ad_click_err', e.message.slice(0,40)); }
      }
      const after = await page.evaluate(() => {
        const target = [...document.querySelectorAll('label')].find(l => {
          const t = (l.innerText || '').replace(/\s+/g, '');
          return t.includes('投放广告赚收益') && l.querySelector('input[type="radio"]');
        });
        if(!target) return null;
        const input=target.querySelector('input[type="radio"]');
        const visual=target.querySelector('.byte-radio-inner')?.classList?.contains('checked')||false;
        return {checked:!!(input&&input.checked), visual};
      });
      L('AD_AFTER',JSON.stringify(after));
      // 2026-08-29：延时复检。受控组件若未真正同步，input.checked 会在下一次 render 被回滚，
      // 立即读取会误报成功。延后 1.2s 再读一次，才能反映真实状态。
      // 注意：即便此处仍读到 false，也不必恐慌——真正生效与否以网络层 article_ad_type=3 为准。
      await page.waitForTimeout(1200);
      const recheck = await page.evaluate(() => {
        const target = [...document.querySelectorAll('label')].find(l => {
          const t = (l.innerText || '').replace(/\s+/g, '');
          return t.includes('投放广告赚收益') && l.querySelector('input[type="radio"]');
        });
        if(!target) return null;
        const input=target.querySelector('input[type="radio"]');
        return {checked:!!(input&&input.checked)};
      });
      L('AD_RECHECK_AFTER_1.2s',JSON.stringify(recheck));
    } else if(label==='shoufa'){
      const before = await page.evaluate(()=>{
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
        let node;
        while(node=walker.nextNode()){
          const t=node.textContent.trim();
          if(t==='头条首发'||t.includes('头条首发')){
            let label=node.parentElement;
            for(let i=0;i<6&&label;i++){ if(label.tagName==='LABEL') break; label=label.parentElement; }
            if(!label||label.tagName!=='LABEL') return {found:true,reason:'no_label'};
            const input=label.querySelector('input[type="checkbox"]');
            return {found:true,checked:!!(input&&input.checked)};
          }
        }
        return {found:false};
      });
      L('SHOUFA_BEFORE',JSON.stringify(before));
      if(before.found && !before.checked){
        await page.evaluate(()=>{
          const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
          let node;
          while(node=walker.nextNode()){
            const t=node.textContent.trim();
            if(t==='头条首发'||t.includes('头条首发')){
              let label=node.parentElement;
              for(let i=0;i<6&&label;i++){ if(label.tagName==='LABEL') break; label=label.parentElement; }
              const input=label&&label.tagName==='LABEL'?label.querySelector('input[type="checkbox"],input[type="radio"],input'):null;
              if(input) input.click();
              else if(label&&label.tagName==='LABEL') label.click();
              break;
            }
          }
        });
        await page.waitForTimeout(400);
      }
      const after=await page.evaluate(()=>{
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
        let node;
        while(node=walker.nextNode()){
          const t=node.textContent.trim();
          if(t==='头条首发'||t.includes('头条首发')){
            let label=node.parentElement;
            for(let i=0;i<6&&label;i++){ if(label.tagName==='LABEL') break; label=label.parentElement; }
            if(!label||label.tagName!=='LABEL') return null;
            const input=label.querySelector('input[type="checkbox"]');
            const visual=input?(input.classList.contains('checked')||input.classList.contains('is-checked')):false;
            return {checked:!!(input&&input.checked),visual};
          }
        }
        return null;
      });
      L('SHOUFA_AFTER',JSON.stringify(after));
    }
  }

  await ensureOption('ad');
  await page.waitForTimeout(300);
  await ensureOption('shoufa');
  await page.screenshot({path:'debug/publish_options_state.png', fullPage:true}).catch(()=>{});
  L('OPTIONS_DONE');

  // ---- 3.6 填摘要（发布要求摘要≥2字，否则“还需输入 2 个字”拦截）----
  const SUM = process.env.SUM || '工作5年没起色？这4本书帮我建立职场底层认知，从月薪3千走到管理层。';
  const s1 = await page.evaluate((SUM) => {
    function findSum(SUM, root){
      root = root || document;
      const toggles=[...root.querySelectorAll('button,span,div,a,[role="button"]')].filter(e=>{
        const t=(e.textContent||'').trim();
        return /添加摘要|写摘要|编辑摘要|添加导读|写导读/.test(t) && e.offsetWidth>0 && e.offsetHeight>0;
      });
      const log=[];
      if(toggles.length){ try{ toggles[0].click(); log.push('toggle:'+toggles[0].textContent.trim()); }catch(e){} }
      const ta=root.querySelector('textarea[placeholder*="摘要"]')
          || root.querySelector('textarea[placeholder*="简介"]')
          || root.querySelector('textarea[placeholder*="导读"]')
          || [...root.querySelectorAll('textarea')].find(x=>/摘要|简介|导读|一句话/.test(x.placeholder||''))
          || root.querySelector('input[placeholder*="摘要"]')
          || root.querySelector('input[placeholder*="简介"]')
          || root.querySelector('input[placeholder*="导读"]');
      if(ta){
        try{
          const proto=(ta.tagName==='TEXTAREA')?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
          setter.call(ta, SUM);
          ta.dispatchEvent(new Event('input',{bubbles:true}));
          ta.dispatchEvent(new Event('change',{bubbles:true}));
          log.push('filled_'+ta.tagName+' len='+ta.value.length);
          return {ok:true, log};
        }catch(e){ log.push('fill_err:'+e.message.slice(0,40)); }
      }
      const ce=[...root.querySelectorAll('[contenteditable="true"]')].find(e=>/摘要|简介|导读/.test((e.getAttribute('placeholder')||'')+(e.textContent||'')));
      if(ce){ try{ ce.focus(); ce.innerText=SUM; ce.dispatchEvent(new Event('input',{bubbles:true})); log.push('filled_ce'); return {ok:true,log}; }catch(e){} }
      return {ok:false, log};
    }
    return findSum(SUM, document);
  }, SUM);
  L('SUMMARY_MAIN=', s1);
  if(!s1.ok){
    const dbg=await page.evaluate(()=>{
      const tas=[...document.querySelectorAll('textarea')].map(t=>({ph:t.placeholder,len:t.value.length}));
      const inp=[...document.querySelectorAll('input')].filter(i=>/摘要|简介|summary/i.test(i.placeholder||i.name||i.className||'')).map(i=>({ph:i.placeholder,name:i.name}));
      const txts=[...document.querySelectorAll('*')].filter(e=>{const t=(e.textContent||'').trim();return t&&/添加摘要|写摘要|编辑摘要|摘要/.test(t)&&t.length<20&&e.children.length===0;}).map(e=>e.textContent.trim()).slice(0,10);
      return {textareas:tas.slice(0,10), sumInputs:inp, sumTexts:txts};
    });
    L('SUMMARY_DIAG_MAIN=', dbg);
  }
  await page.waitForTimeout(600);

  // ---- 4. 等待草稿自动保存完成（避免保存中状态阻塞发布按钮）----
  L('waiting_autosave');
  for(let wi=0;wi<15;wi++){
    const saving = await page.evaluate(()=>/(?:草稿)?保存中/.test(document.body.innerText));
    if(!saving){ L('AUTOSAVE_DONE'); break; }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(500);

  // ---- 4.5 发布前封面再确认（2026-10-01 修复：草稿自动保存会周期性重置 React 封面状态 pgc_feed_covers=[]，
  //   即便前期 COVER_IN_STATE=true，点「预览并发布」那一刻封面可能已被清掉 → VALIDATION 报「无封面」→ PUB_FIRED=false → 停成草稿。
  //   对策：点发布按钮前检查 .article-cover 是否仍有 <img>；缺失则从 COVER_FILE 重新上传并固化封面状态，确保发布 payload 一定带封面。----
  {
    const coverNowOk = await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('.article-cover img')].map(i=>i.src);
      return imgs.some(s=>s&&s.length>10);
    }).catch(()=>false);
    L('COVER_CHECK_BEFORE_PUBLISH=', coverNowOk);
    if(!coverNowOk){
      L('COVER_REUPLOAD_TRIGGER');
      try{
        await page.evaluate(()=>{
          const ac=document.querySelector('.article-cover'); if(!ac) return;
          const els=[...ac.querySelectorAll('div,span,button,[role="button"]')].filter(e=>e.offsetWidth>10&&e.offsetHeight>10);
          const hit=els.find(e=>/上传|添加|点击|\+/.test(e.textContent||'') || /upload|add|plus|uploader/i.test((e.className||'').toString()));
          if(hit){ try{hit.click();}catch(e){} }
        });
        await page.waitForTimeout(1500);
        const fi=page.locator('input[type="file"]');
        if(await fi.count()){ await fi.first().setInputFiles(COVER_FILE).catch(e=>L('reupload err', e.message.slice(0,80))); L('COVER_REUPLOAD_SET'); }
        for(let k=0;k<20;k++){
          await page.waitForTimeout(1000);
          const st=await page.evaluate(()=>{
            const imgs=[...document.querySelectorAll('.article-cover img')].map(i=>i.src);
            if(imgs.some(s=>s&&s.length>10)) return {ok:true};
            const btns=[...document.querySelectorAll('button,[role="button"]')].filter(e=>e.offsetWidth>10&&e.offsetHeight>10&&/确定|完成|使用|裁剪/.test(e.textContent||''));
            if(btns.length){ try{btns[0].click();}catch(e){} return {crop:true}; }
            return {none:true};
          });
          if(st.ok){ L('COVER_REUPLOAD_ATTACHED'); break; }
        }
        await page.evaluate(()=>{ const ta=document.querySelector('textarea[placeholder*="标题"]'); if(ta){ try{ const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(ta,ta.value); ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){} } }).catch(()=>{});
        await page.waitForTimeout(2500);
        const okAfter=await page.evaluate(()=>{ const imgs=[...document.querySelectorAll('.article-cover img')].map(i=>i.src); return imgs.some(s=>s&&s.length>10); }).catch(()=>false);
        L('COVER_REUPLOAD_FINAL=', okAfter);
      }catch(e){ L('COVER_REUPLOAD_ERR', e.message.slice(0,120)); }
    }
  }

  // ---- 5. 获取发布按钮详细信息 + 去遮罩 ----
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(800);
  const btnInfo = await page.evaluate(() => {
    function clearOverlays(btn){
      if(!btn) return null;
      const r=btn.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
      let el=document.elementFromPoint(cx,cy); let d=0;
      while(el && el!==btn && d<6){ el.style.pointerEvents='none'; el.style.zIndex='-1'; el=document.elementFromPoint(cx,cy); d++; }
      return el===btn?'TOP':(el?el.tagName:'null');
    }
    const btns=[...document.querySelectorAll('button')];
    const target=btns.find(b=>/预览并发布/.test(b.textContent||''));
    if(!target) return {found:false, allBtns:btns.map(b=>b.textContent.trim().slice(0,14))};
    return {
      found:true, text:target.textContent.trim(), cls:(target.className||'').slice(0,60),
      disabled:target.disabled, html:target.outerHTML.slice(0,400),
      overlay:clearOverlays(target), rect:target.getBoundingClientRect()
    };
  });
  L('PUB_BTN=', btnInfo);

  // ---- 5.5 扫描CSRF/签名token + 隐藏字段 ----
  const tokenScan = await page.evaluate(()=>{
    const info = {};
    // 隐藏input
    info.hiddenInputs = [...document.querySelectorAll('input[type="hidden"]')].map(e=>({name:e.name||e.id,value:(e.value||'').slice(0,100)}));
    // meta标签中的token
    info.metaTokens = [...document.querySelectorAll('meta')].filter(m=>/(csrf|token|signature|_sign)/i.test(m.name||m.getAttribute('name')||m.httpEquiv||'')).map(m=>({name:(m.name||m.getAttribute('name')||''),content:(m.content||'').slice(0,100)}));
    // cookie中可能的token
    info.tokenCookies = document.cookie.split(';').filter(c=>/(csrf|token|signature|_sign|session)/i.test(c)).map(c=>c.trim().slice(0,120));
    // 全局JS变量
    const jsVars = {};
    for(const k of ['__INITIAL_STATE__','__NUXT__','CSRF_TOKEN','_signature','antiCSRF','token']){
      try{ if(window[k]) jsVars[k] = JSON.stringify(window[k]).slice(0,200); }catch(e){}
    }
    info.jsVars = jsVars;
    // 所有cookie名
    info.allCookieNames = document.cookie.split(';').map(c=>c.trim().split('=')[0]).filter(Boolean);
    // localStorage 中可能存在的token
    try {
      const ls = {};
      for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(/(token|csrf|anti|sign|tt_|argus|acrawler)/i.test(k)) ls[k]=(localStorage.getItem(k)||'').slice(0,120); }
      info.localStorage = ls;
    } catch(e){ info.localStorage = {err:e.message.slice(0,40)}; }
    // 直接尝试读取常见anti-token全局变量
    try {
      const g = {};
      for(const k of ['tt-anti-token','ttAntiToken','antiToken','_anti_token','ArgusUA','acrawler']){
        try{ if(window[k]!==undefined) g[k]=String(window[k]).slice(0,120); }catch(e){}
      }
      info.antiGlobals = g;
    } catch(e){ info.antiGlobals = {err:e.message.slice(0,40)}; }
    return info;
  });
  L('TOKEN_SCAN=', tokenScan);

  // ---- 6. 智能发布：点"预览并发布"→点"确认发布"→轮询真实 code:0 ----
  let clickMethod='none';
  let pubFired=false;
  let confirmed=false;
  let SUBMITTED=false; // 防同一次运行内重复提交：一旦点过确认发布或收到 code:0，不再点任何提交按钮
  async function tryClickConfirm(){
    const r = await page.evaluate(() => {
      function clearOverlays(btn){
        if(!btn) return false;
        const rc=btn.getBoundingClientRect(); const cx=rc.left+rc.width/2, cy=rc.top+rc.height/2;
        let el=document.elementFromPoint(cx,cy); let d=0;
        while(el && el!==btn && d<8){ el.style.pointerEvents='none'; el.style.zIndex='-1'; el=document.elementFromPoint(cx,cy); d++; }
        return el===btn;
      }
      function doClick(btn){
        if(!btn) return false;
        try{ btn.click(); }catch(e){}
        try{ btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); }catch(e){}
        return true;
      }
      const b=[...document.querySelectorAll('button,[role="button"],div')].find(x=>/确认发布|立即发布|确定发布/.test((x.textContent||'').trim()) && !/预览|定时|返回/.test(x.textContent||''));
      if(!b) return false;
      clearOverlays(b); doClick(b);
      return true;
    });
    return r;
  }
  if(btnInfo.found){
    const pb=page.locator('button',{hasText:/预览并发布/});
    if(await pb.count()){ await pb.first().click({force:true,timeout:6000}).catch(e=>L('pw_err',e.message.slice(0,50))); clickMethod='A_pw'; }
  }
  await page.waitForTimeout(1500);
  for(let pi=0; pi<20; pi++){
    await page.waitForTimeout(1000);
    const st = await page.evaluate(()=>{
      const dlgs=[...document.querySelectorAll('[role="dialog"],[class*="Modal"],[class*="modal"],[class*="preview-panel"],[class*="publish-dialog"]')].filter(e=>e.offsetWidth>80&&e.offsetHeight>80);
      const conf=[...document.querySelectorAll('button,[role="button"]')].find(x=>/确认发布|立即发布|确定发布/.test((x.textContent||'').trim()) && !/预览|定时|返回/.test(x.textContent||''));
      return {d:dlgs.length, hasConf:!!conf, u:location.href.slice(0,60)};
    });
    st.r=_resp.length;
    L('POLL_'+pi+'=', st);
    if(st.hasConf && !confirmed && !SUBMITTED && !GATE.locked){
      const ok = await tryClickConfirm();
      // 2026-08-28 修复：此前只置 confirmed 不置 SUBMITTED，导致二段点击守卫(!gotOk)因响应 async 滞后而误判，二次点发布。
      if(ok){ confirmed=true; SUBMITTED=true; clickMethod+='+CONFIRM'; L('CONFIRM_CLICKED SUBMITTED=true'); }
    }
    const okCode = _resp.some(r=>{ try{ return JSON.parse(r.snip).code===0; }catch(e){ return false; } });
    if(okCode){ pubFired=true; SUBMITTED=true; L('PUB_OK_DETECTED'); break; }
    if(!st.hasConf && !st.d && pi===4 && !confirmed && !SUBMITTED && !GATE.locked){
      L('RETRY_PREVIEW');
      const pb2=page.locator('button',{hasText:/预览并发布/});
      if(await pb2.count()){ await pb2.first().click({force:true,timeout:4000}).catch(()=>{}); await page.waitForTimeout(1500); }
    }
  }
  L('CLICK_METHOD=', clickMethod, 'CONFIRMED=', confirmed, 'PUB_FIRED=', pubFired || _resp.some(r=>{try{return JSON.parse(r.snip).code===0}catch(e){return false}}));
  const gotOk = _resp.some(r=>{ try{ return JSON.parse(r.snip).code===0; }catch(e){ return false; } });
  // 治本：只要"点过确认发布"(confirmed/SUBMITTED)，不论网络响应是否抓到，立即原子登记，防后续重试重复发。
  if((confirmed || SUBMITTED) && _meta && !ledger.ledgerHas(_meta.date, _meta.slot, 'art')){
    markPublishedNow(TITLE, _meta.date, _meta.slot, CONTENT_FILE, process.env.TOPIC||'');
  }

  // ---- 7. 处理预览对话框（如果出现了）----
  const dlInfo = await page.evaluate((SUM) => {
    function clearOverlays(btn){
      if(!btn) return false;
      const r=btn.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
      let el=document.elementFromPoint(cx,cy); let d=0;
      while(el && el!==btn && d<6){ el.style.pointerEvents='none'; el.style.zIndex='-1'; el=document.elementFromPoint(cx,cy); d++; }
      return el===btn;
    }
    function fillSum(SUM){
      const toggles=[...document.querySelectorAll('button,span,div,a,[role="button"]')].filter(e=>{const t=(e.textContent||'').trim();return /添加摘要|写摘要|编辑摘要|添加导读|写导读/.test(t)&&e.offsetWidth>0&&e.offsetHeight>0;});
      const log=[];
      if(toggles.length){ try{toggles[0].click(); log.push('toggle:'+toggles[0].textContent.trim());}catch(e){} }
      const ta=document.querySelector('textarea[placeholder*="摘要"]')||document.querySelector('textarea[placeholder*="简介"]')||document.querySelector('textarea[placeholder*="导读"]')||[...document.querySelectorAll('textarea')].find(x=>/摘要|简介|导读|一句话/.test(x.placeholder||''))||document.querySelector('input[placeholder*="摘要"]')||document.querySelector('input[placeholder*="简介"]');
      if(ta){ try{ const proto=(ta.tagName==='TEXTAREA')?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(ta,SUM); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.dispatchEvent(new Event('change',{bubbles:true})); log.push('filled_'+ta.tagName+' len='+ta.value.length); return {ok:true,log}; }catch(e){ log.push('err:'+e.message.slice(0,30)); } }
      const ce=[...document.querySelectorAll('[contenteditable="true"]')].find(e=>/摘要|简介|导读/.test((e.getAttribute('placeholder')||'')+(e.textContent||'')));
      if(ce){ try{ ce.focus(); ce.innerText=SUM; ce.dispatchEvent(new Event('input',{bubbles:true})); log.push('filled_ce'); return {ok:true,log}; }catch(e){} }
      return {ok:false,log};
    }
    const sumRes=fillSum(SUM);
    const confBtn=[...document.querySelectorAll('button,[role="button"]')].find(b=>/确认发布|立即发布|确定发布/.test((b.textContent||'').trim())&&!/预览|定时/.test(b.textContent||''));
    let container=null, node=confBtn?confBtn.parentElement:document.body;
    while(node && node!==document.body){ const c=node.className||''; if(node.getAttribute('role')==='dialog' || /(modal|dialog|overlay|mask|preview-panel|publish-dialog|preview-dialog)/i.test(c)){ if(node.offsetHeight>150 || node.getAttribute('role')==='dialog'){ container=node; break; } } node=node.parentElement; }
    if(!container) container = confBtn ? confBtn.closest('div') : document.body;
    const fields=[...container.querySelectorAll('textarea,input,[contenteditable="true"]')].map(e=>({tag:e.tagName, type:e.type||'', ph:e.placeholder||(e.getAttribute&&e.getAttribute('placeholder'))||'', cls:(e.className||'').toString().slice(0,50), len:(e.value!==undefined?e.value:(e.innerText||'')).length}));
    const labels=[...container.querySelectorAll('*')].filter(e=>{const t=(e.textContent||'').trim();return t&&/摘要|简介|导读|一句话|填写/.test(t)&&t.length<24&&e.children.length===0;}).map(e=>e.textContent.trim().slice(0,20));
    const allInputs=[...document.querySelectorAll('textarea,input')].map(e=>({tag:e.tagName, ph:e.placeholder||'', cls:(e.className||'').toString().slice(0,40)})).slice(0,30);
    const dlgHtml = container ? container.outerHTML : 'NO_CONTAINER';
    if(confBtn){ const top=clearOverlays(confBtn); return {confirm:confBtn.textContent.trim().slice(0,20), overlayTop:top, fieldCount:fields.length, fields, labels, allInputs, sum:sumRes, dlgHtml}; }
    return {confirm:'NONE', fieldCount:fields.length, fields, labels, allInputs, sum:sumRes, dlgHtml};
  }, SUM);
  L('DIALOG=', dlInfo);
  try{ fs.writeFileSync('debug/dialog.html', dlInfo.dlgHtml||'EMPTY'); L('DIALOG_HTML_WRITTEN len='+(dlInfo.dlgHtml||'').length); }catch(e){ L('dlg write err',e.message.slice(0,40)); }

  // 如果找到确认按钮，受信点击（仅当尚未真收到服务端 code:0 时才点，避免重复提交）
  // 2026-08-28 修复：守卫由 !gotOk 改为 以内存确定标志为准(GATE.locked/SUBMITTED/confirmed)，
  // gotOk 依赖 async 响应监听、常来不及解析，是"同一次运行发两遍"的直接元凶。
  if(!GATE.locked && !SUBMITTED && !confirmed && !gotOk && dlInfo.confirm && dlInfo.confirm!=='NONE'){
    const dl=page.locator('button',{hasText:new RegExp(dlInfo.confirm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))});
    if(await dl.count()){ await dl.first().click({force:true,timeout:6000}).catch(e=>L('confirm err',e.message.slice(0,60))); L('TRUSTED_CLICK confirm:', dlInfo.confirm); SUBMITTED=true; if(_meta && !ledger.ledgerHas(_meta.date, _meta.slot, 'art')) markPublishedNow(TITLE, _meta.date, _meta.slot, CONTENT_FILE, process.env.TOPIC||''); }
    await page.waitForTimeout(3000);
    // 二次确认弹窗
    for(let k=0;k<3;k++){
      const again = await page.evaluate(() => {
        function clearOverlays(btn){
          if(!btn) return false;
          const r=btn.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
          let el=document.elementFromPoint(cx,cy); let d=0;
          while(el && el!==btn && d<6){ el.style.pointerEvents='none'; el.style.zIndex='-1'; el=document.elementFromPoint(cx,cy); d++; }
          return el===btn;
        }
        const all=[...document.querySelectorAll('button,[role="button"]')];
        const b=all.find(x=>/^(确定|知道了|好的|完成)$/.test((x.textContent||'').trim()) && !/预览|定时|返回|发布/.test(x.textContent||''));
        if(b && clearOverlays(b)) return (b.textContent||'').trim().slice(0,20);
        return '';
      });
      if(again){ L('SECOND_CONFIRM=', again); const b2=page.locator('button',{hasText:new RegExp(again.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}); if(await b2.count()){ await b2.first().click({force:true,timeout:5000}).catch(()=>{}); } await page.waitForTimeout(3000); }
      else break;
    }
  } else {
    L('NO_CONFIRM_BTN — preview dialog did not open or was already closed');
  }

  // 校验诊断 + 成功判定
  await page.waitForTimeout(4000);
  const vinfo = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const errs = [...document.querySelectorAll('*')]
      .filter(e=>{ const t=(e.textContent||'').trim(); return t && /(封面|必填|请选择|请上传|未填写|不完整|无法发布|错误|失败|还需输入)/.test(t) && t.length<40 && e.children.length===0; })
      .map(e=>e.textContent.trim()).filter(Boolean).slice(0,15);
    const hint = /封面|上传封面|必填|请选择封面|请上传|未填写|不完整|无法发布/.test(txt) ? 'HINT_PRESENT' : 'no_hint';
    const m = txt.match(/封面[^。\n]{0,18}|上传封面[^。\n]{0,18}|必填[^。\n]{0,12}|请选择封面[^。\n]{0,12}|请上传[^。\n]{0,12}|未填写[^。\n]{0,12}|不完整[^。\n]{0,12}|无法发布[^。\n]{0,12}|还需输入[^。\n]{0,12}/);
    const hintText = m ? m[0] : 'none';
    const coverArea = [...document.querySelectorAll('[class*="cover"],[class*="Cover"],input[type="file"]')].length;
    const success = /发布成功|已发布|发布完成|内容已提交|提交成功/.test(txt);
    return { errs, hint, hintText, coverAreaCount: coverArea, success, bodySnippet: txt.slice(0,300) };
  });
  L('VALIDATION=', vinfo);
  const pubPost = _api.filter(x=>x.m==='POST' && /publish|article|submit|content/i.test(x.u));
  L('PUBLISH_POST=', pubPost);
  L('PUBLISH_RESP=', _resp);
  L('PUBLISH_REQ_BODY=', _reqBody);
  L('REQ_HEADERS=', _reqHeaders);
  L('PUBLISH_API=', _api);
  L('FINAL_URL=', page.url());
  const toast = await page.evaluate(()=>document.body.innerText.match(/(发布成功|已发布|发布失败|操作频繁|网络异常|审核中)[^。\n]{0,20}/)?.[0]||'NO_TOAST');
  L('TOAST=', toast);
  let hasPubOk = false;
  try { hasPubOk = _resp.length>0 && _resp.some(function(r){ if(r.code===0) return true; if(r.snip){ try{ const o=JSON.parse(r.snip); if(o&&o.code===0) return true; }catch(e){ if(/"code":0\b/.test(r.snip)) return true; } } return false; }); } catch(e){ hasPubOk=false; }
  // 真实发布判据（2026-08-26 修复假成功）：
  // 必须存在一条 /article/publish 响应，满足：
  //   (1) 服务端 code===0
  //   (2) 其对应请求体携带正文(content=%3Cp) 与封面(pgc_feed_covers=%5B%7B 即 [{)
  //   (3) 不是纯草稿保存(save!=='1')
  // 草稿自动保存(save=1)即使 code:0 也不算发布成功——这是此前多次“假成功”的根因。
  function isRealPubReq(b){ return b && /content=%3Cp/.test(b) && /pgc_feed_covers=%5B%7B/.test(b); }
  let realPubIdx=-1;
  _resp.forEach((r,i)=>{ if(realPubIdx<0 && r.code===0 && isRealPubReq(_reqBody[i]||'') && String(r.reqSave)!=='1') realPubIdx=i; });
  const hasRealPublish = realPubIdx>=0;

  // ---- 页面状态终极校验（2026-08-27 修复假阴性重复发布）----
  // 根因：响应监听器(_resp)是 async，服务端 code:0 响应体有时来不及解析进 _resp，
  //       导致 hasRealPublish=false → SUCCESS='NO' → 不写台账/锁 → 硬闸门失效 → 被重试/重复发布。
  // 因此：即便没抓到 code:0 网络响应，只要发布后页面已离开编辑器(publish 页)或出现了"已发布"态文案，
  //       仍判定真实发布成功，强制写台账+锁，从根本上堵住重复发布。
  const urlNow = page.url() || '';
  const leftEditor = !/graphic\/publish|weitoutiao\/publish/.test(urlNow);
  const pagePublishedState = /已发布|发布成功|内容已提交|审核中|草稿箱|作品管理|管理\/content/.test(vinfo.bodySnippet || '');
  // 终极可靠性：发布后页面若不存在"无封面/失败/错误"等拦截提示，且(已离开发布页 或 出现已发布态 或 服务端给过确认)，
  // 视为真发布。失败时页面通常会停留发布页并弹出"无封面/无法发布"等提示——此时 leftEditor=false 且 vinfo 含 errs。
  const noBlockHint = (vinfo.errs||[]).filter(e=>/无封面|必填|请选择|请上传|未填写|不完整|无法发布|失败|错误/.test(e)).length===0;
  const pageStateOk = (leftEditor || pagePublishedState) && noBlockHint;
  const SUCCESS_FINAL = (hasRealPublish || vinfo.success || pageStateOk) ? 'YES' : 'NO';
  L('REAL_PUBLISH=', hasRealPublish, 'idx=', realPubIdx, 'vinfo_success=', vinfo.success, 'leftEditor=', leftEditor, 'pagePublishedState=', pagePublishedState, 'noBlockHint=', noBlockHint, 'pageStateOk=', pageStateOk, 'toast=', toast, 'SUCCESS=', SUCCESS_FINAL);
  if(hasRealPublish){ L('REAL_PUBLISH_SNIP=', (_resp[realPubIdx].snip||'').slice(0,300)); }
  if(SUCCESS_FINAL==='YES'){
    // 绝大多数情况下 markPublishedNow() 已在"点确认发布"那一刻登记过(幂等)，此处仅作兜底补登记。
    if(_meta && !ledger.ledgerHas(_meta.date, _meta.slot, 'art')){ markPublishedNow(TITLE, _meta.date, _meta.slot, CONTENT_FILE, process.env.TOPIC||''); }
    else { L('LEDGER_ALREADY_WRITTEN_NOW'); }
  }
  const dump = await page.evaluate(()=>{ const all=[...document.querySelectorAll('button,[role="button"],div,span')].filter(e=>{const t=(e.textContent||'').trim();return /确认发布|摘要|预览|发布成功|已发布|审核/.test(t)&&t.length<30;}).map(e=>({t:e.textContent.trim().slice(0,20),cls:(e.className||'').toString().slice(0,40),tag:e.tagName})); return all.slice(0,25); });
  L('DOM_DUMP=', dump);
  await page.screenshot({path:'debug/auto_publish_result.png'}).catch(()=>{});
  await Promise.race([browser.close(), new Promise(r=>setTimeout(r,5000))]);
  L('DONE');
  process.exit(0);
})().catch(e => { L('FATAL', e.message.slice(0,200)); process.exit(7); });
