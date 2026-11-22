// Claude Code CLI runner (Echo). Spawns `claude -p` with argument arrays only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as safety from './safety.mjs';
import { claudeCandidates, firstExisting, killProcessTree } from './platform.mjs';
import { join, extname } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const TASK_TOOLS = 'Read Grep Glob Edit Write';

export function findClaude() {
  const env = process.env.CSA_CLAUDE_BIN;
  if (env) return env;
  const found = firstExisting(claudeCandidates());
  return found || 'claude';
}

export const DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'PowerShell'];

export function buildClaudeArgs({ mode = 'review', model, sessionId, addDirs, maxBudgetUsd, schema, mcpConfigPath } = {}) {
  // H1: never load project/local settings (hooks, allow rules) from the agent-chosen cwd, no shell tools, no MCP servers.
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'user', '--disallowedTools', ...DENIED_TOOLS];
  if (mcpConfigPath) args.push('--strict-mcp-config', '--mcp-config', String(mcpConfigPath));
  if (mode === 'task') {
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', TASK_TOOLS);
  } else {
    args.push('--permission-mode', 'plan');
  }
  if (model) args.push('--model', String(model));
  if (sessionId) args.push('--resume', String(sessionId));
  for (const d of addDirs || []) args.push('--add-dir', String(d));
  if (maxBudgetUsd != null && Number.isFinite(Number(maxBudgetUsd))) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (schema) args.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  return args;
}

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    notes: { type: 'string' },
    required_changes: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'notes', 'required_changes'],
};

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    killProcessTree(child.pid, { child });
  } catch { /* ignore */ }
}

function parseOutput(stdout) {
  const text = (stdout || '').trim();
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const i = text.lastIndexOf('\n{');
    if (i >= 0) { try { obj = JSON.parse(text.slice(i + 1)); } catch { /* ignore */ } }
  }
  if (Array.isArray(obj)) obj = obj.find((x) => x && x.type === 'result') || obj[obj.length - 1];
  return obj;
}

/** Run claude once. Never rejects: failures come back with is_error true. */
export function runClaude({ prompt, mode = 'review', cwd, sessionId, model, addDirs, maxBudgetUsd, schema, timeoutMs = DEFAULT_TIMEOUT_MS, env: extraEnv, mcpConfigPath } = {}) {
  return new Promise((resolve) => {
    const bin = findClaude();
    if (!mcpConfigPath) {
      mcpConfigPath = join(mkdtempSync(join(tmpdir(), 'csa-mcp-')), 'mcp-empty.json');
      writeFileSync(mcpConfigPath, '{"mcpServers":{}}');
    }
    const args = buildClaudeArgs({ mode, model, sessionId, addDirs, maxBudgetUsd, schema, mcpConfigPath });
    const baseEnv = typeof safety.childEnv === 'function'
      ? safety.childEnv()
      : Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ANTIGRAVITY_/i.test(k)));
    const env = { ...baseEnv, ...(extraEnv || {}) };
    const isJs = ['.mjs', '.js', '.cjs'].includes(extname(bin).toLowerCase());
    const cmd = isJs ? process.execPath : bin;
    const full = isJs ? [bin, ...args] : args;
    const fail = (msg, extra = {}) => resolve({ result: msg, session_id: null, usage: null, cost_usd: null, is_error: true, ...extra });
    let child;
    try {
      child = spawn(cmd, full, { cwd: cwd || process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return fail(`could not start claude: ${e.message}`); }
    let out = '', err = '', done = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 8e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    child.stdin.on('error', () => {});
    // The prompt goes through stdin: avoids the Windows command-line limit and variadic flag capture.
    child.stdin.end(String(prompt ?? ''));
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); fail(`claude failed to run: ${e.message}`); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (timedOut) return fail(`claude timed out after ${Math.round(timeoutMs / 1000)}s and was stopped`, { timed_out: true });
      const o = parseOutput(out);
      if (!o || typeof o !== 'object') {
        return fail(`claude exited with code ${code} and no JSON output. ${(err || out).trim().slice(0, 500)}`);
      }
      const result = typeof o.result === 'string' ? o.result : (o.result != null ? JSON.stringify(o.result) : '');
      const r = {
        result,
        session_id: o.session_id ?? null,
        usage: o.usage ?? null,
        cost_usd: o.total_cost_usd ?? null,
        is_error: Boolean(o.is_error) || (code !== 0 && !result),
      };
      if (o.structured_output != null) r.structured_output = o.structured_output;
      resolve(r);
    });
  });
}

/** Pull a verdict object out of structured output or free text. */
export function parseVerdict(run) {
  const norm = (o) => {
    if (!o || typeof o !== 'object') return null;
    const v = String(o.verdict || '').toLowerCase();
    if (v !== 'approve' && v !== 'changes') return null;
    return { verdict: v, notes: String(o.notes ?? ''), required_changes: Array.isArray(o.required_changes) ? o.required_changes.map(String) : [] };
  };
  const s = norm(run.structured_output);
  if (s) return s;
  // L5: only the last 64 KB; first complete top-level object that carries a valid verdict.
  const text = (run.result || '').slice(-65536);
  let i = 0;
  while ((i = text.indexOf('{', i)) !== -1) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    try { const v = norm(JSON.parse(text.slice(i, end + 1))); if (v) return v; } catch { /* next */ }
    i = end + 1;
  }
  return null;
}
