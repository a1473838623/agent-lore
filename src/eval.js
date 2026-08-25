'use strict';
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { ensureDir, readJsonl, appendJsonl, repoId } = require('./util');
const store = require('./store');
const promote = require('./promote');
const recallMod = require('./recall');

/**
 * 召回评测 —— 这个项目里唯一能回答「检索到底该用哪种」的东西。
 *
 * 为什么必须有：
 *   「我用了向量检索」和「我测了两种检索、知道各自什么时候更好」是两个层次。
 *   而且没有评测就没法回答本项目最核心的一个设计追问 ——
 *   **为什么规范走常驻、经验走检索，以及经验检索为什么默认关键词而不是向量。**
 *
 * 评测集格式（JSONL，人工标注）：
 *   {"q": "查询", "expect": ["ruleKey1", ...], "type": "symbol|natural"}
 *
 * `type` 是关键维度，不是可选字段：
 *   symbol  —— 查询含专有名词（类名/方法名/配置项），贴近真实使用
 *   natural —— 自然语言描述（"调用失败要不要重试"）
 *   两类分开统计，才能看出两种召回各自的强项；混在一起算总分会把结论抹平。
 */

const evalFile = (repo) => path.join(HOME, 'eval', repo + '.jsonl');

function load(repo) {
  return readJsonl(evalFile(repo)).filter((r) => r.q && Array.isArray(r.expect));
}

function add(repo, rec) {
  ensureDir(path.dirname(evalFile(repo)));
  appendJsonl(evalFile(repo), rec);
}

/** 被检索的候选池：规范 + 踩坑，都带上稳定的 key 便于标注 */
function corpus(repo) {
  const conv = store.getConventions(repo).split(String.fromCharCode(10))
    .filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
    .map((rule) => ({ key: promote.ruleKey(rule), rule, kind: 'convention' }));
  const pits = store.allPitfalls(repo)
    .map((p) => ({ key: p.key || promote.ruleKey(p.rule), rule: p.rule, kind: 'pitfall', file: p.file }));
  return [...conv, ...pits];
}

/** 单条查询的 recall@k：期望命中里有几个进了 top-k */
async function scoreOne(q, items, mode, k, spec) {
  const { rows, degraded } = await recallMod.recall(q.q, items, { mode, topK: k, spec });
  const got = rows.map((r) => r.item.key);
  const hit = q.expect.filter((e) => got.includes(e)).length;
  return {
    recall: q.expect.length ? hit / q.expect.length : 0,
    // 精确率：top-k 里有多少是该命中的。只看 recall 会奖励"把什么都召回来"
    precision: got.length ? hit / got.length : 0,
    top1: got[0] && q.expect.includes(got[0]) ? 1 : 0,
    degraded,
  };
}

async function run(repo, { mode = 'keyword', k = 3, spec } = {}) {
  const qs = load(repo);
  if (!qs.length) return { error: '评测集为空，先跑 lore eval init' };
  const items = corpus(repo);
  if (!items.length) return { error: '候选池为空：还没有规范或踩坑' };

  const byType = {};
  let degraded = null;
  for (const q of qs) {
    const t = q.type || 'unknown';
    const s = await scoreOne(q, items, mode, k, spec);
    if (s.degraded) degraded = s.degraded;
    (byType[t] = byType[t] || []).push(s);
  }

  const agg = (rows) => ({
    n: rows.length,
    recall: rows.reduce((a, b) => a + b.recall, 0) / rows.length,
    precision: rows.reduce((a, b) => a + b.precision, 0) / rows.length,
    top1: rows.reduce((a, b) => a + b.top1, 0) / rows.length,
  });

  const all = Object.values(byType).flat();
  return {
    mode, k, degraded,
    corpusSize: items.length,
    overall: agg(all),
    byType: Object.fromEntries(Object.entries(byType).map(([t, r]) => [t, agg(r)])),
  };
}

/** 三种模式跑同一份评测集，输出对照 —— 这才是能写进简历的那个数字 */
async function compare(repo, { k = 3, spec } = {}) {
  const out = {};
  for (const mode of recallMod.MODES) out[mode] = await run(repo, { mode, k, spec });
  return { k, results: out };
}

/**
 * 生成评测集骨架：把每条规范/踩坑各出一道题，query 留空由人填。
 * 刻意不自动生成 query —— 用模型造 query 再用模型检索，等于自己给自己出题，
 * 测出来的数字没有意义。
 */
function initSkeleton(repo) {
  const items = corpus(repo);
  const existing = new Set(load(repo).map((r) => r.q));
  const rows = items.map((it) => ({
    q: '', expect: [it.key], type: 'symbol',
    _hint: it.rule.slice(0, 90),
  })).filter((r) => !existing.has(r.q));
  return { file: evalFile(repo), rows, corpusSize: items.length };
}

module.exports = { load, add, corpus, run, compare, initSkeleton, evalFile };
