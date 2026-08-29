"""检索质量指标。

Node 侧只算 recall@k / precision@k / top1，这三个都只看"命中没命中"，
不看**命中排在第几**。对注入场景这个区别是要命的：注入有 token 预算，
实际只取前几条，一个正确答案排第 8 位和没召回到几乎没有区别。
所以这里补上位次敏感的 MRR 与 nDCG。

不依赖 numpy：指标本身就是几行算术，手写比引入依赖更清楚，
也便于在面试里逐行讲清楚每个指标在惩罚什么。
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence


def recall_at_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> float:
    """召回率：该找到的里找回了几成。只看有没有，不看排第几。"""
    rel = set(relevant)
    if not rel:
        return 0.0
    hit = len(rel & set(ranked[:k]))
    return hit / len(rel)


def precision_at_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> float:
    """精确率：返回的前 k 条里有几成是对的。

    只看 recall 会奖励"把什么都召回来"，必须和 precision 一起读。
    """
    rel = set(relevant)
    top = ranked[:k]
    if not top:
        return 0.0
    return len(rel & set(top)) / len(top)


def reciprocal_rank(ranked: Sequence[str], relevant: Iterable[str]) -> float:
    """第一个正确答案排第几的倒数。排第 1 得 1.0，排第 5 得 0.2，没有得 0。

    这是对"用户只看前几条"最直接的建模。
    """
    rel = set(relevant)
    for i, key in enumerate(ranked, start=1):
        if key in rel:
            return 1.0 / i
    return 0.0


def average_precision(ranked: Sequence[str], relevant: Iterable[str]) -> float:
    """平均精确率：每命中一次就记一次当前精确率，再对命中数取平均。

    多个正确答案时比 MRR 更全面——MRR 只管第一个。
    """
    rel = set(relevant)
    if not rel:
        return 0.0
    hits = 0
    total = 0.0
    for i, key in enumerate(ranked, start=1):
        if key in rel:
            hits += 1
            total += hits / i
    return total / len(rel)


def dcg(gains: Sequence[float]) -> float:
    """折损累计增益：位次越靠后，增益按 log2 折损。"""
    return sum(g / math.log2(i + 1) for i, g in enumerate(gains, start=1))


def ndcg_at_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> float:
    """归一化 DCG：实际排序的 DCG 除以理想排序的 DCG。

    理想排序 = 所有正确答案都排在最前面。归一化后才能跨查询求平均，
    因为不同查询的正确答案个数不同，DCG 的量纲不可比。
    """
    rel = set(relevant)
    if not rel:
        return 0.0
    gains = [1.0 if key in rel else 0.0 for key in ranked[:k]]
    ideal = [1.0] * min(len(rel), k)
    denom = dcg(ideal)
    return (dcg(gains) / denom) if denom else 0.0


#: 对外暴露的指标表。值签名统一为 (ranked, relevant, k) -> float，
#: 这样 runner 可以无脑遍历，新增指标不用改调用方。
METRICS = {
    "recall@k": recall_at_k,
    "precision@k": precision_at_k,
    "MRR": lambda r, rel, k: reciprocal_rank(r[:k], rel),
    "MAP": lambda r, rel, k: average_precision(r[:k], rel),
    "nDCG@k": ndcg_at_k,
}
