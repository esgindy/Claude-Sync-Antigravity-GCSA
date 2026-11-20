// Automatic refresh of Claude Code overall usage for the GCSA live dashboard.
// Security contract: NEVER reads credentials, OAuth tokens, .credentials.json, cookies, or ~/.claude,
// NEVER calls undocumented endpoints with user tokens, and NEVER fabricates numbers from transcripts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { packageRoot, home as defaultHomePath } from './paths.mjs';
import { redact, childEnv } from './safety.mjs';

export const CLAUDE_USAGE_THROTTLE_MS = 20_000;
export const DEFAULT_CLAUDE_USAGE_MAX_AGE_S = 600;
export const CLAUDE_USAGE_CMD_TIMEOUT_MS = 5_000;

export const SHORT_SETUP_HINT =
  'Call csa_board set_usage, run scripts/push-claude-usage.mjs, or set claude_usage_command in config.json (see docs/INSTALL.md).';

const FORBIDDEN_CRED_ARG_RE =
  /(?:^|[\\/])(?:\.claude|\.gemini|\.ssh|\.aws|\.credentials\.json|credentials[^\\/]*|cookies[^\\/]*|\.env(?:\.[^\\/]*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.(?:pem|key|pfx|p12|kdbx))(?:$|[\\/])/i;

let lastRefreshAt = 0;
let lastHomeDir = null;
let lastResolvedUsage = null;
let lastCommandFailure = null;
let inFlightPromise = null;
let refreshCount = 0;

export function resolveHome(customHome) {
  if (customHome) return path.resolve(customHome);
  if (process.env.CSA_HOME) return path.resolve(process.env.CSA_HOME);
  return defaultHomePath;
}

export function snapshotFile(customHome) {
  return path.join(resolveHome(customHome), 'claude-usage.json');
}

export function resolveStatusFile(customHome) {
  if (process.env.CSA_STATUS) return path.resolve(process.env.CSA_STATUS);
  const h = resolveHome(customHome);
  const homeStatus = path.join(h, 'status.json');
  if (customHome || process.env.CSA_HOME || fs.existsSync(homeStatus)) return homeStatus;
  const repoStatus = path.join(packageRoot, 'dashboard', 'status.json');
  return fs.existsSync(repoStatus) ? repoStatus : homeStatus;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
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

function loadActiveConfig(customHome) {
  const def = readJsonSafe(path.join(packageRoot, 'config.default.json')) || {};
  const user = readJsonSafe(path.join(resolveHome(customHome), 'config.json')) || {};
  return { ...def, ...user };
}

export function sanitizeUsageText(value, maxLen = 300) {
  if (value === null || value === undefined) return null;
  let s = redact(String(value));
  s = s.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/gi, '[REDACTED]');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]');
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]');
  s = s.replace(/((?:api[_-]?key|secret|password|auth|token)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED]');
  return s.trim().slice(0, maxLen) || null;
}

export function clampUsagePct(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value === 'boolean' || typeof value === 'object' || typeof value === 'symbol' || typeof value === 'function') {
    return { ok: false, value: null };
  }
  const str = typeof value === 'string' ? value.trim() : '';
  if (typeof value === 'string' && !str) return { ok: true, value: null };
  const num = typeof value === 'number' ? value : Number(str);
  if (!Number.isFinite(num)) return { ok: false, value: null };
  const clamped = Math.min(100, Math.max(0, Math.round(num * 10) / 10));
  return { ok: true, value: clamped };
}

export function validateAndClampUsage(raw, { fallbackUpdatedAt = null, requireAtLeastOnePct = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Usage payload must be a JSON object' };
  }
  const raw5 = raw.five_hour_remaining_pct !== undefined
    ? raw.five_hour_remaining_pct
    : (raw.fiveHourRemainingPct !== undefined ? raw.fiveHourRemainingPct : raw.five_hour);
  const rawW = raw.weekly_remaining_pct !== undefined
    ? raw.weekly_remaining_pct
    : (raw.weeklyRemainingPct !== undefined ? raw.weeklyRemainingPct : raw.weekly);

  const c5 = clampUsagePct(raw5);
  if (!c5.ok) return { ok: false, error: 'Invalid five_hour_remaining_pct' };
  const cW = clampUsagePct(rawW);
  if (!cW.ok) return { ok: false, error: 'Invalid weekly_remaining_pct' };

  if (requireAtLeastOnePct && c5.value === null && cW.value === null) {
    return { ok: false, error: 'At least one of five_hour_remaining_pct or weekly_remaining_pct is required' };
  }

  let updated_at = fallbackUpdatedAt || new Date().toISOString();
  if (typeof raw.updated_at === 'string' && raw.updated_at.trim()) {
    const parsedTs = Date.parse(raw.updated_at);
    if (!Number.isNaN(parsedTs)) {
      updated_at = new Date(parsedTs).toISOString();
    }
  }

  return {
    ok: true,
    data: {
      five_hour_remaining_pct: c5.value,
      weekly_remaining_pct: cW.value,
      resets_at: sanitizeUsageText(raw.resets_at ?? raw.resetsAt ?? null, 80),
      note: sanitizeUsageText(raw.note ?? null, 300),
      updated_at,
    },
  };
}

function updateStatusClaudeUsage(usageObj, { customHome, isExplicitSet = false, onlyIfStatusExists = false } = {}) {
  try {
    const file = resolveStatusFile(customHome);
    if (onlyIfStatusExists && !fs.existsSync(file) && !usageObj?.available) return;
    let s = readJsonSafe(file);
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      s = { project: null, owner: 'Eslam Elgindy', agents: [], log: [] };
    }
    s.agents ||= [];
    s.log ||= [];
    if (usageObj?.available) {
      s.claude_usage = { ...usageObj };
      if (isExplicitSet) {
        s.claude_usage_last_set = {
          five_hour_remaining_pct: usageObj.five_hour_remaining_pct,
          weekly_remaining_pct: usageObj.weekly_remaining_pct,
          resets_at: usageObj.resets_at,
          note: usageObj.note,
          updated_at: usageObj.updated_at,
        };
      }
    } else {
      // Preserve last valid numbers in claude_usage_last_set if they existed in claude_usage
      const prev = validateAndClampUsage(s.claude_usage);
      if (prev.ok && !s.claude_usage_last_set) {
        s.claude_usage_last_set = prev.data;
      }
      s.claude_usage = { ...usageObj };
    }
    atomicWriteJson(file, s);
  } catch { /* status persistence is best effort */ }
}

/**
 * Atomically writes <CSA_HOME>/claude-usage.json (and optionally updates status.json).
 * Values are validated and clamped to 0-100; texts are sanitized.
 */
export function writeClaudeUsageSnapshot(payload, { customHome, updateStatus = true, isExplicitSet = false } = {}) {
  const norm = validateAndClampUsage(payload);
  if (!norm.ok) throw new Error(norm.error);
  const file = snapshotFile(customHome);
  atomicWriteJson(file, norm.data);
  const freshObj = {
    available: true,
    stale: false,
    source: isExplicitSet ? 'set_usage' : 'snapshot',
    ...norm.data,
    age_s: 0,
    reason: null,
    reason_code: null,
    hint: null,
  };
  if (updateStatus) {
    updateStatusClaudeUsage(freshObj, { customHome, isExplicitSet });
  }
  lastResolvedUsage = freshObj;
  lastCommandFailure = null;
  return norm.data;
}

function validateUsageCommandConfig(cmd) {
  if (!Array.isArray(cmd)) {
    return { ok: false, reason_code: 'command_invalid', error: 'claude_usage_command must be an array [executable, ...args], not a shell string' };
  }
  if (cmd.length === 0 || !cmd.every((x) => typeof x === 'string') || !cmd[0].trim()) {
    return { ok: false, reason_code: 'command_invalid', error: 'claude_usage_command must be a non-empty string array [executable, ...args]' };
  }
  for (const arg of cmd) {
    if (FORBIDDEN_CRED_ARG_RE.test(arg) || /\.credentials\.json/i.test(arg)) {
      return { ok: false, reason_code: 'command_blocked', error: 'Refused claude_usage_command referencing credential or secret files' };
    }
  }
  return { ok: true };
}

function runUsageCommandAsync(cmd, { timeoutMs = CLAUDE_USAGE_CMD_TIMEOUT_MS, nowMs = Date.now() } = {}) {
  const chk = validateUsageCommandConfig(cmd);
  if (!chk.ok) return Promise.resolve(chk);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch (e) {
      return finish({ ok: false, reason_code: 'command_failed', error: redact(String(e?.message || e)).slice(0, 200) });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* ignore */ }
      finish({ ok: false, reason_code: 'command_timeout', error: `claude_usage_command timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (d) => {
      if (stdout.length < 65536) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < 16384) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      finish({ ok: false, reason_code: 'command_failed', error: redact(String(e?.message || e)).slice(0, 200) });
    });
    child.on('close', (code) => {
      if (timedOut) return;
      if (code !== 0) {
        const msg = redact((stderr || stdout || `exit code ${code}`).trim()).slice(0, 200);
        return finish({ ok: false, reason_code: 'command_failed', error: `claude_usage_command failed (exit ${code}): ${msg}` });
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return finish({ ok: false, reason_code: 'command_invalid_json', error: 'claude_usage_command did not output valid JSON' });
      }
      const norm = validateAndClampUsage(parsed, { fallbackUpdatedAt: new Date(nowMs).toISOString() });
      if (!norm.ok) {
        return finish({ ok: false, reason_code: 'command_invalid_payload', error: `claude_usage_command output invalid: ${norm.error}` });
      }
      return finish({ ok: true, data: norm.data });
    });
  });
}

function getMaxAgeS(cfg) {
  const raw = cfg?.claude_usage_max_age_s;
  if (raw !== undefined && raw !== null && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
    return Number(raw);
  }
  return DEFAULT_CLAUDE_USAGE_MAX_AGE_S;
}

function inspectSnapshotAndStatus({ cfg, customHome, nowMs = Date.now() }) {
  const maxAgeS = getMaxAgeS(cfg);
  const snapPath = snapshotFile(customHome);
  let freshSnap = null;
  let expiredSnap = null;
  let snapReason = 'no snapshot file';

  if (fs.existsSync(snapPath)) {
    const rawSnap = readJsonSafe(snapPath);
    let mtimeIso = null;
    try { mtimeIso = fs.statSync(snapPath).mtime.toISOString(); } catch { /* ignore */ }
    const normSnap = validateAndClampUsage(rawSnap, { fallbackUpdatedAt: mtimeIso || new Date(nowMs).toISOString() });
    if (normSnap.ok) {
      const ts = Date.parse(normSnap.data.updated_at);
      const ageMs = Number.isNaN(ts) ? Infinity : Math.max(0, nowMs - ts);
      const isFresh = maxAgeS > 0 && ageMs <= maxAgeS * 1000;
      if (isFresh) {
        freshSnap = {
          available: true,
          stale: false,
          source: 'snapshot',
          ...normSnap.data,
          age_s: Math.round(ageMs / 1000),
          reason: null,
          reason_code: null,
          hint: null,
        };
      } else {
        expiredSnap = normSnap.data;
        snapReason = `snapshot older than ${maxAgeS}s (${Math.round(ageMs / 1000)}s old)`;
      }
    } else {
      snapReason = `snapshot invalid (${normSnap.error})`;
    }
  }

  // Last value from csa_board set_usage in status.json (or expired snapshot from set_usage)
  const statusObj = readJsonSafe(resolveStatusFile(customHome));
  const lastSetNorm = validateAndClampUsage(statusObj?.claude_usage_last_set);
  const statusUsageNorm = validateAndClampUsage(statusObj?.claude_usage);

  const candidates = [];
  if (lastSetNorm.ok) candidates.push(lastSetNorm.data);
  if (statusUsageNorm.ok) candidates.push(statusUsageNorm.data);
  if (expiredSnap) candidates.push(expiredSnap);

  candidates.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  const lastSetCandidate = candidates[0] || null;

  return { maxAgeS, freshSnap, lastSetCandidate, snapReason };
}

function buildFallbackOrUnavailable({ lastSetCandidate, snapReason, cmdError = null, cmdCode = null, nowMs = Date.now() }) {
  if (lastSetCandidate) {
    const ts = Date.parse(lastSetCandidate.updated_at);
    const ageS = Number.isNaN(ts) ? null : Math.max(0, Math.round((nowMs - ts) / 1000));
    const reason = cmdError
      ? `${snapReason}; ${cmdError}`
      : `${snapReason}; using last csa_board set_usage value`;
    return {
      available: true,
      stale: true,
      source: 'set_usage',
      ...lastSetCandidate,
      age_s: ageS,
      reason,
      reason_code: cmdCode || 'stale',
      hint: SHORT_SETUP_HINT,
    };
  }
  const reason = cmdError
    ? `${snapReason}; ${cmdError}`
    : 'No usage snapshot or csa_board set_usage data yet';
  return {
    available: false,
    stale: false,
    source: 'none',
    five_hour_remaining_pct: null,
    weekly_remaining_pct: null,
    resets_at: null,
    note: null,
    updated_at: null,
    age_s: null,
    reason,
    reason_code: cmdCode || 'no_data',
    hint: SHORT_SETUP_HINT,
  };
}

/**
 * Pure read of the current Claude usage state from disk (snapshot + status.json)
 * without spawning claude_usage_command. Used by /api/status for instant dashboard reads.
 */
export function readCurrentClaudeUsage(config = null, { customHome, now } = {}) {
  try {
    const activeHome = resolveHome(customHome);
    const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const cfg = config || loadActiveConfig(customHome);
    const { freshSnap, lastSetCandidate, snapReason } = inspectSnapshotAndStatus({ cfg, customHome, nowMs });
    if (freshSnap) return freshSnap;
    const cmdFail = lastCommandFailure && lastCommandFailure.home === activeHome ? lastCommandFailure : null;
    return buildFallbackOrUnavailable({
      lastSetCandidate,
      snapReason,
      cmdError: cmdFail?.error || null,
      cmdCode: cmdFail?.code || null,
      nowMs,
    });
  } catch (e) {
    return {
      available: false,
      stale: false,
      source: 'none',
      five_hour_remaining_pct: null,
      weekly_remaining_pct: null,
      resets_at: null,
      note: null,
      updated_at: null,
      age_s: null,
      reason: redact(String(e?.message || 'Unable to read Claude usage')),
      reason_code: 'read_error',
      hint: SHORT_SETUP_HINT,
    };
  }
}

export function resetClaudeUsageThrottle() {
  lastRefreshAt = 0;
  lastResolvedUsage = null;
  lastCommandFailure = null;
  inFlightPromise = null;
}

export function getClaudeUsageRefreshStats() {
  return { lastRefreshAt, refreshCount, lastResolvedUsage };
}

/**
 * Automatic refresh of Claude Code usage.
 * Fire-and-forget safe, NEVER throws or rejects, throttled to once per 20 s.
 * Priority:
 *  (a) <CSA_HOME>/claude-usage.json if fresh (claude_usage_max_age_s, default 600)
 *  (b) optional config.claude_usage_command (array: executable + args, no shell string, 5s timeout, clamped 0-100)
 *  (c) last value from csa_board set_usage, marked stale
 *  (none) unavailable with reason and short setup hint
 */
export function refreshClaudeUsage({ reason = 'auto', force = false, now, customHome, config } = {}) {
  try {
    const activeHome = resolveHome(customHome);
    if (lastHomeDir !== activeHome) {
      lastHomeDir = activeHome;
      lastRefreshAt = 0;
      lastResolvedUsage = null;
      inFlightPromise = null;
    }

    const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    if (!force && lastRefreshAt > 0 && nowMs >= lastRefreshAt && (nowMs - lastRefreshAt) < CLAUDE_USAGE_THROTTLE_MS) {
      if (inFlightPromise) return inFlightPromise;
      return Promise.resolve({
        ok: true,
        throttled: true,
        reason: String(reason || 'auto'),
        usage: lastResolvedUsage || readCurrentClaudeUsage(config, { customHome, now: nowMs }),
      });
    }

    lastRefreshAt = nowMs;
    refreshCount += 1;

    const cfg = config || loadActiveConfig(customHome);
    const { freshSnap, lastSetCandidate, snapReason } = inspectSnapshotAndStatus({ cfg, customHome, nowMs });

    // Source (a): fresh snapshot wins immediately (synchronously)
    if (freshSnap) {
      lastResolvedUsage = freshSnap;
      updateStatusClaudeUsage(freshSnap, { customHome, onlyIfStatusExists: true });
      return Promise.resolve({
        ok: true,
        throttled: false,
        reason: String(reason || 'auto'),
        usage: freshSnap,
      });
    }

    // Source (b): optional config.claude_usage_command
    const rawCmd = cfg.claude_usage_command;
    const hasCmdConfig = rawCmd !== null && rawCmd !== undefined && !(Array.isArray(rawCmd) && rawCmd.length === 0);

    if (!hasCmdConfig) {
      // Source (c) or unavailable (synchronously)
      const resolved = buildFallbackOrUnavailable({ lastSetCandidate, snapReason, nowMs });
      lastResolvedUsage = resolved;
      updateStatusClaudeUsage(resolved, { customHome, onlyIfStatusExists: true });
      return Promise.resolve({
        ok: true,
        throttled: false,
        reason: String(reason || 'auto'),
        usage: resolved,
      });
    }

    const cmdCheck = validateUsageCommandConfig(rawCmd);
    if (!cmdCheck.ok) {
      lastCommandFailure = { home: activeHome, error: cmdCheck.error, code: cmdCheck.reason_code };
      const resolved = buildFallbackOrUnavailable({
        lastSetCandidate,
        snapReason,
        cmdError: cmdCheck.error,
        cmdCode: cmdCheck.reason_code,
        nowMs,
      });
      lastResolvedUsage = resolved;
      updateStatusClaudeUsage(resolved, { customHome, onlyIfStatusExists: true });
      return Promise.resolve({
        ok: true,
        throttled: false,
        reason: String(reason || 'auto'),
        usage: resolved,
      });
    }

    // Run valid command asynchronously with 5s timeout
    const p = runUsageCommandAsync(rawCmd, { timeoutMs: CLAUDE_USAGE_CMD_TIMEOUT_MS, nowMs })
      .then((cmdRes) => {
        if (cmdRes.ok) {
          lastCommandFailure = null;
          try {
            atomicWriteJson(snapshotFile(customHome), cmdRes.data);
          } catch { /* ignore snapshot write error */ }
          const freshFromCmd = {
            available: true,
            stale: false,
            source: 'command',
            ...cmdRes.data,
            age_s: Math.max(0, Math.round((nowMs - Date.parse(cmdRes.data.updated_at)) / 1000)),
            reason: null,
            reason_code: null,
            hint: null,
          };
          lastResolvedUsage = freshFromCmd;
          updateStatusClaudeUsage(freshFromCmd, { customHome, onlyIfStatusExists: false });
          return {
            ok: true,
            throttled: false,
            reason: String(reason || 'auto'),
            usage: freshFromCmd,
          };
        }
        lastCommandFailure = { home: activeHome, error: cmdRes.error, code: cmdRes.reason_code };
        const fallback = buildFallbackOrUnavailable({
          lastSetCandidate,
          snapReason,
          cmdError: cmdRes.error,
          cmdCode: cmdRes.reason_code,
          nowMs,
        });
        lastResolvedUsage = fallback;
        updateStatusClaudeUsage(fallback, { customHome, onlyIfStatusExists: true });
        return {
          ok: true,
          throttled: false,
          reason: String(reason || 'auto'),
          usage: fallback,
        };
      })
      .catch((e) => {
        const fallback = buildFallbackOrUnavailable({
          lastSetCandidate,
          snapReason,
          cmdError: redact(String(e?.message || e)).slice(0, 200),
          cmdCode: 'command_failed',
          nowMs,
        });
        lastResolvedUsage = fallback;
        return {
          ok: true,
          throttled: false,
          reason: String(reason || 'auto'),
          usage: fallback,
        };
      })
      .finally(() => {
        inFlightPromise = null;
      });

    inFlightPromise = p;
    return p;
  } catch (e) {
    const safeFallback = {
      available: false,
      stale: false,
      source: 'none',
      five_hour_remaining_pct: null,
      weekly_remaining_pct: null,
      resets_at: null,
      note: null,
      updated_at: null,
      age_s: null,
      reason: redact(String(e?.message || 'refresh error')).slice(0, 200),
      reason_code: 'refresh_error',
      hint: SHORT_SETUP_HINT,
    };
    return Promise.resolve({
      ok: false,
      throttled: false,
      reason: String(reason || 'auto'),
      usage: safeFallback,
    });
  }
}
