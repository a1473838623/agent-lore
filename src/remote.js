'use strict';
/**
 * 远端配置的唯一解析处：环境变量优先，其次 settings.json。
 *
 * 为什么不能只认环境变量。用 setx 或图形界面设的变量只写进注册表，
 * 对已经启动的进程无效 —— 而 hook 是 Claude Code 拉起的子进程，
 * 继承的是 Claude Code 启动那一刻的环境。于是配好之后要重启 Claude Code
 * 才生效，中间这段时间 hook 会静默回落到本地文件，
 * 一边写本地一边以为在写服务器，正是要消灭的那种分叉。
 *
 * settings.json 每次调用现读，hook 是一次性进程，下一次编辑就生效。
 * 放这里也合适：连哪台服务器是「这台机器怎么用」，属于偏好不属于知识。
 *
 * 单独成文件而不是塞进 config.js：settings.js 依赖 config.js，
 * config.js 再反过来依赖 settings.js 就成环了。
 */
function conf() {
  // 服务端必须强制走本地文件。settings.json 存在 HOME 里，而容器的 HOME
  // 就是那份共享数据目录 —— 万一 remote 被写进去，看板会通过 HTTP 调自己，
  // 而它是单线程的，同步自调必然死锁。这个开关让服务端不受配置文件影响。
  if (process.env.AGENT_LORE_LOCAL) return { base: '', token: '', timeout: 5000 };
  let s = {};
  try { s = require('./settings').load(); } catch { /* 读不出就当没有 */ }
  return {
    base: (process.env.AGENT_LORE_REMOTE || s.remote || '').replace(/\/+$/, ''),
    token: process.env.AGENT_LORE_TOKEN || s.remoteToken || '',
    timeout: Number(process.env.AGENT_LORE_TIMEOUT || s.remoteTimeout || 5000),
  };
}

module.exports = { conf };
