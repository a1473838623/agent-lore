'use strict';
/**
 * 远端后端：把 store 的调用发到看板的 /store 接口，数据只有服务器上那一份。
 *
 * 为什么是同步的。hook 是一次性进程 —— 读 stdin、干活、写 stdout、退出，
 * 没有别的事要并发做，所以「不阻塞」在这里没有价值；
 * 而保住同步签名意味着 11 个调用方、68 个调用点一行都不用改。
 * 全链路改 async 能达到同样的效果，但要动的代码多二十倍，
 * 而这个项目没有测试兜底。
 *
 * 同步 HTTP 的做法：起一个 worker 线程去做真正的异步请求，
 * 主线程用 Atomics.wait 停在 SharedArrayBuffer 上等它，
 * 结果经 MessageChannel 回传，用 receiveMessageOnPort 取出来。
 * 这三个都是 Node 内置的，不引入任何第三方依赖 —— 那是这个项目的一条底线。
 *
 * 出错一律抛异常，不回退到本地文件：回退会当场制造出第二份数据，
 * 而单一数据源正是这次改造要解决的问题。
 * 调用方（hook）本来就有 fail-open 的 try/catch，抛出去它们会安静跳过。
 */
const os = require('os');
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const { base: BASE, token: TOKEN, timeout: TIMEOUT } = require('./remote').conf();

const FNS = [
  'putSnapshot', 'getSnapshot', 'dropSnapshot', 'listSnapshots',
  'addPending', 'listPending', 'markClassified',
  'addCandidate', 'listCandidates',
  'addConvention', 'getConventions', 'addPitfall', 'getPitfalls', 'allPitfalls',
  'recordMetric', 'readMetrics',
  'addCritique', 'readCritique', 'readHandled', 'writeHandled',
  'addEval', 'readEval', 'evalPath', 'readClients',
];

// worker 只在第一次调用时起，起完复用。
// 一次 hook 通常连着调三五次 store，摊下来这点启动开销可以忽略
let worker = null;
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'store-remote-worker.js'));
  // 不 unref 的话主线程干完活也退不掉
  worker.unref();
  return worker;
}

function call(fn, args) {
  if (!BASE) throw new Error('AGENT_LORE_REMOTE 未设置');
  const w = ensureWorker();
  const shared = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  w.postMessage(
    { shared, port: port2, url: BASE + '/store', token: TOKEN, timeout: TIMEOUT, fn, args,
      // 带上机器名，服务端记下谁在接入 —— 否则「有几台机器在用」无从得知
      client: os.hostname() },
    [port2]);

  // 0 是初始值；worker 完事后写 1 再 notify。
  // 这里给的超时比请求超时略长，免得两边同时到点导致读不到结果
  const st = Atomics.wait(shared, 0, 0, TIMEOUT + 1000);
  if (st === 'timed-out') throw new Error('lore 远端超时：' + BASE);

  const msg = receiveMessageOnPort(port1);
  if (!msg) throw new Error('lore 远端无响应');
  const r = msg.message;
  if (r.error) throw new Error('lore 远端出错：' + r.error);
  return r.value;
}

module.exports = Object.fromEntries(
  FNS.map((fn) => [fn, (...args) => call(fn, args)]));
