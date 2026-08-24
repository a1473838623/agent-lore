'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 冷启动：从**现有代码库**直接归纳规范，不用等人工修正累积。
 *
 * 为什么需要它：成熟仓库的规范已经写在代码里了。等「AI 写错 → 人修正 → 累计 3 次」
 * 才学到一条，对一个几万文件的老仓库是最慢的路径。
 *
 * 🔑 关键设计：**不喂全文，喂统计特征。**
 * 33000 个 Java 文件全文喂进模型既不可能也没必要 —— 规范体现在**频次对比**上：
 * 「@Autowired 出现 12 次，构造器注入 480 次」比读 100 个文件更能说明这个仓库的偏好。
 * token 成本差几个数量级，结论还更可靠。
 */

const EXT = { '.java': 'java', '.ts': 'ts', '.js': 'js', '.py': 'py', '.go': 'go', '.kt': 'kt' };
const SKIP = /(^|[\/])(node_modules|target|build|dist|\.git|\.idea|__pycache__|\.venv|vendor|generated)([\/]|$)/;

/** 对立模式：两两成对，靠**频次比**判断仓库倾向哪一边 */
const PROBES = {
  java: [
    ['依赖注入', /@Autowired\s*\n\s*(private|protected)/g, /^\s*private\s+final\s+\w[\w<>,\s]*\s+\w+;/gm],
    ['日志',     /System\.out\.print/g,                     /\b(log|logger|LOGGER)\.(info|warn|error|debug)\(/g],
    ['日志拼接', /\.(info|warn|error|debug)\([^)]*\+\s*\w/g, /\.(info|warn|error|debug)\("[^"]*\{\}/g],
    ['空判断',   /!=\s*null\s*&&/g,                          /\b(Objects\.(nonNull|isNull)|StringUtils\.is)/g],
    ['集合创建', /new\s+(ArrayList|HashMap)\s*<[^>]*>\s*\(\)/g, /\b(List|Map)\.of\(|Collections\.empty/g],
    ['异常',     /catch\s*\([^)]*\)\s*\{\s*\}/g,             /catch\s*\([^)]*\)\s*\{[^}]*log\w*\./g],
    ['事务',     /@Transactional\b/g,                        /TransactionTemplate|PlatformTransactionManager/g],
    ['参数校验', /if\s*\([^)]*==\s*null\s*\)\s*(throw|return)/g, /@(Valid|Validated|NotNull|NotBlank)\b/g],
  ],
  ts: [
    ['异步',   /\.then\s*\(/g,                 /\bawait\s+/g],
    ['类型',   /:\s*any\b/g,                   /\binterface\s+\w+|\btype\s+\w+\s*=/g],
    ['声明',   /\bvar\s+/g,                    /\b(const|let)\s+/g],
    ['相等',   /[^=!]==[^=]/g,                 /===/g],
  ],
  js: [
    ['异步',   /\.then\s*\(/g,                 /\bawait\s+/g],
    ['声明',   /\bvar\s+/g,                    /\b(const|let)\s+/g],
    ['模块',   /\brequire\s*\(/g,              /^\s*import\s+/gm],
  ],
  py: [
    ['格式化', /%\s*\(|\.format\(/g,           /\bf["']/g],
    ['类型',   /\bdef\s+\w+\([^)]*\)\s*:/g,    /\bdef\s+\w+\([^)]*\)\s*->/g],
  ],
};

function walk(root, { maxFiles = 4000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) stack.push(p);
      else if (EXT[path.extname(e.name)]) {
        out.push(p);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/** 采集统计特征 */
function profile(root, opts = {}) {
  const files = walk(root, opts);
  const byLang = {};
  const imports = new Map();
  const annotations = new Map();
  let scanned = 0, bytes = 0;

  for (const f of files) {
    const lang = EXT[path.extname(f)];
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.length > 200 * 1024) continue;
    scanned++; bytes += src.length;

    byLang[lang] = byLang[lang] || { files: 0, probes: {} };
    byLang[lang].files++;

    for (const [name, reA, reB] of (PROBES[lang] || [])) {
      const a = (src.match(reA) || []).length;
      const b = (src.match(reB) || []).length;
      const slot = (byLang[lang].probes[name] = byLang[lang].probes[name] || { a: 0, b: 0 });
      slot.a += a; slot.b += b;
    }

    for (const m of src.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) {
      const k = m[1].split('.').slice(0, 4).join('.');
      imports.set(k, (imports.get(k) || 0) + 1);
    }
    for (const m of src.matchAll(/@([A-Z]\w+)/g)) {
      annotations.set(m[1], (annotations.get(m[1]) || 0) + 1);
    }
  }

  const top = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
  return { root, totalFound: files.length, scanned, bytes, byLang, imports: top(imports, 25), annotations: top(annotations, 25) };
}

const LABELS = {
  '依赖注入': ['@Autowired 字段注入', 'final 字段 + 构造器注入'],
  '日志': ['System.out.print', '日志框架'],
  '日志拼接': ['字符串拼接', '{} 占位符'],
  '空判断': ['手写 != null &&', 'Objects/StringUtils 工具类'],
  '集合创建': ['new ArrayList/HashMap', 'List.of / Collections.empty'],
  '异常': ['空 catch 块', 'catch 中记日志'],
  '事务': ['@Transactional 注解', '编程式事务'],
  '参数校验': ['手写 if null 判断', '@Valid / @NotNull 注解'],
  '异步': ['.then() 链式', 'async/await'],
  '类型': ['any / 无类型标注', '显式类型 / 类型标注'],
  '声明': ['var', 'const/let'],
  '相等': ['==', '==='],
  '模块': ['require', 'import'],
  '格式化': ['% / .format()', 'f-string'],
};

/** 渲染成给模型看的归纳提示词 */
function buildPrompt(prof) {
  const L = [`# 代码库规范归纳\n`,
    `仓库：${prof.root}`,
    `扫描 ${prof.scanned} 个源文件（共发现 ${prof.totalFound}，${(prof.bytes / 1048576).toFixed(1)} MB）\n`];

  for (const [lang, d] of Object.entries(prof.byLang)) {
    L.push(`## ${lang}（${d.files} 个文件）\n`);
    L.push('| 维度 | 写法 A | 次数 | 写法 B | 次数 | 倾向 |');
    L.push('|---|---|---|---|---|---|');
    for (const [name, { a, b }] of Object.entries(d.probes)) {
      if (a + b < 5) continue;                        // 样本太少不下结论
      const [la, lb] = LABELS[name] || ['A', 'B'];
      const total = a + b;
      const lean = a / total > 0.8 ? '**强烈偏 A**' : b / total > 0.8 ? '**强烈偏 B**'
                 : a > b ? '偏 A' : b > a ? '偏 B' : '混用';
      L.push(`| ${name} | ${la} | ${a} | ${lb} | ${b} | ${lean} |`);
    }
    L.push('');
  }

  if (prof.annotations.length) L.push(`## 高频注解\n${prof.annotations.map(([k, v]) => `@${k}(${v})`).join('  ')}\n`);
  if (prof.imports.length) L.push(`## 高频 import 前缀\n${prof.imports.map(([k, v]) => `${k}(${v})`).join('  ')}\n`);

  L.push(`---

根据以上**频次统计**归纳这个仓库的编码规范。

规则：
1. 只在**倾向明确**（一边占比 > 80%）时才下结论；混用的维度**不要编规范**
2. 每条写成可复用的一般性陈述，不提具体类名/变量名。**rule 字段必须用英文**（它会进 CLAUDE.md）
3. "混用"本身可能是有意的（比如新老代码并存），**不要**把它写成规范
4. 宁可少写几条，不要写不确定的

每行输出一个 JSON：
{"label":"style","confidence":0.0-1.0,"rule":"<一句话规范>","evidence":"<支撑它的频次对比>"}`);

  return L.join('\n');
}

module.exports = { profile, buildPrompt, walk };
