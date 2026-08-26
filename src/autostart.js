'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const settings = require('./settings');

/**
 * 开机自启看板 —— 与 agent-beacon 的 src/autostart.js 同款做法。
 *
 * Windows:  往启动文件夹写一个 .vbs，`WScript.Shell.Run cmd, 0, False`。
 *           **0 = 完全隐藏窗口**，开机不弹 cmd。这是 .vbs 相对 .lnk 的唯一原因。
 * Linux:    XDG autostart .desktop
 * macOS:    LaunchAgent plist
 *
 * best-effort：写失败(比如被安全软件拦)就返回 { ok:false, message }，UI 显示原因、
 * 把开关拨回去。不做任何规避——beacon 也是这个行为。
 *
 * 与 beacon 唯一的不同：beacon 的 daemon 是全局服务，本项目的看板按仓库作用域，
 * 所以 .vbs 里多一行 CurrentDirectory，把仓库目录固化进去，否则自启后看板显示空仓库。
 */

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'lore.js');
const NODE = process.execPath;
const NAME = 'agent-lore-dashboard';

function target() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
      'Start Menu', 'Programs', 'Startup', NAME + '.vbs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agentlore.dashboard.plist');
  }
  return path.join(os.homedir(), '.config', 'autostart', NAME + '.desktop');
}

/**
 * 把任意 JS 字符串编成一个**纯 ASCII 的 VBScript 字符串表达式**。
 *
 * 为什么必须这样：.vbs 由 wscript 按系统 GBK 读取，而我们写文件是 UTF-8。
 * 只要文件里有中文(路径含「秋招」)，读出来就是乱码 → 80070003 找不到路径。
 * 让文件保持纯 ASCII，中文用 ChrW(&Hxxxx) 在运行时还原，就彻底绕开编码问题。
 * 例："秋" → ChrW(&H79CB)。**必须用 ChrW 不是 Chr**：Chr() 只接受 0-255，
 * 传入 >255 会抛「无效的过程调用或参数」(800A0005)；ChrW() 才收 Unicode 码点。
 */
function vbsStr(s) {
  const parts = [];
  let lit = '';
  const flush = () => { if (lit) { parts.push('"' + lit.replace(/"/g, '""') + '"'); lit = ''; } };
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code < 128) lit += ch;
    else { flush(); parts.push('ChrW(&H' + code.toString(16).toUpperCase() + ')'); }
  }
  flush();
  return parts.length ? parts.join(' & ') : '""';
}

function body(cwd, port) {
  if (process.platform === 'win32') {
    // 与 beacon 同款：Run cmd, 0(隐藏), False(不等待)。
    // 整条命令用 vbsStr 编成纯 ASCII 表达式，中文路径不会乱码。
    const cmd = `"${NODE}" "${BIN}" dashboard --cwd "${cwd}"`;
    return [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Environment("PROCESS")("AGENT_LORE_PORT") = "${port}"`,
      `sh.Run ${vbsStr(cmd)}, 0, False`,
    ].join('\r\n') + '\r\n';
  }
  if (process.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentlore.dashboard</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${BIN}</string><string>dashboard</string></array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>AGENT_LORE_PORT</key><string>${port}</string></dict>
</dict></plist>
`;
  }
  return `[Desktop Entry]
Type=Application
Name=agent-lore dashboard
Exec=${NODE} ${BIN} dashboard
Path=${cwd}
X-GNOME-Autostart-enabled=true
Terminal=false
`;
}

function status() {
  const f = target();
  const exists = fs.existsSync(f);
  const s = settings.load();
  return {
    enabled: exists,
    file: f,
    cwd: s.autostartCwd,
    platform: process.platform,
    drift: exists !== !!s.autostart,
  };
}

function enable(cwd, port) {
  const f = target();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body(cwd, port || 4519), 'utf8');
    if (process.platform === 'darwin') { try { execFileSync('launchctl', ['load', f]); } catch { /* 已加载 */ } }
  } catch (e) {
    // 不绕过：如实返回失败原因，UI 会显示并把开关拨回去
    return { ok: false, file: f, message: e.message.split('\n')[0] };
  }
  if (!fs.existsSync(f)) return { ok: false, file: f, message: '写入后文件不存在，可能被安全软件拦截' };
  settings.save({ autostart: true, autostartCwd: cwd });
  return { ok: true, file: f, cwd };
}

function disable() {
  const f = target();
  try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
  if (process.platform === 'darwin') { try { execFileSync('launchctl', ['unload', f]); } catch { /* ignore */ } }
  settings.save({ autostart: false });
  return { ok: true, file: f };
}

module.exports = { enable, disable, status, target };
