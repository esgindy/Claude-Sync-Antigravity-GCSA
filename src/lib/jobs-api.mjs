// startJob / waitJob / cancelJob used by every tool.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './paths.mjs';
import { killProcessTree } from './platform.mjs';
import { createJob, readJob, updateJob, jobDir, readJson, writeJson, reapJob, pidAlive, jobsRoot } from './store.mjs';
import { randomBytes } from 'node:crypto';
import { checkPaths, resolveSafe, isInside, isTooBroad } from './safety.mjs';
import { selectTransport, recordTransportSuccess } from './transport.mjs';
import { usageJobsToday } from './usage.mjs';
import { logMessage } from './messages.mjs';
import { autoTier, pickModel } from './router.mjs';
import { listModels, findModel } from './models.mjs';
import { getQuota, quotaById } from './quota.mjs';
import { adoptLateResult, DESKTOP_WARNING } from './desktop-job.mjs';
import { resolveDesktopProjectBinding } from './workspace-binding.mjs';
import { refreshClaudeUsage } from './claude-usage.mjs';
import { recordNotification } from './notifications.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(here, '..', 'runner.mjs');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()\[\]-]{0,80}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function todayPrefix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Jobs started today: job folders created today, or usage-log entries if higher. */
export function jobsStartedToday() {
  let n = 0;
  try {
    const pre = todayPrefix();
    n = fs.readdirSync(jobsRoot()).filter((x) => x.startsWith(pre)).length;
  } catch { /* no jobs yet */ }
  return Math.max(n, usageJobsToday());
}

export const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export function preamble(kind) {
  if (kind === 'edit') {
    return [
      'You are executing a task for another AI agent (Claude), which will review your work.',
      'You may create and edit files inside the working directory and the added directories only.',
      'Never run shell commands yourself. If a command is needed, do not run it: list it in commands_requested with its cwd and the reason.',
      'Put the real answer or a clear report in the "summary" field of your structured output.',
      'List every file you created or changed in files_changed. Put open points in followups and anything the reviewer must know in handoff_notes.',
    ].join('\n');
  }
  return [
    'You are executing a READ-ONLY task for another AI agent (Claude), which will review your answer.',
    'Do not modify, create or delete any files.',
    'Never run shell commands. If a command would help, do not run it: list it in commands_requested with its cwd and the reason.',
    'Put the real answer in the "summary" field of your structured output (not just a pointer to it).',
    'files_changed must be an empty list for a read task. Put open points in followups and anything the reviewer must know in handoff_notes.',
  ].join('\n');
}

export async function resolveModel(config, input, target) {
  const base = { prompt: input.prompt, kind: input.kind, addDirs: input.add_dirs };
  if (target === 'desktop') {
    const t = input.tier && input.tier !== 'auto' ? input.tier : autoTier(base).tier;
    const why = input.tier && input.tier !== 'auto' ? `tier "${t}" chosen by the caller` : `auto: ${autoTier(base).reason}`;
    const alias = input.model || config.desktop_model_map?.[t] || 'flash';
    return { model: alias, tier: t, reason: input.model ? 'model chosen explicitly by the caller' : `${why} (desktop alias)` };
  }
  let models = [];
  let quotaMap = {};
  try { models = await listModels(); } catch { /* model list is optional */ }
  let explicit = input.model || null;
  if (explicit) {
    const found = findModel(explicit, models);
    if (found) explicit = found.id;
    else if (models.length) throw new Error(`Unknown model "${explicit}". Use agy_models to list valid ids.`);
  } else {
    try {
      const q = await Promise.race([getQuota(), new Promise((_, rej) => setTimeout(() => rej(new Error('quota timeout')), 12000).unref())]);
      quotaMap = quotaById(q, models);
    } catch { /* ignore quota errors */ }
  }
  return pickModel(config, { ...base, tier: input.tier, model: explicit }, quotaMap);
}

export async function startJob(input = {}) {
  const config = loadConfig();
  const kind = input.kind === 'edit' ? 'edit' : 'read';
  const rawTarget = input.target || config.default_target || 'auto';
  const requestedTarget = (rawTarget === 'cli' || rawTarget === 'desktop' || rawTarget === 'auto') ? rawTarget : 'auto';
  const prompt = String(input.prompt ?? '');
  if (!prompt.trim()) throw new Error('prompt is empty.');
  const cwdIn = path.resolve(input.cwd || process.cwd());
  let st;
  try { st = fs.statSync(cwdIn); } catch { throw new Error(`cwd does not exist: ${cwdIn}`); }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwdIn}`);

  const addIn = (input.add_dirs || []).map((d) => path.resolve(cwdIn, String(d)));
  const chk = checkPaths([cwdIn, ...addIn]);
  if (chk.blocked.length) {
    throw new Error('Refused: ' + chk.blocked.map((b) => `${b.path} (${b.reason})`).join('; '));
  }
  for (const d of addIn) {
    if (!fs.existsSync(d)) throw new Error(`add_dir does not exist: ${d}`);
  }
  const cwd = resolveSafe(cwdIn);
  const addDirs = addIn.map(resolveSafe);
  for (const d of [cwd, ...addDirs]) {
    if (isTooBroad(d)) throw new Error(`Refused: ${d} is a drive root or the user profile folder; use a project folder.`);
  }
  const roots = (config.allowed_roots || []).filter(Boolean);
  if (roots.length) {
    for (const d of [cwd, ...addDirs]) {
      if (!roots.some((r) => isInside(d, r))) throw new Error(`Refused: ${d} is outside allowed_roots.`);
    }
  }

  if (input.model !== undefined && input.model !== null && input.model !== '' && !MODEL_RE.test(String(input.model))) {
    throw new Error('Invalid model name.');
  }
  const convIn = input.conversation || input.conversation_id || null;
  if (convIn && !UUID_RE.test(String(convIn))) {
    throw new Error('Invalid conversation id (expected a UUID).');
  }
  const cap = config.daily_max_jobs;
  if (cap && jobsStartedToday() >= cap) {
    throw new Error(`Daily job limit reached (${cap}). Raise daily_max_jobs in config.json or try tomorrow.`);
  }
  // Every job belongs to a server-issued chain, so a nested csa-antigravity call inherits it via env.
  const chain_id = input.chain_id || process.env.CSA_CHAIN_ID || `chain-${randomBytes(4).toString('hex')}`;
  const hop = input.hop || (process.env.CSA_CHAIN_ID ? Number(process.env.CSA_HOP) || 0 : 0);

  const tr = await selectTransport({ requestedTarget, kind, config });
  const target = tr.transport;
  let resolvedConversation = convIn;
  let binding = null;
  let transportReason = tr.transport_reason;
  if (target === 'desktop') {
    binding = await resolveDesktopProjectBinding({
      cwd,
      conversation_id: convIn,
      allow_non_project: !!input.allow_non_project,
      config,
    });
    resolvedConversation = binding.conversation_id || convIn || null;
    if (binding.reason) {
      transportReason = tr.transport_reason ? `${tr.transport_reason} [${binding.reason}]` : binding.reason;
    }
  }
  recordTransportSuccess({ transport: target, transport_reason: transportReason });

  const picked = await resolveModel(config, { ...input, prompt, kind, add_dirs: addDirs }, target);
  const timeoutS = Math.min(config.max_timeout_s || 3600, Math.max(10, Math.floor(Number(input.timeout_s) || config.default_timeout_s || 600)));

  const id = createJob({
    target,
    requested_target: requestedTarget,
    transport: target,
    transport_reason: transportReason,
    kind,
    cwd,
    model: picked.model,
    requested_model: input.model || null,
    tier: picked.tier,
    tier_reason: picked.reason,
    add_dirs: addDirs,
    timeout_s: timeoutS,
    conversation_id: resolvedConversation || null,
    title: input.title || null,
    notify_session: input.notify_session || config.claude_notify_session || null,
    chain_id,
    hop,
    swarm_id: input.swarm_id || null,
  });
  const dir = jobDir(id);
  fs.writeFileSync(path.join(dir, 'prompt.txt'), `${preamble(kind)}\n\n---\nTASK:\n${prompt}\n`);

  logMessage({
    direction: 'claude->antigravity',
    channel: target,
    transport: target,
    transport_reason: transportReason,
    job_id: id,
    chain_id,
    conversation_id: resolvedConversation || null,
    model: picked.model,
    kind: 'task',
    text: prompt,
  });

  const child = spawn(process.execPath, [RUNNER, dir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
  updateJob(id, { runner_pid: child.pid });
  try { refreshClaudeUsage({ reason: 'job_start' }); } catch { /* never throw */ }
  return {
    job_id: id,
    model: picked.model,
    tier: picked.tier,
    tier_reason: picked.reason,
    transport: target,
    transport_reason: transportReason,
    ...(resolvedConversation ? { conversation_id: resolvedConversation } : {}),
    ...(binding?.mode ? { binding_mode: binding.mode } : {}),
    ...(target === 'desktop' ? { warning: DESKTOP_WARNING, unrestricted: !!tr.policy?.auto_exec, ...(tr.policy?.policy_warning ? { policy_warning: tr.policy.policy_warning } : {}) } : {}),
  };
}

const SUMMARY_LIMIT = 4000;

export function getCompact(id) {
  let job = readJob(id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  job = reapJob(job);
  let result = readJson(path.join(jobDir(id), 'result.json'));
  const late = adoptLateResult(job, jobDir(id), result);
  if (late) {
    writeJson(path.join(jobDir(id), 'result.json'), late);
    job = updateJob(id, { state: late.state, ended: late.completed_at || new Date().toISOString(), error: null });
    result = late;
    try {
      const needsApproval = late.status === 'needs_approval' || late.status === 'blocked' || (late.commands_requested?.length > 0);
      recordNotification({
        type: needsApproval ? 'approval_needed' : 'task_completed',
        job_id: id,
        chain_id: job.chain_id || null,
        conversation_id: late.conversation_id,
        target_session: job.notify_session || null,
        status: late.status,
        completed_at: late.completed_at,
        started_at: job.started || job.created || null,
        model: late.model,
        transport: late.transport || job.transport || 'desktop',
        commands_requested: late.commands_requested,
        denied_files: late.denied_files,
        files_changed: late.files_changed,
        summary: late.summary,
      });
    } catch { /* notification is best effort */ }
    try {
      logMessage({
        direction: 'antigravity->claude',
        channel: 'desktop',
        transport: late.transport || job.transport || 'desktop',
        transport_reason: late.transport_reason || job.transport_reason || null,
        job_id: id,
        chain_id: job.chain_id || undefined,
        conversation_id: late.conversation_id,
        model: late.model,
        kind: 'reply',
        status: late.status,
        completed_at: late.completed_at,
        text: late.read_only_violation ? `${late.read_only_warning}\n${late.summary}` : late.summary,
      });
    } catch { /* logging is best effort */ }
  }
  const end = job.ended ? Date.parse(job.ended) : Date.now();
  const start = Date.parse(job.started || job.created);
  const elapsed_s = Math.max(0, Math.round((end - start) / 100) / 10);
  const base = {
    job_id: job.id,
    model: job.model,
    tier: job.tier,
    tier_reason: job.tier_reason,
    conversation_id: job.conversation_id,
    target: job.target,
    transport: job.transport || job.target,
    transport_reason: job.transport_reason || null,
    fallback_from: job.fallback_from || null,
    fallback_reason: job.fallback_reason || null,
    kind: job.kind,
    title: job.title,
  };
  const compact = result && TERMINAL.has(job.state)
    ? { ...base, ...result, state: job.state }
    : { ...base, status: job.state, state: job.state, error: job.error || undefined };
  if (result?.read_only_violation) {
    compact.read_only_violation = true;
    if (result.read_only_warning) compact.read_only_warning = result.read_only_warning;
  }
  if (typeof compact.summary === 'string' && compact.summary.length > SUMMARY_LIMIT) {
    compact.summary = compact.summary.slice(0, SUMMARY_LIMIT) + '... [truncated, use agy_result with full=true]';
  }
  compact.job_id = job.id;
  compact.started_at = job.started || job.created || null;
  compact.completed_at = result?.completed_at || job.ended || null;
  compact.elapsed_s = elapsed_s;
  return compact;
}

export async function waitJob(id, waitS = 30) {
  const limit = Math.min(Math.max(Number(waitS) || 0, 0), 50) * 1000;
  const deadline = Date.now() + limit;
  for (;;) {
    const j = reapJob(readJob(id));
    if (!j) throw new Error(`Unknown job: ${id}`);
    if (TERMINAL.has(j.state) || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return getCompact(id);
}

export function cancelJob(id) {
  const job = readJob(id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  if (TERMINAL.has(job.state)) return getCompact(id);
  if (job.runner_pid && pidAlive(job.runner_pid) && job.runner_pid !== process.pid) {
    killProcessTree(job.runner_pid);
  }
  updateJob(id, { state: 'cancelled', ended: new Date().toISOString(), error: 'Cancelled by caller.' });
  writeJson(path.join(jobDir(id), 'result.json'), {
    job_id: id,
    state: 'cancelled',
    status: 'failed',
    summary: '',
    files_changed: [],
    commands_requested: [],
    denied_files: [],
    followups: [],
    handoff_notes: '',
    conversation_id: job.conversation_id,
    usage: null,
    model: job.model,
    tier: job.tier,
    tier_reason: job.tier_reason,
    transport: job.transport || job.target,
    transport_reason: job.transport_reason || null,
    fallback_from: job.fallback_from || null,
    fallback_reason: job.fallback_reason || null,
    error: 'Cancelled by caller.',
  });
  return getCompact(id);
}

export function fullResponse(id, maxChars = 20000) {
  if (!readJob(id)) throw new Error(`Unknown job: ${id}`);
  const dir = jobDir(id);
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'response.txt'), 'utf8'); } catch {
    const r = readJson(path.join(dir, 'result.json'));
    text = r?.summary || '';
  }
  if (text.length > maxChars) return text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]`;
  return text;
}
