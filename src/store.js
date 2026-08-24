'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS, METRICS } = require('./config');
const { ensureDir, sha1, readIfExists, appendJsonl, readJsonl } = require('./util');

const snapFile = (repo, file) => path.join(DIRS.snapshot, repo, sha1(file) + '.json');

/** 记录 agent 写入后的文件状态。这是"人类修正"的比较基准 */
function putSnapshot(repo, file, content, sessionId) {
  const p = snapFile(repo, file);
  ensureDir(path.dirname(p));
  // 记 sessionId 是为了把同一次交互里改的多个文件聚成一个归因批次：
  // 一次需求改动常横跨多文件，逐个文件归因既重复、模型又缺跨文件上下文
  fs.writeFileSync(p, JSON.stringify({ file, content, at: Date.now(), by: 'agent', sessionId }), 'utf8');
}

function getSnapshot(repo, file) {
  const raw = readIfExists(snapFile(repo, file));
  return raw ? JSON.parse(raw) : null;
}

function dropSnapshot(repo, file) {
  try { fs.unlinkSync(snapFile(repo, file)); } catch { /* 本来就没有 */ }
}

function listSnapshots(repo) {
  const dir = path.join(DIRS.snapshot, repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// —— 待归因队列 ——
const pendingFile = (repo) => path.join(DIRS.pending, repo + '.jsonl');
const addPending  = (repo, rec) => appendJsonl(pendingFile(repo), rec);
const listPending = (repo) => readJsonl(pendingFile(repo)).filter((r) => !r.classified);

function markClassified(repo, id) {
  const f = pendingFile(repo);
  const all = readJsonl(f).map((r) => (r.id === id ? { ...r, classified: true } : r));
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// —— 候选（已归因、未达阈值）——
const candFile  = (repo) => path.join(DIRS.candidate, repo + '.jsonl');
const addCandidate  = (repo, rec) => appendJsonl(candFile(repo), rec);
const listCandidates = (repo) => readJsonl(candFile(repo));

// —— 已确认的知识 ——
const convFile = (repo) => path.join(DIRS.convention, repo + '.md');
const pitDir   = (repo) => path.join(DIRS.pitfall, repo);

/** convention 是全量常驻的，追加进一个 md 文件 */
function addConvention(repo, rule, evidence) {
  const f = convFile(repo);
  ensureDir(path.dirname(f));
  const block = `\n- ${rule}\n  <!-- 来源: ${evidence.count} 次人工修正, 首见 ${new Date(evidence.firstSeen).toISOString().slice(0, 10)}, id=${evidence.key} -->\n`;
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${repo} · 编码规范\n\n> 由 agent-lore 从人工修正中提炼。每条都附来源，可回溯可删除。\n`, 'utf8');
  fs.appendFileSync(f, block, 'utf8');
}

const getConventions = (repo) => readIfExists(convFile(repo)) || '';

/** pitfall 按文件路径分片存，注入时按路径/符号召回 */
function addPitfall(repo, rec) {
  const d = pitDir(repo);
  ensureDir(d);
  const f = path.join(d, sha1(rec.file) + '.jsonl');
  appendJsonl(f, rec);
}

function getPitfalls(repo, file) {
  const f = path.join(pitDir(repo), sha1(file) + '.jsonl');
  return readJsonl(f);
}

function allPitfalls(repo) {
  const d = pitDir(repo);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => readJsonl(path.join(d, f)));
}

const recordMetric = (rec) => appendJsonl(METRICS, { ...rec, at: Date.now() });
const readMetrics  = () => readJsonl(METRICS);

module.exports = {
  putSnapshot, getSnapshot, dropSnapshot, listSnapshots,
  addPending, listPending, markClassified,
  addCandidate, listCandidates,
  addConvention, getConventions, addPitfall, getPitfalls, allPitfalls,
  recordMetric, readMetrics,
};
