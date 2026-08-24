'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { repoId } = require('./util');
const store = require('./store');
const metrics = require('./metrics');
const promote = require('./promote');

/**
 * 本地看板 —— 把「注入了什么、花了多少 token、有没有用上」这些不可见的东西显示出来。
 *
 * 和 agent-beacon 的看板同一个思路：agent 背后的状态，不显示就等于不存在。
 * 尤其是「修正复发率」——这是本项目唯一的效果指标，必须一眼能看到。
 */
const PORT = Number(process.env.AGENT_LORE_PORT || 4519);

function data(cwd) {
  const repo = repoId(cwd);
  const s = metrics.stats();
  return {
    repo,
    conventions: store.getConventions(repo).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    pitfalls: store.allPitfalls(repo).map((p) => ({ file: p.file, rule: p.rule })),
    pending: store.listPending(repo).map((p) => ({ id: p.id, file: p.file, hunks: p.hunkCount, diff: p.diff })),
    ready: promote.readyToPromote(repo),
    candidates: store.listCandidates(repo).filter((c) => c.label === 'style').length,
    stats: s,
  };
}

function serve(cwd) {
  const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  http.createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data(cwd)));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  }).listen(PORT, '127.0.0.1', () => {
    console.log('[lore] 看板 http://127.0.0.1:' + PORT + '   (Ctrl+C 退出)');
  });
}

module.exports = { serve, data, PORT };
