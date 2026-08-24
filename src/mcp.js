'use strict';
/**
 * L2 接入层 —— MCP stdio server（DESIGN §5）。
 *
 * 给没有 hook 机制、但支持 MCP 的 harness 用：Cursor / Cline / Codex / Windsurf …
 * 与 L1 的区别是**注入时机不可控** —— L1 能在编辑前强制注入，L2 只能等 agent 主动调。
 * 所以 L2 的 tool description 写得很直白，就是为了提高被调用的概率。
 *
 * 协议：换行分隔的 JSON-RPC 2.0，零依赖手写。
 */
const path = require('path');
const { repoId } = require('./util');
const store = require('./store');
const injectMod = require('./inject');
const attribute = require('./attribute');
const detect = require('./detect');

const TOOLS = [
  {
    name: 'lore_context',
    description: '在修改某个文件之前调用。返回这个仓库的编码规范，以及该文件相关的历史踩坑。' +
                 '没有相关内容时返回空——这是正常的，不必重试。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: '将要修改的文件绝对路径' } },
      required: ['file'],
    },
  },
  {
    name: 'lore_snapshot',
    description: '写完文件后调用，记录本次 AI 写入的内容，供后续对比人类修正。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'lore_pending',
    description: '列出已捕获、待归因的人类修正 diff。返回的内容需要你按 style/bug/feature 三分类判断。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const PROMPTS = [
  { name: 'lore_review', description: '归因待处理的人类修正：判断哪些是规范修正、哪些是修 bug、哪些是业务变更' },
];

function handle(msg, cwd) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'agent-lore', version: '1.0.0' },
      });

    case 'tools/list':   return ok({ tools: TOOLS });
    case 'prompts/list': return ok({ prompts: PROMPTS });

    case 'prompts/get': {
      const repo = repoId(cwd);
      const pending = store.listPending(repo);
      const text = pending.length ? attribute.buildPrompt(pending) : '当前没有待归因的修正。';
      return ok({ messages: [{ role: 'user', content: { type: 'text', text } }] });
    }

    case 'tools/call': {
      const { name, arguments: a = {} } = params || {};
      const text = callTool(name, a, cwd);
      return ok({ content: [{ type: 'text', text }] });
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }
}

function callTool(name, a, cwd) {
  const repo = repoId(cwd);
  try {
    switch (name) {
      case 'lore_context': {
        const parts = [];
        const conv = store.getConventions(repo);
        const rules = conv.split('\n').filter((l) => l.startsWith('- '));
        if (rules.length) parts.push('本仓库编码规范：\n' + rules.join('\n'));
        const ctx = injectMod.buildContext(cwd, path.resolve(a.file || ''));
        if (ctx) {
          parts.push(ctx.text);
          store.recordMetric({ type: 'inject', repo, file: a.file, keys: ctx.keys, tokens: ctx.tokens, via: 'mcp' });
        }
        return parts.join('\n\n') || '';   // 未命中返回空串，不编造内容
      }
      case 'lore_snapshot': {
        const fs = require('fs');
        const p = path.resolve(a.file || '');
        store.putSnapshot(repo, p, fs.readFileSync(p, 'utf8'));
        return 'ok';
      }
      case 'lore_pending': {
        detect.scan(cwd);
        const pending = store.listPending(repo);
        return pending.length ? attribute.buildPrompt(pending) : '没有待归因的修正。';
      }
      default:
        return 'unknown tool: ' + name;
    }
  } catch (e) {
    return '';   // fail-open：MCP 层出错也不能让 agent 卡住
  }
}

function serve(cwd) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const res = handle(msg, cwd);
      if (res && msg.id !== undefined) process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
}

module.exports = { serve, handle, TOOLS };
