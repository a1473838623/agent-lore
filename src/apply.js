'use strict';
const store = require('./store');
const attribute = require('./attribute');
const promote = require('./promote');

/**
 * 应用一条归因结论 —— CLI 和看板共用这一份。
 *
 * 抽出来的原因很实际：两个入口各写一遍，闸门条件迟早会漂移，
 * 而"置信度闸"这种东西一旦两边不一致，知识库就会被从松的那一侧污染。
 */
function applyVerdict(repo, verdict) {
  const gate = attribute.accept(verdict);
  if (!gate.ok) {
    store.markClassified(repo, verdict.id);
    return { ok: false, dropped: true, why: gate.why };
  }

  const src = store.listPending(repo).find((p) => p.id === verdict.id) || { file: '?', diff: '' };
  const res = promote.record(repo, verdict, src);
  store.markClassified(repo, verdict.id);
  store.recordMetric({
    type: 'correction',
    repo,
    key: res.key || promote.ruleKey(verdict.rule),
    rule: verdict.rule,
    file: src.file,
  });

  return { ok: true, ...res };
}

/** 直接丢弃一条待归因（业务变更，或用户判断不值得学） */
function dismiss(repo, id) {
  store.markClassified(repo, id);
  return { ok: true };
}

/** 人工确认一条达阈值的规范入库 */
function confirmPromotion(repo, key) {
  const ready = promote.readyToPromote(repo).find((r) => r.key === key);
  if (!ready) return { ok: false, why: '这条候选不存在或已入库' };
  store.addConvention(repo, ready.rule, ready);
  store.recordMetric({ type: 'promote', repo, key: ready.key, rule: ready.rule });
  return { ok: true, rule: ready.rule };
}

module.exports = { applyVerdict, dismiss, confirmPromotion };
