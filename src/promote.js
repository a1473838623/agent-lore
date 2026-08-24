'use strict';
const { TUNING } = require('./config');
const { sha1 } = require('./util');
const store = require('./store');

/**
 * 泛化：一次修正是个例，累计 N 次才升格为规范（DESIGN §4-②）。
 *
 * 「同类」在**规范描述层面**做归并，不是在 diff 文本层面 ——
 * 同一条规范在不同文件里的 diff 可以长得完全不同。
 * v0 用归一化后的描述做精确匹配 + 关键词重叠；v1 换成语义聚类。
 */

const normalize = (rule) => rule.toLowerCase()
  .replace(/[`"'，。、；：！？,.;:!?()（）\s]+/g, ' ')
  .trim();

const ruleKey = (rule) => sha1(normalize(rule)).slice(0, 10);

/**
 * 规范描述的相似度。
 *
 * ⚠️ 不能按空格切词 —— 中文没有空格，整句会被切成一个 token，同义规范算出来相似度极低。
 * 所以：ASCII 按词切，CJK 按**字符二元组**切（和 SQLite FTS5 用 trigram 处理中文同理）。
 * 用 overlap coefficient 而非 Jaccard，避免长短句被长度差异惩罚。
 */
function tokenize(s) {
  const t = normalize(s);
  const out = new Set();
  for (const w of t.split(' ')) {
    if (!w) continue;
    if (/[一-龥]/.test(w)) {
      // CJK：字符二元组
      const chars = [...w];
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
      if (chars.length === 1) out.add(chars[0]);
    } else if (w.length > 1) {
      out.add(w);
    }
  }
  return out;
}

function similar(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

/** 记一条已归因的候选，并返回它当前累计到几次 */
function record(repo, verdict, source) {
  const rec = {
    key: ruleKey(verdict.rule),
    rule: verdict.rule,
    label: verdict.label,
    confidence: verdict.confidence,
    file: source.file,
    diff: source.diff,
    at: Date.now(),
  };

  if (verdict.label === 'bug') {
    // 踩坑绑定到具体文件，不需要累计阈值 —— 它本来就是个例
    store.addPitfall(repo, rec);
    return { kind: 'pitfall', count: 1, promoted: true, rule: rec.rule };
  }

  store.addCandidate(repo, rec);
  const all = store.listCandidates(repo).filter((c) => c.label === 'style');
  const group = all.filter((c) => c.key === rec.key || similar(c.rule, rec.rule) >= 0.6);
  return {
    kind: 'convention',
    count: group.length,
    threshold: TUNING.promoteThreshold,
    promoted: false,
    rule: rec.rule,
    key: rec.key,
    firstSeen: Math.min(...group.map((c) => c.at)),
  };
}

/** 列出达到阈值、等待人工确认的规范 */
function readyToPromote(repo) {
  const all = store.listCandidates(repo).filter((c) => c.label === 'style');
  const groups = new Map();
  for (const c of all) {
    let hit = null;
    for (const [k, g] of groups) if (k === c.key || similar(g[0].rule, c.rule) >= 0.6) { hit = k; break; }
    if (hit) groups.get(hit).push(c);
    else groups.set(c.key, [c]);
  }
  const existing = store.getConventions(repo);
  return [...groups.entries()]
    .filter(([k, g]) => g.length >= TUNING.promoteThreshold && !existing.includes(`id=${k}`))
    .map(([key, g]) => ({
      key,
      rule: g[0].rule,
      count: g.length,
      firstSeen: Math.min(...g.map((c) => c.at)),
      files: [...new Set(g.map((c) => c.file))],
    }));
}

module.exports = { record, readyToPromote, ruleKey, similar };
