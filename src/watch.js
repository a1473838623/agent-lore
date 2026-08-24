'use strict';
/**
 * L3 保底方案 —— 不依赖任何 harness 特性（DESIGN §5）。
 *
 * 只监听 git 工作区的文件变化。核心推断：
 *   **未经 L1/L2 上报的变更 = 人类修正**
 * 这个推断在任何 harness 下都成立，所以即使某个工具既没有 hook 也没有 MCP，
 * 采集链路依然能工作 —— 这是「跨 harness 可移植」能不能兑现的关键。
 */
const fs = require('fs');
const path = require('path');
const { gitRoot, repoId } = require('./util');
const detect = require('./detect');

const IGNORE = /(^|[\/])(\.git|node_modules|target|dist|build|\.idea|\.venv|__pycache__)([\/]|$)/;

function watch(cwd, { intervalMs = 5000, onFound } = {}) {
  const root = gitRoot(cwd) || cwd;
  const repo = repoId(cwd);
  console.log(`[lore watch] 监听 ${root}  仓库=${repo}  每 ${intervalMs / 1000}s 扫一次`);

  let timer = null;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { found } = detect.scan(cwd);
      const real = found.filter((f) => !f.skipped);
      if (real.length) {
        console.log(`[lore watch] 捕获 ${real.length} 处人工修正`);
        for (const r of real) console.log(`  ${r.id}  ${path.relative(root, r.file)}`);
        if (onFound) onFound(real);
      }
    }, intervalMs);
  };

  try {
    fs.watch(root, { recursive: true }, (_e, f) => { if (f && !IGNORE.test(f)) kick(); });
  } catch (e) {
    // 某些平台不支持 recursive；退化成定时轮询，功能不变只是延迟高一点
    console.log(`[lore watch] fs.watch 不可用(${e.code})，改用轮询`);
    setInterval(() => detect.scan(cwd), intervalMs);
  }
  kick();
}

module.exports = { watch };
