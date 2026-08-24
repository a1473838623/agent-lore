'use strict';

/**
 * 规范/踩坑的标签推导。
 *
 * 为什么在**读取时**推导而不是写入时存：
 *   ① 已有的规范没有标签，读时推导可以直接生效，不用数据迁移
 *   ② 标签体系一定会调整，存下来就得重刷全库
 *   ③ 归因模型将来若能直接给出标签，与这里推导的合并即可，接口不变
 *
 * 分三层，各回答一个问题：
 *   scope  —— 属于哪个技术域（git / java / powershell …）：**决定归类**
 *   plat   —— 限定在哪个平台（windows / linux）：决定"这条对我适用吗"
 *   kind   —— 是什么性质（编码风格 / 工具用法 / 陷阱 / 流程）：决定"该怎么用它"
 */

// 顺序即优先级：越靠前越具体，primary 取第一个命中的
const SCOPE = [
  ['git',        /\bgit\b|\.gitignore|\bcommit\b|\brebase\b|\bstash\b|\bgh auth\b|\bgh repo\b|\bHEAD\b/i],
  ['powershell', /powershell|\bpwsh\b|ErrorRecord|Get-\w+|Set-\w+|\$\?/i],
  ['shell',      /\bbash\b|heredoc|\bshell\b|\bstdout\b|\bstderr\b|\bexit code\b/i],
  ['java',       /\bjava\b|\bjvm\b|spring|maven|\bmvn\b|@Autowired|slf4j|dubbo|-D[a-z.]+=/i],
  ['javascript', /javascript|\bnode\b|npm\b|String\.replace|\bregex\b|indexOf|JSON\.parse|typescript/i],
  ['python',     /\bpython\b|\bpip\b|PYTHONIOENCODING|\.py\b/i],
  ['sql',        /\bsql\b|\bselect\b.*\bfrom\b|\bindex\b.*\btable\b|\bmysql\b|\bupdate\b.*\bwhere\b/i],
  ['docker',     /docker|kubernetes|\bk8s\b|container/i],
  ['http',       /\bhttp\b|\bapi\b|endpoint|\brest\b|status code/i],
];

const PLATFORM = [
  ['windows', /windows|powershell|GBK|CRLF|\.exe\b|%USERPROFILE%/i],
  ['linux',   /\blinux\b|\bunix\b|\bLF\b\s|chmod|\/etc\//i],
];

// 具体的性质排在前面，generic 的 pitfall/style 垫底 ——
// 否则"度量口径不一致会让指标静默算错"会被 pitfall 抢走，丢掉 metrics 这个更有信息量的分类
const KIND = [
  ['meta',     /\bLANGUAGE\b|write .*in English|规范本身|rule text/i],
  ['encoding', /encoding|utf-?8|GBK|mojibake|charset|乱码/i],
  ['metrics',  /\bmetric\w*\b|统计|指标|复发率/i],
  ['algorithm',/similarity|tokeniz|n-gram|相似度|分词|算法/i],
  ['ops',      /\bport\b|process|restart|background service|服务|端口|进程/i],
  ['codegen',  /escape sequence|generat\w+ code|string replacement|heredoc|string literal|写代码|代码生成/i],
  ['pitfall',  /silently|静默|never throws|fails? (with|when)|aborts?|breaks?|会导致|踩坑/i],
  ['style',    /prefer|instead of|rather than|should use|must use|不要用|统一用/i],
];

/** 命中的全部标签 */
const hits = (table, text) => table.filter(([, re]) => re.test(text)).map(([name]) => name);

/**
 * 主题标签：取**在文本里出现位置最靠前**的那个，而不是表里排最前的。
 *
 * 因为关键词命中顺序 ≠ 主题。例：
 *   "On Windows PowerShell, never redirect stderr of a native exe (git/gh/mvn/node)…"
 *   git 在表里排第一，但它只是举例；PowerShell 出现在第 3 个词，才是这条规则讲的东西。
 */
function earliest(table, text) {
  let best = null, bestAt = Infinity;
  for (const [name, re] of table) {
    const m = text.match(re);
    if (m && m.index < bestAt) { best = name; bestAt = m.index; }
  }
  return best;
}

/** @returns {{primary:string, scope:string[], platform:string[], kind:string, all:string[]}} */
function derive(rule) {
  const t = String(rule || '');
  const scope = hits(SCOPE, t);
  const platform = hits(PLATFORM, t);
  const kind = hits(KIND, t)[0] || 'style';
  const primary = earliest(SCOPE, t) || earliest(PLATFORM, t) || kind;
  return {
    primary,
    scope,
    platform,
    kind,
    all: [...new Set([primary, ...scope, ...platform, kind])],
  };
}

/** 按 primary 分组，组内保持原顺序。返回 [[tag, rules[]], …]，按组内条数降序 */
function group(rules) {
  const m = new Map();
  for (const r of rules) {
    const text = typeof r === 'string' ? r : r.rule;
    const k = derive(text).primary;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** 展示用的中文名。CLAUDE.md 里不用这个——那边一律英文 */
const LABEL = {
  git: 'Git', powershell: 'PowerShell', shell: 'Shell', java: 'Java',
  javascript: 'JavaScript', python: 'Python', sql: 'SQL', docker: '容器',
  http: 'HTTP', windows: 'Windows', linux: 'Linux',
  meta: '元规则', encoding: '编码', pitfall: '陷阱', codegen: '代码生成',
  ops: '运维', metrics: '度量', algorithm: '算法', style: '编码风格',
};

module.exports = { derive, group, LABEL, SCOPE, PLATFORM, KIND };
