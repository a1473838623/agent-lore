"""agent-lore 检索评测 CLI。

    python -m evalkit compare --repo _global
    python -m evalkit compare --repo _global --by-type
    python -m evalkit sweep   --repo _global --mode hybrid

与 Node 侧 lore eval compare 的区别：那边给点估计，这边给不确定度。
小评测集上，没有置信区间的点估计会把抽样噪声读成策略差异。
"""
from __future__ import annotations

import argparse
import io
import sys
from collections import defaultdict

from .runner import DegradedError, evaluate, load_eval_set
from .stats import bootstrap_ci, fmt_ci, paired_permutation_test, significance_label

# Windows 控制台默认 GBK，中文与制表符会抛 UnicodeEncodeError 直接中断整个报告
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

MODES = ["keyword", "vector", "hybrid"]


def _table(rows: list[list[str]], head: list[str]) -> str:
    widths = [max(len(str(r[i])) for r in [head] + rows) for i in range(len(head))]
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(head))
    sep = "  ".join("-" * widths[i] for i in range(len(head)))
    body = "\n".join("  ".join(str(r[i]).ljust(widths[i]) for i in range(len(head))) for r in rows)
    return f"{line}\n{sep}\n{body}"


def cmd_compare(args):
    queries = load_eval_set(args.repo)
    print(f"评测集 {len(queries)} 条  ·  k={args.k}  ·  自助法 {args.iters} 次重采样\n")

    results = {}
    for mode in MODES:
        try:
            cols, _ = evaluate(args.repo, mode, args.k, queries)
            results[mode] = cols
        except DegradedError as e:
            # 不出数、只说明原因。给出降级后的数字等于伪造该策略的成绩
            print(f"  ⚠️ {mode} 已排除：{e}")
        except Exception as e:  # 其它故障不该让整份报告挂掉
            print(f"  {mode}: 跳过（{e}）")

    if not results:
        return 1

    metric_names = list(next(iter(results.values())).keys())
    for metric in metric_names:
        rows = []
        for mode, cols in results.items():
            point, lo, hi = bootstrap_ci(cols[metric], iters=args.iters)
            rows.append([mode, fmt_ci(point, lo, hi)])
        print(f"\n[{metric}]  点估计与 95% 置信区间")
        print(_table(rows, ["策略", "值  [下界, 上界]"]))

    # 两两配对检验：同一批查询上比，消掉查询难易带来的共同方差
    print("\n\n配对置换检验  ·  同一批查询上两策略是否真有差异")
    pairs = [(a, b) for i, a in enumerate(MODES) for b in MODES[i + 1:]
             if a in results and b in results]
    rows = []
    for a, b in pairs:
        diff, p = paired_permutation_test(results[a]["recall@k"], results[b]["recall@k"],
                                          iters=args.iters)
        rows.append([f"{a} vs {b}", f"{diff * 100:+.1f}pt", f"{p:.4f}", significance_label(p)])
    print(_table(rows, ["对比", "recall 差值", "p 值", "结论"]))

    if args.by_type:
        _by_type(args, queries, results)
    return 0


def _by_type(args, queries, results):
    """按查询形态拆开看。整体平均会把两类相反的表现抵消掉，
    掩盖掉"符号查询关键词就够、自然语言必须上向量"这个关键结论。"""
    buckets = defaultdict(list)
    for i, q in enumerate(queries):
        buckets[q.get("type", "unknown")].append(i)

    print("\n\n按查询形态拆分  ·  recall@k")
    head = ["形态", "条数"] + list(results.keys())
    rows = []
    for t, idxs in sorted(buckets.items()):
        row = [t, str(len(idxs))]
        for mode, cols in results.items():
            vals = [cols["recall@k"][i] for i in idxs]
            row.append(f"{sum(vals) / len(vals) * 100:.0f}%" if vals else "-")
        rows.append(row)
    print(_table(rows, head))


def cmd_sweep(args):
    """扫 topK：注入有 token 预算，k 不是越大越好，要看边际收益在哪拐弯。"""
    queries = load_eval_set(args.repo)
    print(f"参数扫描  mode={args.mode}  评测集 {len(queries)} 条\n")
    rows = []
    prev = None
    for k in [1, 3, 5, 10, 20]:
        cols, _ = evaluate(args.repo, args.mode, k, queries)
        r = sum(cols["recall@k"]) / len(cols["recall@k"])
        n = sum(cols["nDCG@k"]) / len(cols["nDCG@k"])
        delta = "-" if prev is None else f"{(r - prev) * 100:+.1f}pt"
        rows.append([str(k), f"{r * 100:.1f}%", f"{n:.3f}", delta])
        prev = r
    print(_table(rows, ["k", "recall@k", "nDCG@k", "较上一档"]))
    return 0


def main():
    ap = argparse.ArgumentParser(prog="evalkit", description="agent-lore 检索评测")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("compare", help="三种策略对照，带置信区间与显著性检验")
    c.add_argument("--repo", default="_global")
    c.add_argument("--k", type=int, default=5)
    c.add_argument("--iters", type=int, default=5000)
    c.add_argument("--by-type", action="store_true", help="按查询形态拆分")
    c.set_defaults(fn=cmd_compare)

    s = sub.add_parser("sweep", help="扫描 topK，看边际收益拐点")
    s.add_argument("--repo", default="_global")
    s.add_argument("--mode", default="hybrid")
    s.set_defaults(fn=cmd_sweep)

    args = ap.parse_args()
    try:
        sys.exit(args.fn(args))
    except FileNotFoundError as e:
        print(str(e)); sys.exit(1)


if __name__ == "__main__":
    main()
