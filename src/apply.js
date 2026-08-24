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

/**
 * 对整个批次应用一条归因。
 *
 * 🔑 计数语义：**一个批次只算一次证据，不是 N 次。**
 *   一次交互里 agent 写了 5 个文件、人用同样方式改了 5 处，这是**一个人做的一个决定**，
 *   不是 5 个独立证据。按 N 次计，单次交互就能顶到升格阈值，
 *   "累计 ≥3 次才泛化"这道闸就形同虚设了。
 *
 * 例外是 bug：踩坑绑定具体文件，所以批次内每个文件各记一条。
 */
function applyBatch(repo, { ids = [], label, rule, confidence }) {
  if (!ids.length) return { ok: false, why: '批次为空' };
  const gate = attribute.accept({ label, rule, confidence });
  if (!gate.ok) {
    ids.forEach((id) => store.markClassified(repo, id));
    return { ok: false, dropped: true, why: gate.why, count: ids.length };
  }

  const pending = store.listPending(repo);
  const items = ids.map((id) => pending.find((p) => p.id === id)).filter(Boolean);

  let res;
  if (label === 'bug') {
    // 踩坑按文件绑定，逐个文件记
    for (const it of items) res = promote.record(repo, { label, rule, confidence }, it);
    res = { ...res, files: items.length };
  } else {
    // 规范：整批只记一条候选
    res = promote.record(repo, { label, rule, confidence }, items[0] || { file: '?', diff: '' });
  }

  ids.forEach((id) => store.markClassified(repo, id));
  store.recordMetric({
    type: 'correction', repo,
    key: res.key || promote.ruleKey(rule), rule,
    file: (items[0] || {}).file, batchSize: items.length,
  });

  const auto = promote.autoPromote(repo);
  return { ok: true, ...res, batchSize: items.length, autoPromoted: auto.map((a) => a.rule) };
}

/** 直接丢弃一条或一批待归因（业务变更，或用户判断不值得学） */
function dismiss(repo, id) {
  const ids = Array.isArray(id) ? id : [id];
  ids.forEach((x) => store.markClassified(repo, x));
  return { ok: true, count: ids.length };
}

/** 人工确认一条达阈值的规范入库 */
function confirmPromotion(repo, key) {
  const ready = promote.readyToPromote(repo).find((r) => r.key === key);
  if (!ready) return { ok: false, why: '这条候选不存在或已入库' };
  store.addConvention(repo, ready.rule, ready);
  store.recordMetric({ type: 'promote', repo, key: ready.key, rule: ready.rule });
  return { ok: true, rule: ready.rule };
}

module.exports = { applyVerdict, applyBatch, dismiss, confirmPromotion, autoAttribute };
