'use strict';
/**
 * 本地文件后端。这是知识数据的实际读写实现，全部同步。
 *
 * store.js 会在「本机直接读文件」和「走 HTTP 找远端要」之间选一个，
 * 这个文件只管前者；容器里的看板也直接用它，因为数据就在它脚下。
 */
const fs = require('fs');
const path = require('path');
const { HOME, DIRS, METRICS } = require('./config');
const { ensureDir, sha1, readIfExists, appendJsonl, readJsonl, repoRel } = require('./util');

// key 用仓库内相对路径，不用绝对路径 —— 见 util.repoRel 的说明
const snapFile = (repo, file) => path.join(DIRS.snapshot, repo, sha1(repoRel(repo, file)) + '.json');

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
  const f = path.join(d, sha1(repoRel(repo, rec.file)) + '.jsonl');
  appendJsonl(f, rec);
}

function getPitfalls(repo, file) {
  const f = path.join(pitDir(repo), sha1(repoRel(repo, file)) + '.jsonl');
  return readJsonl(f);
}

function allPitfalls(repo) {
  const d = pitDir(repo);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => readJsonl(path.join(d, f)));
}

const recordMetric = (rec) => appendJsonl(METRICS, { ...rec, at: Date.now() });
const readMetrics  = () => readJsonl(METRICS);

// ── 会话层学习信号与评测语料 ──────────────────────────────
// 这两样原本由 critique.js 与 eval.js 直接读写 HOME，绕开了 store。
// 单机时没差别，一旦数据挪到远端，它们就会继续写本机 ——
// 于是一半知识在服务器、一半在本地，正是这次改造要消灭的分叉。
const critiqueFile = () => path.join(HOME, 'critique.jsonl');
const handledFile  = () => path.join(HOME, 'critique-handled.json');
const evalFile     = (repo) => path.join(HOME, 'eval', repo + '.jsonl');

const addCritique  = (rec) => appendJsonl(critiqueFile(), rec);
const readCritique = () => { try { return readJsonl(critiqueFile()); } catch { return []; } };

function readHandled() {
  try { return JSON.parse(fs.readFileSync(handledFile(), 'utf8')); } catch { return {}; }
}
function writeHandled(obj) {
  ensureDir(HOME);
  try { fs.writeFileSync(handledFile(), JSON.stringify(obj, null, 2), 'utf8'); } catch { /* ignore */ }
}

function addEval(repo, rec) {
  ensureDir(path.dirname(evalFile(repo)));
  appendJsonl(evalFile(repo), rec);
}
const readEval = (repo) => readJsonl(evalFile(repo));
const evalPath = (repo) => evalFile(repo);

// 谁在接入。只有服务端会写它（见 dashboard 的 /store），
// 本地后端读到的多半是空的，这正常
const readClients = () => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'clients.json'), 'utf8')); }
  catch { return {}; }
};

module.exports = {
  readClients,
  addCritique, readCritique, readHandled, writeHandled,
  addEval, readEval, evalPath,
  putSnapshot, getSnapshot, dropSnapshot, listSnapshots,
  addPending, listPending, markClassified,
  addCandidate, listCandidates,
  addConvention, getConventions, addPitfall, getPitfalls, allPitfalls,
  recordMetric, readMetrics,
};
