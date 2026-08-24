#!/usr/bin/env node
'use strict';
/**
 * L1 注入钩子 —— 挂 PreToolUse(Write|Edit|MultiEdit)。
 * 在编辑真正发生**之前**，把这个文件相关的历史踩坑注入 agent 上下文。
 *
 * 三条硬约束在这里体现：
 *   未命中 → 什么都不输出（零 token，不是输出"无相关知识"）
 *   有预算 → lore inject 内部按 300 token 裁剪
 *   fail-open → 任何异常、超时都放行，绝不阻塞编辑
 */
const { execFileSync } = require('child_process');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let text = '';
  try {
    const ev = JSON.parse(raw || '{}');
    const fp = ev.tool_input && (ev.tool_input.file_path || ev.tool_input.filePath);
    if (fp) {
      const args = [path.join(__dirname, '..', 'bin', 'lore.js'), 'inject', fp];
      // 带上 session_id：同一仓库可能有多个会话在做不同需求，边界必须按会话隔离
      if (ev.session_id) args.push('--session', ev.session_id);
      text = execFileSync(process.execPath, args,
        { cwd: ev.cwd || process.cwd(), encoding: 'utf8', timeout: 3000 }).trim();
    }
  } catch { /* fail-open */ }

  if (text) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
    }));
  }
  process.exit(0);   // 永远放行
});
