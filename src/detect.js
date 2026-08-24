'use strict';
const fs = require('fs');
const { TUNING } = require('./config');
const { sha1, repoId } = require('./util');
const { lineDiff, renderHunks } = require('./diff');
const store = require('./store');

/**
 * 检测「人类修正」。
 *
 * 判定逻辑（DESIGN §5 L3 保底方案的核心推断）：
 *   agent 写入时留了快照 → 之后文件内容变了 → 且这次变化没有经过 agent 上报
 *   ⇒ 这次变化来自人类
 *
 * 这个推断不依赖任何 harness 特性，只要 agent 的写入被 hook 或 watch 捕获即可成立。
 *
 * 时间窗（TUNING.windowMinutes）是第一道降噪闸：超窗的改动更可能是独立开发，
 * 而不是在纠正 AI（DESIGN §4-① 归因难题）。
 */
function scan(cwd) {
  const repo = repoId(cwd);
  const snaps = store.listSnapshots(repo);
  const found = [];
  const now = Date.now();

  for (const snap of snaps) {
    let current;
    try { current = fs.readFileSync(snap.file, 'utf8'); }
    catch { store.dropSnapshot(repo, snap.file); continue; }   // 文件没了

    if (current === snap.content) continue;                     // 没被改过

    const ageMin = (now - snap.at) / 60000;
    if (ageMin > TUNING.windowMinutes) {
      // 超窗：不采集，但要刷新基准，否则下次会把这段改动重新算一遍
      store.putSnapshot(repo, snap.file, current, snap.sessionId);
      found.push({ file: snap.file, skipped: 'out-of-window', ageMin: Math.round(ageMin) });
      continue;
    }

    const d = lineDiff(snap.content, current);
    if (!d.hunks.length) continue;

    const rec = {
      id: sha1(snap.file + snap.at + current.length).slice(0, 12),
      file: snap.file,
      repo,
      agentAt: snap.at,
      sessionId: snap.sessionId || null,
      humanAt: now,
      ageMin: Math.round(ageMin),
      hunkCount: d.hunks.length,
      diff: renderHunks(d.hunks),
      classified: false,
    };
    store.addPending(repo, rec);
    // 把当前内容设为新基准 —— 同一处修正只学一次
    store.putSnapshot(repo, snap.file, current, snap.sessionId);
    found.push(rec);
  }
  return { repo, found };
}

module.exports = { scan };
