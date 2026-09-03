'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 一键安装。把 hook 写进 Claude Code 配置，并打印其它 harness 的接入方式。
 * 写之前先备份 —— settings.json 里可能有用户自己的配置，不能覆盖。
 */
const ROOT = path.resolve(__dirname, '..');
const HOOK_PRE = path.join(ROOT, 'hooks', 'pre-edit.js');
const HOOK_POST = path.join(ROOT, 'hooks', 'post-write.js');
const HOOK_PROMPT = path.join(ROOT, 'hooks', 'user-prompt.js');
const MATCHER = 'Write|Edit|MultiEdit';

const claudeSettingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');

/**
 * 认出哪些 hook 是自己装的。
 *
 * 不能靠路径里有没有 agent-lore 这个词 —— 那是文件夹名，用户随手一改就失效：
 * git clone 时换个名字、放进 tools/lore、或者装到别的目录，
 * 旧条目就删不掉，于是每装一次多一条。而失效条目是静默的：
 * node 找不到文件直接退出，Claude Code 不报错，表现为 hook 时灵时不灵。
 *
 * 按脚本文件名认，那是这个项目自己控制的，改文件夹名不影响。
 * 顺带保留对旧写法的识别，让老用户升级时也能清干净。
 */
const OURS = /\/hooks\/(pre-edit|post-write|user-prompt)\.js/i;

/** 把嵌套结构里所有字符串收出来 —— 不同版本的配置结构不一样，不硬编码层级 */
function strings(o, out = []) {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => strings(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => strings(x, out));
  return out;
}

const isOurs = (h) => strings(h).some((c) => {
  // 反斜杠统一成正斜杠再判。不能对 JSON.stringify 的结果做正则 ——
  // 那里 Windows 路径的反斜杠是双写的，字符类只匹配一个，永远对不上
  const n = c.replace(/\\/g, '/');
  return OURS.test(n) || n.includes('agent-lore');
});

function installClaudeCode({ dryRun = false } = {}) {
  const p = claudeSettingsPath();
  let cfg = {};
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    try { cfg = JSON.parse(raw); } catch { return { ok: false, reason: p + ' 不是合法 JSON，请先修复' }; }
    if (!dryRun) fs.writeFileSync(p + '.bak-' + Date.now(), raw, 'utf8');
  }

  cfg.hooks = cfg.hooks || {};
  const entry = (script, matcher) => {
    const e = { hooks: [{ type: 'command', command: 'node "' + script + '"' }] };
    // UserPromptSubmit 不是工具事件，没有 matcher —— 带上会导致该 hook 永不触发
    if (matcher) e.matcher = matcher;
    return e;
  };

  const plan = [
    ['PreToolUse', HOOK_PRE, MATCHER],
    ['PostToolUse', HOOK_POST, MATCHER],
    // 对话层信号：批评本身就是学习素材，且不依赖改动是否经过 Write/Edit
    ['UserPromptSubmit', HOOK_PROMPT, null],
  ];
  // 先清后装。清的范围是所有事件，不只是要装的那三个 ——
  // 旧版本可能把 hook 装在别的事件上，只清计划内的会漏
  let stale = 0;
  for (const event of Object.keys(cfg.hooks)) {
    const before = (cfg.hooks[event] || []).length;
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !isOurs(h));
    stale += before - cfg.hooks[event].length;
  }
  for (const [event, script, matcher] of plan) {
    (cfg.hooks[event] = cfg.hooks[event] || []).push(entry(script, matcher));
  }
  // 清掉被清空的事件键，别在配置里留一堆空数组
  for (const event of Object.keys(cfg.hooks)) {
    if (!cfg.hooks[event].length) delete cfg.hooks[event];
  }

  if (dryRun) {
    return { ok: true, dryRun: true, path: p, stale,
      preview: JSON.stringify(cfg.hooks, null, 2) };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { ok: true, path: p, stale };
}

function uninstallClaudeCode() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) return { ok: false, reason: '没有 settings.json' };
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  let removed = 0;
  // 遍历所有事件而不是写死那三个：旧版本装在哪个事件上不好说，
  // 卸载要能卸干净，否则用户以为卸了、实际还留着失效条目
  for (const ev of Object.keys(cfg.hooks || {})) {
    const before = cfg.hooks[ev].length;
    cfg.hooks[ev] = cfg.hooks[ev].filter((h) => !isOurs(h));
    removed += before - cfg.hooks[ev].length;
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { ok: true, removed, path: p };
}

/** 其它 harness 的接入片段 —— 打印出来让用户自己贴 */
function otherHarnesses() {
  const bin = path.join(ROOT, 'bin', 'lore.js');
  return {
    'MCP 客户端（Cursor / Cline / Codex / Windsurf …）':
      JSON.stringify({ mcpServers: { 'agent-lore': { command: 'node', args: [bin, 'mcp'] } } }, null, 2),
    'L3 保底（任何工具，零 harness 依赖）': 'node "' + bin + '" watch',
  };
}

module.exports = { installClaudeCode, uninstallClaudeCode, otherHarnesses, claudeSettingsPath };
