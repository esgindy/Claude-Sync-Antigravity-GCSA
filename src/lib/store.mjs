// Atomic JSON files and job records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { home, ensureHome } from './paths.mjs';
import { refreshClaudeUsage } from './claude-usage.mjs';

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can briefly lock the target; retry a few times.
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
      try {
        const until = Date.now() + 25;
        while (Date.now() < until) { /* short spin */ }
        fs.renameSync(tmp, file);
        ok = true;
      } catch { /* retry */ }
    }
    if (!ok) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function jobsRoot() {
  return path.join(home, 'jobs');
}

export function jobDir(id) {
  if (!/^[0-9]{14}-[0-9a-f]{6}$/.test(String(id))) throw new Error(`Invalid job id: ${id}`);
  return path.join(jobsRoot(), id);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createJob(fields = {}) {
  ensureHome();
  let id;
  do {
    id = `${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
  } while (fs.existsSync(path.join(jobsRoot(), id)));
  fs.mkdirSync(path.join(jobsRoot(), id), { recursive: true });
  const job = {
    id,
    state: 'queued',
    target: 'cli',
    requested_target: 'auto',
    transport: 'cli',
    transport_reason: null,
    fallback_from: null,
    fallback_reason: null,
    kind: 'read',
    cwd: null,
    model: null,
    requested_model: null,
    tier: null,
    tier_reason: null,
    add_dirs: [],
    timeout_s: null,
    conversation_id: null,
    title: null,
    chain_id: null,
    hop: 0,
    swarm_id: null,
    created: new Date().toISOString(),
    started: null,
    ended: null,
    runner_pid: null,
    error: null,
    ...fields,
  };
  job.id = id;
  writeJson(path.join(jobDir(id), 'job.json'), job);
  try { refreshClaudeUsage({ reason: 'job_start' }); } catch { /* never throw */ }
  return id;
}

export function readJob(id) {
  return readJson(path.join(jobDir(id), 'job.json'));
}

export function updateJob(id, patch) {
  const job = readJob(id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  const next = { ...job, ...patch, id: job.id };
  writeJson(path.join(jobDir(id), 'job.json'), next);
  if (patch && patch.state && patch.state !== job.state) {
    try { refreshClaudeUsage({ reason: `job_state:${patch.state}` }); } catch { /* never throw */ }
  }
  return next;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Mark queued/running jobs whose runner is gone as failed. Returns the (possibly updated) job. */
export function reapJob(job) {
  if (!job) return job;
  if ((job.state === 'queued' || job.state === 'running') && job.runner_pid && !pidAlive(job.runner_pid)) {
    // Re-read: the runner may have finished between our read and the pid check.
    const fresh = readJob(job.id);
    if (fresh && (fresh.state === 'queued' || fresh.state === 'running')) {
      return updateJob(job.id, {
        state: 'failed',
        ended: new Date().toISOString(),
        error: 'Runner process exited unexpectedly.',
      });
    }
    return fresh;
  }
  return job;
}

export function listJobs({ limit = 20 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(jobsRoot()).filter((n) => /^[0-9]{14}-[0-9a-f]{6}$/.test(n));
  } catch {
    return [];
  }
  names.sort().reverse();
  const n = Math.max(1, limit);
  const out = [];
  // Read a few extra: ids created in the same second sort randomly, so order by `created`.
  for (const name of names.slice(0, n + 50)) {
    const j = readJson(path.join(jobsRoot(), name, 'job.json'));
    if (j) out.push(j);
  }
  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return out.slice(0, n).map(reapJob);
}
