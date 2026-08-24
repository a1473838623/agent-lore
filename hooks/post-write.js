#!/usr/bin/env node
'use strict';
/**
 * L1 采集钩子 —— 挂 PostToolUse(Write|Edit|MultiEdit)。
 * agent 写完文件后立刻快照，作为「人类修正」的比较基准。
 *
 * 无论发生什么都以 exit 0 结束：这个钩子绝不能拖累编辑流程（fail-open）。
 */
const { execFileSync } = require('child_process');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const fp = ev.tool_input && (ev.tool_input.file_path || ev.tool_input.filePath);
    if (!fp) return;
    execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'lore.js'), 'snapshot', fp],
      { cwd: ev.cwd || process.cwd(), stdio: 'ignore', timeout: 3000 });
  } catch { /* fail-open：任何异常都不影响 agent */ }
  process.exit(0);
});
