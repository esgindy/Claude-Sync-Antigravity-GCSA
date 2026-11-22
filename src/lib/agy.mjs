// agy CLI runner and stream-json parsing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './paths.mjs';
import { redact, childEnv } from './safety.mjs';
import { agyCandidates, firstExisting, hasKnownExt, pathExts, looksLikePath, AGY_LOCATION_LABEL, killProcessTree, isWin } from './platform.mjs';

export const OUTPUT_CAP = 8 * 1024 * 1024;

function isFile(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function wellKnownAgy() {
  return firstExisting(agyCandidates());
}

function findOnPath(name) {
  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  const dirs = String(rawPath)
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const exts = hasKnownExt(name) ? [''] : pathExts();
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, name + ext);
      if (isFile(cand)) return cand;
    }
  }
  return null;
}

export function findAgy(config = null) {
  const envBin = typeof process.env.CSA_AGY_BIN === 'string' ? process.env.CSA_AGY_BIN.trim() : '';
  if (envBin) return envBin;
  const cfg = config || loadConfig();
  const cfgPath = typeof cfg?.agy_path === 'string' ? cfg.agy_path.trim() : '';
  if (cfgPath && isFile(cfgPath)) return cfgPath;
  const known = wellKnownAgy();
  if (known) return known;
  return findOnPath('agy') || 'agy';
}

/** Probe agy CLI locations without executing the binary. */
export function probeCli(config = null) {
  const checked = [];
  const envBin = typeof process.env.CSA_AGY_BIN === 'string' ? process.env.CSA_AGY_BIN.trim() : '';
  if (envBin) {
    const isPathLike = looksLikePath(envBin);
    const foundPath = isPathLike ? (isFile(envBin) ? envBin : null) : findOnPath(envBin);
    const available = !!foundPath;
    checked.push({
      label: 'CSA_AGY_BIN',
      path: isPathLike ? envBin : (foundPath || `${envBin} on PATH`),
      found: available,
    });
    return {
      available,
      path: available ? foundPath : null,
      source: available ? 'CSA_AGY_BIN' : null,
      checked,
    };
  }

  const cfg = config || loadConfig();
  const cfgPath = typeof cfg?.agy_path === 'string' ? cfg.agy_path.trim() : '';
  if (cfgPath) {
    const found = isFile(cfgPath);
    checked.push({ label: 'config.agy_path', path: cfgPath, found });
    if (found) return { available: true, path: cfgPath, source: 'config.agy_path', checked };
  }

  const knownList = agyCandidates();
  const exe = wellKnownAgy();
  checked.push({ label: AGY_LOCATION_LABEL, path: exe || knownList.join(' | '), found: !!exe });
  if (exe) return { available: true, path: exe, source: AGY_LOCATION_LABEL, checked };

  const foundPath = findOnPath('agy');
  checked.push({ label: 'PATH', path: foundPath || 'agy on PATH', found: !!foundPath });
  return {
    available: !!foundPath,
    path: foundPath || null,
    source: foundPath ? 'PATH' : null,
    checked,
  };
}

/** Command + leading args to run the agy binary (a .mjs path runs with node). */
export function agyCommand(args = []) {
  const bin = findAgy();
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, args: [bin, ...args] };
  return { cmd: bin, args };
}

export function buildAgyArgs({ prompt, kind = 'read', model, conversation, addDirs, timeoutS, schema, allow } = {}) {
  const args = ['-p', String(prompt ?? ''), '--mode', kind === 'edit' ? 'accept-edits' : 'plan', '--output-format', 'stream-json'];
  if (model) args.push('--model', String(model));
  if (conversation) args.push('--conversation', String(conversation));
  for (const d of addDirs || []) args.push('--add-dir', String(d));
  if (timeoutS) args.push('--print-timeout', `${Math.max(1, Math.floor(timeoutS))}s`);
  if (schema) args.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  if (allow && allow.length) {
    const rules = allow.map((c) => `command(${c})`);
    args.push('--settings', JSON.stringify({ permissions: { allow: rules } }));
  }
  return args;
}

function killTree(child) {
  if (!child || !child.pid) return;
  killProcessTree(child.pid, { child });
}

/** Run a command with an args array. Resolves (never rejects) with {code, stdout, stderr, timedOut}. */
export function runProcess(cmd, args, { cwd, timeoutMs, env, input, capBytes = OUTPUT_CAP } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let capped = false;
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        env: env || childEnv(),
        windowsHide: true,
        // POSIX: own process group, so a timeout/cap kill (process.kill(-pid)) also stops the
        // shell's children (e.g. an approved "npm run dev"), as taskkill /T does on Windows.
        detached: !isWin,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: redact(String(e.message)), timedOut: false, capped: false });
      return;
    }
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, capped });
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
          setTimeout(() => finish(-1), 2000).unref();
        }, timeoutMs)
      : null;
    const over = () => {
      if (capped) return;
      capped = true;
      killTree(child);
    };
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > capBytes) { stdout = stdout.slice(-capBytes); over(); }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > capBytes) { stderr = stderr.slice(-capBytes); over(); }
    });
    child.on('error', (e) => { stderr += redact(String(e.message)); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function runAgy(args, { cwd, timeoutMs, env } = {}) {
  const { cmd, args: full } = agyCommand(args);
  return runProcess(cmd, full, { cwd, timeoutMs, env: env || childEnv() });
}

const FILE_PARAM_KEYS = ['AbsolutePath', 'Path', 'TargetFile', 'File', 'FilePath', 'path', 'file_path', 'SearchPath', 'DirectoryPath'];

function firstParam(params, keys) {
  for (const k of keys) if (params && typeof params[k] === 'string' && params[k]) return params[k];
  return null;
}

export function parseStream(stdout) {
  let result = null;
  const stepMap = new Map();
  let order = 0;
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.event === 'result' && ev.result) {
      result = ev.result;
    } else if (ev.event === 'step_update' && ev.step_update) {
      const su = ev.step_update;
      const key = `${su.conversation_id || ''}#${su.step_index ?? order}`;
      const info = su.tool_info || {};
      const prev = stepMap.get(key);
      stepMap.set(key, {
        order: prev ? prev.order : order++,
        tool: su.tool_name || info.name || prev?.tool || null,
        params: info.parameters || prev?.params || {},
        state: su.state || prev?.state || null,
        error: info.error?.message || prev?.error || null,
      });
    }
  }
  const all = [...stepMap.values()].sort((a, b) => a.order - b.order);
  const denied = [];
  for (const s of all) {
    if (s.state !== 'ERROR' || !s.error || !/permission/i.test(s.error)) continue;
    const cmd = firstParam(s.params, ['CommandLine', 'command', 'Command']);
    if (cmd) {
      denied.push({ tool: s.tool, kind: 'command', target: redact(cmd), cwd: firstParam(s.params, ['Cwd', 'cwd', 'WorkingDirectory']) });
    } else {
      denied.push({ tool: s.tool, kind: 'file', target: firstParam(s.params, FILE_PARAM_KEYS), cwd: null });
    }
  }
  const steps = all.map((s) => ({ tool: s.tool, params: s.params, state: s.state }));
  return { result, denied, steps };
}

/** JSON schema for the structured output we ask agy to return. */
export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'The real answer or a clear report of what was done.' },
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_requested: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, cwd: { type: 'string' }, reason: { type: 'string' } },
        required: ['command'],
      },
    },
    followups: { type: 'array', items: { type: 'string' } },
    handoff_notes: { type: 'string' },
  },
  required: ['summary'],
};
