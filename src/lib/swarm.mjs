// Parallel multi-agent runs: many jobs under one swarm id, at most swarm_max_parallel running at once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let overrides = {};
// Tests (or callers) may inject { jobsApi, paths, messages, safety }.
export function setDeps(o) { overrides = o || {}; }

async function dep(name, file) {
  return overrides[name] || (await import(file));
}
const jobsApi = () => dep('jobsApi', './jobs-api.mjs');
const paths = () => dep('paths', './paths.mjs');
const messages = () => dep('messages', './messages.mjs');
const safety = () => dep('safety', './safety.mjs');

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const locks = new Map();
const timers = new Map();

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

async function swarmFile(id) {
  if (!/^sw-[0-9]{14}-[0-9a-f]{6}$/.test(String(id))) throw new Error('Invalid swarm_id.');
  const { home } = await paths();
  const dir = path.join(home, 'swarms');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.json`);
}

function save(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const normFile = (cwd, f) => path.resolve(cwd, String(f)).toLowerCase();

export function checkEditConflicts(parts, cwd) {
  const seen = new Map();
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i].kind || 'read') !== 'edit') continue;
    for (const f of parts[i].files || []) {
      const key = normFile(cwd, f);
      if (seen.has(key) && seen.get(key) !== i) {
        throw new Error(`Parts ${seen.get(key) + 1} and ${i + 1} are both edit parts and both list "${f}". Parallel edits must not share files; split the files differently or run them in sequence.`);
      }
      seen.set(key, i);
    }
  }
}

function partPrompt(p) {
  let t = p.prompt;
  if (p.kind === 'edit' && p.files && p.files.length) {
    t += `\n\nYou may modify only these files (other agents are editing other files in parallel):\n${p.files.map((f) => `- ${f}`).join('\n')}`;
  }
  return t;
}

export async function startSwarm({ mode, parts, cwd, target = 'cli', title, models, prompt }) {
  if (!cwd) throw new Error('cwd is required.');
  if (!['split', 'compare'].includes(mode)) throw new Error('mode must be "split" or "compare".');
  let list;
  if (mode === 'compare') {
    const ms = Array.isArray(models) ? models : [];
    const p = prompt || (parts && parts[0] && parts[0].prompt);
    if (!p) throw new Error('compare mode needs a prompt.');
    if (ms.length < 2 || ms.length > 3) throw new Error('compare mode needs 2-3 models.');
    if (new Set(ms.map((m) => m.toLowerCase())).size !== ms.length) throw new Error('compare models must be different.');
    if (parts && parts.some((x) => x.kind === 'edit')) throw new Error('compare mode is read-only; edits from several models would overwrite each other.');
    list = ms.map((m) => ({ prompt: p, model: m, kind: 'read', files: [] }));
  } else {
    if (!Array.isArray(parts) || parts.length < 1) throw new Error('split mode needs at least one part.');
    if (parts.length > 12) throw new Error('At most 12 parts per swarm.');
    list = parts.map((x) => ({ prompt: x.prompt, tier: x.tier && x.tier !== 'auto' ? x.tier : undefined, model: x.model, kind: x.kind || 'read', files: x.files || [] }));
    if (list.some((x) => !x.prompt)) throw new Error('Every part needs a prompt.');
    checkEditConflicts(list, cwd);
  }
  const { isSecretPath } = await safety();
  for (const p of list) for (const f of p.files) {
    if (typeof isSecretPath === 'function' && isSecretPath(f)) throw new Error(`File "${f}" looks like a secret file and cannot be used.`);
  }
  let resolvedTarget = target;
  let gate = null;
  if (target === 'auto') {
    const { selectTransport, recordTransportSuccess } = await import('./transport.mjs');
    const { loadConfig } = await paths();
    const cfg = loadConfig();
    const kind = list.some((p) => p.kind === 'edit') ? 'edit' : 'read';
    const tr = await selectTransport({ requestedTarget: 'auto', kind, config: cfg });
    resolvedTarget = tr.transport;
    gate = tr.policy || null;
    recordTransportSuccess({ transport: resolvedTarget, transport_reason: tr.transport_reason });
  } else if (target === 'desktop') {
    const { desktopGate } = await import('./desktop.mjs');
    const { loadConfig } = await paths();
    const cfg = loadConfig();
    for (const p of list) gate = desktopGate({ kind: p.kind }, cfg);
  }
  const id = `sw-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const file = await swarmFile(id);
  const sw = {
    id, mode, cwd, target: resolvedTarget, requested_target: target, title: title || (mode === 'compare' ? 'Compare' : 'Swarm'), created: new Date().toISOString(),
    parts: list.map((p, i) => ({ index: i, ...p, job_id: null, error: null })),
  };
  await withLock(id, async () => { save(file, sw); await pump(id); });
  ensureTimer(id);
  const cur = load(file);
  const extra = gate ? { warning: (await import('./desktop-job.mjs')).DESKTOP_WARNING, unrestricted: gate.auto_exec } : {};
  return { ...extra, swarm_id: id, jobs: cur.parts.map((p) => p.job_id).filter(Boolean), queued: cur.parts.filter((p) => !p.job_id && !p.error).length };
}

// Start queued parts while fewer than swarm_max_parallel jobs are active. Must run under withLock.
async function pump(id) {
  const file = await swarmFile(id);
  const sw = load(file);
  if (!sw) return null;
  const { loadConfig } = await paths();
  const max = Math.max(1, Number(loadConfig().swarm_max_parallel) || 4);
  const api = await jobsApi();
  let active = 0;
  for (const p of sw.parts) {
    if (p.job_id && !p.final) {
      let c;
      try { c = api.getCompact(p.job_id); } catch { c = null; }
      if (c && TERMINAL.has(c.state)) p.final = c.state; else active++;
    }
  }
  for (const p of sw.parts) {
    if (active >= max) break;
    if (p.job_id || p.error) continue;
    try {
      const r = await api.startJob({
        prompt: partPrompt(p), cwd: sw.cwd, kind: p.kind, tier: p.tier, model: p.model,
        target: sw.target, title: `${sw.title} #${p.index + 1}`, swarm_id: sw.id,
      });
      p.job_id = r.job_id; p.requested_model = r.model; p.tier = r.tier || p.tier;
      active++;
      try {
        const m = await messages();
        m.logMessage({ direction: 'claude->antigravity', channel: sw.target === 'desktop' ? 'desktop' : 'cli', job_id: r.job_id, kind: 'task', model: r.model, text: `Swarm ${sw.id} part ${p.index + 1}/${sw.parts.length} (${sw.mode}) started: ${p.prompt.slice(0, 300)}` });
      } catch {}
    } catch (e) {
      p.error = String(e.message || e).slice(0, 300);
      p.final = 'failed';
    }
  }
  save(file, sw);
  return sw;
}

function ensureTimer(id) {
  if (timers.has(id)) return;
  const t = setInterval(async () => {
    try {
      const sw = await withLock(id, () => pump(id));
      if (!sw || sw.parts.every((p) => p.final)) { clearInterval(t); timers.delete(id); }
    } catch { clearInterval(t); timers.delete(id); }
  }, Number(process.env.CSA_SWARM_TICK_MS) || 3000);
  t.unref();
  timers.set(id, t);
}

export async function swarmStatus(swarm_id) {
  const file = await swarmFile(swarm_id);
  if (!load(file)) throw new Error(`Swarm ${swarm_id} not found.`);
  const sw = await withLock(swarm_id, () => pump(swarm_id));
  if (sw.parts.some((p) => !p.final)) ensureTimer(swarm_id);
  const api = await jobsApi();
  const parts = sw.parts.map((p) => {
    if (p.error) return { index: p.index + 1, state: 'failed', error: p.error };
    if (!p.job_id) return { index: p.index + 1, state: 'queued', model: p.model || null, tier: p.tier || null };
    let c;
    try { c = api.getCompact(p.job_id); } catch (e) { c = { job_id: p.job_id, state: 'failed', error: String(e.message) }; }
    return { index: p.index + 1, job_id: p.job_id, ...c };
  });
  const states = parts.map((p) => p.state);
  let state;
  if (states.some((s) => s === 'queued' || s === 'running')) state = 'running';
  else if (states.every((s) => s === 'done')) state = 'done';
  else if (states.some((s) => s === 'done')) state = 'partial';
  else state = 'failed';
  return { swarm_id, mode: sw.mode, title: sw.title, state, parts };
}
