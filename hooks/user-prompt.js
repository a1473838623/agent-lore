#!/usr/bin/env node
'use strict';
/**
 * 语义层采集钩子 —— 挂 UserPromptSubmit。
 *
 * 捕捉的是**人说的批评本身**，而不是代码 diff。
 *
 * 为什么单独一条信号线：diff 只看得见结果，看不见要求。
 * "这个词不专业""这段太长""别写论述句"——这些规范从来不体现为某一次代码修改，
 * 人是在对话里说的，说完 agent 自己去改。只盯 diff 的话，
 * 同一类批评说十遍也学不到；而人愿意说第二遍，恰恰说明第一遍没落实。
 *
 * 无论发生什么都 exit 0 且不产生输出：这个钩子在人敲回车后同步执行，
 * 绝不能拖慢或打断提问（fail-open）。
 */
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const evt = JSON.parse(raw || '{}');
    const text = evt.prompt || evt.user_prompt || '';
    if (!text) return process.exit(0);

    const { repoId } = require(path.join(__dirname, '..', 'src', 'util'));
    const critique = require(path.join(__dirname, '..', 'src', 'critique'));
    critique.record(repoId(evt.cwd || process.cwd()), text, evt.session_id);
  } catch { /* fail-open：采集失败绝不影响对话 */ }
  process.exit(0);
});

// stdin 迟迟不来也要退出，不能挂住提问
setTimeout(() => process.exit(0), 2000).unref();
