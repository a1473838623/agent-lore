'use strict';
const fs = require('fs');
const path = require('path');
const { HOME } = require('./config');
const { ensureDir, readIfExists } = require('./util');

/**
 * 用户偏好 —— 与知识数据分开存。
 *
 * 知识数据是"学到的东西"，偏好是"你怎么用它"。混在一起的话，
 * 想重置知识库就得连偏好一起删，反过来也一样。
 */
const FILE = path.join(HOME, 'settings.json');

const DEFAULTS = {
  autostart: false,        // 开机自启看板
  autostartCwd: null,      // 自启时用哪个仓库目录——看板是按仓库作用域的，不能用启动文件夹的 cwd
  autoUpdate: false,       // 启动时自动拉取 agent-lore 新版本
  refreshMs: 5000,         // 看板轮询间隔，0 = 关闭
  // 多台机器共用一份知识时填这三个：数据只在服务器上，本机不存。
  // 环境变量同名项优先级更高，留空即本机读写文件
  remote: null,            // 例如 http://10.0.8.2:4519
  remoteToken: null,
  remoteTimeout: 5000,
};

function load() {
  const raw = readIfExists(FILE);
  if (!raw) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(raw) }; } catch { return { ...DEFAULTS }; }
}

function save(patch) {
  const next = { ...load(), ...patch };
  ensureDir(path.dirname(FILE));
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { load, save, DEFAULTS, FILE };
