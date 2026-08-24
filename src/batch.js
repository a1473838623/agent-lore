'use strict';

/**
 * 归因批次 —— 把待归因的 diff 按「一次交互」聚起来。
 *
 * 为什么不以单个 diff 为归因单位：
 *   ① **一次需求改动通常横跨多个文件。** 人改了 5 个文件产生 5 条待归因，
 *      但它们是同一个修正意图，逐条归因是重复劳动。
 *   ② **归因质量受损。** 单看一个文件的 diff，常常判不出是 style 还是 feature；
 *      看到"这次交互里 agent 写了哪些文件、人整体改了什么"，判断会准得多。
 *   ③ **不符合人的记忆单位。** 人记得的是"刚才让它加支付回调，写完我改了几处"，
 *      不是"OrderService.java 第 3 个 hunk"。
 *
 * 聚批依据：`session_id` + agent 写入时间的邻近性。
 *   Claude Code 的 hook 事件给了 session_id，但没给 turn id ——
 *   一个 turn 里 agent 连续写多个文件，时间必然接近，所以用「同会话 + 时间间隔 < GAP」近似一个 turn。
 *
 * 读取时聚合，不落库：批次划分规则一定会调，存下来就得重刷。
 */

const GAP_MS = 3 * 60 * 1000;   // 同会话内，agent 写入间隔超过 3 分钟视为两次交互

function groupPending(pending) {
  const sorted = [...pending].sort((a, b) =>
    String(a.sessionId || '').localeCompare(String(b.sessionId || '')) || a.agentAt - b.agentAt);

  const batches = [];
  let cur = null;
  for (const p of sorted) {
    const sameSession = cur && String(cur.sessionId) === String(p.sessionId || null);
    const closeInTime = cur && (p.agentAt - cur.lastAt) <= GAP_MS;
    if (!sameSession || !closeInTime) {
      cur = {
        id: 'b-' + (p.sessionId ? String(p.sessionId).slice(0, 8) : 'na') + '-' + p.agentAt,
        sessionId: p.sessionId || null,
        agentAt: p.agentAt,
        lastAt: p.agentAt,
        items: [],
      };
      batches.push(cur);
    }
    cur.items.push(p);
    cur.lastAt = Math.max(cur.lastAt, p.agentAt);
  }

  return batches.map((b) => ({
    ...b,
    files: b.items.map((i) => i.file),
    hunks: b.items.reduce((n, i) => n + (i.hunkCount || 0), 0),
    ageMin: Math.min(...b.items.map((i) => i.ageMin)),
  })).sort((a, b) => b.agentAt - a.agentAt);
}

/** 整批渲染成一段 diff 文本，供归因提示词使用 —— 跨文件上下文正是聚批的意义 */
function renderBatch(batch) {
  return batch.items.map((i) =>
    `--- ${i.file} (${i.hunkCount} 处改动)\n${i.diff}`).join('\n\n');
}

module.exports = { groupPending, renderBatch, GAP_MS };
