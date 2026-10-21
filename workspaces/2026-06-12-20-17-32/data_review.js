// data_review.js — 头条号 3 天周期数据复盘（以 07:00 am / 12:00 noon / 18:00 pm 三时段为骨架）
// 用法: NODE_PATH=... node data_review.js
// 流程: CDP 进后台作品管理 → 滚动抓取近 N 天卡片指标 → 存快照 review_history/ →
//       与上一份快照对比 → 生成 report_review_<date>.md
// 时段定义（本号固定三档）：
//   am    = 早间 07 点档（发布 07:00~07:59）
//   noon  = 中午 12 点档（发布 12:00~12:59，仅微头条，不碰图文）
//   pm    = 晚间 18 点档（发布 18:00~18:59）
//   加发档 am2/am3/noon2/noon3/pm2/pm3/由文章生成 归入其所属主时段统计。
// 各时段核心指标：篇数 / 展现 / 阅读 / CTR / 互动(赞+评) / 主选题簇 / 主选题角度。
// 报告原则：数据呈现、分析、结论三处，三档（am/noon/pm）始终并列对比，不孤立展示。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const BJ = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const log = (s) => { console.log(s); try { fs.appendFileSync('debug/data_review.log', s + '\n'); } catch (e) {} };

// ---- 时段映射：slot（台账档位）或 dt（卡片发布时刻）→ am / noon / pm ----
// 三档定义：am=早间 07 点档(07:00~09:59)、noon=中午 12 点档(10:00~14:59)、pm=晚间 18 点档(15:00~23:59)
// 加发档 am2/am3/noon2/noon3/pm2/pm3/由文章生成 归入其所属主时段统计。
function periodOf(it) {
  // 优先用台账档位（精确，含加发档归主时段）
  let s = (it.slot || '').toLowerCase();
  if (/^am/.test(s)) return 'am';
  if (/^noon/.test(s)) return 'noon';
  if (/^pm/.test(s)) return 'pm';
  // 档位未知时用卡片时刻（dt="MM-DD HH:MM"）
  const hm = (it.dt || '').match(/(\d{2}):/);
  if (hm) { const h = +hm[1]; if (h < 10) return 'am'; if (h < 15) return 'noon'; return 'pm'; }
  return 'unknown';
}
// 选题依据：slot/dt 反查台账拿 angle/depth/stance；无则留空
function pickBasis(it, stateByHead) {
  const key = (it.title || '').slice(0, 10);
  const hit = stateByHead.get(key);
  if (!hit) return {};
  return { angle: hit.angle || '', depth: hit.depth || '', stance: hit.stance || '', topic: hit.topic || hit.topic_tag || '' };
}

async function main() {
  const today = BJ();
  fs.mkdirSync(path.join(ROOT, 'review_history'), { recursive: true });
  const { launchBrowser } = require('./pw_launch.js');
  let browser;
  let items = [];
  try {
    browser = await launchBrowser();
    const ctx = browser.contexts()[0];
    const cookies = JSON.parse(fs.readFileSync(path.join(ROOT, 'toutiao_cookies.json'), 'utf-8'));
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1380, height: 920 });
    log('goto backend');
    await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);
    const url = page.url(); const title = await page.title();
    if (/login|passport/.test(url) || /登录/.test(title)) { log('RESULT=NOT_LOGGED_IN'); process.exit(7); }
    log('page loaded: ' + url);

    // ---- 抓卡片指标（滚动加载）----
    const extract = () => page.evaluate(() => {
      const re = /展现\s*(\d+)\s*阅读\s*(\d+)\s*点赞\s*(\d+)\s*评论\s*(\d+)/;
      const els = document.querySelectorAll('li, tr, div');
      const found = [];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (t.length < 20 || t.length > 900) continue;
        if (!re.test(t)) continue;
        if (/\d{2}-\d{2} \d{2}:\d{2}/.test(t) === false) continue;
        const dates = (t.match(/\d{2}-\d{2} \d{2}:\d{2}/g) || []);
        if (dates.length !== 1) continue;
        const m = t.match(re);
        const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
        const dt = dates[0];
        const dmi = lines.findIndex(l => l === dt);
        let titleGuess = '';
        for (let i = dmi; i >= 0; i--) {
          const L = lines[i];
          if (L.length >= 8 && !/^#/.test(L) && !/^(展开|已发布|审核中|草稿|审核未通过|已删除|查看数据|查看评论|修改|更多|由文章生成|首发|创作活动|置顶|展现)/.test(L) && !/\d{2}-\d{2}/.test(L)) { titleGuess = L; break; }
        }
        found.push({ title: titleGuess, dt, body_head: (lines.slice(0, dmi).find(L => L.length >= 10 && !/^#/.test(L) && !/^(展开|已发布|审核中|草稿|由文章生成|首发|创作活动|置顶)/.test(L)) || ''), status: /已发布/.test(t) ? '已发布' : /审核中/.test(t) ? '审核出' : /未通过/.test(t) ? '未通过' : '未知',
          views: +m[1], reads: +m[2], likes: +m[3], comments: +m[4] });
      }
      return found;
    });

    const dedup = (arr) => {
      const map = new Map();
      for (const it of arr) {
        const k = it.dt + '|' + (it.title || it.status).slice(0, 16);
        const old = map.get(k);
        if (!old || (it.title || '').length > (old.title || '').length) map.set(k, it);
      }
      return [...map.values()];
    };

    let stable = 0; let lastCount = 0;
    for (let round = 0; round < 14 && stable < 3; round++) {
      let batch = await extract();
      batch = dedup(batch);
      items = dedup([...items, ...batch]);
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) el.scrollTop = el.scrollHeight;
        }
      });
      await page.waitForTimeout(1400);
      if (items.length === lastCount) stable++; else stable = 0;
      lastCount = items.length;
      log('scroll round ' + round + ' total=' + items.length);
      if (items.length > 60) break;
    }
    log('CARDS=' + items.length);
    if (!items.length) log('WARN=NO_CARDS（可能虚拟列表未渲染）');
  } catch (e) { log('ERR=' + e.message.slice(0, 200)); }
  finally { if (browser) await browser.close().catch(() => { }); }

  // ---- 映射台账（选题/档位/角度）+ 时段归类 ----
  let state = [];
  try { state = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation_state.json'), 'utf-8')); } catch (e) { }
  const overlap = (a, b) => { if (!a || !b) return 0; const As = new Set(a.slice(0, 12).split('')); let n = 0; for (const ch of b.slice(0, 12)) if (As.has(ch)) n++; return n; };
  const stateByHead = new Map();
  for (const s of state) if (s.title) stateByHead.set(s.title.slice(0, 10), s);

  for (const it of items) {
    const probe = (it.title || '') + ' ' + (it.body_head || '');
    let hit = null, best = 0;
    for (const s of state) {
      if (!s.title) continue;
      if ((it.title || '').slice(0, 10) === s.title.slice(0, 10)) { hit = s; break; }
      const ov = overlap(it.body_head, s.title) + overlap(it.title, s.title);
      if (ov > best) { best = ov; hit = s; }
    }
    if (hit && best >= 4) { it.slot = hit.slot; it.type = hit.type || ''; it.state_date = hit.date; }
    if (!it.type) it.type = it.body_head ? 'wt' : 'art';
    // 角度依据（台账 angle/depth/stance；老台账无 depth/stance 则为空）
    const basis = pickBasis(it, stateByHead);
    it.angle = basis.angle; it.depth = basis.depth; it.stance = basis.stance; it.topic = basis.topic;
    // 题材簇
    it.cluster = /注安|注册安全|安全工程师|挂靠/.test(probe) ? '注安主池' : '非注安';
    it.period = periodOf(it);
  }

  // ---- 存快照 ----
  const snapFile = path.join(ROOT, 'review_history', 'snapshot_' + today + '.json');
  const snap = { date: today, generated_at: new Date().toISOString(), items };
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 1));
  log('SNAPSHOT=' + snapFile + ' items=' + items.length);

  // ---- 找上一份快照（严格早于 today）----
  const files = fs.readdirSync(path.join(ROOT, 'review_history'))
    .filter(f => /^snapshot_\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(9, 19) < today).sort();
  let prev = null, prevDate = '';
  if (files.length) {
    prevDate = files[files.length - 1].slice(9, 19);
    prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'review_history', files[files.length - 1]), 'utf-8'));
  }

  // ---- 时段聚合（核心：am/pm 双指标）----
  const sum = (a) => a.reduce((o, x) => { o.views += x.views; o.reads += x.reads; o.likes += x.likes; o.comments += x.comments; return o; }, { views: 0, reads: 0, likes: 0, comments: 0 });
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
  const periodAgg = (itemsIn) => {
    const out = {};
    for (const p of ['am', 'noon', 'pm']) {
      const sub = itemsIn.filter(x => x.period === p);
      const s = sum(sub);
      const clusters = {};
      for (const c of ['注安主池', '非注安']) { const cs = sum(sub.filter(x => x.cluster === c)); clusters[c] = { n: sub.filter(x => x.cluster === c).length, ...cs, ctr: pct(cs.reads, cs.views) }; }
      // 主选题角度：取该时段台账 angle 众数（按出现次数）
      const ang = {};
      for (const x of sub) if (x.angle) ang[x.angle] = (ang[x.angle] || 0) + 1;
      let topAngle = '—';
      for (const [k, v] of Object.entries(ang).sort((a, b) => b[1] - a[1])) { topAngle = k; break; }
      out[p] = { n: sub.length, ...s, ctr: pct(s.reads, s.views), eng: s.likes + s.comments, clusters, topAngle, sub };
    }
    return out;
  };

  const A = periodAgg(items);
  const P = prev ? periodAgg(prev.items) : null;

  const L = [];
  L.push('# 头条号【职场读书】3 天周期数据复盘（双时段） ' + today);
  L.push('');
  L.push('> 时段定义：**am = 早间 07 点档**（发布 07:00~07:59，含 am2/am3 加发）；**pm = 晚间 18 点档**（发布 18:00~18:59，含 pm2/pm3 加发）。每个时段的**核心指标**固定为：篇数 / 展现 / 阅读 / CTR(阅读÷展现) / 互动(赞+评) / 主选题簇 / 主选题角度。下文数据呈现、分析、结论三处均按 am–pm 成对展开。');
  L.push('');

  // ===== 一、数据呈现：am/pm 成对指标表 =====
  L.push('## 一、数据呈现（am / noon / pm 三档，本周期快照 ' + today + '，共 ' + items.length + ' 张卡片）');
  L.push('| 时段 | 篇数 | 展现 | 阅读 | CTR | 互动(赞+评) | 注安主池 | 非注安 | 主选题角度 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const p of ['am', 'noon', 'pm']) {
    const v = A[p];
    L.push(`| **${p.toUpperCase()}**(${p === 'am' ? '早7点' : p === 'noon' ? '午12点' : '晚18点'}) | ${v.n} | ${v.views} | ${v.reads} | ${v.ctr} | ${v.eng} | ${v.clusters['注安主池'].n}篇/${v.clusters['注安主池'].views}展现 | ${v.clusters['非注安'].n}篇/${v.clusters['非注安'].views}展现 | ${v.topAngle} |`);
  }
  L.push('');
  L.push(`**三档对照读数**：展现 am ${A.am.views} / noon ${A.noon.views} / pm ${A.pm.views}；CTR am ${A.am.ctr} / noon ${A.noon.ctr} / pm ${A.pm.ctr}。三档必须对照看，不单独下结论。`);
  L.push('');
  L.push('### 三档 TOP（按展现，am/noon/pm 各列）');
  for (const p of ['am', 'noon', 'pm']) {
    L.push(`- **${p.toUpperCase()}**：` + A[p].sub.slice().sort((a, b) => b.views - a.views).slice(0, 3)
      .map(x => `[${x.dt}] ${x.title.slice(0, 22)}…（${x.views}展现/${x.reads}阅读${x.angle ? '/' + x.angle : ''}）`).join('　'));
  }
  L.push('');

  // ===== 二、分析阶段：am/pm 跨期 + 成对 =====
  L.push('## 二、分析阶段（am / noon / pm 跨周期对比）');
  if (!P) {
    L.push('- 首期复盘：无上期快照，仅绝对值。三档的成对对比已在本节表格呈现；下一周期起自动叠加跨期增量。');
  } else {
    for (const p of ['am', 'noon', 'pm']) {
      const c = A[p], o = P[p];
      L.push(`- **${p.toUpperCase()}** 档跨期：展现 ${o.views}→${c.views}（${c.views - o.views >= 0 ? '+' : ''}${c.views - o.views}），CTR ${o.ctr}→${c.ctr}，主角度「${o.topAngle}」→「${c.topAngle}」。`);
    }
    // 成对同卡增量：同一张卡（按标题前缀）同时出现在本期与上期快照时，取 am/pm 标注的差值。
    const byKey = (a) => { const m = new Map(); for (const x of a) m.set((x.title || x.dt).slice(0, 12), x); return m; };
    const pmap = byKey(prev.items);
    const deltas = [];
    for (const it of items) {
      const p = pmap.get((it.title || it.dt).slice(0, 12));
      if (!p) continue;
      const dv = it.views - p.views, dr = it.reads - p.reads;
      if (dv !== 0 || dr !== 0) deltas.push({ dt: it.dt, period: it.period, title: (it.title || '').slice(0, 24), dv, dr });
    }
    deltas.sort((a, b) => (b.dv + b.dr) - (a.dv + a.dr));
    if (deltas.length) {
      L.push('- 同卡跨期增量（按 am/pm 档标注，仅取两期都出现的卡）：');
      deltas.slice(0, 5).forEach(x => L.push(`  - [${x.period.toUpperCase()} ${x.dt}] ${x.title}… 展现${x.dv >= 0 ? '+' : ''}${x.dv} 阅读${x.dr >= 0 ? '+' : ''}${x.dr}`));
    }
    L.push('- CTR 口径提示：今日刚发的卡（含 am/pm 新档）存在小时级展现延迟，跨期增量只看两期都出现、且非今日新发的老卡才可信。');
  }
  L.push('');

  // ===== 三、选题复盘：三档选题 + 依据 + 数据关联 =====
  L.push('## 三、选题复盘（am / noon / pm 三档选题 + 选取依据 + 数据关联）');
  L.push('| 时段 | 选题/题材簇 | 角度·深度·立场 | 选取依据 | 关联数据（CTR/展现） |');
  L.push('|---|---|---|---|---|');
  for (const p of ['am', 'noon', 'pm']) {
    const v = A[p];
    const list = v.sub.slice().sort((a, b) => b.views - a.views);
    for (const x of list.slice(0, 3)) {
      const basis = [x.angle, x.depth, x.stance].filter(Boolean).join('·') || '—（老内容无台账角度）';
      const reason = x.topic ? '挂「' + x.topic + '」' : (x.cluster === '注安主池' ? '注安主池选题（流量池）' : '活动池/灵感选题');
      L.push(`| **${p.toUpperCase()}** | ${x.title.slice(0, 20)}…（${x.cluster}） | ${basis} | ${reason} | ${pct(x.reads, x.views)} CTR / ${x.views} 展现 |`);
    }
  }
  L.push('');
  L.push('> 选题选取依据来源：后台「作品数据」推送（最新+最热+扶持优先）与创作灵感活动池。三档差异化规则=同一题 am/noon/pm 必须角度/深度/立场至少 2 维不同。数据关联方式：把每篇的 CTR 回挂到其选题簇与角度，判断「哪类选题×哪个角度」真正跑量。');
  L.push('');

  // ===== 四、结论输出：am/noon/pm 三档建议 =====
  L.push('## 四、结论输出（am / noon / pm 三档，选题/发布/形式）');
  L.push('（由执行 Agent 依据上三节真实数据补全；选题方向、发布时间、内容形式三类，三档分别给出，跨档可对比，结尾给出下一周期需重点优化的具体方向。）');
  L.push('');
  L.push('### 选题方向');
  L.push('- am：' + (A.am.topAngle === '—' ? '当期 am 档主角度待执行 Agent 依 cluster/angle 回填' : `当期主角度「${A.am.topAngle}」`));
  L.push('- noon：' + (A.noon.topAngle === '—' ? '当期 noon 档主角度待执行 Agent 依 cluster/angle 回填' : `当期主角度「${A.noon.topAngle}」`));
  L.push('- pm：' + (A.pm.topAngle === '—' ? '当期 pm 档主角度待执行 Agent 依 cluster/angle 回填' : `当期主角度「${A.pm.topAngle}」`));
  L.push('### 发布时间');
  L.push(`- 三档对照：am(${A.am.views}展现) / noon(${A.noon.views}展现) / pm(${A.pm.views}展现)，执行 Agent 依此判哪档更值得放重点内容。`);
  L.push('### 内容形式');
  L.push('- 执行 Agent 依 am/noon/pm 各自的 wt/art 配比回填。');
  L.push('### 下一周期重点优化方向');
  L.push('- 执行 Agent 依三档跨期趋势（哪档 CTR 升/降、哪簇跑量）给出 1~3 条具体可执行优化项。');

  const repFile = path.join(ROOT, 'report_review_' + today + '.md');
  fs.writeFileSync(repFile, L.join('\n'));
  log('REPORT=' + repFile);
  log('REVIEW_OK');
}

main().catch(e => { log('FATAL=' + e.message); process.exit(1); });
