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
const graphMod = require('./graph');
const settings = require('./settings');
const autostart = require('./autostart');
const updater = require('./update');
const daemonMod = require('./daemon');
const critiqueMod = require('./critique');

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
const GLOBAL = '_global';   // 工具级/环境级规范的作用域，同步到用户级 ~/.claude/CLAUDE.md

const lines = (md) => (md || '').split(String.fromCharCode(10))
  .filter((l) => l.startsWith('- ')).map((l) => l.slice(2));

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
  const globalConv = repo === GLOBAL ? '' : store.getConventions(GLOBAL);
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
    // 规范有两个作用域：本仓库 + 通用(_global)。
    // 通用规范写在用户级 CLAUDE.md、每个会话都加载，是真正在生效的那批 ——
    // 只显示本仓库的话，它们在看板上完全看不见。
    conventions: [
      ...withTags(lines(existing)).map((c) => ({ ...c, scope: 'repo' })),
      ...withTags(lines(globalConv)).map((c) => ({ ...c, scope: 'global' })),
    ],
    pitfalls: [
      ...withTags(store.allPitfalls(repo).map((p) => ({ file: p.file, rule: p.rule, at: p.at, scope: 'repo' }))),
      ...(repo === GLOBAL ? []
        : withTags(store.allPitfalls(GLOBAL).map((p) => ({ file: p.file, rule: p.rule, at: p.at, scope: 'global' })))),
    ],
    // 归因单位是「一次交互」不是「一个文件的 diff」——见 src/batch.js
    batches: batch.groupPending(store.listPending(repo)),
    pendingCount: store.listPending(repo).length,
    ready: promote.readyToPromote(repo).filter((r) => !r.auto),   // auto 的已在归因时入库
    autoRule: TUNING.autoPromote,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    candidates: pendingRules,
    // 知识层：建在文件存储之上，把已有数据里隐含的关系显式化
    knowledge: {
      lifecycle: graphMod.lifecycle(repo).map((x) => ({
        key: x.key, rule: x.rule, state: x.state, why: x.why, tags: x.tags,
        injections: x.injections, recurrence: x.recurrence, evidence: x.evidence.length,
        files: x.files.length, related: x.related.length, source: x.source,
      })),
      globalLifecycle: repo === GLOBAL ? [] : graphMod.lifecycle(GLOBAL).map((x) => ({
        key: x.key, rule: x.rule, state: x.state, why: x.why, tags: x.tags,
        injections: x.injections, recurrence: x.recurrence, evidence: x.evidence.length,
        files: x.files.length, related: x.related.length, source: x.source,
      })),
      // 对话层信号：反复出现的口头批评，与 diff 正交
      critique: critiqueMod.clusters(repo),
      coverage: graphMod.coverage(repo === GLOBAL ? [GLOBAL] : [repo, GLOBAL]),
      graph: graphMod.graph(repo === GLOBAL ? [GLOBAL] : [repo, GLOBAL]),
      // 知识岛：三个维度都算好，前端切换不用回后端
      islands: {
        domain: graphMod.islands(repo === GLOBAL ? [GLOBAL] : [repo, GLOBAL], { by: 'domain' }),
        file: graphMod.islands(repo === GLOBAL ? [GLOBAL] : [repo, GLOBAL], { by: 'file' }),
        scope: graphMod.islands(repo === GLOBAL ? [GLOBAL] : [repo, GLOBAL], { by: 'scope' }),
      },
      stateLabel: graphMod.STATE_LABEL,
    },
    stats: {
      ...s,
      rules: [
        ...withTags(s.rules).map((r) => ({ ...r, scope: 'repo' })),
        ...(repo === GLOBAL ? [] : withTags(metrics.stats(GLOBAL).rules).map((r) => ({ ...r, scope: 'global' }))),
      ],
    },
    settings: settings.load(),
    autostart: autostart.status(),
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
    case '/api/settings':
      return { ok: true, settings: settings.save(body) };
    case '/api/autostart':
      return body.enable
        ? { ...autostart.enable(body.cwd || cwd, PORT), status: autostart.status() }
        : { ...autostart.disable(), status: autostart.status() };
    case '/api/update': {
      if (!body.pull) return updater.check();
      const r = updater.pull();
      // 更新成功就自动重启，让新代码生效——用户点「立即更新」本就期望它直接生效。
      // 延迟一下重启，确保这个响应先发回前端，前端好提示「正在重启」。
      if (r.updated) setTimeout(() => daemonMod.scheduleRestart(cwd, PORT), 500);
      return { ...r, restarting: !!r.updated };
    }
    case '/api/critique':
      return body.action === 'promote'
        ? critiqueMod.promoteToRule(repo, body)
        : (critiqueMod.markHandled(repo, body.cat, body.kind), { ok: true, dismissed: true });
    case '/api/why':
      return graphMod.lineage(body.repo || repo, body.key) || { ok: false, why: '未找到' };
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

  // 启动时自动更新。放在监听之前跑完，因为快进成功后当前进程加载的还是旧代码，
  // 得让用户看到"需要重启"这句话，而不是以为已经生效了。
  if (settings.load().autoUpdate) {
    try {
      const r = updater.pull();
      if (r.updated) {
        console.log(`[lore] 已更新 ${r.from} → ${r.local}，重启看板后生效`);
      } else if (r.behind) {
        console.log(`[lore] 有 ${r.behind} 个新提交但未更新：${r.why}`);
      }
    } catch (e) { console.log('[lore] 自动更新跳过：' + e.message); }
  }

  const server = http.createServer(async (req, res) => {
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      // 新机器接入时从这里取代码，不必配 SSH 或等 GitHub 同步。
      // 更重要的是版本必然一致 —— 发的就是服务端自己在跑的那份，
      // 而 hook 与服务端的接口对不上时的表现是静默失败，最难查
      if (req.method === 'GET' && req.url === '/code') {
        const { spawn } = require('child_process');
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': 'attachment; filename="agent-lore.tar.gz"',
        });
        // 只发运行需要的，不发 .git 与数据
        const tar = spawn('tar', ['-czf', '-', '-C', path.join(__dirname, '..'),
          'src', 'bin', 'hooks', 'package.json'], { stdio: ['ignore', 'pipe', 'ignore'] });
        return tar.stdout.pipe(res);
      }

      // 各机器的 hook 通过这个接口读写唯一那份知识数据。
      // 它能任意读写，比只读的看板权限大得多，所以单独校验令牌；
      // 没配令牌时不校验，保持本机单机使用的零配置体验
      if (req.method === 'POST' && req.url === '/store') {
        const TOKEN = process.env.AGENT_LORE_TOKEN || '';
        if (TOKEN && req.headers['x-lore-token'] !== TOKEN) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, why: '令牌不对' }));
        }
        const { fn, args } = (await readBody(req)) || {};   // readBody 已经解析过 JSON
        // 记下是谁在调。装了 hook 不等于在用，只有真实调用能证明；
        // 多台机器共用一份数据时，这也是唯一能看出「几台在接入」的地方
        try {
          const who = decodeURIComponent(req.headers['x-lore-client'] || '未知');
          const cf = require('path').join(require('./config').HOME, 'clients.json');
          const nfs = require('fs');
          let m = {};
          try { m = JSON.parse(nfs.readFileSync(cf, 'utf8')); } catch { /* 首次 */ }
          const e = m[who] || { calls: 0 };
          m[who] = { calls: e.calls + 1, last: Date.now(), lastFn: fn };
          nfs.writeFileSync(cf, JSON.stringify(m, null, 2), 'utf8');
        } catch { /* 记不上不影响主流程 */ }
        const fs = require('./store-fs');
        // 只放行 store 自己导出的函数，不能拿这个接口调到别的东西
        if (typeof fs[fn] !== 'function') return json({ ok: false, why: '未知函数 ' + fn });
        return json({ ok: true, value: fs[fn](...(args || [])) });
      }
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

  // 默认只监听本机：看板上是编码规范与人工修正记录，不该随手开到局域网。
  // 跑在容器里时必须绑 0.0.0.0，否则端口映射出去也连不上 ——
  // 那种场景下暴露范围由 compose 的端口映射和外层网络决定，是一个有意识的选择
  const HOST = process.env.AGENT_LORE_HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    const shown = (HOST === '0.0.0.0' || HOST === '::') ? '127.0.0.1' : HOST;
    console.log('[lore] 看板 http://' + shown + ':' + PORT + '   (Ctrl+C 退出)');
  });
}

module.exports = { serve, data, PORT };
