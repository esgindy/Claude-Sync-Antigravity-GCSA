// Antigravity desktop app access through the internal `agentapi` CLI.
// Self-contained on purpose (no imports from other project modules): quota.mjs imports discoverLs from here.
// The CSRF token is only ever placed in a child process env. It is never logged, written or returned in errors.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as safety from './safety.mjs';

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const BAD_PROBE = /unavailable|unauthenticated|csrf|not set|connection/i;

// Local redaction (same rules as safety.redact; kept here so this module has no dependencies).
export function redactText(text) {
  let s = String(text ?? '');
  if (typeof safety.redact === 'function') s = String(safety.redact(s));
  s = s.replace(/(--csrf_token[ =]+)("?)[^\s"']+/gi, '$1$2***');
  s = s.replace(/(ANTIGRAVITY_CSRF_TOKEN\s*=\s*)("?)[^\s"']+/gi, '$1$2***');
  s = s.replace(/(x-codeium-csrf-token\s*:\s*)[^\s"']+/gi, '$1***');
  s = s.replace(/(token["'\s:=]+)[0-9a-f-]{32,}/gi, '$1***');
  return s;
}

const MAX_OUT = 8 * 1024 * 1024;
const CONV_ID = /^[0-9a-f][0-9a-f-]{35}$/i; // 36 chars, never starts with "-"
export function assertConversationId(id) {
  if (typeof id !== 'string' || !CONV_ID.test(id)) throw new Error('Invalid conversation_id (expected a UUID).');
  return id;
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
}

// Reads the app's permission settings (observed under "userSettings"; top level kept as fallback).
// Fails closed: if the settings cannot be read, auto_exec is reported true ("unknown").
export function desktopPolicy() {
  const file = process.env.CSA_AG_CONFIG || path.join(process.env.USERPROFILE || os.homedir(), '.gemini', 'config', 'config.json');
  let cfg = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    try { cfg = JSON.parse(raw); } catch { cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); }
  } catch { cfg = null; }
  if (!cfg || typeof cfg !== 'object') return { auto_exec: true, policy: 'unknown (app settings unreadable)', preset: null, readable: false };
  const scopes = [cfg.userSettings, cfg].filter((s) => s && typeof s === 'object');
  const pick = (k) => { for (const s of scopes) if (s[k] != null) return String(s[k]); return null; };
  const policy = pick('autoExecutionPolicy');
  const preset = pick('permissionPreset');
  const auto = (v) => !!v && /AUTO/i.test(v);
  return { auto_exec: auto(policy) || auto(preset), policy, preset, readable: true };
}

// Throws when a desktop job must not start. config = loadConfig() result.
export function desktopGate({ kind = 'read' } = {}, config = {}) {
  const p = desktopPolicy();
  if (p.auto_exec && !config.allow_desktop_auto_exec) {
    const err = new Error('Refused: the Antigravity app is set to run commands without asking (' + (p.policy || p.preset) + '), so a desktop job could execute commands unreviewed. Switch the app to "Request review", or set allow_desktop_auto_exec to true in config.json to accept the risk.');
    err.code = 'DESKTOP_AUTO_EXEC_REFUSED';
    throw err;
  }
  if (kind === 'edit' && !config.allow_desktop_edit) {
    const err = new Error('Refused: edit jobs on the desktop target are disabled because the app has its own permissions. Use target cli for edits, or set allow_desktop_edit to true in config.json.');
    err.code = 'DESKTOP_EDIT_REFUSED';
    throw err;
  }
  return p;
}

let cache = null; // { ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN }, memory only
export function resetDiscoveryCache() { cache = null; }

// Run a process with an argument array; resolves with code/stdout/stderr (never rejects).
export function runProc(cmd, args, { env, timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { env: env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: redactText(e.message), timedOut: false });
    }
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); finish(-1); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d; });
    child.on('error', (e) => { err += redactText(e.message); finish(-1); });
    child.on('close', (c) => finish(c ?? -1));
    child.stdin.on('error', () => {});
    try { child.stdin.end(input ?? ''); } catch {}
  });
}

function agentapiCommand() {
  const bin = process.env.CSA_AGENTAPI;
  if (bin) {
    if (/\.(mjs|js|cjs)$/i.test(bin)) return { cmd: process.execPath, pre: [bin, 'agentapi'] };
    return { cmd: bin, pre: ['agentapi'] };
  }
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return { cmd: path.join(base, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'), pre: ['agentapi'] };
}

function tryJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// Run `agentapi <args>` with the given address/token env (default: discovered).
export async function agentapi(args, env, { timeoutMs = 60000 } = {}) {
  const e = env || await discoverLs();
  const { cmd, pre } = agentapiCommand();
  const targetBin = process.env.CSA_AGENTAPI || cmd;
  if (targetBin && (/[\\/]|\.(mjs|js|cjs|exe)$/i.test(targetBin)) && !fs.existsSync(targetBin)) {
    return { code: -1, json: null, stdout: '', stderr: 'agentapi binary not found' };
  }
  const childEnv = { ...process.env, ANTIGRAVITY_LS_ADDRESS: e.ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN: e.ANTIGRAVITY_CSRF_TOKEN };
  const r = await runProc(cmd, [...pre, ...args], { env: childEnv, timeoutMs });
  return { code: r.code, json: tryJson(r.stdout), stdout: redactText(r.stdout), stderr: redactText(r.stderr) };
}

function probeOk(r) {
  const text = `${r.stdout}\n${r.stderr}\n${r.json && r.json.error ? r.json.error : ''}`;
  if (r.code !== 0 && !r.stdout) return false;
  return !BAD_PROBE.test(text);
}

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'")
$out = @()
foreach ($p in $procs) {
  $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | ForEach-Object { $_.LocalPort })
  $out += [pscustomobject]@{ pid = $p.ProcessId; cmd = $p.CommandLine; ports = $ports }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($out)
`;

export function parseScanOutput(stdout) {
  const data = tryJsonArray(stdout);
  const found = [];
  for (const p of data) {
    const cmd = String(p.cmd || '');
    if (!/--subclient_type[ =]+"?hub\b/.test(cmd)) continue;
    const m = cmd.match(/--csrf_token[ =]+"?([^\s"]+)/);
    if (!m) continue;
    const ports = [].concat(p.ports || []).map(Number).filter((n) => n > 0 && n < 65536);
    found.push({ token: m[1], ports });
  }
  return found;
}

function tryJsonArray(text) {
  const t = String(text || '').trim();
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : (v ? [v] : []); } catch { return []; }
}

export async function discoverLs() {
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const envTok = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (envAddr && envTok) {
    if (typeof safety.registerSecret === 'function') { try { safety.registerSecret(envTok); } catch {} }
    return { ANTIGRAVITY_LS_ADDRESS: envAddr, ANTIGRAVITY_CSRF_TOKEN: envTok };
  }
  if (cache) return cache;
  const ps = await runProc('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { timeoutMs: 30000 });
  const procs = parseScanOutput(ps.stdout);
  if (!procs.length) throw new Error('Antigravity desktop app not found (no language_server.exe hub process). Open the Antigravity app first.');
  for (const p of procs) {
    for (const port of p.ports) {
      const cand = { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`, ANTIGRAVITY_CSRF_TOKEN: p.token };
      const r = await agentapi(['get-conversation-metadata', ZERO_ID], cand, { timeoutMs: 15000 });
      if (probeOk(r)) {
        cache = cand;
        if (typeof safety.registerSecret === 'function') { try { safety.registerSecret(p.token); } catch {} }
        return cache;
      }
    }
  }
  throw new Error('Antigravity app is running but no working agentapi port was found.');
}

function findId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const nc = obj.response && obj.response.newConversation;
  if (nc && typeof nc.conversationId === 'string') return nc.conversationId;
  const stack = [obj];
  while (stack.length) {
    const o = stack.pop();
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^(conversationId|conversation_id)$/.test(k)) return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function apiError(r, what) {
  const j = r.json && r.json.error ? String(r.json.error) : '';
  return new Error(redactText(`${what} failed: ${j || r.stderr || r.stdout || 'exit ' + r.code}`).slice(0, 500));
}

async function call(args) {
  let env = await discoverLs();
  let r = await agentapi(args, env);
  if (!process.env.ANTIGRAVITY_LS_ADDRESS && /unavailable|connection refused|unauthenticated/i.test(`${r.stdout} ${r.stderr}`)) {
    resetDiscoveryCache();
    env = await discoverLs();
    r = await agentapi(args, env);
  }
  return r;
}

export async function newConversation({ prompt, title, model }) {
  const args = ['new-conversation'];
  if (model) args.push(`--model=${model}`);
  if (title) args.push(`--title=${title}`);
  args.push(prompt);
  const r = await call(args);
  if (r.json && r.json.error) throw apiError(r, 'new-conversation');
  const id = findId(r.json);
  if (!id) throw apiError(r, 'new-conversation (no conversation id in response)');
  return id;
}

export async function sendMessage(conversationId, content, { title } = {}) {
  assertConversationId(conversationId);
  const args = ['send-message'];
  if (title) args.push(`--title=${title}`);
  args.push(conversationId, content);
  const r = await call(args);
  if (r.json && r.json.error) throw apiError(r, 'send-message');
  if (r.code !== 0 && !r.json) throw apiError(r, 'send-message');
  return r.json;
}

export async function getMetadata(id) {
  assertConversationId(id);
  const r = await call(['get-conversation-metadata', id]);
  if (r.json && r.json.error) throw apiError(r, 'get-conversation-metadata');
  return r.json;
}

// Returns { running, error } ; error never contains secrets.
export async function checkApp() {
  try {
    const env = await discoverLs();
    const r = await agentapi(['get-conversation-metadata', ZERO_ID], env, { timeoutMs: 15000 });
    if (probeOk(r)) return { running: true, error: null };
    return { running: false, error: redactText(`agentapi probe failed: ${r.json?.error || r.stderr || r.stdout}`).slice(0, 300) };
  } catch (e) {
    return { running: false, error: redactText(e.message).slice(0, 300) };
  }
}

export async function isAppRunning() {
  return (await checkApp()).running;
}
