// topic_rank.js — 离线把 debug/topic_list_<DATE>.json 配对成「统一按讨论量降序」的三档同步排行表
// 2026-09-29 新增。配套抓取器 _grab_topic_list.js（浏览器抓面板全量），本脚本做量/名配对 + 排序 + 三档分配。
// 用法：node topic_rank.js [--date 2026-09-29]   # 读 debug/topic_list_<date>.json → 写 debug/topic_list_<date>_ranked.md
// 修正点：讨论量带千位逗号（2,834万=2834万=28,340,000）——旧版把逗号丢了读成 834万，本版 strip comma。
// 设计：单一扁平降序表（不按垂直度分区）；垂直度仅作「标记」列（信息项，不筛选、不分区）；三档 am/noon/pm 依次消费 Top 位。

const fs = require('fs');
const path = require('path');

const DATE = process.argv[2] ? process.argv[2].replace(/^--date /,'') : (process.env.DATE || (()=>new Date(Date.now()+8*3600*1000).toISOString().slice(0,10))());
const IN = path.join(__dirname, 'debug', 'topic_list_' + DATE + '.json');
const OUT = path.join(__dirname, 'debug', 'topic_list_' + DATE + '_ranked.md');

// 千位逗号修正 + 万/个 归一（单位=讨论数）
// v1.3 fix（2026-09-29）：旧版 /([\d.,]+)\s*(万)?\s*(?:讨论|...)/ 对「6,357万讨论」抓到 6,357万
// 但「万」在捕获组外、被 (讨论|...) 吞掉，strip 逗号后读到 6357（非 6,357 万=63,570,000），差 4 个 0。
// 本版把数字段与单位拆开抓：数字段（含逗号、可含小数）+ 紧邻的「万」。
function toCount(s){
  if(s==null) return null;
  const m = String(s).match(/([\d,]+(?:\.\d+)?)\s*(万?)\s*(?:讨论|人在围观|围观)?/);
  if(!m) return null;
  const num = parseInt(m[1].replace(/,/g,''), 10);
  if(!isFinite(num)) return null;
  return num * (m[2]==='万' ? 10000 : 1);
}
// 本号垂直（职场读书）标记——仅「标注」，不分区、不筛选。
// 口径＝注安/考证主池 + 职场技能 + 管理书评 + 阅读方法。物业/房贷/科技股/金融行情/时政体育娱乐＝非垂直。
function verticalFlag(name){
  const kw = /(注安|注册安全|安全工程师|一建|二建|建筑|造价|职场|打工人|35岁|求职|招聘|裁员|副业|薪资|工资|职称|公积金|阅读|读书|学习|成长|管理|领导力|领导|团队|面试|简历|工作技能|技能提升|工作|失业|就业|内卷|加班)/;
  return kw.test(name) ? '垂直/半' : '非垂直';
}
// 排除词单一事实源（v1.6，2026-10-17）：优先读 inspiration_pool.json 的 exclude_keys（规则文件
// DAILY_TOPIC_RULES.md 明令「禁止写死在代码里」，旧版却把排除词硬编码在此）；读不到（文件缺失/字段为空）
// 才回退到内置默认表，保证离线可跑。行为向后兼容：命中词完全一致。
const EXCLUDE_FALLBACK = /(打卡季|幸运签|晒家乡|对联|飞花令|晒图|拍照|记录我的|记录你|两会|高考|穿搭)/;
let EXCLUDE_RE = EXCLUDE_FALLBACK;
try {
  const poolKeys = (JSON.parse(fs.readFileSync(path.join(__dirname, 'inspiration_pool.json'), 'utf8')).exclude_keys) || [];
  if (poolKeys.length) EXCLUDE_RE = new RegExp(poolKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
} catch (e) { /* inspiration_pool.json 缺失或损坏 → 用内置默认，不阻塞排行 */ }
function excludedFlag(name){
  return EXCLUDE_RE.test(name);
}
// ── 适合度甄别（2026-10-02 v1.5 云明定：不是所有话题都适合，先判能不能落到本号职场读书视角）──
// landable＝「可落本号视角白名单」：命中标题话题能写进 职场技能 / 管理书解读 / 阅读方法 / 考证主池 / 经营数字判断 / 中年读书 任一方向。
// 命中→进「图文取题池」；未命中→降级「微头条补充池」（非垂直大流量靠微头条吃，图文不硬塞，避免稀释 CTR）。
// 注安主池永远 landable（hot_push 锚点）。本白名单是「可落地性」判据，非「流量大小」判据——流量只决定取哪条，landable 才决定这条能不能进图文。
function landable(name){
  const kw = /(注安|注册安全|安全工程师|一建|二建|造价|考证|考公|注会|注册会计师|职称|考编|副业|职场|打工人|35岁|35 岁|求职|招聘|裁员|薪资|工资|月薪|内卷|加班|失业|就业|跳槽|升职|晋升|中年|阅读|读书|书单|学习|成长|书籍|管理|领导力|领导|团队|复盘|判断力|方法|周报|汇报|工作|技能|面试|简历|经营|商业|生意|电商|零售|财务|创业|理财|投资|认知|思维|习惯|自律|效率|职场|工资)/;
  return kw.test(name);
}
// landableReason：给人看的「为什么能落地」一句话（命中哪类方向），写进排行表供成稿参考。
function landableReason(name){
  const map = [
    [/注安|注册安全|安全工程师|一建|二建|造价|考证|考公|注会|注册会计师|职称|考编/, '考证主池'],
    [/职场|打工人|35岁|35 岁|求职|招聘|裁员|薪资|工资|月薪|内卷|加班|失业|就业|跳槽|升职|晋升|副业|创业/, '职场技能'],
    [/管理|领导力|领导|团队|复盘|判断力|方法|经营|商业|生意|电商|零售|财务/, '管理/经营判断'],
    [/阅读|读书|书单|学习|成长|书籍|认知|思维|习惯|自律|效率|中年/, '阅读方法/自我提升'],
    [/周报|汇报|工作|技能|面试|简历/, '职场方法'],
  ];
  for(const [re, lbl] of map){ if(re.test(name)) return lbl; }
  return '';
}

function main(){
  const j = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const lines = (j.raw_lines || []).map(s=>(s||'').trim()).filter(Boolean);
  // 配对：话题行 ^#..#$，量在下一行
  const pairs = [];
  const seen = new Set();
  for(let i=0;i<lines.length;i++){
    const t = lines[i];
    const m = t.match(/^#([^#]{2,40})#$/);
    if(!m) continue;
    const name = m[1].trim();
    if(seen.has(name)) continue;
    seen.add(name);
    let count = null;
    if(i+1 < lines.length){
      const q = lines[i+1];
      const cm = q.match(/^([\d.,]+)\s*(万?)\s*(?:讨论|人在围观|围观)?$/);
      if(cm) count = toCount(cm[1] + (cm[2]||'') + '讨论');
    }
    pairs.push({ name, count });
  }
  // 单一扁平降序（有量的按量排前；无量的按原序垫底）
  const ranked = pairs.slice().sort((a,b)=>{
    if(a.count==null && b.count==null) return 0;
    if(a.count==null) return 1;
    if(b.count==null) return -1;
    return b.count - a.count;
  });
  ranked.forEach((p,i)=>{ p.rank = i+1; p.vflag = verticalFlag(p.name); p.excl = excludedFlag(p.name); p.gt10w = (p.count!=null && p.count>100000); p.land = landable(p.name); p.landWhy = p.land ? landableReason(p.name) : ''; });

  // 三档位次消费（v1.5，2026-10-02 云明定：先甄别可落地性，再取题）：
  // 「图文取题池」= 讨论量≥1万 + 未命中排除词 + landable(能落本号职场读书视角)。
  // 非 landable 的大流量话题（国庆/华为/升旗/迪拜/明星/体育娱乐）不进图文取题池，
  // 自动降级「微头条补充池」（微头条能吃非垂直，数据证互动效率≈图文10倍）；图文不硬塞，避免稀释 CTR。
  // am/noon/pm 按位次依次消费图文取题池；全池无可用 → 退 hot_push 注安主池 / WebSearch。
  const clustersOf = { 物业费:['物业'], 注安:['注安','安全工程师','安全'], 房贷:['房贷'], 科技股:['科技股'] };
  function clusterKey(name){ for(const k in clustersOf){ if(clustersOf[k].some(w=>name.includes(w))) return k; } return null; }
  const inArtPool = p => (p.count!=null && p.count>=10000) && !p.excl && p.land;   // 图文取题池：流量下限 + 未排除 + 可落地
  const inWtPool  = p => (p.count!=null && p.count>=10000) && !p.excl && !p.land;  // 微头条补充池：大流量但不可落地
  const assigned = [];
  const usedClusters = new Set();
  for(const slot of ['am','noon','pm']){
    let chosen=null, skipped=[];
    for(let i=0;i<ranked.length;i++){
      const p=ranked[i];
      if(assigned.some(a=>a.name===p.name)) continue;
      if(!inArtPool(p)){ if(p.gt10w||p.land) skipped.push('r'+p.rank+(p.land?'':'(非落地→微头条池)')); continue; }
      const ck=clusterKey(p.name);
      if(ck && usedClusters.has(ck)){ skipped.push('r'+p.rank+'(同簇)'); continue; }
      chosen={ slot, rank:p.rank, name:p.name, count:p.count, vflag:p.vflag, landWhy:p.landWhy, gt10w:p.gt10w,
               skipNote: skipped.length ? ('跳过 '+skipped.slice(0,6).join('/')+' 后取') : '直取' };
      if(ck) usedClusters.add(ck);
      break;
    }
    if(!chosen) chosen={ slot, rank:-1, name:'(图文取题池无可用 → 退 hot_push 注安主池 / WebSearch)', count:null, vflag:'-', landWhy:'', gt10w:false, skipNote:'图文池无可用' };
    assigned.push(chosen);
  }
  // 微头条补充池（非落地的大流量，最多列 5 条）：微头条可吃，但图文不取。
  const wtPool = ranked.filter(p=>inWtPool(p)).slice(0,5).map(p=>({ rank:p.rank, name:p.name, count:p.count, gt10w:p.gt10w }));

  // 输出 markdown
  let md = '# 推荐话题·统一降序排行（' + DATE + '）\n\n';
  md += '> 单一扁平降序（**不按垂直度分区**）；讨论量=平台面板给的话题人气指标。\n';
  md += '> **v1.5 甄别机制（2026-10-02 云明定：先判能不能落到本号职场读书视角，再取题）**：话题分两个池——\n';
  md += '> · **图文取题池**＝讨论量≥1万 + 未命中排除词 + **可落地**（能写进 职场技能/管理书解读/阅读方法/考证主池/经营数字判断 任一方向）；am/noon/pm 按位次依次消费此池。\n';
  md += '> · **微头条补充池**＝讨论量≥1万 + 未命中排除词 + **不可落地**（国庆/华为/升旗/时政体育娱乐等大众话题）；只喂微头条（微头条能吃非垂直、互动效率≈图文10倍），**图文不硬塞**，避免稀释 CTR。\n';
  md += '> 流量只决定「取哪条」，**可落地性才决定「这条能不能进图文」**。图文取题池全空 → 退 hot_push 注安主池 / WebSearch。同题连推走差异化矩阵（换角度/深度/立场）。\n\n';
  md += '## 三档分配建议（位次消费：只从「图文取题池」取，可落地优先）\n\n| 档 | 位次 | 建议话题 | 讨论量 | >10万 | 可落地方向 | 跳过说明 |\n|---|---|---|---|---|---|---|\n';
  assigned.forEach(a=>{
    md += `| ${a.slot} | rank${a.rank} | #${a.name}# | ${a.count!=null?a.count.toLocaleString():'无量'} | ${a.gt10w?'✅':'—'} | ${a.landWhy||'—'} | ${a.skipNote} |\n`;
  });
  md += '\n## 微头条补充池（大流量但不可落地，仅喂微头条·图文不取，最多 5 条）\n\n| # | 话题 | 讨论量 | >10万 | 说明 |\n|---|---|---|---|---|\n';
  if(wtPool.length){ wtPool.forEach(p=>{ md += `| r${p.rank} | #${p.name}# | ${p.count!=null?p.count.toLocaleString():'无量'} | ${p.gt10w?'✅':'—'} | 大流量·非落地，微头条可吃 |\n`; }); }
  else { md += '| — | （本日无可落地的微头条补充条目） | | | |\n'; }
  md += '\n## 全量排行（讨论量降序，' + ranked.length + ' 条）\n\n';
  md += '| # | 话题 | 讨论量 | >10万 | 可落地 | 落地方向 | 排除词 |\n|---|---|---|---|---|---|---|\n';
  for(const p of ranked){
    md += `| ${p.rank} | #${p.name}# | ${p.count!=null ? p.count.toLocaleString() : '无量'} | ${p.gt10w?'✅':'—'} | ${p.land?'✅':'—'} | ${p.landWhy||''} | ${p.excl?'⛔':''} |\n`;
  }
  fs.writeFileSync(OUT, md, 'utf-8');

  // 控制台摘要
  const artN = ranked.filter(p=>inArtPool(p)).length, wtN = ranked.filter(p=>inWtPool(p)).length;
  console.log('== 全量 ' + ranked.length + ' 条 · 图文取题池 ' + artN + ' 条 · 微头条补充池 ' + wtN + ' 条（v1.5 甄别：可落地性定池，流量定位次）==');
  ranked.slice(0,20).forEach(p=> console.log(String(p.rank).padStart(2) + '  ' + String(p.count!=null?p.count.toLocaleString():'无量').padStart(10) + '  ' + (p.land?'✅落地':'  非落') + (p.excl?'⛔':'  ') + '  #'+p.name+'#  '+(p.landWhy?('['+p.landWhy+']'):'')));
  console.log('== 三档分配（只从图文取题池取·可落地优先）==');
  assigned.forEach(a=> console.log(a.slot.padEnd(5)+': rank'+a.rank+' → #'+a.name+'#  '+(a.count!=null?a.count.toLocaleString():'无量')+'  '+(a.landWhy?('落['+a.landWhy+'] '):'')+(a.skipNote||'')));
  console.log('SAVED ' + OUT);
}
try { main(); process.exit(0); }
catch(e){ console.log('ERR ' + e.message); try{console.log(fs.readFileSync(IN,'utf8').slice(0,200));}catch(x){} process.exit(7); }
