'use strict';
const fs = require('fs');
const path = require('path');
const { TUNING } = require('./config');
const { estimateTokens, extractSymbols, repoId, gitRoot } = require('./util');
const store = require('./store');
const spec = require('./spec');
const recallMod = require('./recall');

/**
 * 带外注入（DESIGN §4-③ / §7）。
 *
 * 🔑 这里体现「常驻与检索分离」这条核心判断：
 *   - convention（规范）→ 写进项目的 CLAUDE.md，由 harness 每次全量加载。
 *     **不走这里**，因为检索有召回率，规范漏一次就等于没生效。
 *   - pitfall（踩坑）→ 走这里，按当前编辑的文件路径与符号召回，有 token 预算。
 *
 * 三条硬约束：未命中零注入 · 单次 ≤ 预算 · 任何异常一律放行。
 */
function buildContext(cwd, file, sessionId) {
  const repo = repoId(cwd);
  const budget = TUNING.injectTokenBudget;

  // ① 同文件的踩坑：最相关，优先
  const direct = store.getPitfalls(repo, file).map((p) => ({ ...p, score: 100 }));

  // ② 跨文件但符号重叠的踩坑：次相关
  let related = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const syms = new Set(extractSymbols(content));
    if (syms.size) {
      // 跨文件召回：默认符号匹配。实测（lore eval compare）——
      //   查询含专有名词时关键词 recall 100%、向量 90%
      //   自然语言查询时关键词 0%、向量 30%（同语言可达 100%，瓶颈是跨语言）
      // 这里的"查询"是文件里的符号，天然属于前者，所以默认不上向量。
      // LORE_RECALL=vector|hybrid 可切换。
      related = store.allPitfalls(repo)
        .filter((p) => p.file !== file)
        .map((p) => {
          const hit = [...syms].filter((s) => (p.rule || '').includes(s) || (p.diff || '').includes(s)).length;
          return { ...p, score: hit };
        })
        .filter((p) => p.score > 0);
    }
  } catch { /* 文件可能是新建的，读不到就只用 ① */ }

  // 需求边界属于**状态**不是规范：活跃期间无条件注入，不参与相关性检索。
  // 漏注入一次就可能越界，所以它优先于踩坑，也不受踩坑预算挤占。
  const active = spec.render(spec.get(cwd, sessionId));

  const picked = [...direct, ...related].sort((a, b) => b.score - a.score);
  if (!picked.length && !active) return null;         // ← 全未命中：零注入，不是注入"无相关知识"

  const lines = [];
  let used = 0;
  const usedKeys = [];
  for (const p of picked) {
    const line = `- ${p.rule}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;                  // ← 预算裁剪
    lines.push(line);
    usedKeys.push(p.key);
    used += cost;
  }
  if (!lines.length && !active) return null;

  // 边界排在踩坑前面：它是硬约束，踩坑是参考
  const blocks = [];
  if (active) blocks.push(active);
  // 注入文本一律英文：它进的是模型上下文，不是给人看的
  if (lines.length) blocks.push(`[Known pitfalls for this file] (learned from past human corrections)\n${lines.join('\n')}`);

  return {
    text: blocks.join('\n\n'),
    tokens: used + (active ? estimateTokens(active) : 0),
    keys: usedKeys,
    repo,
  };
}

/**
 * 把已确认的 convention 同步进 CLAUDE.md —— 规范走常驻，不走检索。
 *
 * global=true 时写用户级 ~/.claude/CLAUDE.md，仓库用 _global：
 * 工具级/环境级规范（PowerShell 编码、git 行为、中文分词…）不属于任何仓库，
 * 但每个仓库都需要，所以归到用户级常驻。
 */
function syncClaudeMd(cwd, { global: isGlobal = false } = {}) {
  const repo = isGlobal ? '_global' : repoId(cwd);
  const conv = store.getConventions(repo);
  if (!conv.trim()) return { written: false, reason: '还没有已确认的规范' };

  const target = isGlobal
    ? path.join(require('os').homedir(), '.claude', 'CLAUDE.md')
    : path.join(gitRoot(cwd) || cwd, 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const BEGIN = '<!-- agent-lore:begin -->';
  const END = '<!-- agent-lore:end -->';
  // 按技术域分组再写出去。多花不到 30 个 token，但几十条规则平铺时模型和人都难扫。
  // 分组标题用英文——整个 CLAUDE.md 都会进模型上下文。
  const flat = conv.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const groups = require('./tags').group(flat);
  const rules = groups.length > 1
    ? groups.map(([tag, items]) =>
        `### ${tag}\n` + items.map((r) => '- ' + r).join('\n')).join('\n\n')
    : flat.map((r) => '- ' + r).join('\n');
  // 标题也用英文——整个 CLAUDE.md 都会进模型上下文
  const title = isGlobal ? 'General engineering rules (maintained by agent-lore — do not edit this block)'
                         : 'Repository coding conventions (maintained by agent-lore — do not edit this block)';
  const block = `${BEGIN}\n## ${title}\n\n${rules}\n${END}`;

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* 首次创建 */ }

  // 用 indexOf/slice 而不是 replace(正则, block)，两个原因：
  //   ① 正则里的 [\s\S] 经过任何字符串处理都可能退化成 [sS]，而 replace 不匹配时
  //      **静默返回原串**——写入"成功"但内容没变，最难查的那种 bug
  //   ② String.replace 的替换串里 $& $` $' 有特殊含义，规范文本里出现就会被吃掉
  let next;
  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  if (i >= 0 && j > i) {
    next = existing.slice(0, i) + block + existing.slice(j + END.length);
  } else {
    next = existing ? existing.trimEnd() + '\n\n' + block + '\n' : block + '\n';
  }

  fs.writeFileSync(target, next, 'utf8');

  // 写完必须验证：上面那个 bug 就是"报告成功但没生效"
  const verify = fs.readFileSync(target, 'utf8');
  const written = flat.length;   // 数规则条数，别把 ### 分组标题算进去
  const actual = verify.split('\n').filter((l) => l.startsWith('- ')).length;
  return { written: true, target, count: written, verified: actual === written, actual };
}

module.exports = { buildContext, syncClaudeMd };
