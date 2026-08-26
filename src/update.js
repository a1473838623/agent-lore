'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 自动更新 —— 拉取 agent-lore 自身的新版本。
 *
 * 只用 --ff-only：如果本地有未推送的提交或改动，快进失败，
 * 那就应该停下来让人处理，而不是自动 merge 出一堆冲突。
 * 一个后台自启的工具偷偷改坏自己的代码，比不更新糟得多。
 */
const ROOT = path.resolve(__dirname, '..');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', timeout: opts.timeout || 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,   // 不加就每次调 git 闪一个 cmd 窗口——看板每 5 秒刷新会踩到
  }).trim();
}

function check({ fetch = true } = {}) {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const local = git(['rev-parse', '--short', 'HEAD']);
    const dirty = git(['status', '--porcelain']).length > 0;

    if (fetch) {
      try { git(['fetch', '--quiet', 'origin', branch], { timeout: 20000 }); }
      catch (e) { return { ok: true, branch, local, dirty, offline: true, why: '拉取远程失败：' + e.message.split('\n')[0] }; }
    }

    let behind = 0, ahead = 0, remote = null;
    try {
      remote = git(['rev-parse', '--short', 'origin/' + branch]);
      const counts = git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
      const [a, b] = counts.split(/\s+/).map(Number);
      ahead = a || 0; behind = b || 0;
    } catch { /* 没有 upstream */ }

    return { ok: true, branch, local, remote, ahead, behind, dirty };
  } catch (e) {
    return { ok: false, why: '不是 git 仓库或 git 不可用：' + e.message.split('\n')[0] };
  }
}

function pull() {
  const st = check({ fetch: true });
  if (!st.ok) return st;
  if (st.behind === 0) return { ...st, updated: false, why: '已是最新' };

  // 三种情况都不该自动 merge，停下来交给人
  if (st.dirty) return { ...st, updated: false, why: '本地有未提交改动，先处理再更新' };
  if (st.ahead > 0) return { ...st, updated: false, why: `本地有 ${st.ahead} 个未推送提交，快进会失败` };

  try {
    git(['pull', '--ff-only', '--quiet'], { timeout: 30000 });
    const after = check({ fetch: false });
    return {
      ...after, updated: true, from: st.local,
      // 代码已经加载进当前进程了，不重启不会生效——不说清楚会以为更新没用
      needRestart: true,
    };
  } catch (e) {
    return { ...st, updated: false, why: '快进失败：' + e.message.split('\n')[0] };
  }
}

module.exports = { check, pull, ROOT };
