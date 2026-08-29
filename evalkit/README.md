# evalkit —— 检索评测层（Python）

## 为什么是 Python

运行时留在 Node，评测放到 Python，不是为了用两种语言，是职责不同：

| | 语言 | 理由 |
|---|---|---|
| 检索运行时 | Node | 要嵌进 harness 的 hook 里同步执行，embedding 缓存也在那边 |
| 离线评测 | Python | 统计推断、参数扫描、报告，在 Python 里写起来自然得多 |

两侧唯一的契约是 `lore retrieve` 的 stdin/stdout JSONL，没有共享状态。
检索实现只有一份，Python 不重复造。

## 相比 Node 侧 `lore eval compare` 多了什么

**① 位次敏感的指标。** 原来只有 recall/precision/top1，都只看命中与否。
但注入有 token 预算，实际只取前几条 —— 正确答案排第 8 位和没召回几乎没区别。
补上 MRR、MAP、nDCG@k 后才看得出排序质量。

实测价值：向量与混合的 recall 都是 100% 打平，但 nDCG 差 3.7 个百分点，
**混合的真实收益在排序而不在召回** —— 只看 recall 得不出这个结论。

**② 不确定度。** 评测集只有 20 条，这个规模下点估计的差异大多是抽样噪声。
自助法重采样给出 95% 置信区间，配对置换检验判断差异是否显著。

实测价值：keyword 与 hybrid 差 50 个百分点，p=0.0016，显著；
而某次 100% vs 85% 的对比 p=0.25，**看着差 15 个点其实读不出结论**。

**③ 降级守卫。** embedding 后端不可用时检索会静默退回关键词，
这时报出的 vector 成绩其实是关键词的。evalkit 检测到降级会拒绝出数，
而不是给一个看起来正常的假数字。

## 用法

```bash
# 需要 embedding 后端
ollama serve && ollama pull bge-m3

python -m evalkit compare --repo _global --k 3 --by-type
python -m evalkit sweep   --repo _global --mode hybrid
```

Windows 上先设 `PYTHONIOENCODING=utf-8`，否则控制台按 GBK 编码，
中文报告会抛 UnicodeEncodeError。

零第三方依赖，指标与统计量都是手写的标准库实现。

## 一个被评测抓出来的真问题

跨语言归因当初测出「nomic-embed-text 上中文自然语言召回 30%、英文 100%，
换 bge-m3 后中文追平」，但**默认模型一直没改**，
所以任何人克隆下来跑，拿到的都是 30% 那版。
`src/embed.js` 的默认值已据此改为 `ollama:bge-m3` ——
评测得出的结论必须落到默认值上，否则等于没做。
