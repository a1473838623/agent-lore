'use strict';
const fs = require('fs');
const path = require('path');
const { TUNING } = require('./config');
const { estimateTokens, extractSymbols, repoId, gitRoot } = require('./util');
const store = require('./store');

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

  const picked = [...direct, ...related].sort((a, b) => b.score - a.score);
  if (!picked.length) return null;                    // ← 未命中：零注入，不是注入"无相关知识"

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
  if (!lines.length) return null;

  return {
    text: `【agent-lore】这个文件相关的历史踩坑（来自过往人工修正）：\n${lines.join('\n')}`,
    tokens: used,
    keys: usedKeys,
    repo,
  };
}

/** 把已确认的 convention 同步进项目 CLAUDE.md —— 规范走常驻，不走检索 */
function syncClaudeMd(cwd) {
  const repo = repoId(cwd);
  const conv = store.getConventions(repo);
  if (!conv.trim()) return { written: false, reason: '还没有已确认的规范' };

  const root = gitRoot(cwd) || cwd;
  const target = path.join(root, 'CLAUDE.md');
  const BEGIN = '<!-- agent-lore:begin -->';
  const END = '<!-- agent-lore:end -->';
  const rules = conv.split('\n').filter((l) => l.startsWith('- ')).join('\n');
  const block = `${BEGIN}\n## 本仓库编码规范（agent-lore 自动维护，勿手改此段）\n\n${rules}\n${END}`;

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* 首次创建 */ }

  const next = existing.includes(BEGIN)
    ? existing.replace(new RegExp(`${BEGIN}[\s\S]*?${END}`), block)
    : (existing ? existing.trimEnd() + '\n\n' + block + '\n' : block + '\n');

  fs.writeFileSync(target, next, 'utf8');
  return { written: true, target, count: rules.split('\n').filter(Boolean).length };
}

module.exports = { buildContext, syncClaudeMd };
