'use strict';
/**
 * 知识数据的读写入口。两个后端二选一，调用方感觉不到区别：
 *
 *   不设 AGENT_LORE_REMOTE  → 读写本机文件（store-fs）
 *   设了                    → 走 HTTP 找那台机器要（store-remote）
 *
 * 后者是为了让多台机器共用同一份知识：数据只有服务器上那一份，
 * 各机器的 hook 通过端口访问，而不是各存一份再想办法合并 ——
 * 合并意味着冲突，冲突意味着某台机器的经验会被悄悄丢掉。
 *
 * 两个后端的函数签名完全一致，且都是同步的。
 * 远端的同步是用 worker + Atomics 实现的，见 store-remote.js 的说明。
 */
// 只看环境变量是不够的：setx 设的变量对已运行的进程无效，
// 而 hook 继承的是 Claude Code 启动那一刻的环境。见 remote.js 的说明
const BACKEND = require('./remote').conf().base ? './store-remote' : './store-fs';

module.exports = require(BACKEND);
