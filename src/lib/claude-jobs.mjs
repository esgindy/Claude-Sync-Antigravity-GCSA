// Detached Claude run jobs (Echo). Layout: <home>/claude-jobs/<id>/{job.json,prompt.txt,result.json}
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, loadConfig } from './paths.mjs';
import { readJson, writeJson, pidAlive } from './store.mjs';
import { checkPaths, isTooBroad } from './safety.mjs';
import { logMessage } from './messages.mjs';
import { refreshClaudeUsage } from './claude-usage.mjs';

const runnerPath = fileURLToPath(new URL('../claude-runner.mjs', import.meta.url));
export const DEFAULT_CLAUDE_TIMEOUT_S = 900;
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 48000;

export const claudeJobsRoot = () => join(home, 'claude-jobs');
export const claudeJobDir = (id) => join(claudeJobsRoot(), id);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function inside(base, target) {
  const r = relative(base, target);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };

function allowedRoots() {
  const roots = loadConfig().allowed_roots;
  return Array.isArray(roots) ? roots.map((r) => real(String(r)) || resolve(String(r))) : [];
}

/** Real (junction-resolved) directory that must pass secret check and allowed_roots. Throws otherwise. */
export function vetDir(dir, label = 'cwd') {
  const rp = real(dir);
  if (!rp || !statSync(rp).isDirectory()) throw new Error(`${label} does not exist: ${dir}`);
  const c = checkPaths([rp]);
  if (c.blocked.length) throw new Error(`Refused ${label}: ${c.blocked[0].reason}`);
  if (isTooBroad(rp)) throw new Error(`Refused ${label}: ${dir} is a drive root or the user profile folder; use a project folder.`);
  const roots = allowedRoots();
  if (roots.length && !roots.some((r) => inside(r, rp))) throw new Error(`${label} is outside allowed_roots: ${dir}`);
  return rp;
}

/** Resolve user-supplied files against cwd with realpath. Returns {ok:[abs], blocked:[{path,reason}]}. */
export function vetFiles(files, cwd, extraDirs = []) {
  const ok = [];
  const blocked = [];
  const base = vetDir(cwd);
  const bases = [base, ...extraDirs.map((d) => real(d)).filter(Boolean)];
  const roots = allowedRoots();
  for (const f of files || []) {
    const rp = real(resolve(base, String(f)));
    if (!rp) { blocked.push({ path: String(f), reason: 'not found' }); continue; }
    if (!bases.some((r) => inside(r, rp))) { blocked.push({ path: String(f), reason: 'outside the working directory' }); continue; }
    if (roots.length && !roots.some((r) => inside(r, rp))) { blocked.push({ path: String(f), reason: 'outside allowed_roots' }); continue; }
    const c = checkPaths([rp, resolve(base, String(f))]);
    if (c.blocked.length) { blocked.push({ path: String(f), reason: c.blocked[0].reason }); continue; }
    ok.push(rp);
  }
  return { ok, blocked };
}

/** Sum cost_usd of Claude jobs created today (local date taken from the job id). */
export function dailyClaudeSpend() {
  const prefix = stamp().slice(0, 8);
  let sum = 0;
  let names = [];
  try { names = readdirSync(claudeJobsRoot()); } catch { return 0; }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const r = readJson(join(claudeJobsRoot(), n, 'result.json'));
    if (r && Number.isFinite(Number(r.cost_usd))) sum += Number(r.cost_usd);
  }
  return sum;
}

export function buildReviewPrompt({ goal, summary, files, cwd }) {
  let total = 0;
  const parts = [];
  for (const abs of files) {
    let body;
    try {
      if (!statSync(abs).isFile()) continue;
      body = readFileSync(abs, 'utf8');
    } catch { parts.push(`--- ${relative(cwd, abs)} (could not be read) ---`); continue; }
    let truncated = false;
    if (body.length > MAX_FILE_CHARS) { body = body.slice(0, MAX_FILE_CHARS); truncated = true; }
    if (total + body.length > MAX_TOTAL_CHARS) { parts.push(`--- ${relative(cwd, abs)} (omitted: size budget reached; read it yourself) ---`); continue; }
    total += body.length;
    parts.push(`--- ${relative(cwd, abs)}${truncated ? ' (truncated)' : ''} ---\n${body}`);
  }
  return [
    'You are the reviewer of work that was just done by Antigravity (another AI coding agent). Review it critically but fairly. Do not modify anything.',
    '',
    `Original goal:\n${goal}`,
    '',
    `Antigravity's summary of what it did:\n${summary}`,
    '',
    `Working directory: ${cwd}`,
    parts.length ? `Files changed (current contents):\n${parts.join('\n\n')}` : 'No file contents were supplied; inspect the working directory yourself if needed.',
    '',
    'Answer ONLY with a JSON object, no other text, in exactly this shape:',
    '{"verdict":"approve"|"changes","notes":"short explanation","required_changes":["each concrete change needed, empty if approve"]}',
  ].join('\n');
}

export function buildTaskPrompt({ task, allowEdits, cwd }) {
  return [
    'Antigravity (another AI coding agent) hands you this task. You are better suited for careful reasoning, review and security work.',
    allowEdits
      ? 'You may read and edit files in the working directory (no shell commands). State clearly which files you changed.'
      : 'This is read-only: analyse and answer, do not modify files.',
    `Working directory: ${cwd}`,
    '',
    `Task:\n${task}`,
  ].join('\n');
}

function runningClaudeJobs() {
  const root = join(home, 'claude-jobs');
  let n = 0;
  try {
    for (const id of readdirSync(root)) {
      const j = readJson(join(root, id, 'job.json'));
      if (!j || (j.state !== 'queued' && j.state !== 'running')) continue;
      let alive = true;
      if (j.runner_pid) { try { process.kill(j.runner_pid, 0); } catch { alive = false; } }
      if (alive) n += 1;
    }
  } catch { /* no jobs yet */ }
  return n;
}

/**
 * Start a detached Claude job.
 * kind: 'review' | 'task'. For task, allow_edits picks task mode vs plan mode.
 */
export function startClaudeJob({ kind, prompt, cwd, add_dirs = [], chain_id = null, hop = 0, allow_edits = false, timeout_s = DEFAULT_CLAUDE_TIMEOUT_S, request_text = '', model = null }) {
  if (model != null && !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,80}$/.test(String(model))) throw new Error(`Invalid model name: ${model}`);
  if (!cwd) throw new Error('cwd is required');
  const cfg = loadConfig();
  const cap = Number(cfg.daily_max_claude_usd);
  if (Number.isFinite(cap) && cap > 0) {
    const spent = dailyClaudeSpend();
    if (spent >= cap) throw new Error(`Daily Claude budget reached (${spent.toFixed(2)} of ${cap} USD). Stop and report to the user.`);
  }
  // Costs land only when a run finishes, so also cap how many Claude runs are in flight at once.
  const maxPar = Number(cfg.claude_max_parallel) || 2;
  if (runningClaudeJobs() >= maxPar) throw new Error(`Too many Claude jobs running (${maxPar}). Wait for one to finish with claude_wait.`);
  cwd = vetDir(cwd);
  const dirChk = { ok: add_dirs.map((d) => vetDir(d, 'add_dir')) };
  const id = `${stamp()}-${randomBytes(3).toString('hex')}`;
  const dir = claudeJobDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.txt'), prompt, 'utf8');
  const job = {
    id, state: 'queued', kind, mode: kind === 'task' && allow_edits ? 'task' : 'review',
    cwd, add_dirs: dirChk.ok, timeout_s, chain_id, hop, model: model || null,
    created: new Date().toISOString(), started: null, ended: null, runner_pid: null, error: null,
  };
  writeJson(join(dir, 'job.json'), job);
  try {
    logMessage({ direction: 'antigravity->claude', channel: 'claude-cli', job_id: id, chain_id: chain_id || undefined, kind: kind === 'review' ? 'review' : 'task', text: request_text || prompt });
  } catch { /* logging must not break the job */ }
  const child = spawn(process.execPath, [runnerPath, dir], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  writeJson(join(dir, 'job.json'), { ...readJson(join(dir, 'job.json')), runner_pid: child.pid });
  try { refreshClaudeUsage({ reason: 'claude_job_start' }); } catch { /* never throw */ }
  return { job_id: id, chain_id, hop };
}

export function readClaudeJob(id) {
  if (!/^[0-9]{14}-[0-9a-f]{6}$/.test(String(id))) return null;
  const job = readJson(join(claudeJobDir(id), 'job.json'));
  if (!job) return null;
  if ((job.state === 'queued' || job.state === 'running') && job.runner_pid && !pidAlive(job.runner_pid)) {
    // Runner may have finished between our two reads; re-read once.
    const again = readJson(join(claudeJobDir(id), 'job.json'));
    if (again && (again.state === 'queued' || again.state === 'running')) {
      return { ...again, state: 'failed', error: again.error || 'runner process died' };
    }
    return again;
  }
  return job;
}

export function getClaudeCompact(id, { full = false } = {}) {
  const job = readClaudeJob(id);
  if (!job) return null;
  const res = readJson(join(claudeJobDir(id), 'result.json')) || {};
  const end = job.ended ? Date.parse(job.ended) : Date.now();
  const out = {
    job_id: id, state: job.state, kind: job.kind, chain_id: job.chain_id, hop: job.hop,
    elapsed_s: Math.round((end - Date.parse(job.created)) / 1000),
  };
  if (job.state === 'failed' || job.state === 'done') {
    if (res.verdict) { out.verdict = res.verdict; out.notes = res.notes; out.required_changes = res.required_changes; }
    if (res.session_id) out.session_id = res.session_id;
    if (res.cost_usd != null) out.cost_usd = res.cost_usd;
    const err = res.error || job.error;
    if (err) out.error = err;
    if (res.result != null) out.result = full ? res.result : (res.result.length > 3000 ? `${res.result.slice(0, 3000)}\n...(truncated, use claude_result)` : res.result);
  }
  return out;
}

export async function waitClaudeJob(id, waitS = 30) {
  const limit = Math.min(Math.max(Number(waitS) || 0, 0), 50) * 1000;
  const t0 = Date.now();
  for (;;) {
    const c = getClaudeCompact(id);
    if (!c) return null;
    if (c.state === 'done' || c.state === 'failed' || c.state === 'cancelled') return c;
    if (Date.now() - t0 >= limit) return c;
    await new Promise((r) => setTimeout(r, 400));
  }
}
