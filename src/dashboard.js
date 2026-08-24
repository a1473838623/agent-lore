'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { repoId } = require('./util');
const { TUNING } = require('./config');
const store = require('./store');
const metrics = require('./metrics');
const promote = require('./promote');
const spec = require('./spec');
const apply = require('./apply');
const injectMod = require('./inject');
const detect = require('./detect');
const tags = require('./tags');
const batch = require('./batch');

/**
 * 本地看板。
 *
 * 两个职责，按"要不要你动手"分开：
 *   ① 待办 —— 归因、确认入库。**这是唯一需要人的环节，所以必须能在页面上直接做完**，
 *      而不是看一眼再回命令行敲 JSON。
 *   ② 观测 —— 让「注入了什么、花了多少 token、有没有用上」这些不可见的东西可见。
 *      核心是修正复发率，这是项目唯一的效果指标。
 */
const PORT = Number(process.env.AGENT_LORE_PORT || 4519);

function data(cwd) {
  const repo = repoId(cwd);
  const s = metrics.stats(repo);
  const candidates = store.listCandidates(repo).filter((c) => c.label === 'style');

  // 候选按规范归并，显示"离阈值还差几次"——比一个总数有用得多
  const groups = new Map();
  for (const c of candidates) {
    let hit = null;
    for (const [k, g] of groups) if (k === c.key || promote.similar(g[0].rule, c.rule) >= 0.6) { hit = k; break; }
    if (hit) groups.get(hit).push(c); else groups.set(c.key, [c]);
  }
  const existing = store.getConventions(repo);
  const pendingRules = [...groups.entries()]
    .filter(([k]) => !existing.includes('id=' + k))
    .map(([key, g]) => ({
      key, rule: g[0].rule, count: g.length, threshold: TUNING.promoteThreshold,
      files: [...new Set(g.map((c) => c.file))],
    }))
    .sort((a, b) => b.count - a.count);

  return {
    repo,
    threshold: TUNING.promoteThreshold,
    // 边界按会话隔离：同一仓库可能同时有多个会话在做不同需求
    specs: spec.list(cwd),
    sessions: spec.sessions(cwd),
    conventions: withTags(existing.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))),
    pitfalls: withTags(store.allPitfalls(repo).map((p) => ({ file: p.file, rule: p.rule, at: p.at }))),
    // 归因单位是「一次交互」不是「一个文件的 diff」——见 src/batch.js
    batches: batch.groupPending(store.listPending(repo)),
    pendingCount: store.listPending(repo).length,
    ready: promote.readyToPromote(repo).filter((r) => !r.auto),   // auto 的已在归因时入库
    autoRule: TUNING.autoPromote,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    candidates: pendingRules,
    stats: { ...s, rules: withTags(s.rules) },
    tagLabels: tags.LABEL,
  };
}

/** 给每条挂上标签。读取时推导——已有数据不用迁移，标签体系调整也不用重刷全库 */
function withTags(items) {
  return items.map((it) => {
    const text = typeof it === 'string' ? it : it.rule;
    const t = tags.derive(text);
    const base = typeof it === 'string' ? { rule: it } : it;
    return { ...base, tag: t.primary, tags: t.all };
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function handlePost(url, body, cwd) {
  const repo = repoId(cwd);
  switch (url) {
    case '/api/learn':
      return body.ids ? apply.applyBatch(repo, body) : apply.applyVerdict(repo, body);
    case '/api/dismiss':
      return apply.dismiss(repo, body.ids || body.id);
    case '/api/promote':
      return apply.confirmPromotion(repo, body.key);
    case '/api/auto':
      return apply.autoAttribute(repo, cwd);
    case '/api/scan': {
      const r = detect.scan(cwd);
      return { ok: true, found: r.found.filter((f) => !f.skipped).length };
    }
    case '/api/sync':
      return injectMod.syncClaudeMd(cwd, { global: !!body.global });
    case '/api/spec':
      return body.clear
        ? { ok: true, cleared: spec.clear(cwd, body.sessionId) }
        : { ok: true, spec: spec.set(cwd, body) };
    default:
      return { ok: false, why: 'unknown endpoint' };
  }
}

function serve(cwd) {
  const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

  const server = http.createServer(async (req, res) => {
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'POST') return json(await handlePost(req.url, await readBody(req), cwd));
      if (req.url === '/api') return json(data(cwd));
    } catch (e) {
      return json({ ok: false, why: e.message });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });

  // 端口冲突是最常见的启动失败，且十有八九是自己上次没退干净。
  // 抛一屏堆栈会让人以为代码坏了 —— 直接告诉他怎么处理。
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') { console.error('[lore] 看板启动失败：' + e.message); process.exit(1); }
    console.error(`[lore] 端口 ${PORT} 已被占用。通常是上一个看板没退干净。

  看看是不是已经开着了：  http://127.0.0.1:${PORT}
  换个端口：              AGENT_LORE_PORT=4520 lore dashboard
  找出占用者（PowerShell）：
      Get-NetTCPConnection -LocalPort ${PORT} -State Listen |
        ForEach-Object { Get-Process -Id $_.OwningProcess }`);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('[lore] 看板 http://127.0.0.1:' + PORT + '   (Ctrl+C 退出)');
  });
}

module.exports = { serve, data, PORT };
