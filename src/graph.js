'use strict';
const path = require('path');
const store = require('./store');
const promote = require('./promote');
const tags = require('./tags');
const { TUNING } = require('./config');

/**
 * 知识层 —— 建在文件存储之上，不替换它。
 *
 * 文件存储解决的是「怎么存」：可读、可 git、可手改、无服务，这些不该丢。
 * 但只有存储层，每条规则就是一个孤立的字符串 —— 看不出它从哪来、
 * 和别的规则什么关系、现在还有没有用。
 *
 * 这一层不引入任何新数据，只把已有数据里**隐含的关系**显式化：
 *   血缘 lineage    —— 规则 ← 证据 diff ← 来源文件
 *   覆盖 coverage   —— 知识在技术域上的分布，以及空白区
 *   生命周期 lifecycle —— 规则当前是否还有效
 */

/** 规则的完整血缘：它是怎么来的、被用过几次、有没有用 */
function lineage(repo, ruleKey) {
  const conv = store.getConventions(repo).split(String.fromCharCode(10));
  let rule = null;
  for (let i = 0; i < conv.length; i++) {
    if (!conv[i].startsWith('- ')) continue;
    const text = conv[i].slice(2).trim();
    if (promote.ruleKey(text) === ruleKey || (conv[i + 1] || '').includes('id=' + ruleKey)) {
      rule = text; break;
    }
  }
  if (!rule) return null;

  // 证据：所有归因到这条规则的候选记录，以及它们的来源 diff
  const evidence = store.listCandidates(repo)
    .filter((c) => c.key === ruleKey || promote.similar(c.rule, rule) >= 0.6)
    .map((c) => ({ file: c.file, diff: c.diff, at: c.at, confidence: c.confidence, rule: c.rule }))
    .sort((a, b) => a.at - b.at);

  const m = store.readMetrics().filter((x) => x.repo === repo);
  const promoted = m.find((x) => x.type === 'promote' && x.key === ruleKey);
  const injections = m.filter((x) => x.type === 'inject' && (x.keys || []).includes(ruleKey));
  const corrections = m.filter((x) => x.type === 'correction'
    && (x.key === ruleKey || promote.similar(x.rule || '', rule) >= 0.6));

  const at = promoted ? promoted.at : null;
  const before = at ? corrections.filter((c) => c.at < at).length : corrections.length;
  const after = at ? corrections.filter((c) => c.at >= at).length : 0;

  return {
    key: ruleKey,
    rule,
    tags: tags.derive(rule).all,
    promotedAt: at,
    source: promoted && promoted.source ? promoted.source : 'correction',
    evidence,
    files: [...new Set(evidence.map((e) => e.file).filter(Boolean))],
    injections: injections.length,
    injectedTokens: injections.reduce((n, x) => n + (x.tokens || 0), 0),
    recurrence: { before, after },
    related: promote.findRelated(repo, rule).filter((r) => r.existing !== rule),
    ...classify({ at, injections: injections.length, before, after }),
  };
}

/**
 * 生命周期分类 —— 这是「知识治理」，不是可视化。
 *
 * 一个知识库最大的问题不是存不下，是**存了一堆没人用、或者用了没效果的东西**，
 * 而这两种都不会自己冒出来说话。
 */
function classify({ at, injections, before, after }) {
  if (!at) return { state: 'candidate', why: '尚未入库' };
  const ageDays = (Date.now() - at) / 86400000;

  if (injections === 0) {
    return ageDays > 14
      ? { state: 'stale', why: `入库 ${Math.round(ageDays)} 天从未被注入 —— 对应场景不再出现，可能已过时` }
      : { state: 'fresh', why: '刚入库，还没有注入记录' };
  }
  if (after === 0) return { state: 'effective', why: `注入 ${injections} 次，入库后未再复发` };
  if (after < before) return { state: 'partial', why: `复发减少 ${before} → ${after}，但仍有发生` };
  return { state: 'suspect', why: `注入 ${injections} 次但复发未减 ${before} → ${after} —— 规范可能无效或表述不清` };
}

const STATE_LABEL = {
  candidate: '候选中', fresh: '新入库', effective: '有效',
  partial: '部分见效', stale: '疑似过时', suspect: '疑似无效',
};

/** 全库的生命周期分布 */
function lifecycle(repo) {
  const rules = store.getConventions(repo).split(String.fromCharCode(10))
    .filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  return rules.map((r) => lineage(repo, promote.ruleKey(r))).filter(Boolean);
}

/**
 * 覆盖地图 —— 知识在技术域上的分布，以及**空白区**。
 * 空白比密集更有信息量：某个域一条规则都没有，要么那里没踩过坑，要么踩了没沉淀。
 */
function coverage(repos) {
  // 接受多个作用域：实际生效的是"本仓库 + 通用"之和，只算一边会低估覆盖
  const list = Array.isArray(repos) ? repos : [repos];
  const items = list.flatMap((repo) => [
    ...store.getConventions(repo).split(String.fromCharCode(10))
      .filter((l) => l.startsWith('- ')).map((l) => ({ rule: l.slice(2).trim(), kind: 'convention' })),
    ...store.allPitfalls(repo).map((p) => ({ rule: p.rule, kind: 'pitfall', file: p.file })),
  ]);

  const byTag = new Map();
  for (const it of items) {
    const t = tags.derive(it.rule);
    for (const tag of t.all) {
      if (!byTag.has(tag)) byTag.set(tag, { tag, convention: 0, pitfall: 0, primary: 0 });
      byTag.get(tag)[it.kind]++;
      if (tag === t.primary) byTag.get(tag).primary++;
    }
  }

  // 代码侧覆盖：踩坑绑定了文件，按目录聚合，能看出哪些模块沉淀了知识
  const byDir = new Map();
  for (const p of list.flatMap((r) => store.allPitfalls(r))) {
    if (!p.file) continue;
    const d = path.dirname(p.file).split(/[\\/]/).slice(-2).join('/');
    byDir.set(d, (byDir.get(d) || 0) + 1);
  }

  // 空白：标签体系里存在但一条知识都没有的域
  const known = new Set(byTag.keys());
  const allTags = [...tags.SCOPE, ...tags.KIND].map(([n]) => n);
  const gaps = allTags.filter((t) => !known.has(t));

  return {
    total: items.length,
    byTag: [...byTag.values()].sort((a, b) => (b.convention + b.pitfall) - (a.convention + a.pitfall)),
    byDir: [...byDir.entries()].map(([dir, n]) => ({ dir, n })).sort((a, b) => b.n - a.n),
    gaps,
  };
}

/**
 * 关系图 —— 节点是规则，边是话题相关度。
 * 边不是为了好看：**连成簇的说明该领域知识已成体系，孤立点说明那条规则没有上下文**，
 * 而孤立点往往就是最容易被误用或过时的那些。
 */
function graph(repos, { threshold = 0.3 } = {}) {
  const list = Array.isArray(repos) ? repos : [repos];
  const rules = list.flatMap((repo) => store.getConventions(repo).split(String.fromCharCode(10))
    .filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()));

  const nodes = rules.map((rule, i) => {
    const t = tags.derive(rule);
    return { id: i, key: promote.ruleKey(rule), rule, tag: t.primary, tags: t.all };
  });

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const w = promote.similar(nodes[i].rule, nodes[j].rule);
      if (w >= threshold) edges.push({ a: i, b: j, w: Number(w.toFixed(2)) });
    }
  }

  const degree = new Array(nodes.length).fill(0);
  edges.forEach((e) => { degree[e.a]++; degree[e.b]++; });
  nodes.forEach((n, i) => { n.degree = degree[i]; });

  return { nodes, edges, isolated: nodes.filter((n) => !n.degree).length, threshold };
}

module.exports = { lineage, lifecycle, coverage, graph, classify, STATE_LABEL };
