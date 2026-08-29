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
  for (const [event, script, matcher] of plan) {
    // 幂等：重复安装不叠加
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !JSON.stringify(h).includes('agent-lore'));
    cfg.hooks[event].push(entry(script, matcher));
  }

  if (dryRun) return { ok: true, dryRun: true, path: p, preview: JSON.stringify(cfg.hooks, null, 2) };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { ok: true, path: p };
}

function uninstallClaudeCode() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) return { ok: false, reason: '没有 settings.json' };
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  let removed = 0;
  for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
    if (!cfg.hooks || !cfg.hooks[ev]) continue;
    const before = cfg.hooks[ev].length;
    cfg.hooks[ev] = cfg.hooks[ev].filter((h) => !JSON.stringify(h).includes('agent-lore'));
    removed += before - cfg.hooks[ev].length;
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
