'use strict';
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { ensureDir, readIfExists, repoId } = require('./util');

/**
 * 活跃需求边界 —— 知识库的第三类内容：**上下文状态**。
 *
 * 为什么单独一层：
 *   「不要扩大需求边界」这类约束，写成提示词 agent 也遵循不了。
 *   不是它不懂规则，是它**不知道边界在哪** —— 边界定义在需求层面、跨会话存在，
 *   而 agent 每次会话重置后只看得到当前对话，于是把"边界"错解成"这次对话提到的范围"。
 *
 *   规范说"不要越界"，状态说"界在这里"。缺了后者，前者是空话。
 *
 * 🔑 **按会话隔离**：同一个仓库里可以同时开多个会话做不同需求。
 *   若只存一份仓库级边界，B 会话会被注入 A 的边界，然后拒绝干本该干的活 ——
 *   而且这种串扰很隐蔽，表现为"agent 莫名其妙不肯改"。
 *   hook 事件里带 session_id，正好用来做隔离键。
 *
 * 取用优先级：本会话的边界 > 仓库默认边界（没开会话时从 CLI/看板设的）。
 *
 * 注入策略与另外两类不同：
 *   常驻规范 → CLAUDE.md，harness 每次加载
 *   情境踩坑 → 按路径/符号检索，可能不命中
 *   **需求边界 → 活跃期间每次编辑前无条件注入**（不检索，因为漏一次就越界）
 */

const DEFAULT_KEY = '_default';
const specDir = (repo) => path.join(HOME, 'spec', repo);
const specFile = (repo, key) => path.join(specDir(repo), (key || DEFAULT_KEY) + '.json');
const sessionsFile = () => path.join(HOME, 'sessions.json');

function readSpec(repo, key) {
  const raw = readIfExists(specFile(repo, key));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && s.active ? s : null;
  } catch { return null; }
}

/** 取边界：本会话的优先，没有就退回仓库默认 */
function get(cwd, sessionId) {
  const repo = repoId(cwd);
  return (sessionId && readSpec(repo, sessionId)) || readSpec(repo, DEFAULT_KEY);
}

function set(cwd, { id, scope, out, sessionId }) {
  const repo = repoId(cwd);
  const key = sessionId || DEFAULT_KEY;
  ensureDir(specDir(repo));
  const rec = {
    id: id || '未命名需求',
    scope: scope || '',
    out: out || [],                 // 明确排除在外的东西 —— 边界的另一半
    sessionId: sessionId || null,
    startedAt: Date.now(),
    active: true,
  };
  fs.writeFileSync(specFile(repo, key), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function clear(cwd, sessionId) {
  const repo = repoId(cwd);
  const key = sessionId || DEFAULT_KEY;
  const cur = readSpec(repo, key);
  if (!cur) return null;
  fs.writeFileSync(specFile(repo, key),
    JSON.stringify({ ...cur, active: false, endedAt: Date.now() }, null, 2), 'utf8');
  return cur;
}

/** 列出这个仓库下所有活跃边界（含各会话的），给看板用 */
function list(cwd) {
  const repo = repoId(cwd);
  const dir = specDir(repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    })
    .filter((s) => s && s.active)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 会话注册表 —— hook 每次触发时报到，看板据此列出"最近活跃的会话"。
 * 没有它，用户在看板上根本不知道有哪些会话可以设边界。
 */
function touchSession(sessionId, cwd) {
  if (!sessionId) return;
  const f = sessionsFile();
  let all = {};
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 首次 */ }
  all[sessionId] = { cwd, repo: repoId(cwd), at: Date.now() };

  // 只留最近 20 个，且丢弃 24 小时前的 —— 否则列表会无限膨胀
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const kept = Object.entries(all)
    .filter(([, v]) => v.at > cutoff)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 20);
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(Object.fromEntries(kept), null, 2), 'utf8');
}

function sessions(cwd) {
  const repo = repoId(cwd);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')); } catch { return []; }
  return Object.entries(all)
    .filter(([, v]) => v.repo === repo)
    .map(([id, v]) => ({ id, short: id.slice(0, 8), ...v, spec: readSpec(repo, id) }))
    .sort((a, b) => b.at - a.at);
}

/** 渲染成注入文本 —— **英文**（进模型上下文的一律英文，CLI 输出才跟随用户语言） */
function render(s) {
  if (!s) return null;
  const lines = [`[Active task scope] ${s.id}`];
  if (s.scope) lines.push(`In scope: ${s.scope}`);
  if (s.out && s.out.length) lines.push(`Explicitly OUT of scope: ${s.out.join('; ')}`);
  lines.push('Stop and ask before making any change outside this scope. Do not do it "while you are here".');
  return lines.join('\n');
}

module.exports = { get, set, clear, list, render, sessions, touchSession, specFile, DEFAULT_KEY };
