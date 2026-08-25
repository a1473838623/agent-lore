'use strict';
const { similar } = require('./promote');
const embed = require('./embed');

/**
 * 召回 —— 三种模式，统一接口。
 *
 * 做成可切换而不是二选一，是因为**两种模式的强项互补**：
 *   keyword —— 查询是专有名词（类名、方法名、配置项）时精确率高、几乎不误召
 *   vector  —— 查询是自然语言描述（"调用失败要不要重试"）时能跨措辞召回
 * 实测数据见 `lore eval compare`。默认 keyword，不是因为向量不好，
 * 是因为这个场景的查询天然偏向专有名词。
 */

const MODES = ['keyword', 'vector', 'hybrid'];

/** 关键词召回：复用规范归并那套 tokenize（ASCII 按词 + 三元组，CJK 按字符二元组） */
function keywordScores(query, items) {
  return items.map((it) => ({ item: it, score: similar(query, it.rule || String(it)) }));
}

async function vectorScores(query, items, spec) {
  const texts = items.map((it) => it.rule || String(it));
  const [qv, ...vs] = await embed.embedAll([query, ...texts], spec);
  return items.map((it, i) => ({ item: it, score: embed.cosine(qv, vs[i]) }));
}

/**
 * 混合：RRF 倒数排名融合。
 *
 * ⚠️ 第一版用的是「两路各自 max 归一化后加权」，实测有严重问题：
 *   关键词通道天然稀疏，大部分候选是 0 分。只要有一条拿到微弱匹配，
 *   哪怕原始分只有 0.05，max 归一化后也会变成 1.0，直接压过向量通道的真实高分。
 *   实测查「改了配置但程序没生效」时，一条无关的 git 规则因此排到了第 1，
 *   而正确答案掉到第 2。
 *
 * RRF 只看**排名**不看分值，天然免疫两路分数量纲不同的问题，
 * 也免疫稀疏通道的噪声放大。这是生产级混合检索的标准做法。
 *
 * score = Σ 1 / (K + rank)，K 取 60 是通行经验值：
 * K 越大越弱化头部排名的优势，60 在"尊重排名"和"不让单路一票否决"之间比较平衡。
 */
const RRF_K = 60;

function fuse(kw, vec, alpha = 0.5) {
  const rank = (rows) => {
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    const m = new Map();
    sorted.forEach((r, i) => { if (r.score > 0) m.set(r.item, i + 1); });
    return m;
  };
  const rk = rank(kw), rv = rank(vec);
  return kw.map((r) => {
    const a = rk.has(r.item) ? alpha / (RRF_K + rk.get(r.item)) : 0;
    const b = rv.has(r.item) ? (1 - alpha) / (RRF_K + rv.get(r.item)) : 0;
    return { item: r.item, score: a + b };
  });
}

/**
 * @param {'keyword'|'vector'|'hybrid'} mode
 * @returns {Promise<{mode:string, degraded?:string, rows:Array<{item,score}>}>}
 */
async function recall(query, items, { mode = 'keyword', topK = 5, spec, alpha = 0.5 } = {}) {
  if (!items.length) return { mode, rows: [] };

  let rows, degraded;
  if (mode === 'keyword') {
    rows = keywordScores(query, items);
  } else {
    try {
      const vec = await vectorScores(query, items, spec);
      rows = mode === 'vector' ? vec : fuse(keywordScores(query, items), vec, alpha);
    } catch (e) {
      // embedding 不可用时降级到关键词，而不是报错 —— 召回失败不该阻塞编辑
      rows = keywordScores(query, items);
      degraded = e.message;
    }
  }

  rows = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  return { mode, degraded, rows };
}

module.exports = { recall, keywordScores, vectorScores, fuse, MODES };
