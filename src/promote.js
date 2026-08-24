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
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'not', 'for', 'via', 'on', 'in', 'to', 'of',
  'be', 'is', 'are', 'must', 'should', 'use', 'using', 'used', 'with', 'than', 'rather',
  'through', 'never', 'always', 'instead', 'when', 'that', 'this', 'it', 'by', 'do', 'does']);

function tokenize(s) {
  const t = normalize(s);
  const out = new Set();
  for (const w of t.split(' ')) {
    if (!w) continue;
    if (/[一-龥]/.test(w)) {
      // CJK：字符二元组（中文没有空格，整句会塌成一个词）
      const chars = [...w];
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
      if (chars.length === 1) out.add(chars[0]);
    } else if (w.length > 1 && !STOP.has(w)) {
      // 英文：词本身 + 字符三元组。
      // 只用整词会被词形变化打败——inject/injection、field/fields 被算成不同 token，
      // 同义规范的重叠度只有 0.44，永远到不了阈值。三元组能跨词形匹配上。
      out.add(w);
      for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3));
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

/**
 * 找出话题相关的已有规范（DESIGN §4-③）。
 *
 * ⚠️ 刻意**不自动判断"重复"还是"冲突"**。实测数据：
 *     同义重复 0.64 ｜ 语义对立 0.36 / 0.54 ｜ 无关 0.00
 *   相关与无关分得很开，但**重复与冲突的区间完全重叠** ——
 *   字符串相似度只能判「是不是同一个话题」，判不了「是不是对立」。
 *   靠它自动分类必然出错，而一条被误判为"重复"从而跳过的对立规范，
 *   会让知识库自相矛盾。
 *
 * 所以只负责召回相关项，判断交给 promote 时的人工确认闸 —— 这正是那道闸存在的意义。
 */
const RELATED_THRESHOLD = 0.3;

function findRelated(repo, rule) {
  const store = require('./store');
  const existing = store.getConventions(repo).split(String.fromCharCode(10))
    .filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  return existing
    .map((e) => ({ existing: e, sim: similar(e, rule) }))
    .filter((x) => x.sim >= RELATED_THRESHOLD)
    .sort((a, b) => b.sim - a.sim);
}

module.exports = { record, readyToPromote, ruleKey, similar, findRelated, RELATED_THRESHOLD };
