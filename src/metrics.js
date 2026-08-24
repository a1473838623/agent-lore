'use strict';
const store = require('./store');
const { similar } = require('./promote');

/**
 * 修正复发率 —— 这个项目唯一的效果指标（DESIGN §4-④）。
 *
 * 一条规范被确认并开始注入之后，同类人工修正应当下降。
 * 不下降有两种可能，必须能区分：① 规范本身没用 ② 注入压根没生效（命中率为 0）。
 */
function stats(repo) {
  // metrics.jsonl 是全局单文件，不按仓库过滤的话，"效果"里会混进别的仓库的规范
  const all = repo ? store.readMetrics().filter((m) => m.repo === repo) : store.readMetrics();
  const promoted = all.filter((m) => m.type === 'promote');
  const corrections = all.filter((m) => m.type === 'correction');
  const injects = all.filter((m) => m.type === 'inject');

  // ⚠️ 必须和升格时用同一套归并逻辑，否则同义但措辞不同的修正会被漏计，
  // "入库前"次数被低估 → 复发率算出来是错的
  const sameRule = (c, p) => c.key === p.key || similar(c.rule || '', p.rule || '') >= 0.6;

  const rows = promoted.map((p) => {
    const before = corrections.filter((c) => sameRule(c, p) && c.at < p.at).length;
    const after = corrections.filter((c) => sameRule(c, p) && c.at >= p.at).length;
    const injected = injects.filter((i) => (i.keys || []).includes(p.key)).length;
    return {
      key: p.key,
      rule: p.rule,
      before,
      after,
      injected,
      // 注入次数为 0 时不能下结论 —— 这就是"区分①和②"的地方
      verdict: injected === 0 ? '未注入过，无法判定'
             : after === 0 ? '✅ 未复发'
             : after < before ? '🟡 复发减少'
             : '❌ 仍在复发，规范可能无效',
    };
  });

  return {
    totalInjects: injects.length,
    totalInjectedTokens: injects.reduce((n, i) => n + (i.tokens || 0), 0),
    hitRate: injects.length ? (injects.filter((i) => (i.keys || []).length).length / injects.length) : 0,
    rules: rows,
  };
}

module.exports = { stats };
