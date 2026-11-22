// Starts the live dashboard (if it is not already running) and opens it in the browser once per
// server process, the first time a project starts delegating work. Zero model tokens.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './paths.mjs';
import { redact } from './safety.mjs';
import { openUrl } from './platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(root, 'dashboard', 'server.mjs');
const PROGRESS = path.join(root, 'dashboard', 'progress.mjs');
let opened = false;

function config() {
  const c = loadConfig();
  return { port: Number(c.dashboard_port) || 4317, autoOpen: c.dashboard_auto_open !== false && process.env.CSA_DASHBOARD !== 'off' };
}

export const dashboardUrl = () => `http://127.0.0.1:${config().port}/`;

function isUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function ensureDashboard({ open = true, force = false } = {}) {
  const { port, autoOpen } = config();
  if (!force && !autoOpen) return { url: dashboardUrl(), started: false, opened: false, disabled: true };
  let started = false;
  if (!(await isUp(port))) {
    const child = spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PORT: String(port) } });
    child.on('error', () => {});
    child.unref();
    started = true;
    for (let i = 0; i < 20 && !(await isUp(port)); i++) await new Promise((r) => setTimeout(r, 150));
  }
  let didOpen = false;
  if (open && (force || !opened)) {
    opened = true;
    // Fixed URL built from a number only; no user text reaches the shell.
    openUrl(`http://127.0.0.1:${port}/`);
    didOpen = true;
  }
  return { url: dashboardUrl(), started, opened: didOpen };
}

// Lets Claude register its own agents and tasks on the board (Claude-side subagents included).
export function boardUpdate(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PROGRESS, ...args.map(String)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const last = out.trim().split('\n').pop() || '';
      resolve({ ok: code === 0, output: redact(last.slice(0, 300)) });
    });
    p.on('error', (e) => resolve({ ok: false, output: redact(e.message) }));
  });
}

function sanitizeUsageText(value, maxLen) {
  if (value === null || value === undefined) return null;
  let s = redact(String(value));
  s = s.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/gi, '[REDACTED]');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]');
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]');
  s = s.replace(/((?:api[_-]?key|secret|password|auth|token)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED]');
  return s.trim().slice(0, maxLen) || null;
}

/** Convert a csa_board payload into progress.mjs CLI arguments. */
export function boardActionToArgv(p = {}) {
  switch (p.action) {
    case 'project':
      return ['--project', p.name || ''];
    case 'add_agent':
      return ['--add', p.id || '', p.name || p.id || '', p.model || '', p.role || ''];
    case 'add_task':
      return ['--task', p.id || '', p.task_id || '', p.title || ''];
    case 'set_task':
      return [p.id || '', p.task_id || '', p.state || 'doing', p.note ?? ''];
    case 'now':
      return [p.id || '', '--now', p.note ?? ''];
    case 'set_usage': {
      const usage = {
        five_hour_remaining_pct: p.five_hour_remaining_pct ?? null,
        weekly_remaining_pct: p.weekly_remaining_pct ?? null,
        resets_at: sanitizeUsageText(p.resets_at, 80),
        note: sanitizeUsageText(p.note, 300),
      };
      return ['--set-usage', JSON.stringify(usage)];
    }
    default:
      throw new Error(`Unknown board action: ${p.action}`);
  }
}

/** Apply a csa_board action directly (usable from tools and tests without MCP stdio). */
export async function applyBoardAction(p, { openDashboard = true } = {}) {
  const argv = boardActionToArgv(p);
  const r = await boardUpdate(argv);
  if (openDashboard && !['now', 'set_usage'].includes(p?.action)) {
    ensureDashboard().catch(() => {});
  }
  return r;
}

/** Push Claude Code's overall remaining usage onto the dashboard status file. */
export function setClaudeUsage({ five_hour_remaining_pct = null, weekly_remaining_pct = null, resets_at = null, note = null } = {}) {
  return applyBoardAction(
    { action: 'set_usage', five_hour_remaining_pct, weekly_remaining_pct, resets_at, note },
    { openDashboard: false },
  );
}
