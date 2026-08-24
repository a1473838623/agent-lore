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

const cwd = process.cwd();
// --repo 覆盖：让跨仓库/工具级的通用规范能存进 _global
const REPO_OVERRIDE = (() => { const i = process.argv.indexOf('--repo'); return i >= 0 ? process.argv[i + 1] : null; })();
const [, , cmd, ...rest] = process.argv;
const arg = (n, d) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes('--' + n);

const CMDS = {
  // —— 采集 ——
  snapshot() {                     // lore snapshot <file>   （由 PostToolUse hook 调用）
    const file = rest[0];
    if (!file) return die('用法: lore snapshot <file>');
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }  // 读不到就静默放过
    if (Buffer.byteLength(content) > TUNING.maxFileBytes) return;
    store.putSnapshot(repoId(cwd), path.resolve(file), content);
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

  // —— 升格 ——
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
    try { ctx = inject.buildContext(cwd, path.resolve(file)); } catch { /* fail-open */ }
    if (!ctx) return;              // ← 未命中：什么都不输出，零 token
    store.recordMetric({ type: 'inject', repo: ctx.repo, file, keys: ctx.keys, tokens: ctx.tokens });
    process.stdout.write(ctx.text);
  },

  // —— 观测 ——
  stats() {
    const s = metrics.stats();
    console.log(`注入次数 ${s.totalInjects}   累计注入 ${s.totalInjectedTokens} token   命中率 ${(s.hitRate * 100).toFixed(0)}%`);
    if (!s.rules.length) return console.log('还没有已入库的规范');
    console.log('\n修正复发率：');
    for (const r of s.rules) {
      console.log(`  [${r.key}] 入库前 ${r.before} 次 → 入库后 ${r.after} 次  (注入 ${r.injected} 次)  ${r.verdict}`);
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
      });
      console.log('✅ 需求边界已设置，之后每次编辑前都会注入：');
      console.log(specMod.render(r));
    } else if (sub === 'clear') {
      const r = specMod.clear(cwd);
      console.log(r ? '✅ 已结束：' + r.id : '当前没有活跃需求');
    } else {
      const r = specMod.get(cwd);
      console.log(r ? specMod.render(r) : '当前没有活跃需求边界。设置：lore spec set --id "xxx" --scope "..." --out "a;b"');
    }
  },

  mcp() { require('../src/mcp').serve(cwd); },        // L2：MCP stdio server

  dashboard() { require('../src/dashboard').serve(cwd); },

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
    console.log(`agent-lore —— 从人类修正里学习仓库规范

冷启动 lore bootstrap [--stat] 从现有代码库归纳规范（不必等修正累积）
采集   lore snapshot <file>   记录 agent 写入（hook 调用）
       lore scan              检测人类修正
归因   lore review            输出归因提示词（零配置，交给当前 harness 的模型）
       lore learn --json '..' 回灌归因结果
       lore auto              有 ANTHROPIC_API_KEY 时自动归因
升格   lore promote [--yes]   达阈值的规范入库（人工确认闸）
       lore sync [--global]   规范 → 项目/用户级 CLAUDE.md（常驻，不走检索）
边界   lore spec set --id X --scope "..." --out "a;b"   设当前需求边界（活跃期间无条件注入）
       lore spec show / clear 查看 / 结束
注入   lore inject <file>     输出边界 + 相关踩坑（hook 调用；全未命中零输出）
接入   lore init [--dry]      一键装 Claude Code hook + 打印其它 harness 接入方式
       lore mcp               L2：MCP stdio server（Cursor/Codex/Cline…）
       lore watch             L3：git 工作区监听（任何工具）
       lore uninstall         移除 hook
观测   lore dashboard         本地看板 http://127.0.0.1:4519
       lore stats             修正复发率
       lore list              查看已学到的东西
       lore where             知识库位置

调参   ${JSON.stringify(TUNING, null, 2).split('\n').join('\n       ')}`);
  },
};

function applyVerdict(repo, v) {
  const gate = attribute.accept(v);
  if (!gate.ok) { console.log(`⊘ ${v.id} 丢弃：${gate.why}`); store.markClassified(repo, v.id); return; }
  const src = store.listPending(repo).find((p) => p.id === v.id) || { file: '?', diff: '' };
  const res = promote.record(repo, v, src);
  store.markClassified(repo, v.id);
  store.recordMetric({ type: 'correction', repo, key: res.key || promote.ruleKey(v.rule), rule: v.rule, file: src.file });
  if (res.kind === 'pitfall') console.log(`✅ 踩坑已记录：${res.rule}`);
  else console.log(`📌 规范候选 ${res.count}/${res.threshold}：${res.rule}` +
    (res.count >= res.threshold ? '  ← 已达阈值，跑 lore promote' : ''));
}

function die(msg) { console.error(msg); process.exitCode = 1; }

(async () => {
  const fn = CMDS[cmd] || CMDS.help;
  try { await fn(); } catch (e) { die('错误: ' + e.message); }
})();
