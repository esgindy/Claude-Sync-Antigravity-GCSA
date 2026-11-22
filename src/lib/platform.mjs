// Single place for every OS difference (Windows / macOS / Linux). V5.
// Nothing here imports other project modules, so any module may import it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLATFORM = process.platform;
export const isWin = PLATFORM === 'win32';
export const isMac = PLATFORM === 'darwin';
export const isLinux = PLATFORM === 'linux';

export function userHome() {
  return (isWin && process.env.USERPROFILE) || os.homedir();
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(userHome(), 'AppData', 'Local');
}

/** Default state directory (overridden by CSA_HOME). */
export function stateHome() {
  if (isWin) return path.join(localAppData(), 'claude-sync-antigravity');
  if (isMac) return path.join(userHome(), 'Library', 'Application Support', 'claude-sync-antigravity');
  const xdg = process.env.XDG_DATA_HOME || path.join(userHome(), '.local', 'share');
  return path.join(xdg, 'claude-sync-antigravity');
}

/** Antigravity's own config/brain root (same ~/.gemini layout on every OS). */
export function geminiDir() {
  return path.join(userHome(), '.gemini');
}

/** Claude Code user-scope config (holds user MCP servers). Same name on every OS. */
export function claudeCodeConfigPath(home = userHome()) {
  return path.join(home, '.claude.json');
}

/** Claude Desktop config file. */
export function claudeDesktopConfigPath(home = userHome()) {
  if (isWin) return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (isMac) return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Antigravity MCP config file (same ~/.gemini layout on every OS). */
export function antigravityMcpConfigPath(home = userHome()) {
  return path.join(home, '.gemini', 'config', 'mcp_config.json');
}

/** Executable suffixes to try when looking a bare name up on PATH. */
export function pathExts() {
  return isWin ? ['.exe', '.com', ''] : [''];
}

/** True when `name` already carries a known executable/script extension. */
export function hasKnownExt(name) {
  return isWin ? /\.(exe|com|mjs|cjs|js)$/i.test(name) : /\.(mjs|cjs|js)$/i.test(name);
}

/** True when `s` looks like a file path rather than a bare command name. */
export function looksLikePath(s) {
  return isWin ? /[\\/]|\.(mjs|cjs|js|exe|cmd|bat)$/i.test(s) : /\//.test(s) || /\.(mjs|cjs|js)$/i.test(s);
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** First existing path of the list, else null. */
export function firstExisting(list) {
  for (const p of list) if (p && isFile(p)) return p;
  return null;
}

/** Well-known install locations of the `agy` CLI (checked in order). */
export function agyCandidates() {
  if (isWin) return [path.join(localAppData(), 'agy', 'bin', 'agy.exe')];
  const h = userHome();
  return [
    path.join(h, '.local', 'bin', 'agy'),
    path.join(h, '.gemini', 'antigravity', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];
}

/** Label used for the "well-known location" probe entry in diagnostics. */
export const AGY_LOCATION_LABEL = isWin ? 'localappdata' : 'well-known-paths';

/** Well-known locations of the Claude Code CLI. */
export function claudeCandidates() {
  const h = userHome();
  if (isWin) return [path.join(h, '.local', 'bin', 'claude.exe')];
  return [
    path.join(h, '.local', 'bin', 'claude'),
    path.join(h, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

/** Known locations of the Antigravity desktop `language_server` binary. */
export function languageServerCandidates() {
  if (isWin) return [path.join(localAppData(), 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')];
  if (isMac) {
    return [
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      path.join(userHome(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
    ];
  }
  return [
    '/opt/antigravity/resources/bin/language_server',
    path.join(userHome(), '.gemini', 'antigravity', 'bin', 'language_server'),
  ];
}

/** Process name of the desktop hub, as the OS reports it. */
export const LANGUAGE_SERVER_NAME = isWin ? 'language_server.exe' : 'language_server';

/** Antigravity app.asar (holds the app icon). */
export function antigravityAsarCandidates() {
  if (isWin) return [path.join(localAppData(), 'Programs', 'antigravity', 'resources', 'app.asar')];
  if (isMac) {
    return [
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(userHome(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
    ];
  }
  return ['/opt/antigravity/resources/app.asar'];
}

/** Claude desktop app resource folders that may hold a logo PNG (non-Windows). */
export function claudeAppResourceDirs() {
  if (isMac) {
    return [
      '/Applications/Claude.app/Contents/Resources',
      path.join(userHome(), 'Applications', 'Claude.app', 'Contents', 'Resources'),
    ];
  }
  return [];
}

/** Shell used to run commands the user approved: { cmd, args(commandString) }. */
export function shellInvocation(commandString) {
  if (isWin) return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', commandString] };
  const sh = fs.existsSync('/bin/zsh') && isMac ? '/bin/zsh' : '/bin/sh';
  return { cmd: sh, args: ['-c', commandString] };
}

/** Human name of the shell used for approved commands. */
export const SHELL_NAME = isWin ? 'PowerShell' : (isMac ? 'zsh' : 'sh');

/** spawn() options that hide console windows on Windows; harmless elsewhere. */
export function hideWindow(opts = {}) {
  return isWin ? { ...opts, windowsHide: true } : opts;
}

/** Open a URL in the default browser (URL must be built from trusted parts). */
export function openUrl(url) {
  let child;
  if (isWin) child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  else if (isMac) child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Kill a process and its children. Never throws. */
export function killProcessTree(pid, { child } = {}) {
  if (!pid) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    // POSIX: a detached child leads its own process group, so -pid reaches its children too.
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); return; } catch { /* already gone */ }
  } catch { /* ignore */ }
  try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
}

/** Lower-case a path only where the file system is case-insensitive by convention. */
export function foldCase(p) {
  return isWin || isMac ? String(p).toLowerCase() : String(p);
}

/**
 * Find running Antigravity `language_server` processes with their listening TCP ports.
 * Resolves to [{ pid, cmd, ports: number[] }]. Never throws.
 * `run(cmd, args, {timeoutMs})` must resolve { code, stdout, stderr }.
 */
export async function scanLanguageServers(run) {
  if (isWin) {
    const ps = `
$ErrorActionPreference='SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'")
$out = @()
foreach ($p in $procs) {
  $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | ForEach-Object { $_.LocalPort })
  $out += [pscustomobject]@{ pid = $p.ProcessId; cmd = $p.CommandLine; ports = $ports }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($out)
`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 30000 });
    try {
      const v = JSON.parse(String(r.stdout || '').trim());
      return Array.isArray(v) ? v : (v ? [v] : []);
    } catch { return []; }
  }
  // macOS / Linux: ps for the command line, lsof (mac) or ss/lsof (linux) for the listening ports.
  const list = await run('ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 15000 });
  const procs = [];
  for (const line of String(list.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[2];
    // Executable name must be language_server (not e.g. an editor that merely has the word in its args).
    const exe = cmd.split(/\s--?[A-Za-z]/)[0].trim();
    if (path.basename(exe) !== 'language_server') continue;
    procs.push({ pid: Number(m[1]), cmd, ports: [] });
  }
  for (const p of procs) {
    const r = await run('lsof', ['-nP', '-a', '-p', String(p.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeoutMs: 15000 });
    const ports = new Set();
    for (const l of String(r.stdout || '').split('\n')) {
      const m = /^n.*:(\d+)$/.exec(l.trim());
      if (m) ports.add(Number(m[1]));
    }
    p.ports = [...ports];
  }
  return procs;
}
