#!/usr/bin/env node
'use strict';
/**
 * 一次性迁移：把 snapshot 与 pitfall 的分片文件名从 sha1(绝对路径)
 * 改成 sha1(仓库内相对路径)。
 *
 * 为什么要迁：旧 key 里含绝对路径，知识被绑死在一台机器的目录布局上。
 * 换盘符、挪目录、或者换台机器，sha1 全变，积累的条目一条也召回不到。
 * 而 repoId 本身与路径无关，两者对不齐。
 *
 * 用法：
 *   node bin/migrate-keys.js          先看会改什么，不落盘
 *   node bin/migrate-keys.js --apply  真正执行
 *
 * 幂等：已经是新 key 的文件会被跳过，重复跑没有副作用。
 */
const fs = require('fs');
const path = require('path');
const { DIRS } = require('../src/config');
const { sha1, repoRel, readJsonl } = require('../src/util');

const APPLY = process.argv.includes('--apply');
const stat = { scanned: 0, renamed: 0, already: 0, merged: 0, skipped: 0 };

/** 目标已存在时把内容并过去，而不是覆盖 —— 两个旧 key 可能映射到同一个新 key */
function put(src, dst, jsonl) {
  if (!fs.existsSync(dst)) { fs.renameSync(src, dst); stat.renamed++; return; }
  if (jsonl) {
    fs.appendFileSync(dst, fs.readFileSync(src));
    fs.unlinkSync(src);
    stat.merged++;
  } else {
    // 快照只保留较新的那份，它才是「agent 最后写成什么样」的基准
    const keep = fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs;
    if (keep) fs.renameSync(src, dst); else fs.unlinkSync(src);
    stat.merged++;
  }
}

function migrateDir(base, ext, fileOf) {
  if (!fs.existsSync(base)) return;
  for (const repo of fs.readdirSync(base)) {
    const dir = path.join(base, repo);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(ext)) continue;
      const src = path.join(dir, name);
      stat.scanned++;
      const orig = fileOf(src);
      if (!orig) { stat.skipped++; continue; }
      const want = sha1(repoRel(repo, orig)) + ext;
      if (want === name) { stat.already++; continue; }
      console.log(`  ${repo}/${name.slice(0, 8)}… → ${want.slice(0, 8)}…  ${repoRel(repo, orig)}`);
      if (APPLY) put(src, path.join(dir, want), ext === '.jsonl');
    }
  }
}

console.log(APPLY ? '执行迁移\n' : '试运行，不落盘。确认无误后加 --apply\n');

console.log('snapshot:');
migrateDir(DIRS.snapshot, '.json', (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).file || null; } catch { return null; }
});

console.log('pitfall:');
migrateDir(DIRS.pitfall, '.jsonl', (p) => {
  const rows = readJsonl(p);
  return rows.length ? rows[0].file || null : null;
});

console.log(`\n扫描 ${stat.scanned}　改名 ${stat.renamed}　合并 ${stat.merged}`
  + `　已是新 key ${stat.already}　读不出路径跳过 ${stat.skipped}`);
if (!APPLY && stat.scanned - stat.already - stat.skipped > 0) {
  console.log('加 --apply 执行');
}
