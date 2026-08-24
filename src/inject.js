'use strict';
const fs = require('fs');
const path = require('path');
const { TUNING } = require('./config');
const { estimateTokens, extractSymbols, repoId, gitRoot } = require('./util');
const store = require('./store');
const spec = require('./spec');

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
function buildContext(cwd, file) {
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
  const active = spec.render(spec.get(cwd));

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
  if (lines.length) blocks.push(`【历史踩坑】这个文件相关（来自过往人工修正）：\n${lines.join('\n')}`);

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
  const rules = conv.split('\n').filter((l) => l.startsWith('- ')).join('\n');
  const title = isGlobal ? '通用工程规范（agent-lore 自动维护，勿手改此段）'
                         : '本仓库编码规范（agent-lore 自动维护，勿手改此段）';
  const block = `${BEGIN}\n## ${title}\n\n${rules}\n${END}`;

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* 首次创建 */ }

  const next = existing.includes(BEGIN)
    ? existing.replace(new RegExp(`${BEGIN}[\s\S]*?${END}`), block)
    : (existing ? existing.trimEnd() + '\n\n' + block + '\n' : block + '\n');

  fs.writeFileSync(target, next, 'utf8');
  return { written: true, target, count: rules.split('\n').filter(Boolean).length };
}

module.exports = { buildContext, syncClaudeMd };
