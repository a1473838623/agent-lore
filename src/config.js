'use strict';
const os = require('os');
const path = require('path');

const HOME = process.env.AGENT_LORE_HOME || path.join(os.homedir(), '.agent-lore');

module.exports = {
  HOME,
  DIRS: {
    convention: path.join(HOME, 'convention'),   // 仓库级规范 → 全量常驻注入
    pitfall:    path.join(HOME, 'pitfall'),      // 踩坑 → 按路径/符号注入
    candidate:  path.join(HOME, 'candidate'),    // 未达阈值的候选
    snapshot:   path.join(HOME, 'snapshot'),     // agent 写入快照
    pending:    path.join(HOME, 'pending'),      // 待归因的 diff
  },
  METRICS: require('path').join(HOME, 'metrics.jsonl'),

  // —— 可调参数。四个真难题里有三个的旋钮在这 ——
  // 阈值定高学不到，定低学到噪声；应当用 `lore stats` 的复发率反调（DESIGN §4-②）
  TUNING: {
    // 归因置信度下限。宁可漏，不可错 —— 学到一条错规范的代价远高于漏掉一条对的
    minConfidence: 0.75,
    // 同类修正累计多少次才升格为 convention
    promoteThreshold: 3,
    // 采集时间窗（分钟）。超过这个窗口的改动视为独立开发，不是在纠正 AI
    windowMinutes: 30,
    // 单次注入 token 预算上限（粗略按 char/4 估算）
    injectTokenBudget: 300,
    // 单个文件快照体积上限，超过不采集（避免把生成物/大文件塞进来）
    maxFileBytes: 256 * 1024,

    // —— 分级自动入库 ——
    // 错规范的代价不对称：入库后每次编辑都注入、污染所有后续代码，且不易察觉；
    // 漏一条只是下次再学。所以闸门有价值，但不该每条都问人。
    // 同时满足这三条才自动入库，否则进"待确认"由人判断。
    autoPromote: {
      minCount: 5,            // 累计次数远超升格阈值（3）
      minAvgConfidence: 0.9,  // 归因平均置信度很高
      requireNoRelated: true, // 与已有规范无话题重叠（有重叠可能是重复或冲突，必须人看）
    },
  },
};
