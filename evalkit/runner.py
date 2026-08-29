"""执行层：驱动 Node 侧检索，收集每条查询的指标向量。

分工的理由：检索必须留在 Node——它要嵌进 harness 的 hook 里同步跑，
而且 embedding 缓存在那边。评测留在 Python——统计推断、参数扫描
在这边写起来自然得多。两侧通过 stdin/stdout 的 JSONL 通信，
契约就是 lore retrieve 那一个命令，没有共享状态。

批量而非逐条调用：一次起进程跑完整个评测集，
embedding 进程内缓存才有意义，否则每条查询都要重新起 node 并重算向量。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from .metrics import METRICS

ROOT = Path(__file__).resolve().parent.parent
LORE_BIN = ROOT / "bin" / "lore.js"
HOME = Path(os.environ.get("AGENT_LORE_HOME", Path.home() / ".agent-lore"))

# Windows 上起子进程会闪控制台窗口，stdio 重定向挡不住，必须显式压掉。
# 参数扫描要起几十次 node，不压的话满屏黑框闪。
_NO_WINDOW = {"creationflags": 0x08000000} if sys.platform == "win32" else {}


def load_eval_set(repo: str) -> list[dict[str, Any]]:
    """读评测集。每行 {"q": 查询, "expect": [正确的 ruleKey], "type": 查询形态}"""
    path = HOME / "eval" / f"{repo}.jsonl"
    if not path.exists():
        raise FileNotFoundError(
            f"找不到评测集 {path}\n先跑： node bin/lore.js eval init --repo {repo}"
        )
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("q") and rec.get("expect"):
            out.append(rec)
    return out


def retrieve(queries: list[dict], repo: str, mode: str, k: int) -> dict[str, list[str]]:
    """调 Node 批量检索，返回 {查询id: [排序后的 ruleKey]}。"""
    payload = "\n".join(
        json.dumps({"id": str(i), "q": q["q"]}, ensure_ascii=False)
        for i, q in enumerate(queries)
    )
    proc = subprocess.run(
        ["node", str(LORE_BIN), "retrieve", "--repo", repo, "--mode", mode, "--k", str(k)],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(ROOT),
        timeout=300,
        **_NO_WINDOW,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"检索失败 mode={mode}: {(proc.stderr or '').strip()[:200]}")

    ranked: dict[str, list[str]] = {}
    degraded = 0
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        ranked[rec["id"]] = rec.get("ranked", [])
        if rec.get("degraded"):
            degraded += 1
    return ranked, degraded


def score(queries: list[dict], ranked: dict[str, list[str]], k: int) -> dict[str, list[float]]:
    """把排名换算成每条查询的各项指标。

    返回**逐条**而非平均值：统计检验需要原始的每条数值，
    先平均就没法算置信区间，也没法做配对比较。
    """
    cols: dict[str, list[float]] = {name: [] for name in METRICS}
    for i, q in enumerate(queries):
        r = ranked.get(str(i), [])
        for name, fn in METRICS.items():
            cols[name].append(fn(r, q["expect"], k))
    return cols


class DegradedError(RuntimeError):
    """向量后端不可用时被抛出。

    **必须拦住而不是照常出数**：embedding 拿不到时检索会静默退回关键词，
    这时报出来的 "vector 60%" 其实是关键词的成绩，读的人无从分辨。
    一个会悄悄给出错误数字的评测，比没有评测更危险——
    它会让人基于假数据下策略结论。
    """


def evaluate(repo: str, mode: str, k: int, queries: list[dict] | None = None,
             allow_degraded: bool = False):
    """跑一个策略，返回 (逐条指标, 查询列表)。

    向量类策略一旦发生降级就抛错，除非显式 allow_degraded。
    """
    qs = queries if queries is not None else load_eval_set(repo)
    ranked, degraded = retrieve(qs, repo, mode, k)
    if degraded and mode != "keyword" and not allow_degraded:
        raise DegradedError(
            f"{mode} 有 {degraded}/{len(qs)} 条查询降级为关键词检索，"
            f"该模式的数字不可信。请先启动 embedding 后端： ollama serve"
        )
    return score(qs, ranked, k), qs
