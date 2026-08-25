'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { sha1, ensureDir, readIfExists } = require('./util');

/**
 * Embedding 后端 —— 可插拔，零依赖。
 *
 * 为什么需要它：pitfall 召回原本靠「文件路径 + 符号匹配」。
 * 这在同文件内很准，但**跨文件的坑召不回来** —— 一条讲"支付状态更新要用条件更新"的坑，
 * 在改 OrderService 时召不出来，因为路径不同、符号也不重叠。
 * 规模一上去这就是主要漏召来源，所以需要语义召回作为补充。
 *
 * 但**不默认开启**：检索词是专有名词时关键词精确率更高（见 eval.js 的对照数据）。
 * 做成可切换，按查询形态选，而不是一刀切上向量。
 *
 * 配置：LORE_EMBED=ollama:nomic-embed-text | openai:text-embedding-3-small | off
 */

const CACHE_DIR = path.join(HOME, 'embed-cache');

function parseSpec(spec) {
  const raw = spec || process.env.LORE_EMBED || 'ollama:nomic-embed-text';
  if (raw === 'off') return null;
  const i = raw.indexOf(':');
  return i < 0 ? { kind: 'ollama', model: raw } : { kind: raw.slice(0, i), model: raw.slice(i + 1) };
}

function post(url, body, headers = {}, timeout = 30000) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      timeout,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json: ' + d.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 规整 Ollama 地址。
 *
 * ⚠️ `OLLAMA_HOST` 是给**服务端绑定**用的，可能只是 `0.0.0.0` 或 `127.0.0.1:11434`，
 * 不带协议 —— 直接拼 `/api/embeddings` 会得到非法 URL。
 * 而且 `0.0.0.0` 是"监听所有网卡"的意思，**客户端不能连它**，要换成回环地址。
 */
function ollamaBase() {
  let h = (process.env.OLLAMA_HOST || '').trim();
  if (!h) return 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  const u = new URL(h);
  if (u.hostname === '0.0.0.0' || u.hostname === '::') u.hostname = '127.0.0.1';
  if (!u.port) u.port = '11434';
  return u.origin;
}

async function embedOne(text, spec) {
  const s = parseSpec(spec);
  if (!s) throw new Error('embedding 后端已关闭（LORE_EMBED=off）');

  if (s.kind === 'ollama') {
    const r = await post(ollamaBase() + '/api/embeddings', { model: s.model, prompt: text });
    if (r.error) throw new Error('ollama: ' + r.error);
    if (!r.embedding) throw new Error('ollama 未返回 embedding');
    return r.embedding;
  }

  // openai 兼容：OpenAI 本身、硅基流动、DashScope 兼容模式等都走这条
  const base = process.env.LORE_EMBED_BASE || 'https://api.openai.com/v1';
  const key = process.env.OPENAI_API_KEY || process.env.LORE_EMBED_KEY;
  if (!key) throw new Error('缺少 OPENAI_API_KEY / LORE_EMBED_KEY');
  const r = await post(base + '/embeddings', { model: s.model, input: text },
    { authorization: 'Bearer ' + key });
  if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r.data[0].embedding;
}

/** 带磁盘缓存的批量 embedding。文本没变就不重算 —— 评测要反复跑，不缓存会很慢也很贵 */
async function embedAll(texts, spec) {
  const s = parseSpec(spec);
  const tag = s ? s.kind + '-' + s.model : 'off';
  ensureDir(CACHE_DIR);
  const out = [];
  for (const t of texts) {
    const f = path.join(CACHE_DIR, sha1(tag + '|' + t) + '.json');
    const hit = readIfExists(f);
    if (hit) { out.push(JSON.parse(hit)); continue; }
    const v = await embedOne(t, spec);
    fs.writeFileSync(f, JSON.stringify(v), 'utf8');
    out.push(v);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 探测后端是否可用 —— 不可用时上层要能降级到关键词，而不是报错 */
async function probe(spec) {
  const s = parseSpec(spec);
  if (!s) return { ok: false, why: 'LORE_EMBED=off' };
  try {
    const v = await embedOne('probe', spec);
    return { ok: true, kind: s.kind, model: s.model, dim: v.length };
  } catch (e) {
    return { ok: false, kind: s.kind, model: s.model, why: e.message };
  }
}

module.exports = { embedAll, embedOne, cosine, probe, parseSpec, CACHE_DIR };
