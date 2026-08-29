"""统计推断：区分"真的更好"和"样本太小碰巧更好"。

为什么需要这一层：评测集只有几十条查询。这个规模下，
"混合召回 92% vs 向量 85%" 这样的差距完全可能是抽样噪声——
换一批查询结论就翻转。只报点估计而不报不确定度，
等于把噪声当成结论，后续所有调参都建立在幻觉上。

两个工具：
  bootstrap_ci  —— 单个策略的指标有多不确定
  paired_test   —— 两个策略的差异是否显著

都用重采样方法而非正态近似：指标是有界的比例值，
分布明显偏斜，t 检验的正态假设在这里不成立。
"""
from __future__ import annotations

import random
from typing import Callable, Sequence

#: 固定随机种子。评测必须可复现——同样的数据跑两次得出不同置信区间，
#: 就没法判断指标变化是代码改动还是重采样抖动导致的。
DEFAULT_SEED = 20260826


def bootstrap_ci(
    values: Sequence[float],
    iters: int = 5000,
    alpha: float = 0.05,
    seed: int = DEFAULT_SEED,
) -> tuple[float, float, float]:
    """自助法置信区间。返回 (点估计, 下界, 上界)。

    做法：从原样本有放回地重抽同样多的条数，算一次均值，重复上万次，
    取结果分布的分位数。它不假设任何分布形状，小样本下比正态近似稳。
    """
    n = len(values)
    if n == 0:
        return (0.0, 0.0, 0.0)
    point = sum(values) / n
    if n == 1:
        return (point, point, point)

    rng = random.Random(seed)
    means = []
    for _ in range(iters):
        resample = [values[rng.randrange(n)] for _ in range(n)]
        means.append(sum(resample) / n)
    means.sort()
    lo = means[int(alpha / 2 * iters)]
    hi = means[min(iters - 1, int((1 - alpha / 2) * iters))]
    return (point, lo, hi)


def paired_permutation_test(
    a: Sequence[float],
    b: Sequence[float],
    iters: int = 10000,
    seed: int = DEFAULT_SEED,
) -> tuple[float, float]:
    """配对置换检验。返回 (均值差 a-b, p 值)。

    **必须配对**：两个策略跑的是同一批查询，查询本身的难易差异是共同的。
    按配对比较能把这部分方差消掉，比独立两样本检验灵敏得多。

    零假设是两个策略无差别，那么每条查询上 a 和 b 的标签可以随意互换。
    随机互换上万次，看实际观测到的差距落在这个分布的哪个位置。
    """
    if len(a) != len(b):
        raise ValueError("配对检验要求两组长度一致")
    n = len(a)
    if n == 0:
        return (0.0, 1.0)

    diffs = [x - y for x, y in zip(a, b)]
    observed = sum(diffs) / n
    if all(d == 0 for d in diffs):
        return (0.0, 1.0)

    rng = random.Random(seed)
    extreme = 0
    for _ in range(iters):
        # 每条差值随机翻转符号 = 随机互换该条上两个策略的归属
        shuffled = sum(d if rng.random() < 0.5 else -d for d in diffs) / n
        if abs(shuffled) >= abs(observed):
            extreme += 1
    # +1 平滑：避免 p=0 这种过度自信的报告
    p = (extreme + 1) / (iters + 1)
    return (observed, p)


def fmt_ci(point: float, lo: float, hi: float, pct: bool = True) -> str:
    """把点估计与区间格式化成一列，方便并排比较。"""
    if pct:
        return f"{point * 100:5.1f}%  [{lo * 100:4.1f}, {hi * 100:4.1f}]"
    return f"{point:.3f}  [{lo:.3f}, {hi:.3f}]"


def significance_label(p: float) -> str:
    """把 p 值翻成人话。评测报告给人看，不该只甩一个数字。"""
    if p < 0.01:
        return "显著"
    if p < 0.05:
        return "边际显著"
    return "不显著"
