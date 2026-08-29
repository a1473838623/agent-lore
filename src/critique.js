'use strict';
const path = require('path');
const { HOME } = require('./config');
const { ensureDir, appendJsonl, readJsonl } = require('./util');

/**
 * 对话层的学习信号 —— 反复出现的口头批评。
 *
 * 【为什么需要这一层】
 * 原有采集只认一种信号：agent 写了文件、人改了、比 diff。这条路有两个盲区：
 *   ① 改动不经 Write/Edit 工具时管道整条不启动 —— 比如整场会话都用脚本改文件；
 *   ② 更根本的是，**有些规范从来不体现为 diff**。
 *      "这段太长""这个词不专业""别写论述句"——人是在对话里说的，
 *      说完 agent 自己去改，diff 里只看得见结果，看不见要求。
 *
 * 补一条正交信号：把人说的**批评本身**存下来。同一类批评重复出现，
 * 就是一条该入库的规范，这个判断不需要看任何文件。
 *
 * 【为什么按类型聚类而不是文本相似度】
 * 批评句里，被引用的具体内容是噪声，抱怨的类型才是信号。
 * "这一段有点长"和"冲突感知那段太长了"文本相似度实测为 0，
 * 但它们显然是同一个抱怨。所以聚类键取**批评类型**，不取文本。
 *
 * 【为什么用关键词而不是模型判断】
 * UserPromptSubmit 在人敲回车后同步执行，加一次推理会让每次提问都卡一下。
 * 关键词不完美，但零延迟、可解释，且误判的代价只是多一条候选——
 * 候选本来就要人工确认才入库。
 */

const FILE = () => path.join(HOME, 'critique.jsonl');

/**
 * 批评类型表。聚类以类型为键，所以词表的作用是**把不同说法归到同一类**，
 * 而不是穷举所有可能的措辞。
 */
const CATEGORIES = {
  length: {
    label: '篇幅过长或过短',
    words: ['太长', '太短', '有点长', '有点短', '太啰嗦', '写得太多', '精简一下'],
  },
  wording: {
    label: '用词不专业',
    words: ['不专业', '太口语', '这个词用', '措辞', '术语不'],
  },
  register: {
    label: '表达方式不合适',
    words: ['不适合', '不太合适', '不合适', '描述类', '论述', '这种表达', '这种描述', '换种表达'],
  },
  soundness: {
    label: '设计或逻辑不合理',
    words: ['不合理', '有问题', '有点问题', '不妥', '设计不', '这样不对'],
  },
  missing: {
    label: '该做没做',
    words: ['为什么没', '为什么不', '怎么没', '没有写', '漏了', '忘了'],
  },
  recurring: {
    label: '同一问题反复出现',
    words: ['还是一样', '又出现', '还是有', '还是没', '怎么还', '老问题', '重复出现'],
  },
  clarity: {
    label: '看不懂或结构混乱',
    words: ['看不懂', '不清楚', '很奇怪', '太乱', '有点乱', '没有归类'],
  },
  rejection: {
    label: '明确否定或要求重做',
    words: ['不对', '不行', '不好', '不该', '不应该', '不需要', '没必要',
      '别写', '别用', '不要用', '不要写', '重写', '应该改'],
  },
};

/** 排除词：命中这些的多半是提问而非批评 */
const EXCLUDE = ['是什么意思', '怎么实现', '有什么区别', '能不能', '可以吗'];

/**
 * 判断是不是批评，返回命中的类型列表。
 * @returns {{cat:string,label:string,word:string}[] | null}
 */
function detect(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return null;   // 过长的多半是贴代码或需求
  if (EXCLUDE.some((e) => t.includes(e))) return null;

  const hits = [];
  for (const [cat, def] of Object.entries(CATEGORIES)) {
    const word = def.words.find((w) => t.includes(w));
    if (word) hits.push({ cat, label: def.label, word });
  }
  return hits.length ? hits : null;
}

/** 记一条批评。fail-open：出任何错都不能影响用户提问 */
function record(repo, text, sessionId) {
  const hits = detect(text);
  if (!hits) return null;
  const rec = {
    repo,
    text: String(text).trim().slice(0, 300),
    cats: hits.map((h) => h.cat),
    session: sessionId || null,
    at: Date.now(),
  };
  try {
    ensureDir(HOME);
    appendJsonl(FILE(), rec);
  } catch { return null; }
  return rec;
}

function all(repo) {
  let rows = [];
  try { rows = readJsonl(FILE()); } catch { return []; }
  return repo ? rows.filter((r) => r.repo === repo) : rows;
}

/**
 * 按批评类型聚合，返回重复出现的类型。
 *
 * @param minSize 重复几次才算模式。默认 2 —— 口头批评的成本比代码修正高，
 *                人愿意说第二遍，说明第一遍确实没被落实，
 *                所以阈值比代码规范的 3 次更低。
 */
function clusters(repo, { minSize = 2 } = {}) {
  const rows = all(repo).sort((a, b) => a.at - b.at);
  const byCat = new Map();

  for (const r of rows) {
    for (const cat of r.cats || []) {
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(r);
    }
  }

  const out = [];
  for (const [cat, group] of byCat) {
    if (group.length < minSize) continue;
    // 跨会话重复比同一会话内重复更强：说明不是一次沟通没说清，而是真没学会
    const sessions = new Set(group.map((g) => g.session).filter(Boolean)).size;
    out.push({
      cat,
      label: (CATEGORIES[cat] || {}).label || cat,
      size: group.length,
      sessions,
      first: group[0].at,
      last: group[group.length - 1].at,
      samples: group.slice(-3).map((g) => g.text),
    });
  }
  return out.sort((a, b) => b.sessions - a.sessions || b.size - a.size);
}

module.exports = { detect, record, all, clusters, CATEGORIES, FILE };
