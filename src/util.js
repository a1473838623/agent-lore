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

module.exports = { ensureDir, sha1, readIfExists, appendJsonl, readJsonl, repoId, gitRoot, estimateTokens, extractSymbols };
