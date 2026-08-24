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

  // 够格的直接入库，不占用人的注意力；边缘情况才留给待确认
  const auto = promote.autoPromote(repo);

  return { ok: true, ...res, autoPromoted: auto.map((a) => a.rule) };
}

/** 批量自动归因：需要 ANTHROPIC_API_KEY。没有 key 时返回原因，让调用方给出降级提示 */
async function autoAttribute(repo, cwd) {
  const key = process.env.ANTHROPIC_API_KEY;
  const pending = store.listPending(repo);
  if (!pending.length) return { ok: true, done: 0, why: '没有待归因的修正' };
  if (!key) {
    return { ok: false, needKey: true,
      why: '自动归因需要 ANTHROPIC_API_KEY。未设置时可用 lore review 把提示词交给当前 harness 的模型判断' };
  }
  const verdicts = await attribute.classifyViaApi(pending, key);
  const results = verdicts.map((v) => ({ id: v.id, label: v.label, ...applyVerdict(repo, v) }));
  return {
    ok: true,
    done: results.length,
    kept: results.filter((r) => r.ok).length,
    dropped: results.filter((r) => !r.ok).length,
    autoPromoted: [...new Set(results.flatMap((r) => r.autoPromoted || []))],
  };
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

module.exports = { applyVerdict, dismiss, confirmPromotion, autoAttribute };
