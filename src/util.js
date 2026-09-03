'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(file) {
  const raw = readIfExists(file);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** 仓库标识：优先用 git remote，其次 git 根目录名，最后当前目录名 */
function repoId(cwd) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
      const m = remote.match(/([^/:]+\/[^/]+?)(\.git)?$/);
      if (m) return m[1].replace(/\//g, '__');
    } catch { /* 没有 remote，退回目录名 */ }
    return path.basename(root);
  } catch {
    return path.basename(cwd);
  }
}

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return null; }
}

// gitRoot 要 spawn 一次 git，按目录记住结果。hook 进程活得很短，
// 一次调用通常只涉及一两个目录，缓存足够，也不必考虑失效
const _rootCache = new Map();

/**
 * 仓库内相对路径，正斜杠分隔。pitfall 与 snapshot 用它做 key。
 *
 * 不能用绝对路径：那会把知识绑死在这台机器的目录布局上。换个盘符、
 * 挪个目录、或者换台机器，sha1 全变，积累的条目一条都召回不到 ——
 * 而 repoId 本身是与路径无关的，key 却不是，两者对不齐。
 *
 * 非 git 目录没有天然锚点，退回按仓库名切：路径里最后一次出现 repo
 * 的位置之后就是相对路径。再不行才用文件名，此时有重名风险，
 * 但仍好过绝对路径 —— 至少跨机器是稳定的。
 */
function repoRel(repo, file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (!_rootCache.has(dir)) _rootCache.set(dir, gitRoot(dir));
  let root = _rootCache.get(dir);
  if (!root && repo) {
    // repoId 可能来自 git remote，形如 owner__name，而目录名只有 name，
    // 所以两种写法都要试，否则有 remote 的仓库在这条兜底路径上永远匹配不到
    const names = [repo, repo.split('__').pop()];
    const segs = abs.split(/[\\/]/);
    for (const n of names) {
      const i = segs.lastIndexOf(n);
      if (i >= 0) { root = segs.slice(0, i + 1).join(path.sep); break; }
    }
  }
  const rel = root ? path.relative(root, abs) : path.basename(abs);
  return rel.split(path.sep).join('/');
}

/** 粗略 token 估算。英文 ~4 char/token，中文更密，取 2.5 保守些 */
const estimateTokens = (s) => Math.ceil([...s].reduce(
  (n, c) => n + (c.charCodeAt(0) > 127 ? 1 / 1.6 : 1 / 4), 0));

/** 从文件内容里抽取符号（类名/方法名/函数名），用于注入时的相关性匹配 */
function extractSymbols(content, limit = 40) {
  const out = new Set();
  const pats = [
    /\b(?:class|interface|enum|record|trait|struct)\s+([A-Z][A-Za-z0-9_]*)/g,
    /\b(?:function|func|def|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\b(?:public|private|protected|static|async)\s+[\w<>\[\],\s]+?\s+([a-z][A-Za-z0-9_]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/g,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(content)) && out.size < limit) out.add(m[1]);
  }
  return [...out];
}

module.exports = { ensureDir, sha1, readIfExists, appendJsonl, readJsonl, repoId, gitRoot, repoRel, estimateTokens, extractSymbols };
