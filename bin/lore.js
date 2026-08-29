#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { TUNING, HOME } = require('../src/config');
const { repoId: _repoId } = require('../src/util');
const repoId = (d) => REPO_OVERRIDE || _repoId(d);
const store = require('../src/store');
const detect = require('../src/detect');
const attribute = require('../src/attribute');
const promote = require('../src/promote');
const inject = require('../src/inject');
const metrics = require('../src/metrics');
const bootstrap = require('../src/bootstrap');
const install = require('../src/install');
const specMod = require('../src/spec');
const applyMod = require('../src/apply');
const evalMod = require('../src/eval');
const embedMod = require('../src/embed');
const graphMod = require('../src/graph');
const settingsMod = require('../src/settings');
const autostartMod = require('../src/autostart');
const updateMod = require('../src/update');
const daemonMod = require('../src/daemon');

const NL = String.fromCharCode(10);
const cwd = process.cwd();
// --repo 覆盖：让跨仓库/工具级的通用规范能存进 _global
const REPO_OVERRIDE = (() => { const i = process.argv.indexOf('--repo'); return i >= 0 ? process.argv[i + 1] : null; })();
const [, , cmd, ...rest] = process.argv;
const arg = (n, d) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : d; };
// 单字母旗标也认单横杠：`-d` 是后台启动的通行写法，只匹配 `--d` 会让它静默落到前台分支，
// 现象是"敲了 -d 却卡住不返回"，看起来像程序挂了
const has = (n) => rest.includes('--' + n) || (n.length === 1 && rest.includes('-' + n));

const CMDS = {
  // —— 采集 ——
  snapshot() {                     // lore snapshot <file>   （由 PostToolUse hook 调用）
    const file = rest[0];
    if (!file) return die('用法: lore snapshot <file>');
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }  // 读不到就静默放过
    if (Buffer.byteLength(content) > TUNING.maxFileBytes) return;
    store.putSnapshot(repoId(cwd), path.resolve(file), content, arg('session'));
  },

  scan() {                         // lore scan   检测人类修正
    const { repo, found } = detect.scan(cwd);
    const real = found.filter((f) => !f.skipped);
    const skipped = found.filter((f) => f.skipped);
    console.log(`仓库 ${repo}：发现 ${real.length} 处人工修正` +
      (skipped.length ? `，${skipped.length} 处超出 ${TUNING.windowMinutes} 分钟采集窗已跳过` : ''));
    for (const r of real) console.log(`  ${r.id}  ${path.relative(cwd, r.file)}  (${r.hunkCount} 处改动, AI 写完 ${r.ageMin} 分钟后)`);
    if (real.length) console.log(`\n下一步：lore review   ← 输出归因提示词`);
  },

  bootstrap() {              // lore bootstrap [--path .] [--max 4000]  冷启动：从现有代码库归纳规范
    const root = path.resolve(arg('path', cwd));
    const max = Number(arg('max', 4000));
    process.stderr.write(`扫描 ${root} …
`);
    const prof = bootstrap.profile(root, { maxFiles: max });
    if (has('stat')) {           // 只看统计，不出提示词
      for (const [lang, d] of Object.entries(prof.byLang)) {
        console.log(`
[${lang}] ${d.files} 文件`);
        for (const [n, { a, b }] of Object.entries(d.probes)) {
          if (a + b < 5) continue;
          const pct = ((Math.max(a, b) / (a + b)) * 100).toFixed(0);
          console.log(`  ${n.padEnd(6)} A=${String(a).padStart(6)}  B=${String(b).padStart(6)}   ${pct}% 偏向${a > b ? 'A' : 'B'}`);
        }
      }
      return;
    }
    console.log(bootstrap.buildPrompt(prof));
    console.log(`
---
把每行 JSON 回灌：  lore learn --json '<那一行>' --bootstrap`);
  },

  // —— 归因 ——
  review() {                       // lore review   打印分类提示词，交给当前 harness 里的模型
    const repo = repoId(cwd);
    const pending = store.listPending(repo);
    if (!pending.length) return console.log('没有待归因的修正。先跑 lore scan');
    console.log(attribute.buildPrompt(pending));
    console.log(`\n---\n把每行 JSON 回灌：  lore learn --json '<那一行>'`);
  },

  async auto() {                   // lore auto   有 ANTHROPIC_API_KEY 时无人值守归因
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return die('需要 ANTHROPIC_API_KEY。没有 key 就用 lore review（零配置路径）');
    const repo = repoId(cwd);
    const pending = store.listPending(repo);
    if (!pending.length) return console.log('没有待归因的修正');
    const verdicts = await attribute.classifyViaApi(pending, key, arg('model', 'claude-sonnet-5'));
    for (const v of verdicts) applyVerdict(repo, v);
  },

  learn() {                        // lore learn --json '{...}'
    const raw = arg('json');
    if (!raw) return die(`用法: lore learn --json '{"id":"..","label":"style","confidence":0.9,"rule":".."}'`);
    let v; try { v = JSON.parse(raw); } catch { return die('JSON 解析失败'); }
    if (has('bootstrap')) {
      // 冷启动来的规范：证据是整个代码库的频次统计，不是单次修正，
      // 所以不走 ≥3 次累计阈值，但**仍然要过置信度闸和人工确认**
      const gate = attribute.accept({ ...v, label: 'style' });
      if (!gate.ok) return console.log(`⊘ 丢弃：${gate.why}`);
      const repo = repoId(cwd);
      store.addConvention(repo, v.rule, { count: 1, firstSeen: Date.now(), key: promote.ruleKey(v.rule) + '·bootstrap' });
      store.recordMetric({ type: 'promote', repo, key: promote.ruleKey(v.rule), rule: v.rule, source: 'bootstrap' });
      return console.log(`✅ 冷启动规范已入库：${v.rule}`);
    }
    applyVerdict(repoId(cwd), v);
  },

  // —— 确认入库 ——
  promote() {                      // lore promote   列出达阈值的规范，--yes 确认入库
    const repo = repoId(cwd);
    const ready = promote.readyToPromote(repo);
    if (!ready.length) {
      const cands = store.listCandidates(repo).filter((c) => c.label === 'style');
      return console.log(`没有达到阈值(${TUNING.promoteThreshold}次)的规范。当前候选 ${cands.length} 条`);
    }
    for (const r of ready) {
      console.log(`\n[${r.key}] 累计 ${r.count} 次  涉及 ${r.files.length} 个文件`);
      console.log(`  规范：${r.rule}`);
    }
    if (!has('yes')) return console.log(`\n⚠️ 人工确认闸：确认无误后跑  lore promote --yes`);
    for (const r of ready) {
      store.addConvention(repo, r.rule, r);
      store.recordMetric({ type: 'promote', repo, key: r.key, rule: r.rule });
      console.log(`✅ 已入库 ${r.key}`);
    }
    console.log(`\n下一步：lore sync   ← 写进项目 CLAUDE.md（规范走常驻，不走检索）`);
  },

  sync() {                         // lore sync [--global]   convention → CLAUDE.md
    const r = inject.syncClaudeMd(cwd, { global: has('global') });
    if (!r.written) return console.log(`跳过：${r.reason}`);
    console.log(r.verified
      ? `✅ ${r.count} 条规范已写入 ${r.target}`
      : `❌ 写入未生效：期望 ${r.count} 条，文件里只有 ${r.actual} 条 — ${r.target}`);
  },

  // —— 注入 ——
  inject() {                       // lore inject <file>   （由 PreToolUse hook 调用）
    const file = rest[0];
    if (!file) return die('用法: lore inject <file>');
    let ctx = null;
    try { ctx = inject.buildContext(cwd, path.resolve(file), arg('session')); } catch { /* fail-open */ }
    if (!ctx) return;              // ← 未命中：什么都不输出，零 token
    store.recordMetric({ type: 'inject', repo: ctx.repo, file, keys: ctx.keys, tokens: ctx.tokens });
    process.stdout.write(ctx.text);
  },

  // —— 观测 ——
  stats() {   // lore stats [--all]  默认只看本仓库
    const s = metrics.stats(has('all') ? null : repoId(cwd));
    console.log(`注入次数 ${s.totalInjects}   累计注入 ${s.totalInjectedTokens} token   命中率 ${(s.hitRate * 100).toFixed(0)}%`);
    if (!s.rules.length) return console.log('还没有已入库的规范');
    console.log('\n修正复发率：');
    for (const r of s.rules) {
      // seed/bootstrap 的规范没有入库前基线，不显示 0→0 的复发数字
      const recur = r.measurable
        ? `入库前 ${r.before} 次 → 入库后 ${r.after} 次  (注入 ${r.injected} 次)`
        : `注入 ${r.injected} 次`;
      console.log(`  [${r.key}] ${recur}  ${r.verdict}`);
      console.log(`     ${r.rule}`);
    }
  },

  list() {
    const repo = repoId(cwd);
    console.log(`# ${repo}\n`);
    console.log(store.getConventions(repo) || '(暂无已确认规范)');
    const pits = store.allPitfalls(repo);
    console.log(`\n踩坑记录 ${pits.length} 条`);
    for (const p of pits.slice(0, 20)) console.log(`  - [${path.basename(p.file)}] ${p.rule}`);
  },

  watch() { require('../src/watch').watch(cwd, { intervalMs: Number(arg('interval', 5)) * 1000 }); },

  spec() {          // lore spec set|show|clear   —— 管理当前需求边界（上下文状态）
    const sub = rest[0];
    if (sub === 'set') {
      const r = specMod.set(cwd, {
        id: arg('id', rest[1]),
        scope: arg('scope'),
        out: (arg('out') || '').split(';').map((x) => x.trim()).filter(Boolean),
        sessionId: arg('session'),
      });
      console.log('✅ 需求边界已设置，之后每次编辑前都会注入：');
      console.log(specMod.render(r));
    } else if (sub === 'clear') {
      const r = specMod.clear(cwd, arg('session'));
      console.log(r ? '✅ 已结束：' + r.id : '当前没有活跃需求');
    } else {
      const r = specMod.get(cwd, arg('session'));
      console.log(r ? specMod.render(r) : '当前没有活跃需求边界。设置：lore spec set --id "xxx" --scope "..." --out "a;b"');
    }
  },

  why() {                          // lore why <ruleKey>   一条规则的来源与证据
    const key = rest.find((x) => !x.startsWith('--'));
    if (!key) return die('用法: lore why <ruleKey>   ruleKey 见 lore knowledge');
    const g = graphMod.lineage(repoId(cwd), key);
    if (!g) return die('没找到这条规则');
    console.log(g.rule + NL);
    console.log('  状态    ' + graphMod.STATE_LABEL[g.state] + ' —— ' + g.why);
    console.log('  标签    ' + g.tags.join('、'));
    console.log('  来源    ' + (g.source === 'seed' ? '初始化种入' : g.source === 'bootstrap' ? '代码库归纳' : g.evidence.length + ' 次人工修正'));
    console.log('  注入    ' + g.injections + ' 次，累计 ' + g.injectedTokens + ' token');
    console.log('  复发    入库前 ' + g.recurrence.before + ' 次 → 入库后 ' + g.recurrence.after + ' 次');
    if (g.files.length) console.log('  涉及    ' + g.files.map((f) => require('path').basename(f)).join('、'));
    if (g.related.length) {
      console.log(NL + '  相关规范：');
      g.related.forEach((r) => console.log('    ' + r.sim.toFixed(2) + '  ' + r.existing.slice(0, 70)));
    }
    if (g.evidence.length) {
      console.log(NL + '  证据 diff：');
      g.evidence.slice(0, 3).forEach((e) => {
        console.log('    ── ' + (e.file ? require('path').basename(e.file) : '?') + ' ──');
        String(e.diff || '').split(NL).slice(0, 6).forEach((l) => console.log('    ' + l));
      });
    }
  },

  knowledge() {                    // lore knowledge   知识层总览
    const repo = repoId(cwd);
    const lc = graphMod.lifecycle(repo);
    if (!lc.length) return console.log('知识库为空');

    const by = {};
    lc.forEach((x) => { (by[x.state] = by[x.state] || []).push(x); });
    console.log('共 ' + lc.length + ' 条规范' + NL);
    console.log('生命周期：');
    for (const [st, rows] of Object.entries(by)) {
      console.log('  ' + (graphMod.STATE_LABEL[st] || st).padEnd(8) + String(rows.length).padStart(3) + ' 条  ' +
        '█'.repeat(Math.round(rows.length / lc.length * 24)));
    }

    // 需要关注的：过时与无效——知识库最大的问题不是存不下，是存了没用的东西
    const attention = [...(by.stale || []), ...(by.suspect || [])];
    if (attention.length) {
      console.log(NL + '⚠️ 需要关注：');
      attention.forEach((x) => {
        console.log('  [' + x.key + '] ' + graphMod.STATE_LABEL[x.state] + ' —— ' + x.why);
        console.log('       ' + x.rule.slice(0, 74));
      });
    }

    const cv = graphMod.coverage(repo);
    console.log(NL + '覆盖地图：');
    cv.byTag.slice(0, 10).forEach((t) => {
      const n = t.convention + t.pitfall;
      console.log('  ' + t.tag.padEnd(12) + String(n).padStart(3) + '  ' + '▪'.repeat(Math.min(n, 20)));
    });
    if (cv.gaps.length) console.log('  空白域：' + cv.gaps.join('、') + '  —— 要么没踩过坑，要么踩了没沉淀');

    const gr = graphMod.graph(repo);
    console.log(NL + '关系：' + gr.nodes.length + ' 节点 / ' + gr.edges.length + ' 边 / ' + gr.isolated + ' 个孤立点');
    if (gr.isolated > gr.nodes.length * 0.6) {
      console.log('  孤立点占多数 —— 当前是一堆互不相关的经验，尚未在某个领域成体系');
    }
    console.log(NL + '看单条溯源：lore why <ruleKey>');
  },

  /**
   * lore retrieve --mode hybrid --k 10
   * 批量检索的机器接口：stdin 逐行 {"id","q"}，stdout 逐行 {"id","ranked",...}。
   *
   * 给 Python 评测层用。做成批量而非逐次调用，是因为 embedding 有进程内缓存，
   * 一次起进程跑完整个评测集，比每条查询起一次 node 快一个量级。
   */
  async retrieve() {
    const evalMod2 = require('../src/eval');
    const recallMod = require('../src/recall');
    const items = evalMod2.corpus(REPO_OVERRIDE || repoId(cwd));
    if (!items.length) return die('知识库为空');

    const mode = arg('mode', 'hybrid');
    const k = Number(arg('k', 10));

    const lines = fs.readFileSync(0, 'utf8').split(NL).filter((l) => l.trim());
    for (const line of lines) {
      let q; try { q = JSON.parse(line); } catch { continue; }
      if (!q || !q.q) continue;
      try {
        const { rows, degraded } = await recallMod.recall(q.q, items, { mode, topK: k });
        process.stdout.write(JSON.stringify({
          id: q.id != null ? q.id : q.q,
          ranked: rows.map((r) => r.item.key),
          scores: rows.map((r) => Number((r.score != null ? r.score : 0).toFixed(4))),
          degraded: !!degraded,
        }) + NL);
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: q.id != null ? q.id : q.q, ranked: [], error: String(e.message || e) }) + NL);
      }
    }
  },

  async search() {                 // lore search <自然语言查询>
    // 必须连带跳过旗标的值。只滤 --xxx 会把 _global、3 这些值当成查询词，
    // 污染 embedding 后排序整个变样——而且现象很隐蔽，看起来像召回算法不准
    const q = (() => {
      const out = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].startsWith('--')) { i++; continue; }
        out.push(rest[i]);
      }
      return out.join(' ');
    })();
    if (!q) return die('用法: lore search "调用失败要不要重试" [--mode hybrid] [--k 5]');
    const evalMod2 = require('../src/eval');
    const recallMod = require('../src/recall');
    const items = evalMod2.corpus(REPO_OVERRIDE || repoId(cwd));
    if (!items.length) return console.log('知识库为空');

    // 自然语言查询默认 hybrid：实测 keyword 在这类查询上 recall 为 0，
    // 而注入路径的查询是文件符号，那里 keyword 已经 100%，所以两条路径默认值不同
    const mode = arg('mode', 'hybrid');
    const r = await recallMod.recall(q, items, { mode, topK: Number(arg('k', 5)), spec: arg('spec') });
    if (r.degraded) console.log('⚠️ 向量后端不可用，已降级到关键词：' + r.degraded + NL);
    if (!r.rows.length) return console.log('没有召回结果');
    console.log(`${r.mode} · 候选池 ${items.length} 条` + NL);
    // RRF 分值天然很小（~0.008），直接显示没有信息量。归一化成"相对最高分"更好读。
    const top = r.rows[0].score || 1;
    r.rows.forEach((x, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${(x.score / top).toFixed(2)}] ${x.item.rule}`);
      if (x.item.file) console.log('     ' + require('path').basename(x.item.file));
    });
  },

  async embed() {                  // lore embed   探测 embedding 后端
    const r = await embedMod.probe(arg('spec'));
    console.log(r.ok
      ? `✅ ${r.kind}:${r.model}  维度 ${r.dim}`
      : `❌ ${r.kind || '?'}:${r.model || '?'} 不可用 —— ${r.why}` + NL + '   召回会自动降级到关键词，不影响使用');
  },

  async eval() {                   // lore eval init|run|compare
    const repo = repoId(cwd);
    const sub = rest[0];
    const k = Number(arg('k', 3));

    if (sub === 'init') {
      const sk = evalMod.initSkeleton(repo);
      if (!sk.rows.length) return console.log('候选池为空：还没有规范或踩坑');
      require('fs').writeFileSync(sk.file.replace('.jsonl', '.skeleton.jsonl'),
        sk.rows.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
      console.log(`已生成 ${sk.rows.length} 道题的骨架：${sk.file.replace('.jsonl', '.skeleton.jsonl')}`);
      console.log(NL + '把每行的 q 填上（_hint 是对应的规范），type 标 symbol 或 natural，');
      console.log('然后改名成 ' + require('path').basename(sk.file) + ' 即可。');
      console.log(NL + '⚠️ 刻意不自动生成 query —— 用模型造题再用模型检索，等于自己给自己出题，数字没意义。');
      return;
    }

    if (sub === 'compare') {
      const r = await evalMod.compare(repo, { k, spec: arg('spec') });
      const modes = Object.entries(r.results);
      if (modes[0][1].error) return console.log(modes[0][1].error);
      console.log(`评测集 ${modes[0][1].overall.n} 题 · 候选池 ${modes[0][1].corpusSize} 条 · recall@${k}` + NL);
      const types = [...new Set(modes.flatMap(([, v]) => Object.keys(v.byType || {})))];
      const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';
      console.log('模式        总recall  总precision  top1   ' + types.map((t) => t + ' recall').join('  '));
      for (const [m, v] of modes) {
        if (v.error) { console.log(m.padEnd(11) + v.error); continue; }
        console.log(m.padEnd(11) + pct(v.overall.recall) + '      ' + pct(v.overall.precision)
          + '     ' + pct(v.overall.top1) + '   '
          + types.map((t) => (v.byType[t] ? pct(v.byType[t].recall) : '  -  ')).join('     '));
        if (v.degraded) console.log('            ⚠️ 已降级到关键词：' + v.degraded);
      }
      return;
    }

    const r = await evalMod.run(repo, { mode: arg('mode', 'keyword'), k, spec: arg('spec') });
    if (r.error) return console.log(r.error);
    console.log(JSON.stringify(r, null, 2));
  },

  mcp() { require('../src/mcp').serve(cwd); },        // L2：MCP stdio server

  async dashboard() {              // lore dashboard [-d|--stop|--restart|--status]
    const PORT = Number(process.env.AGENT_LORE_PORT || 4519);

    // 后台启停，对齐 agent-beacon 的 start -d / stop。
    // 这是主路径：看板是"想看时才看"的东西，不必常驻，也不必碰系统启动项。
    if (has('stop') || has('restart')) {
      const r = await daemonMod.stop(PORT);
      console.log(r.ok ? (r.already ? '看板本来就没在跑' : '✅ 已停止 PID=' + r.pid) : '❌ ' + r.why);
      if (!has('restart')) return;
    }
    if (has('status')) {
      const st = await daemonMod.status(PORT);
      console.log(st.running ? `✅ 运行中 PID=${st.pid}  ${st.url}`
        : st.orphanPort ? `⚠️ 端口 ${PORT} 被占用，但不是本工具启的进程`
        : '未运行');
      return;
    }
    if (has('d') || has('daemon') || has('restart')) {
      const r = await daemonMod.start(arg('cwd', cwd), PORT);
      console.log(r.ok ? (r.already ? '看板已在运行  ' + r.url : '✅ 已后台启动 PID=' + r.pid + '  ' + r.url)
        : '❌ ' + r.why);
      return;
    }

    // 前台运行。--cwd 给开机自启用：从 Startup 拉起时 cwd 是启动文件夹，
    // 仓库会被判成 "Startup"，看板显示一个空仓库，现象很难查
    const dir = arg('cwd');
    if (dir) { try { process.chdir(dir); } catch { /* 目录没了就用当前的 */ } }
    require('../src/dashboard').serve(dir || cwd);
  },

  autostart() {                    // lore autostart on|off|status
    const sub = rest[0] || 'status';
    if (sub === 'on') {
      const r = autostartMod.enable(arg('cwd', cwd), Number(process.env.AGENT_LORE_PORT || 4519));
      if (!r.ok) return die('❌ 启用失败：' + (r.message || '被安全软件拦截'));
      console.log('✅ 开机自启已启用，开机后无窗口后台运行');
      console.log('   脚本 ' + r.file);
      console.log('   仓库 ' + r.cwd);
      return;
    }
    if (sub === 'off') { console.log('✅ 已关闭：' + autostartMod.disable().file); return; }
    const st = autostartMod.status();
    console.log((st.enabled ? '✅ 已启用' : '未启用') + '   ' + st.file);
    if (st.cwd) console.log('   仓库 ' + st.cwd);
    if (st.drift) console.log('   ⚠️ 配置与实际文件不一致，重新执行 lore autostart on/off 修正');
  },

  async update() {                 // lore update [--pull]
    const r = has('pull') ? updateMod.pull() : updateMod.check();
    if (!r.ok) return die(r.why);
    console.log('分支 ' + r.branch + '   本地 ' + r.local + (r.remote ? '   远程 ' + r.remote : ''));
    if (r.dirty) console.log('   ⚠️ 本地有未提交改动');
    if (r.ahead) console.log('   本地领先 ' + r.ahead + ' 个提交');
    if (r.offline) return console.log('   ' + r.why);
    if (r.updated) {
      console.log('✅ 已更新 ' + r.from + ' → ' + r.local);
      console.log('   ⚠️ 代码已加载进当前进程，**重启看板后才生效**');
    } else if (r.behind) {
      console.log('   落后 ' + r.behind + ' 个提交' + (r.why ? '，' + r.why : '') + (has('pull') ? '' : '。拉取：lore update --pull'));
    } else {
      console.log('   已是最新');
    }
  },

  init() {                                             // 一键装 hook
    const r = install.installClaudeCode({ dryRun: has('dry') });
    if (!r.ok) return die(r.reason);
    if (r.dryRun) { console.log('[预览] ' + r.path + String.fromCharCode(10) + r.preview); return; }
    console.log('✅ Claude Code hook 已装入 ' + r.path + '（原文件已备份）');
    console.log('   重启 Claude Code 后生效');
    for (const [name, snippet] of Object.entries(install.otherHarnesses())) {
      console.log(String.fromCharCode(10) + '── ' + name + ' ──' + String.fromCharCode(10) + snippet);
    }
  },

  uninstall() {
    const r = install.uninstallClaudeCode();
    console.log(r.ok ? '✅ 已移除 ' + r.removed + ' 条 hook 配置' : r.reason);
  },

  where() { console.log(HOME); },

  help() {
    // 默认只显示常用命令，别把 hook 内部调用的命令糊到用户脸上。全部命令用 lore help --all
    if (!has('all')) {
      console.log(`agent-lore —— 让 AI 编码工具从你的修正里学习仓库规范

首次使用
  lore init              一键接入 Claude Code（装 hook）
  lore dashboard -d      ▶ 启动看板，浏览器开 http://127.0.0.1:4519

看板起来后，采集、归因、入库都在网页上点，不用记命令。

常用
  lore dashboard -d      启动看板       lore dashboard --stop  关闭看板
  lore knowledge         知识库总览     lore stats             规范有没有生效
  lore search <查询>     检索知识库     lore list              看学到了什么

全部命令： lore help --all`);
      return;
    }
    console.log(`agent-lore 全部命令

启动看板
  lore dashboard         前台运行（Ctrl+C 退出）
  lore dashboard -d      后台启动（推荐）· --stop 停止 · --restart 重启 · --status 状态

接入
  lore init [--dry]      装 Claude Code hook + 打印其它 harness 接入方式
  lore mcp               MCP stdio server（Cursor/Codex/Cline…）
  lore watch             git 工作区监听（任何工具） · lore uninstall 移除 hook

学习流程（多数由 hook 自动触发，也可手敲）
  lore scan              检测人类修正      lore review   输出归因提示词
  lore learn --json '..' 回灌归因结果      lore auto     有 API key 时自动归因
  lore promote [--yes]   达阈值入库        lore sync [--global]  规范→CLAUDE.md
  lore bootstrap [--stat] 从现有代码库冷启动归纳规范

需求边界
  lore spec set --id X --scope "..." --out "a;b"   设当前需求边界
  lore spec show / clear

检索与评测
  lore search <查询>     自然语言检索      lore embed         探测 embedding 后端
  lore retrieve          批量检索 JSON 接口，供 Python 评测层调用
  lore eval init         生成评测集骨架    lore eval compare  三种召回对照

知识层
  lore knowledge         生命周期·覆盖·关系   lore why <ruleKey>  单条规则溯源

系统
  lore autostart on|off  开机自启          lore update [--pull]  更新 agent-lore
  lore stats             修正复发率        lore list   看学到的东西 · lore where 库位置

hook 内部调用（一般不用手敲）
  lore snapshot <file>   记录 agent 写入   lore inject <file>  输出注入内容

调参 ~/.agent-lore 或 src/config.js：
${JSON.stringify(TUNING, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`);
  },
};

function applyVerdict(repo, v) {
  const res = applyMod.applyVerdict(repo, v);
  if (!res.ok) return console.log(`⊘ ${v.id} 丢弃：${res.why}`);
  if (res.kind === 'pitfall') return console.log(`✅ 踩坑已记录：${res.rule}`);
  const auto = res.autoPromoted || [];
  console.log(`📌 规范候选 ${res.count}/${res.threshold}：${res.rule}`);
  for (const a of auto) console.log(`   ⚡ 已自动入库：${a}`);
  if (!auto.length && res.count >= res.threshold) console.log('   ← 已达阈值，跑 lore promote 人工确认');
}

function die(msg) { console.error(msg); process.exitCode = 1; }

(async () => {
  const fn = CMDS[cmd] || CMDS.help;
  try { await fn(); } catch (e) { die('错误: ' + e.message); }
})();
