#!/usr/bin/env node
'use strict';
/**
 * L1 采集钩子 —— 挂 PostToolUse(Write|Edit|MultiEdit)。
 *
 * 做两件事，都是自动的：
 *   ① 快照当前文件，作为「人类修正」的比较基准
 *   ② 顺带扫一遍**其它**已快照文件 —— 人类在别处的修改就是在这一步被捕获的
 *
 * ② 是采集自动化的关键：不需要你记得敲 lore scan。agent 每写一次文件，
 * 就顺手把上一轮的人工修正收进来了。
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
    const lore = path.join(__dirname, '..', 'bin', 'lore.js');
    // 会话报到：看板据此列出"最近活跃的会话"，否则用户不知道有哪些会话可以设边界
    try { require('../src/spec').touchSession(ev.session_id, ev.cwd || process.cwd()); } catch { /* fail-open */ }
    const opts = { cwd: ev.cwd || process.cwd(), stdio: 'ignore', timeout: 3000 };
    // ② 先扫：此刻 fp 的快照还是上一轮的，能捕获到人类对它以及对其它文件的修改
    try { execFileSync(process.execPath, [lore, 'scan'], opts); } catch { /* fail-open */ }
    // ① 再快照：把本次 agent 写入设为新基准
    const snapArgs = [lore, 'snapshot', fp];
    if (ev.session_id) snapArgs.push('--session', ev.session_id);
    execFileSync(process.execPath, snapArgs, opts);
  } catch { /* fail-open：任何异常都不影响 agent */ }
  process.exit(0);
});
