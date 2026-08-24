'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS, HOME } = require('./config');
const { ensureDir, readIfExists, repoId } = require('./util');

/**
 * 活跃需求边界 —— 知识库的第三类内容：**上下文状态**。
 *
 * 为什么单独一层：
 *   「不要扩大需求边界」这类约束，写成提示词 agent 也遵循不了。
 *   不是它不懂规则，是它**不知道边界在哪** —— 边界定义在需求层面、跨会话存在，
 *   而 agent 每次会话重置后只看得到当前对话，于是把"边界"错解成"这次对话提到的范围"。
 *
 * 所以这类约束的正确形态不是「规范」，是「状态」：
 *   规范说"不要越界"，状态说"界在这里"。缺了后者，前者是空话。
 *
 * 注入策略与另外两类不同：
 *   常驻规范 → CLAUDE.md，harness 每次加载
 *   情境踩坑 → 按路径/符号检索，可能不命中
 *   **需求边界 → 活跃期间每次编辑前无条件注入**（不检索，因为漏一次就越界）
 */

const specFile = (repo) => path.join(HOME, 'spec', repo + '.json');

function get(cwd) {
  const raw = readIfExists(specFile(repoId(cwd)));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && s.active ? s : null;
  } catch { return null; }
}

function set(cwd, { id, scope, out }) {
  const repo = repoId(cwd);
  const f = specFile(repo);
  ensureDir(path.dirname(f));
  const rec = {
    id: id || '未命名需求',
    scope: scope || '',
    out: out || [],           // 明确排除在外的东西 —— 边界的另一半
    startedAt: Date.now(),
    active: true,
  };
  fs.writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function clear(cwd) {
  const f = specFile(repoId(cwd));
  const cur = get(cwd);
  if (!cur) return null;
  fs.writeFileSync(f, JSON.stringify({ ...cur, active: false, endedAt: Date.now() }, null, 2), 'utf8');
  return cur;
}

/** 渲染成注入文本。刻意写得像一道闸，而不是一句建议 */
function render(spec) {
  if (!spec) return null;
  const lines = [`[Active task scope] ${spec.id}`];
  if (spec.scope) lines.push(`In scope: ${spec.scope}`);
  if (spec.out && spec.out.length) lines.push(`Explicitly OUT of scope: ${spec.out.join('; ')}`);
  lines.push('Stop and ask before making any change outside this scope. Do not do it "while you are here".');
  return lines.join('\n');
}

module.exports = { get, set, clear, render, specFile };
