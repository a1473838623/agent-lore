'use strict';
/**
 * 接入自检：一条命令回答「我现在到底在不在用 lore」。
 *
 * 这个问题原本没法直接回答 —— hook 装没装要翻 Claude Code 的 settings.json，
 * 数据读的是本地还是服务器要看环境变量和配置文件哪个生效，
 * 服务器通不通要自己去 curl。任何一环断了都是静默失败：
 * hook 有 fail-open，读不到就跳过，界面上什么都不会显示。
 * 于是「配好了以为在用，其实一直没生效」是最容易发生的状态。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME } = require('./config');
const { conf } = require('./remote');
const embedMod = require('./embed');

const HOOKS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'];

function hookState() {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  const out = { file: p, found: {} };
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return out; }
  for (const [evt, groups] of Object.entries(d.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        const cmd = h.command || '';
        if (!/lore/i.test(cmd)) continue;
        const m = cmd.match(/"([^"]+)"/);
        const script = m ? m[1] : cmd;
        out.found[evt] = { script, exists: fs.existsSync(script) };
      }
    }
  }
  return out;
}

function probe(base, token, timeout) {
  // 用 store 自己那条路探活，而不是单发一个 HTTP —— 要验的是
  // 「hook 真正走的那条链路通不通」，不是「这台服务器 ping 得到」
  const t0 = Date.now();
  try {
    const store = require('./store');
    const n = store.getConventions('_global').split('\n').length;
    return { ok: true, ms: Date.now() - t0, lines: n };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: e.message };
  }
}

function report(repo) {
  const c = conf();
  const remote = !!c.base;
  const h = hookState();
  const p = probe(c.base, c.token, c.timeout);

  const L = [];
  L.push('接入自检');
  L.push('─'.repeat(52));

  L.push(`  数据后端    ${remote ? '远端 ' + c.base : '本机文件 ' + HOME}`);
  if (remote) {
    L.push(`              令牌 ${c.token ? '已配' : '未配'}　超时 ${c.timeout}ms`);
    L.push(`              配置来源 ${process.env.AGENT_LORE_REMOTE ? '环境变量' : 'settings.json'}`);
  }
  L.push(`  连通        ${p.ok ? `正常　${p.ms}ms　全局规范 ${p.lines} 行` : '失败：' + p.why}`);

  // Embedding 是同一类静默失败：配错机器不会报错，只是语义召回一直不生效、
  // 悄悄降级回关键词。这里只报配置（同步、不发请求），要验连通用 `lore embed`。
  const ec = embedMod.conf();
  const espec = embedMod.parseSpec();
  if (!espec) {
    L.push('  Embedding   已关闭（embed=off）　语义召回不启用，仅用关键词');
  } else {
    const ebase = espec.kind === 'ollama'
      ? embedMod.ollamaBase(ec.base)
      : (ec.base || 'https://api.openai.com/v1');
    const esrc = process.env.LORE_EMBED || process.env.LORE_EMBED_BASE ? '环境变量'
      : (ec.base ? 'settings.json' : '默认值');
    L.push(`  Embedding   ${espec.kind}:${espec.model} → ${ebase}`);
    L.push(`              配置来源 ${esrc}　连通性用 \`lore embed\` 验`);
  }

  L.push('');
  const missing = HOOKS.filter((e) => !h.found[e]);
  const broken = HOOKS.filter((e) => h.found[e] && !h.found[e].exists);
  L.push(`  hook 注册   ${missing.length ? '缺 ' + missing.join('、') : '三个都在'}`
    + (broken.length ? `　★路径不存在：${broken.join('、')}` : ''));
  for (const e of HOOKS) {
    const f = h.found[e];
    L.push(`    ${e.padEnd(18)}${f ? (f.exists ? '✓ ' : '✗ ') + f.script : '未注册'}`);
  }

  // 装了 hook 不等于在用。只有真实调用能证明，而且要看最近有没有 ——
  // 一个月前的记录说明不了今天在不在用
  const ago = (t) => {
    const d = Date.now() - t;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
    return Math.round(d / 86400e3) + ' 天前';
  };

  let fresh = 0;
  try {
    const store = require('./store');
    const all = store.readMetrics();
    const now = Date.now();
    fresh = all.filter((r) => now - (r.at || 0) < 24 * 3600e3).length;
    const last = all.reduce((m, r) => Math.max(m, r.at || 0), 0);
    L.push('');
    L.push(`  产出记录    累计 ${all.length} 条　近 24 小时 ${fresh} 条`
      + (last ? `　最后一次 ${ago(last)}` : ''));
    if (!fresh) {
      L.push('    近一天没有新记录。可能的原因：');
      L.push('    · 装好 hook 后没重启 Claude Code');
      L.push('    · 改动都走了 Bash，而 hook 只认 Edit 与 Write 工具');
      L.push('    · 这段时间确实没编辑代码');
    }
  } catch { L.push('  产出记录    读不到（后端不通）'); }

  // 多台机器共用一份数据时，这是唯一能看出「几台在接入」的地方
  if (remote) {
    try {
      const m = require('./store').readClients();
      if (m && Object.keys(m).length) {
        L.push('');
        L.push('  接入的机器');
        for (const [k, v] of Object.entries(m).sort((a, b) => b[1].last - a[1].last)) {
          L.push(`    ${k.padEnd(20)}${String(v.calls).padStart(6)} 次　${ago(v.last)}`
            + (k === os.hostname() ? '　← 本机' : ''));
        }
      }
    } catch { /* 老服务端没这个接口，不影响自检的其余部分 */ }
  }

  L.push('');
  const ok = p.ok && !missing.length && !broken.length;
  L.push(ok
    ? (fresh ? '  结论  已接入，近一天有产出。'
             : '  结论  已接入，但近一天没有产出 —— 看上面列的三个原因。')
    : '  结论  没有完整接入，上面标 ✗ 或失败的那几项要先解决。');
  return L.join('\n');
}

module.exports = { report, hookState, conf };
