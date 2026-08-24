'use strict';
/**
 * 零依赖的行级 diff。
 *
 * 用 LCS 动态规划，但对大文件设了上限 —— 学习信号只需要"改了哪几行"，
 * 不需要精确到最优编辑脚本；超限时退化成粗粒度的区间比对，不影响归因质量。
 */

const MAX_LINES = 1500; // 超过就走退化路径，避免 O(n*m) 卡死

/** @returns {{added:string[], removed:string[], hunks:Array<{before:string[],after:string[]}>}} */
function lineDiff(before, after) {
  const A = before.split('\n');
  const B = after.split('\n');
  if (A.length > MAX_LINES || B.length > MAX_LINES) return coarseDiff(A, B);

  // LCS 长度表
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯成 hunk：连续的增删聚成一段，便于归因时看清"这一处改了什么"
  const hunks = [];
  const added = [], removed = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur && (cur.before.length || cur.after.length)) hunks.push(cur); cur = null; };

  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { flush(); i++; j++; continue; }
    cur = cur || { before: [], after: [] };
    if (dp[i + 1][j] >= dp[i][j + 1]) { cur.before.push(A[i]); removed.push(A[i]); i++; }
    else { cur.after.push(B[j]); added.push(B[j]); j++; }
  }
  cur = cur || { before: [], after: [] };
  while (i < A.length) { cur.before.push(A[i]); removed.push(A[i]); i++; }
  while (j < B.length) { cur.after.push(B[j]); added.push(B[j]); j++; }
  flush();

  return { added, removed, hunks };
}

/** 大文件退化路径：掐头去尾，中间整块算一个 hunk */
function coarseDiff(A, B) {
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const before = A.slice(s, A.length - e);
  const after = B.slice(s, B.length - e);
  return { added: after, removed: before, hunks: before.length || after.length ? [{ before, after }] : [] };
}

/** 渲染成统一 diff 文本，喂给归因用 */
function renderHunks(hunks, maxLines = 120) {
  const out = [];
  for (const h of hunks) {
    for (const l of h.before) out.push('- ' + l);
    for (const l of h.after) out.push('+ ' + l);
    out.push('');
    if (out.length > maxLines) { out.push(`… (已截断，共 ${hunks.length} 处改动)`); break; }
  }
  return out.join('\n').trim();
}

module.exports = { lineDiff, renderHunks };
