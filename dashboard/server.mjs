#!/usr/bin/env node
// Claude Sync Antigravity: live dashboard (v3). Zero model tokens: it only reads local files.
// /api/status merges: manual agents (status file), Antigravity jobs, Claude jobs, message log,
// git commits, project files, transport state, security policy, and Claude + Antigravity usage.
// /logo/<claude|antigravity> serves the installed apps' icons.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { here, csaHome, statusFile, emptyStatus } from './common.mjs';
import { redact } from '../src/lib/safety.mjs';
import { usageReport } from '../src/lib/usage.mjs';
import { listModels } from '../src/lib/models.mjs';
import { getQuota, summarizeStatus } from '../src/lib/quota.mjs';
import { probeCli } from '../src/lib/agy.mjs';
import { refreshClaudeUsage, readCurrentClaudeUsage } from '../src/lib/claude-usage.mjs';

const repoRoot = path.resolve(here, '..');
const argPort = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  const eq = process.argv.find((a) => a.startsWith('--port='));
  return eq ? Number(eq.slice(7)) : 0;
})();
const port = Number(argPort || process.env.PORT || process.env.CSA_DASHBOARD_PORT || 4317);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const clip = (v, n) => String(v ?? '').slice(0, n);

// ---------- jobs -> agents ----------
const JOB_STATE = { queued: 'todo', running: 'doing', done: 'done', failed: 'blocked', cancelled: 'blocked' };

function taskTitle(dir) {
  try {
    const p = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
    const t = p.includes('TASK:') ? p.slice(p.indexOf('TASK:') + 5) : p;
    return clip(t.trim().split(/\r?\n/).find((l) => l.trim()) || '', 140);
  } catch { return ''; }
}

function readJobs(sub, limit = 150) {
  const base = path.join(csaHome, sub);
  let ids = [];
  try { ids = fs.readdirSync(base).filter((d) => /^[\w-]{6,80}$/.test(d)).sort().reverse().slice(0, limit); } catch { return []; }
  return ids.map((id) => {
    const dir = path.join(base, id);
    const job = readJson(path.join(dir, 'job.json'));
    if (!job) return null;
    return { job, result: readJson(path.join(dir, 'result.json')), title: taskTitle(dir) };
  }).filter(Boolean);
}

function jobAgents() {
  const agents = new Map();
  const add = (key, init, task, active, ts) => {
    if (!agents.has(key)) agents.set(key, { ...init, tasks: [], active: false, last: 0, now: '' });
    const a = agents.get(key);
    a.tasks.push(task);
    a.active ||= active;
    if (ts > a.last) a.last = ts;
    if (active && !a.now) a.now = task.title;
  };
  for (const { job, result, title } of readJobs('jobs')) {
    const model = job.model || '?';
    const name = job.title ? clip(job.title, 50) : `Antigravity · ${model}`;
    const transport = job.transport || job.target || 'cli';
    const transportReason = job.transport_reason ? redact(job.transport_reason) : null;
    add(`agy:${name}`, {
      id: `agy-${name}`,
      name,
      model,
      side: 'antigravity',
      auto: true,
      role: transport === 'desktop' ? 'desktop' : 'cli',
      transport,
      transport_reason: transportReason,
    }, {
      id: job.id,
      title: title || job.id,
      state: JOB_STATE[job.state] || 'todo',
      note: clip(redact(result?.status === 'needs_approval' ? 'needs approval' : (result?.error || '')), 120),
      transport,
      transport_reason: transportReason,
      tier: job.tier || null,
      tier_reason: job.tier_reason ? redact(job.tier_reason) : null,
      fallback_from: job.fallback_from || null,
      fallback_reason: job.fallback_reason ? redact(job.fallback_reason) : null,
      read_only_violation: Boolean(result?.read_only_violation),
      read_only_warning: result?.read_only_warning ? redact(result.read_only_warning) : null,
    }, job.state === 'running' || job.state === 'queued', Date.parse(job.created) || 0);
  }
  for (const { job, result, title } of readJobs('claude-jobs')) {
    const model = job.model || 'default';
    const name = `Claude · ${model}`;
    const transport = job.transport || job.target || 'cli';
    const transportReason = job.transport_reason ? redact(job.transport_reason) : null;
    add(`claude:${name}`, {
      id: `claude-${model}`,
      name,
      model: `claude ${model}`,
      side: 'claude',
      auto: true,
      role: 'reverse',
      transport,
      transport_reason: transportReason,
    }, {
      id: job.id,
      title: title || `${job.kind} ${job.id}`,
      state: JOB_STATE[job.state] || 'todo',
      note: clip(redact(result?.verdict || result?.error || ''), 120),
      transport,
      transport_reason: transportReason,
      tier: job.tier || null,
      tier_reason: job.tier_reason ? redact(job.tier_reason) : null,
      fallback_from: job.fallback_from || null,
      fallback_reason: job.fallback_reason ? redact(job.fallback_reason) : null,
      read_only_violation: Boolean(result?.read_only_violation),
      read_only_warning: result?.read_only_warning ? redact(result.read_only_warning) : null,
    }, job.state === 'running' || job.state === 'queued', Date.parse(job.created) || 0);
  }
  return [...agents.values()].sort((a, b) => b.last - a.last).slice(0, 30).map((a) => ({ ...a, tasks: a.tasks.slice(0, 25) }));
}

// ---------- project root, files, commits ----------
function projectRoot() {
  if (process.env.CSA_PROJECT) return path.resolve(process.env.CSA_PROJECT);
  const latest = readJobs('jobs', 1)[0]?.job?.cwd;
  return latest && fs.existsSync(latest) ? latest : repoRoot;
}

function files(root) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= 400 || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'dist', '.csa'].includes(e.name) || e.name.startsWith('.env')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1); else out.push(path.relative(root, p).replace(/\\/g, '/'));
      if (out.length >= 400) return;
    }
  };
  walk(root, 0);
  return out;
}

function commits(root) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'log', '--pretty=format:%h|%ad|%s', '--date=format:%H:%M', '-n', '30'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => { const [hash, time, ...s] = l.split('|'); return { hash, time, subject: s.join('|') }; });
}

// Reads only the last 256 KB of the message log, so a large log never slows the 2 s poll.
function messages() {
  const file = path.join(csaHome, 'messages.jsonl');
  let fd;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // first line may be cut
    return lines.filter(Boolean).slice(-60).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ---------- logos read from the installed apps at runtime (never bundled in the repo) ----------
const logoCache = {};
function claudeLogo() {
  const readFromPkgDir = (pkgDir) => {
    if (!pkgDir) return null;
    const assetsDir = path.join(pkgDir, 'assets');
    const preferred = path.join(assetsDir, 'Square310x310Logo.png');
    try { return fs.readFileSync(preferred); } catch { /* fallback below */ }
    try {
      const alt = fs.readdirSync(assetsDir).find((f) => /^(Square(310x310|150x150|44x44)Logo|StoreLogo).*\.png$/i.test(f));
      if (alt) return fs.readFileSync(path.join(assetsDir, alt));
    } catch { /* ignore */ }
    return null;
  };
  const base = 'C:\\Program Files\\WindowsApps';
  try {
    const pkg = fs.readdirSync(base).filter((d) => /^Claude_[\d.]+_x64__/.test(d)).sort().pop();
    const buf = pkg && readFromPkgDir(path.join(base, pkg));
    if (buf) return buf;
  } catch { /* WindowsApps often denies readdirSync to non-admin; query AppxPackage below */ }
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage *Claude* | Select-Object -ExpandProperty InstallLocation -First 1)',
    ], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const dir = (r.stdout || '').trim().split(/\r?\n/)[0]?.trim();
    const buf = readFromPkgDir(dir);
    if (buf) return buf;
  } catch { /* not installed or PowerShell unavailable */ }
  return null;
}
function antigravityLogo() {
  const asar = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'app.asar');
  let fd;
  try {
    fd = fs.openSync(asar, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const hsize = head.readUInt32LE(12);
    if (hsize > 50e6) return null;
    const hb = Buffer.alloc(hsize);
    fs.readSync(fd, hb, 0, hsize, 16);
    const e = JSON.parse(hb.toString()).files?.['icon.png'];
    if (!e || e.size > 2e6) return null;
    const data = Buffer.alloc(e.size);
    fs.readSync(fd, data, 0, e.size, 8 + head.readUInt32LE(4) + Number(e.offset));
    return data;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const logo = (name) => {
  if (!(name in logoCache)) logoCache[name] = name === 'claude' ? claudeLogo() : antigravityLogo();
  return logoCache[name];
};

// ---------- config, security policy, transport state & usage ----------
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const QUOTA_TTL_MS = 30 * 1000;
let modelRefreshInFlight = false;
let lastModelRefreshAt = 0;
const quotaCache = { data: null, error: null, fetchedAt: 0, promise: null, attempted: false };

function loadMergedConfig() {
  const def = readJson(path.join(repoRoot, 'config.default.json')) || {};
  const user = readJson(path.join(csaHome, 'config.json')) || {};
  const cfg = { ...def, ...user };
  cfg.tiers = { ...(def.tiers || {}), ...(user.tiers || {}) };
  if (def.desktop_model_map || user.desktop_model_map) {
    cfg.desktop_model_map = { ...(def.desktop_model_map || {}), ...(user.desktop_model_map || {}) };
  }
  return cfg;
}

function readAppPolicy() {
  const file = process.env.CSA_AG_CONFIG || path.join(process.env.USERPROFILE || os.homedir(), '.gemini', 'config', 'config.json');
  let cfg = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    try { cfg = JSON.parse(raw); } catch { cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); }
  } catch { cfg = null; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { auto_exec: true, policy: 'unknown (app settings unreadable)', preset: null, readable: false };
  }
  const scopes = [cfg.userSettings, cfg].filter((s) => s && typeof s === 'object' && !Array.isArray(s));
  const pick = (k) => { for (const s of scopes) if (s[k] != null) return String(s[k]); return null; };
  const policy = pick('autoExecutionPolicy');
  const preset = pick('permissionPreset');
  const auto = (v) => !!v && /AUTO/i.test(v);
  return { auto_exec: auto(policy) || auto(preset), policy, preset, readable: true };
}

function readSecurity(cfg) {
  const app = readAppPolicy();
  const auto_exec_warning = Boolean(cfg.allow_desktop_auto_exec || (app.readable && app.auto_exec));
  return {
    auto_exec_warning,
    allow_desktop_auto_exec: Boolean(cfg.allow_desktop_auto_exec),
    allow_desktop_edit: Boolean(cfg.allow_desktop_edit),
    desktop_policy: {
      auto_exec: app.readable ? app.auto_exec : true,
      policy: app.policy,
      preset: app.preset,
      readable: app.readable,
    },
  };
}

function readTransportState() {
  const st = readJson(path.join(csaHome, 'transport-state.json'));
  if (!st || typeof st !== 'object' || Array.isArray(st)) return null;
  if (st.last_error && typeof st.last_error === 'object' && typeof st.last_error.message === 'string') {
    return { ...st, last_error: { ...st.last_error, message: redact(st.last_error.message) } };
  }
  return st;
}

function hasAgyBinary(cfg) {
  try { return probeCli(cfg).available; } catch { return false; }
}

function readModelsCacheWithRefresh(cfg) {
  const cache = readJson(path.join(csaHome, 'models-cache.json'));
  const cached = Array.isArray(cache?.models) ? cache.models : [];
  const stale = !cache || !cached.length || (Date.now() - (Number(cache.fetched_at) || 0) >= MODEL_CACHE_TTL_MS);
  if (stale && !modelRefreshInFlight && Date.now() - lastModelRefreshAt >= MODEL_CACHE_TTL_MS && hasAgyBinary(cfg)) {
    modelRefreshInFlight = true;
    lastModelRefreshAt = Date.now();
    listModels({ refresh: true }).catch(() => {}).finally(() => { modelRefreshInFlight = false; });
  }
  return cached;
}

function extractQuotaPayload(raw) {
  if (!raw || typeof raw !== 'object') return { plan: null, credits: null, models: [] };
  if (raw.userStatus) {
    const base = summarizeStatus(raw);
    const cfgs = raw.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const byLabel = new Map(base.models.map((m) => [String(m.label).toLowerCase(), m]));
    for (const c of cfgs) {
      if (!c?.label) continue;
      const key = String(c.label).toLowerCase();
      const modelId = c?.modelOrAlias?.model ? String(c.modelOrAlias.model) : null;
      const existing = byLabel.get(key);
      if (existing) {
        if (modelId && !existing.id) existing.id = modelId;
      } else {
        const extra = {
          ...(modelId ? { id: modelId } : {}),
          label: String(c.label),
          remaining_pct: null,
          resets_at: c?.quotaInfo?.resetTime ?? null,
        };
        base.models.push(extra);
        byLabel.set(key, extra);
      }
    }
    return base;
  }
  return {
    plan: raw.plan ?? null,
    credits: raw.credits ?? null,
    models: Array.isArray(raw.models) ? raw.models : [],
  };
}

function triggerQuotaRefresh() {
  if (quotaCache.promise) return quotaCache.promise;
  quotaCache.attempted = true;
  quotaCache.promise = getQuota()
    .then((q) => {
      quotaCache.data = q;
      quotaCache.error = null;
      quotaCache.fetchedAt = Date.now();
    })
    .catch((e) => {
      quotaCache.error = redact(String(e?.message || e || 'Quota unavailable'));
      quotaCache.fetchedAt = Date.now();
    })
    .finally(() => {
      quotaCache.promise = null;
    });
  return quotaCache.promise;
}

async function resolveQuota() {
  if (process.env.CSA_QUOTA_FILE) {
    try {
      const raw = JSON.parse(fs.readFileSync(process.env.CSA_QUOTA_FILE, 'utf8'));
      return { quota: extractQuotaPayload(raw), quotaError: null };
    } catch (e) {
      return { quota: null, quotaError: redact(String(e?.message || e || 'Quota unavailable')) };
    }
  }
  if (!quotaCache.attempted) {
    const p = triggerQuotaRefresh();
    await Promise.race([p, new Promise((r) => setTimeout(r, 600))]);
  } else if (!quotaCache.promise && Date.now() - quotaCache.fetchedAt >= QUOTA_TTL_MS) {
    triggerQuotaRefresh();
  }
  return { quota: quotaCache.data, quotaError: quotaCache.error };
}

function safeUsageReport() {
  try {
    return usageReport();
  } catch {
    return {
      today: { tokens: 0, jobs: 0, by_model: {} },
      all_time: { tokens: 0, jobs: 0, by_model: {} },
      claude_tokens_saved_estimate: 0,
    };
  }
}

async function buildAntigravityUsage(cfg) {
  const usage = safeUsageReport();
  const cachedModels = readModelsCacheWithRefresh(cfg);
  const { quota, quotaError } = await resolveQuota();

  const entries = [];
  const byId = new Map();
  const byLabel = new Map();
  const normSlug = (s) => String(s || '').toLowerCase().replace(/[()[\]]+/g, '').trim().replace(/\s+/g, '-');

  const registerEntry = (id, label) => {
    const mId = String(id || label).trim();
    const mLabel = String(label || id).trim();
    const entry = {
      id: mId,
      label: mLabel,
      remaining_pct: null,
      resets_at: null,
      today_tokens: 0,
      today_jobs: 0,
      total_tokens: 0,
      total_jobs: 0,
    };
    entries.push(entry);
    if (mId) { byId.set(mId.toLowerCase(), entry); byId.set(normSlug(mId), entry); }
    if (mLabel) { byLabel.set(mLabel.toLowerCase(), entry); byId.set(normSlug(mLabel), entry); }
    return entry;
  };

  // 1. Models from models-cache.json
  for (const m of cachedModels) {
    if (!m || (!m.id && !m.label)) continue;
    const idKey = m.id ? String(m.id).trim().toLowerCase() : '';
    const lblKey = m.label ? String(m.label).trim().toLowerCase() : '';
    if ((idKey && byId.has(idKey)) || (lblKey && byLabel.has(lblKey))) continue;
    registerEntry(m.id || m.label, m.label || m.id);
  }

  // 2. Models from quota.models (including models without remainingFraction -> remaining_pct: null)
  for (const qm of quota?.models || []) {
    if (!qm || (!qm.label && !qm.id)) continue;
    const qLabel = qm.label ? String(qm.label).trim() : '';
    const qId = qm.id ? String(qm.id).trim() : '';
    let entry = (qLabel && (byLabel.get(qLabel.toLowerCase()) || byId.get(qLabel.toLowerCase())))
      || (qId && (byId.get(qId.toLowerCase()) || byLabel.get(qId.toLowerCase())))
      || null;
    if (!entry) entry = registerEntry(qId || qLabel, qLabel || qId);
    if (qm.remaining_pct !== undefined && qm.remaining_pct !== null && Number.isFinite(Number(qm.remaining_pct))) {
      entry.remaining_pct = Number(qm.remaining_pct);
    }
    if (qm.resets_at !== undefined && qm.resets_at !== null && qm.resets_at !== '') {
      entry.resets_at = String(qm.resets_at);
    }
  }

  // 3. Models configured in cfg.tiers
  for (const list of Object.values(cfg.tiers || {})) {
    if (!Array.isArray(list)) continue;
    for (const tid of list) {
      const idStr = String(tid || '').trim();
      if (!idStr) continue;
      if (byId.has(idStr.toLowerCase()) || byLabel.has(idStr.toLowerCase())) continue;
      registerEntry(idStr, idStr);
    }
  }

  // 4. Models from usage.today.by_model and usage.all_time.by_model (accumulated once per bucket key)
  const ensureUsageEntry = (key) => {
    const k = String(key || '').trim();
    if (!k) return null;
    const lower = k.toLowerCase();
    return byId.get(lower) || byLabel.get(lower) || registerEntry(k, k);
  };
  for (const [k, v] of Object.entries(usage.today?.by_model || {})) {
    const entry = ensureUsageEntry(k);
    if (!entry || !v) continue;
    entry.today_tokens += Number(v.tokens) || 0;
    entry.today_jobs += Number(v.jobs) || 0;
  }
  for (const [k, v] of Object.entries(usage.all_time?.by_model || {})) {
    const entry = ensureUsageEntry(k);
    if (!entry || !v) continue;
    entry.total_tokens += Number(v.tokens) || 0;
    entry.total_jobs += Number(v.jobs) || 0;
  }

  const used = entries
    .filter((m) => m.total_tokens > 0 || m.total_jobs > 0)
    .sort((a, b) => (b.total_tokens - a.total_tokens) || (b.today_tokens - a.today_tokens) || (b.total_jobs - a.total_jobs));
  const top_model = used[0] ? { ...used[0] } : null;

  return {
    plan: quota?.plan ?? null,
    credits: quota?.credits ?? null,
    quota_error: quotaError || null,
    today_tokens: Number(usage.today?.tokens) || 0,
    today_jobs: Number(usage.today?.jobs) || 0,
    all_time_tokens: Number(usage.all_time?.tokens) || 0,
    all_time_jobs: Number(usage.all_time?.jobs) || 0,
    claude_tokens_saved_estimate: Number(usage.claude_tokens_saved_estimate) || 0,
    models: entries,
    top_model,
  };
}

// ---------- server ----------
// DNS-rebinding guard: only answer requests addressed to this machine's loopback name.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

async function apiStatus() {
  try { await refreshClaudeUsage({ reason: 'dashboard_status' }); } catch { /* never throw */ }
  const status = readJson(statusFile()) || emptyStatus();
  const root = projectRoot();
  const cfg = loadMergedConfig();
  const claude_usage = readCurrentClaudeUsage(cfg);
  return {
    status: { ...status, project: status.project || path.basename(root), claude_usage },
    jobAgents: jobAgents(),
    commits: commits(root),
    messages: messages(),
    files: files(root),
    transportState: readTransportState(),
    security: readSecurity(cfg),
    claude_usage,
    claudeUsage: claude_usage,
    antigravityUsage: await buildAntigravityUsage(cfg),
    now: new Date().toISOString(),
  };
}

http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
  const url = String(req.url || '/');
  if (url.startsWith('/api/status')) {
    try {
      const payload = await apiStatus();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: redact(String(e?.message || e)) }));
    }
  }
  const m = /^\/logo\/(claude|antigravity)$/.exec(url);
  if (m) {
    const img = logo(m[1]);
    if (!img) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
    return res.end(img);
  }
  if (url === '/' || url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(here, 'index.html')));
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => {
  try { refreshClaudeUsage({ reason: 'dashboard_startup' }); } catch { /* never throw */ }
  console.log(`dashboard on http://127.0.0.1:${port}`);
});
