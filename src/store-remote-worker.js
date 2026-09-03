'use strict';
/**
 * store-remote 的工作线程。主线程停在 Atomics.wait 上，由这里发真正的请求，
 * 完事后写标志位并唤醒它。
 *
 * 用 http/https 模块而不是 fetch：fetch 在 Node 18 以下没有，
 * 而 package.json 只要求 >=18，不值得为一个内部调用抬高门槛。
 */
const http = require('http');
const https = require('https');
const { parentPort } = require('worker_threads');

parentPort.on('message', ({ shared, port, url, token, timeout, fn, args, client }) => {
  const done = (payload) => {
    port.postMessage(payload);
    // 先写值再 notify：反过来的话主线程可能被唤醒时还看到旧值，
    // Atomics.wait 会认为是伪唤醒继续等下去
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
  };

  let u;
  try { u = new URL(url); } catch (e) { return done({ error: '地址不合法: ' + url }); }
  const body = Buffer.from(JSON.stringify({ fn, args }), 'utf8');
  const mod = u.protocol === 'https:' ? https : http;

  const req = mod.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    timeout,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      ...(token ? { 'x-lore-token': token } : {}),
      ...(client ? { 'x-lore-client': encodeURIComponent(client) } : {}),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (res.statusCode !== 200) return done({ error: 'HTTP ' + res.statusCode + ' ' + text.slice(0, 200) });
      try {
        const r = JSON.parse(text);
        done(r.ok ? { value: r.value } : { error: r.why || '未知错误' });
      } catch (e) { done({ error: '响应不是 JSON: ' + text.slice(0, 120) }); }
    });
  });

  req.on('timeout', () => { req.destroy(); done({ error: '请求超时 ' + timeout + 'ms' }); });
  req.on('error', (e) => done({ error: e.message }));
  req.end(body);
});
