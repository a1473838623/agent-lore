'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { HOME } = require('./config');
const { ensureDir, readIfExists } = require('./util');

/**
 * 看板的后台启停 —— 对齐 agent-beacon 的 `beacon start -d` / `stop`。
 *
 * 这才该是主路径，开机自启只是可选项：
 *   看板是"想看时才看"的东西，常驻一个进程在那儿转没什么必要，
 *   而且启动项在 Windows 上会撞安全软件（见 autostart.js）。
 *   显式启停既不需要任何系统权限，也不会在你不用的时候占资源。
 */
const PIDFILE = path.join(HOME, 'dashboard.pid');
const BIN = path.join(__dirname, '..', 'bin', 'lore.js');

const readPid = () => {
  const raw = readIfExists(PIDFILE);
  const n = raw && Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 端口是否被占。比 pid 更可靠：pid 文件可能是上次没清理干净的残留 */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

async function status(port) {
  const pid = readPid();
  const running = alive(pid);
  const busy = await portBusy(port);
  return {
    pid: running ? pid : null,
    running,
    portBusy: busy,
    // pid 死了但端口还占着 = 有个不是我们启的进程在用这个端口，或残留
    orphanPort: busy && !running,
    url: 'http://127.0.0.1:' + port,
  };
}

async function start(cwd, port) {
  const st = await status(port);
  if (st.running) return { ok: true, already: true, pid: st.pid, url: st.url };
  if (st.portBusy) return { ok: false, why: `端口 ${port} 已被占用，但不是本工具启的进程` };

  const args = [BIN, 'dashboard'];
  if (cwd) args.push('--cwd', cwd);
  // detached:true —— 让子进程独立存活，否则父进程(敲 -d 的那个)一退出就把它带走，
  //                  表现为"启动成功但打开是空的"。
  // windowsHide:true —— 压住控制台窗口，不闪黑窗口。
  // 两者并存：detached 保活，windowsHide 无窗口。unref() 让父进程不等它。
  const child = spawn(process.execPath, args, {
    cwd: cwd || process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_LORE_PORT: String(port) },
  });
  child.unref();

  ensureDir(path.dirname(PIDFILE));
  fs.writeFileSync(PIDFILE, String(child.pid), 'utf8');

  // 等端口真正起来再报成功，否则"启动成功"之后打开是空白
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await portBusy(port)) return { ok: true, pid: child.pid, url: 'http://127.0.0.1:' + port };
  }
  return { ok: false, pid: child.pid, why: '进程已拉起但端口 6 秒内未监听，看看是不是启动就崩了' };
}

async function stop(port) {
  const pid = readPid();
  if (!alive(pid)) {
    try { fs.unlinkSync(PIDFILE); } catch { /* 没有就算了 */ }
    const busy = await portBusy(port);
    return busy
      ? { ok: false, why: `没有本工具的进程记录，但端口 ${port} 仍被占用——需要手动处理` }
      : { ok: true, already: true };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* 已经没了 */ }

  // 确认端口真的释放。只 kill 不确认，下次启动会撞 EADDRINUSE，
  // 而那个现象看起来像代码有问题——这条规则就在知识库里
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await portBusy(port))) {
      try { fs.unlinkSync(PIDFILE); } catch { /* ignore */ }
      return { ok: true, pid };
    }
  }
  return { ok: false, pid, why: '已发送终止信号但端口 3 秒内未释放' };
}

/**
 * 就地重启当前看板进程。用于「立即更新」后让新代码生效。
 *
 * 难点：当前进程自己就占着端口，没法先起新进程再退旧的。
 * 所以派生一个**独立的引导进程**(脱离当前进程)，它轮询等端口释放后再起新看板；
 * 然后当前进程主动退出。引导进程用 node 跑一小段 inline 脚本，零额外文件。
 */
function scheduleRestart(cwd, port) {
  const boot = `
    const net=require('net'),{spawn}=require('child_process');
    const port=${port}, bin=${JSON.stringify(BIN)}, cwd=${JSON.stringify(cwd || process.cwd())};
    const free=()=>new Promise(r=>{const s=net.createServer();
      s.once('error',()=>r(false));s.once('listening',()=>s.close(()=>r(true)));s.listen(port,'127.0.0.1');});
    (async()=>{
      for(let i=0;i<60;i++){ if(await free()) break; await new Promise(r=>setTimeout(r,200)); }
      const c=spawn(process.execPath,[bin,'dashboard','--cwd',cwd],
        {cwd,detached:true,windowsHide:true,stdio:'ignore',
         env:{...process.env,AGENT_LORE_PORT:String(port)}});
      c.unref();
    })();`;
  const boot2 = spawn(process.execPath, ['-e', boot], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  boot2.unref();
  // 给引导进程一点时间站稳，再退出自己
  setTimeout(() => process.exit(0), 300);
}

module.exports = { start, stop, status, scheduleRestart, PIDFILE };
