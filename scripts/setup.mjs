#!/usr/bin/env node
// GCSA one-step installer (Windows / macOS / Linux).
//
//   node scripts/setup.mjs                 install deps, register MCP servers, verify
//   node scripts/setup.mjs --dry-run       show what would change, write nothing
//   node scripts/setup.mjs --uninstall     remove the GCSA entries from the app configs
//   node scripts/setup.mjs --only claude-code,claude-desktop,antigravity
//   node scripts/setup.mjs --skip-deps --skip-verify --skip-agy --skip-statusline --skip-path
//
// Also: installs the official Antigravity `agy` CLI when missing (antigravity.google/cli, SHA-512
// verified by Google's installer) and sets a Claude Code statusLine that keeps the dashboard's
// Claude usage fresh (an existing statusLine is kept and chained, and restored on --uninstall).
//
// Runs before `npm install`: imports only Node built-ins and src/lib/platform.mjs.
// Every config file it changes is backed up first (<file>.bak-gcsa-<timestamp>) and written atomically.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLATFORM, isWin, userHome, stateHome,
  claudeCodeConfigPath, claudeDesktopConfigPath, antigravityMcpConfigPath,
  firstExisting, agyCandidates, claudeCandidates, languageServerCandidates,
} from '../src/lib/platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = ['claude-code', 'claude-desktop', 'antigravity'];

// ---------- pure helpers (exported for tests) ----------

/** What each app's config should contain for this install. */
export function planEntries({ home = userHome(), node = process.execPath, root = ROOT } = {}) {
  const claudeSide = path.join(root, 'src', 'servers', 'claude-side.mjs');
  const agySide = path.join(root, 'src', 'servers', 'antigravity-side.mjs');
  return [
    {
      target: 'claude-code', app: 'Claude Code', file: claudeCodeConfigPath(home), key: 'csa',
      entry: { type: 'stdio', command: node, args: [claudeSide], env: {} },
      // Claude Code creates ~/.claude.json on first launch; don't create it ourselves.
      requires: claudeCodeConfigPath(home),
      missingHint: 'Launch Claude Code once (it creates ~/.claude.json), then run setup again.',
    },
    {
      target: 'claude-desktop', app: 'Claude Desktop', file: claudeDesktopConfigPath(home), key: 'csa',
      entry: { command: node, args: [claudeSide] },
      requires: path.dirname(claudeDesktopConfigPath(home)),
      missingHint: 'Claude Desktop does not look installed (no config folder). Install/launch it, then run setup again.',
    },
    {
      target: 'antigravity', app: 'Antigravity', file: antigravityMcpConfigPath(home), key: 'csa-antigravity',
      entry: { command: node, args: [agySide] },
      requires: path.join(home, '.gemini'),
      missingHint: 'Antigravity does not look installed (no ~/.gemini). Install/launch it, then run setup again.',
    },
  ];
}

function readJsonLoose(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // a broken config is an error: never overwrite something we can't parse
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Add/update (or remove) one MCP server entry in a JSON config file.
 * Returns { status: 'added'|'updated'|'unchanged'|'removed'|'absent'|'skipped', backup?, reason? }.
 */
export function applyEntry(plan, { dryRun = false, remove = false, stamp = timestamp() } = {}) {
  if (!fs.existsSync(plan.requires)) return { status: 'skipped', reason: plan.missingHint };
  let data;
  try { data = readJsonLoose(plan.file); } catch (e) {
    return { status: 'skipped', reason: `cannot parse ${plan.file} (${e.message}); fix it by hand, nothing was changed.` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'skipped', reason: `${plan.file} is not a JSON object; nothing was changed.` };
  }
  const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
  const had = Object.prototype.hasOwnProperty.call(servers, plan.key);
  let status;
  if (remove) {
    if (!had) return { status: 'absent' };
    delete servers[plan.key];
    status = 'removed';
  } else {
    if (had && sameJson(servers[plan.key], plan.entry)) return { status: 'unchanged' };
    servers[plan.key] = plan.entry;
    status = had ? 'updated' : 'added';
  }
  data.mcpServers = servers;
  if (dryRun) return { status, dryRun: true };
  return { status, backup: writeJsonWithBackup(plan.file, data, stamp) };
}

/** Back up (if present) and atomically write a JSON config. Returns the backup path or null. */
function writeJsonWithBackup(file, data, stamp) {
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-gcsa-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.gcsa-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { if (backup) fs.chmodSync(tmp, fs.statSync(backup).mode & 0o777); } catch { /* keep 0600 */ }
  fs.renameSync(tmp, file);
  return backup;
}

// ---------- Claude Code statusLine (automatic Claude usage for the dashboard) ----------

const STATUSLINE_SCRIPT = 'claude-statusline.mjs';

/** Shell-safe command for settings.json. Forward slashes work for node and for Claude Code's shell on Windows too. */
export function statusLineCommand({ node = process.execPath, root = ROOT, win = isWin } = {}) {
  const fix = (p) => (win ? p.replace(/\\/g, '/') : p);
  const q = (p) => `"${fix(p).replace(/(["\\$`])/g, '\\$1')}"`;
  return `${q(node)} ${q(path.join(root, 'scripts', STATUSLINE_SCRIPT))}`;
}

export function statusLinePlan({ home = userHome(), node = process.execPath, root = ROOT, csaHome, win = isWin } = {}) {
  const claudeDir = path.join(home, '.claude');
  const state = csaHome || (process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : stateHome());
  return {
    file: path.join(claudeDir, 'settings.json'),
    requires: claudeDir,
    chainFile: path.join(state, 'statusline-chain.json'),
    entry: { type: 'command', command: statusLineCommand({ node, root, win }), padding: 0 },
  };
}

const isOurStatusLine = (sl) => !!sl && typeof sl.command === 'string' && sl.command.includes(STATUSLINE_SCRIPT);

/**
 * Install/update/remove the GCSA statusLine in ~/.claude/settings.json.
 * A different pre-existing statusLine is saved to chainFile and still displayed (our script runs it).
 * Returns { status: 'added'|'updated'|'chained'|'unchanged'|'removed'|'restored'|'absent'|'skipped', backup?, reason? }.
 */
export function applyStatusLine(plan, { dryRun = false, remove = false, stamp = timestamp() } = {}) {
  if (!fs.existsSync(plan.requires)) return { status: 'skipped', reason: 'Claude Code does not look installed (no ~/.claude).' };
  let data;
  try { data = readJsonLoose(plan.file); } catch (e) {
    return { status: 'skipped', reason: `cannot parse ${plan.file} (${e.message}); fix it by hand, nothing was changed.` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'skipped', reason: `${plan.file} is not a JSON object; nothing was changed.` };
  }
  const cur = data.statusLine;
  let chain = null;
  try { chain = JSON.parse(fs.readFileSync(plan.chainFile, 'utf8')); } catch { /* none */ }

  if (remove) {
    if (!isOurStatusLine(cur)) return { status: 'absent' };
    let status = 'removed';
    if (chain?.original && typeof chain.original === 'object') { data.statusLine = chain.original; status = 'restored'; }
    else delete data.statusLine;
    if (dryRun) return { status, dryRun: true };
    const backup = writeJsonWithBackup(plan.file, data, stamp);
    try { fs.unlinkSync(plan.chainFile); } catch { /* none */ }
    return { status, backup };
  }

  if (isOurStatusLine(cur) && sameJson(cur, plan.entry)) return { status: 'unchanged' };
  let status = cur ? (isOurStatusLine(cur) ? 'updated' : 'chained') : 'added';
  if (dryRun) return { status, dryRun: true };
  if (status === 'chained') {
    fs.mkdirSync(path.dirname(plan.chainFile), { recursive: true });
    const command = cur && cur.type === 'command' && typeof cur.command === 'string' ? cur.command : '';
    fs.writeFileSync(plan.chainFile, JSON.stringify({ command, original: cur, saved_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  }
  data.statusLine = plan.entry;
  return { status, backup: writeJsonWithBackup(plan.file, data, stamp) };
}

// ---------- PATH (macOS / Linux) ----------
// GCSA itself never needs PATH (configs use absolute paths), but people type `node`, `npm` and `agy`.

const PATH_MARK = '# >>> GCSA PATH >>>';

/** Folders holding node / agy that are missing from PATH. */
export function missingPathDirs({ node = process.execPath, agy = firstExisting(agyCandidates()), envPath = process.env.PATH || '', home = userHome() } = {}) {
  const have = new Set(envPath.split(path.delimiter).filter(Boolean).map((d) => path.resolve(d.replace(/^~(?=\/|$)/, home))));
  const want = [];
  const nodeDir = path.dirname(node);
  // prefer ~/.local/bin when node is linked there (manual Node installs), else node's own folder
  const localBin = path.join(home, '.local', 'bin');
  const nodeVia = fs.existsSync(path.join(localBin, 'node')) ? localBin : nodeDir;
  for (const d of [nodeVia, agy ? path.dirname(agy) : null]) {
    if (d && !have.has(path.resolve(d)) && !want.includes(d)) want.push(d);
  }
  return want;
}

export function shellRcFile({ home = userHome(), shell = process.env.SHELL || '' } = {}) {
  if (/bash$/.test(shell)) return path.join(home, PLATFORM === 'darwin' ? '.bash_profile' : '.bashrc');
  if (/zsh$/.test(shell) || PLATFORM === 'darwin') return path.join(home, '.zshrc');
  return path.join(home, '.profile');
}

/** Add one marked, idempotent export line to the shell profile. */
export function ensurePathInRc(dirs, { rcFile = shellRcFile(), home = userHome(), dryRun = false, stamp = timestamp() } = {}) {
  if (!dirs.length) return { status: 'present' };
  let cur = '';
  try { cur = fs.readFileSync(rcFile, 'utf8'); } catch { /* new file */ }
  if (cur.includes(PATH_MARK)) return { status: 'present', rcFile };
  const show = (d) => (d.startsWith(home + path.sep) ? `$HOME${d.slice(home.length)}` : d);
  // Already exported by the user (e.g. export PATH="$HOME/.local/bin:$PATH")? Then don't duplicate it.
  const exported = cur.split('\n').filter((l) => /^\s*(export\s+)?PATH=/.test(l)).join('\n');
  const forms = (d) => [d, show(d), show(d).replace('$HOME', '${HOME}'), show(d).replace('$HOME', '~')];
  dirs = dirs.filter((d) => !forms(d).some((f) => exported.includes(f)));
  if (!dirs.length) return { status: 'present', rcFile };
  const block = `\n${PATH_MARK}\nexport PATH="${dirs.map(show).join(':')}:$PATH"\n# <<< GCSA PATH <<<\n`;
  if (dryRun) return { status: 'added', rcFile, dryRun: true };
  let backup = null;
  if (cur) { backup = `${rcFile}.bak-gcsa-${stamp}`; fs.copyFileSync(rcFile, backup); }
  fs.appendFileSync(rcFile, block);
  return { status: 'added', rcFile, backup };
}

// ---------- Antigravity agy CLI ----------

export const AGY_INSTALL = {
  unix: ['/bin/bash', ['-c', 'set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash']],
  win: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex']],
};

/** Install the official agy CLI if it is missing. */
function installAgyCli() {
  const before = firstExisting(agyCandidates());
  if (before) return { status: 'present', path: before };
  const [cmd, args] = isWin ? AGY_INSTALL.win : AGY_INSTALL.unix;
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, timeout: 300_000 });
  const after = firstExisting(agyCandidates());
  if (after) return { status: 'installed', path: after };
  return { status: 'failed', code: r.status, error: r.error?.message };
}

/** Warnings about where the project / Node live (lessons from real installs). */
export function locationWarnings({ root = ROOT, node = process.execPath } = {}) {
  const w = [];
  if (/OneDrive|Dropbox|Google ?Drive|CloudStorage|Mobile Documents|iCloud/i.test(root)) {
    w.push(`The project is inside a cloud-synced folder (${root}). Sync can lock or evict files while the MCP servers run; prefer a local folder such as ${path.join(userHome(), 'GCSA')}.`);
  }
  if (/[\\/](tmp|temp|scratchpad)[\\/]/i.test(node)) {
    w.push(`Node is running from a temporary folder (${node}). The app configs will point at it; install Node permanently first (nodejs.org).`);
  }
  return w;
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- side-effecting steps ----------

function npmCommand() {
  const dir = path.dirname(process.execPath);
  const cli = firstExisting([
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),            // Windows layout
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS/Linux layout
  ]);
  if (cli) return { cmd: process.execPath, pre: [cli], shell: false };
  return { cmd: 'npm', pre: [], shell: isWin };
}

function installDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk'))) return { status: 'present' };
  const { cmd, pre, shell } = npmCommand();
  const args = [...pre, fs.existsSync(path.join(ROOT, 'package-lock.json')) ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'];
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell, windowsHide: true });
  return { status: r.status === 0 ? 'installed' : 'failed', code: r.status };
}

/** Start an MCP server over stdio, run initialize + tools/list, return the tool names. */
function probeServer(file, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch {} resolve(res); };
    const t = setTimeout(() => finish({ ok: false, error: 'no answer (timeout)' }), timeoutMs);
    p.on('error', (e) => finish({ ok: false, error: e.message }));
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) finish({ ok: !!m.result, tools: (m.result?.tools || []).map((x) => x.name), error: m.error?.message });
        } catch { /* partial line */ }
      }
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gcsa-setup', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

async function environmentReport() {
  const lines = [];
  const ls = firstExisting(languageServerCandidates());
  lines.push([ls ? 'ok' : 'warn', `Antigravity desktop app: ${ls || 'not found (Desktop mode unavailable until it is installed)'}`]);
  const agy = firstExisting(agyCandidates());
  lines.push([agy ? 'ok' : 'info', `agy CLI: ${agy || 'not found (optional; "auto" uses the Desktop app)'}`]);
  const claude = firstExisting(claudeCandidates());
  lines.push([claude ? 'ok' : 'info', `claude CLI: ${claude || 'not found (needed only for the reverse direction: Antigravity asking Claude to review)'}`]);
  try {
    const { desktopPolicy } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'desktop.mjs')).href);
    const pol = desktopPolicy();
    if (pol.auto_exec) lines.push(['warn', `Antigravity runs commands automatically (${pol.policy}). Desktop jobs still run, but switching it to "Request review" in Antigravity's settings is recommended.`]);
    else lines.push(['ok', `Antigravity command policy: ${pol.policy}`]);
  } catch { /* deps not installed or app absent */ }
  return lines;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = { dryRun: false, uninstall: false, only: TARGETS, skipDeps: false, skipVerify: false, skipAgy: false, skipStatusLine: false, skipPath: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--skip-deps') o.skipDeps = true;
    else if (a === '--skip-verify') o.skipVerify = true;
    else if (a === '--skip-agy') o.skipAgy = true;
    else if (a === '--skip-statusline') o.skipStatusLine = true;
    else if (a === '--skip-path') o.skipPath = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      o.only = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = o.only.filter((t) => !TARGETS.includes(t));
      if (bad.length) throw new Error(`Unknown --only target(s): ${bad.join(', ')}. Use: ${TARGETS.join(', ')}`);
    } else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

const ICON = { ok: '✔', warn: '⚠', info: '•', fail: '✖' };
const say = (kind, msg) => console.log(`  ${ICON[kind] || '•'} ${msg}`);

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  console.log(`\nGCSA ${pkg.version} setup — ${PLATFORM}${opts.dryRun ? ' (dry run: nothing is written)' : ''}${opts.uninstall ? ' (uninstall)' : ''}\n`);

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) { say('fail', `Node ${process.versions.node} is too old; GCSA needs Node 20+ (nodejs.org).`); process.exit(1); }
  say('ok', `Node ${process.versions.node} at ${process.execPath}`);
  say('ok', `Project: ${ROOT}`);
  for (const w of locationWarnings()) say('warn', w);

  // 2. Dependencies
  if (!opts.uninstall && !opts.skipDeps && !opts.dryRun) {
    const d = installDeps();
    if (d.status === 'failed') { say('fail', `npm install failed (exit ${d.code}).`); process.exit(1); }
    say('ok', d.status === 'present' ? 'Dependencies already installed' : 'Dependencies installed');
  }

  // 3. State folder
  if (!opts.uninstall && !opts.dryRun) {
    const h = process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : stateHome();
    fs.mkdirSync(h, { recursive: true });
    say('ok', `State folder: ${h}`);
  }

  // 4. Register / unregister
  console.log(`\n${opts.uninstall ? 'Removing' : 'Registering'} MCP servers:`);
  const stamp = timestamp();
  let changed = 0;
  for (const plan of planEntries().filter((p) => opts.only.includes(p.target))) {
    const r = applyEntry(plan, { dryRun: opts.dryRun, remove: opts.uninstall, stamp });
    if (r.status === 'skipped') { say('warn', `${plan.app}: skipped — ${r.reason}`); continue; }
    if (['added', 'updated', 'removed'].includes(r.status)) changed++;
    say('ok', `${plan.app}: "${plan.key}" ${r.status}${r.dryRun ? ' (would be)' : ''} in ${plan.file}${r.backup ? `\n      backup: ${r.backup}` : ''}`);
  }

  // 5. Claude Code statusLine → automatic Claude usage on the dashboard
  if (!opts.skipStatusLine && opts.only.includes('claude-code')) {
    console.log(`\n${opts.uninstall ? 'Removing' : 'Setting'} the Claude usage statusLine:`);
    const r = applyStatusLine(statusLinePlan(), { dryRun: opts.dryRun, remove: opts.uninstall, stamp });
    if (r.status === 'skipped') say('warn', `statusLine: skipped — ${r.reason}`);
    else {
      if (['added', 'updated', 'chained', 'removed', 'restored'].includes(r.status)) changed++;
      const what = {
        added: 'added', updated: 'updated', unchanged: 'already set', absent: 'not set by GCSA (left alone)',
        removed: 'removed', restored: 'removed; your previous statusLine was restored',
        chained: 'added; your existing statusLine is kept and still shown',
      }[r.status] || r.status;
      say('ok', `Claude Code statusLine: ${what}${r.dryRun ? ' (would be)' : ''}${r.backup ? `\n      backup: ${r.backup}` : ''}`);
      if (!opts.uninstall) say('info', 'Claude Code passes your 5-hour/weekly limits to it (Pro/Max plans); the dashboard updates while you use Claude Code.');
    }
  }

  if (opts.uninstall) {
    console.log(`\nDone. Restart the apps to drop the servers. Project files and ${stateHome()} were left in place.\n`);
    return;
  }

  // 6. Verify the servers answer
  if (!opts.skipVerify && !opts.dryRun) {
    console.log('\nChecking the servers:');
    for (const f of ['claude-side.mjs', 'antigravity-side.mjs']) {
      const r = await probeServer(path.join(ROOT, 'src', 'servers', f));
      say(r.ok ? 'ok' : 'fail', `${f}: ${r.ok ? `${r.tools.length} tools` : r.error}`);
    }
  }

  // 7. agy CLI (official installer, only when missing)
  if (!opts.skipAgy && !opts.dryRun) {
    console.log('\nAntigravity agy CLI:');
    const a = installAgyCli();
    if (a.status === 'present') say('ok', `agy CLI already installed: ${a.path}`);
    else if (a.status === 'installed') say('ok', `agy CLI installed: ${a.path}`);
    else say('warn', `agy CLI could not be installed automatically (${a.error || `exit ${a.code}`}). Install it by hand: ${isWin ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash'} — GCSA still works through the Antigravity Desktop app meanwhile.`);
  }

  // 8. PATH for typing node / npm / agy in a terminal (macOS / Linux; Windows installers handle PATH)
  let pathNote = '';
  if (!isWin && !opts.skipPath) {
    const dirs = missingPathDirs();
    if (dirs.length) {
      console.log('\nTerminal PATH:');
      const r = ensurePathInRc(dirs, { dryRun: opts.dryRun, stamp });
      if (r.status === 'added') {
        say('ok', `Added ${dirs.join(', ')} to PATH in ${r.rcFile}${r.dryRun ? ' (would be)' : ''}${r.backup ? `\n      backup: ${r.backup}` : ''}`);
        pathNote = '  Open a NEW terminal window so `node`, `npm` and `agy` work there.\n';
      } else say('ok', `${r.rcFile} already adds ${dirs.join(', ')} to PATH (open a new terminal window if \`node\`/\`agy\` are not found).`);
    }
  }

  // 9. Environment
  console.log('\nEnvironment:');
  for (const [k, m] of await environmentReport()) say(k, m);

  const nodeCmd = isWin ? 'node' : `"${process.execPath}"`;
  console.log(`\nNext steps:
  1. ${changed ? 'Restart Claude Desktop and Antigravity, and open a new Claude Code session' : 'Nothing changed; restart the apps only if they were open before an earlier setup'}.
  2. Open Antigravity, then ask Claude to run agy_desktop_status.
  3. Dashboard: ${nodeCmd} dashboard/server.mjs  →  http://127.0.0.1:4317/
${pathNote}  To remove: ${nodeCmd} scripts/setup.mjs --uninstall
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`setup failed: ${e.message}`); process.exit(1); });
}
