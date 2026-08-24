# agent-lore

> **让 AI 编码工具从人类的修正里自动学习仓库规范。**
> 你改了它写的代码，那个 diff 就是它该学的东西。

零依赖 · Node ≥18 · MIT · 定位为 **harness 扩展层**，不是 agent，不替代任何工具。

设计文档见 [DESIGN.md](DESIGN.md)。

---

## 它解决什么

现有 AI 编码工具的规范**全靠人手写**（CLAUDE.md / Cursor Rules / Copilot Instructions），
写完就开始腐烂。而每天都在产生一个免费、真实、高质量的学习信号，却被完全丢弃：

> Agent 写了代码，你改了三处。**那三处就是它没学会的东西。**
> 下一次，它还会那样写。

agent-lore 采集这个信号，归因、去噪、累计、提炼成规范，再在下次编辑前带外注入回去。

## 闭环

```
Agent 写文件 ──► 快照
                   │
           人类随后修改             ← 免费、持续、外部信号
                   │  diff
          归因（三分类 + 置信度闸）
           ├─ feature 业务变更 → 丢弃
           ├─ bug     修 AI 的错 → 踩坑，绑定文件
           └─ style   规范修正   → 候选
                   │  同类累计 ≥3 次
             人工确认 → 入库
                   │
        convention → CLAUDE.md（常驻，不检索）
        pitfall    → 编辑前 hook 带外注入（≤300 token）
                   │
          度量：修正复发率           ← 闭环验证
```

## 快速开始

```bash
git clone <repo> && cd agent-lore && npm link   # 或直接用 node bin/lore.js
```

Claude Code（L1，最完整）—— `~/.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Write|Edit|MultiEdit",
      "hooks": [{ "type": "command", "command": "node /abs/path/agent-lore/hooks/pre-edit.js" }] }],
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit",
      "hooks": [{ "type": "command", "command": "node /abs/path/agent-lore/hooks/post-write.js" }] }]
  }
}
```

其他 harness（L3 保底，零依赖任何扩展点）：

```bash
lore watch          # 监听 git 工作区，未经上报的变更即视为人类修正
```

## 日常用法

```bash
lore scan                  # 检测人类修正
lore review                # 输出归因提示词 → 交给当前 harness 的模型判断
lore learn --json '{...}'  # 回灌归因结果
lore promote               # 看达阈值的规范
lore promote --yes         # 人工确认入库
lore sync                  # 规范写进项目 CLAUDE.md
lore stats                 # 修正复发率
```

有 `ANTHROPIC_API_KEY` 时可以 `lore auto` 无人值守归因；没有也能完整工作 —— **归因默认借用当前 harness 里的模型，零配置零 key**。

## 五条设计约束

| # | 约束 | 为什么 |
|---|---|---|
| 1 | **未命中零注入** | 不是注入"无相关知识"，是完全不动 |
| 2 | **单次 ≤300 token** | 注入过多就是污染上下文 |
| 3 | **fail-open** | 查询超时/失败/文件不存在一律放行，绝不阻塞编辑 |
| 4 | **人工确认闸** | 学到一条错规范的代价 >> 漏掉一条对规范 |
| 5 | **不改 agent 本身** | 只在工具调用边界介入 |

与 [agent-beacon](https://github.com/a1473838623/agent-beacon) 共享这套约束 —— 同一方法论的两个应用。

## 已知边界

- **归因准确率是天花板。** 人对文件的改动大部分是业务演进而非纠正 AI，噪声占多数。
  三道闸（置信度阈值、30 分钟采集窗、≥3 次累计）都是在压误报，代价是召回偏低。
- **同类归并是关键词级的**（ASCII 按词 + CJK 字符二元组），不是语义聚类。措辞差异过大时会漏并。
- **`lore stats` 在注入次数为 0 时不下结论** —— 必须能区分"规范没用"和"注入没生效"。
- 检索刻意不上向量：检索词天然是专有名词，关键词精确率更高。规模到千级再换，接口不变。

## 目录

```
~/.agent-lore/
├── convention/<repo>.md    规范 → 全量常驻
├── pitfall/<repo>/*.jsonl  踩坑 → 按路径/符号注入
├── candidate/*.jsonl       未达阈值的候选
├── pending/*.jsonl         待归因
├── snapshot/               agent 写入快照
└── metrics.jsonl           注入与复发记录
```

全是 markdown / JSONL：可读、可 git、可手改、可 Grep。**索引损坏删掉重建即可，数据永不锁在索引里。**

## License

MIT
