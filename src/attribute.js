'use strict';
const https = require('https');
const { TUNING } = require('./config');

/**
 * 归因：把一次 diff 分成三类。这是整个项目的天花板（DESIGN §4-①）。
 *
 * 两个后端：
 *   manual —— 默认。输出一段分类提示词，由当前 harness 里的模型判断后回调 `lore learn`。
 *             零配置、零 API key，且天然带人工确认闸。
 *   api    —— 设了 ANTHROPIC_API_KEY 时可用，无人值守批量归因。
 */

const CLASSIFY_PROMPT = `你在判断一次代码修改的性质。上面是 AI 写完代码之后，人类随即做出的修改。

请分成三类之一：

- **style** —— 人类在纠正写法：命名、注入方式、错误处理、日志、分层、API 用法偏好等。
  这类可以提炼成一条对整个仓库都成立的规范。
- **bug** —— 人类在修 AI 写出的缺陷：逻辑错误、边界遗漏、并发/资源问题等。
  这类应记成一条踩坑，绑定到具体文件。
- **feature** —— 人类在改业务：需求变了、加功能、调参数。**与 AI 写得对不对无关。**

⚠️ 判断原则：**宁可判成 feature，也不要误判成 style**。
学到一条错规范会污染之后所有编码；漏掉一条对规范只是少学一点。
拿不准就选 feature，confidence 给低。

对每一处改动输出一行 JSON：
{"id":"<原 id>","label":"style|bug|feature","confidence":0.0-1.0,"rule":"<一句话规范或坑，feature 留空>"}

rule 要写成**可复用的一般性陈述**，不要提具体变量名。
好例子："Spring Bean 依赖使用构造器注入，不用 @Autowired 字段注入"
坏例子："把 OrderService 里的 foo 字段改成构造器参数"`;

function buildPrompt(records) {
  const blocks = records.map((r) => `## id=${r.id}  文件: ${r.file}  (AI 写完 ${r.ageMin} 分钟后被改)

\`\`\`diff
${r.diff}
\`\`\``).join('\n\n');
  return blocks + '\n\n---\n\n' + CLASSIFY_PROMPT;
}

/** 调 Anthropic API 做自动归因。可选路径，没有 key 就不走这里 */
function classifyViaApi(records, apiKey, model = 'claude-sonnet-5') {
  const body = JSON.stringify({
    model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: buildPrompt(records) }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message));
          const text = (j.content || []).map((c) => c.text || '').join('');
          resolve(parseVerdicts(text));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 从模型输出里抠出 JSON 行。容错：允许包在 markdown 代码块里 */
function parseVerdicts(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim().replace(/^```(json)?|```$/g, '').trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = JSON.parse(s);
      if (v.id && v.label) out.push(v);
    } catch { /* 不是合法 JSON，跳过 */ }
  }
  return out;
}

/**
 * 置信度闸 —— 「宁可漏，不可错」落到代码上就是这个函数。
 * feature 直接丢弃；style/bug 低于阈值也丢弃。
 */
function accept(verdict) {
  if (verdict.label === 'feature') return { ok: false, why: '业务变更，非学习信号' };
  if (!verdict.rule || !verdict.rule.trim()) return { ok: false, why: '没给出可复用的 rule' };
  if ((verdict.confidence ?? 0) < TUNING.minConfidence) {
    return { ok: false, why: `置信度 ${verdict.confidence} < ${TUNING.minConfidence}` };
  }
  return { ok: true };
}

module.exports = { buildPrompt, classifyViaApi, parseVerdicts, accept, CLASSIFY_PROMPT };
