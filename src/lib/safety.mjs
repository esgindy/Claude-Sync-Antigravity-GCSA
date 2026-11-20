// Secret-file filter, redaction and child-process environment.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { home } from './paths.mjs';

const MASK = '[REDACTED]';

// ---------- redaction ----------
const secrets = new Set();

/** Register an exact secret value; redact() will mask it literally from now on (in-memory only). */
export function registerSecret(value) {
  const v = String(value ?? '');
  if (v.length >= 6) secrets.add(v);
}

export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const v of secrets) {
    if (s.includes(v)) s = s.split(v).join(MASK);
  }
  // JSON forms: "ANTIGRAVITY_CSRF_TOKEN":"x", "x-codeium-csrf-token":"x", "csrf_token":"x"
  s = s.replace(/("(?:ANTIGRAVITY_CSRF_TOKEN|x-codeium-csrf-token|csrf[_-]?token)"\s*:\s*")[^"]*/gi, `$1${MASK}`);
  s = s.replace(/(--csrf[_-]token(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`);
  s = s.replace(/(ANTIGRAVITY_CSRF_TOKEN\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`);
  s = s.replace(/(x-codeium-csrf-token\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`);
  s = s.replace(/(token["']?\s*[:=]?\s*["']?)([0-9a-fA-F][0-9a-fA-F-]{30,})/gi, `$1${MASK}`);
  return s;
}

/** Environment for child processes: no ANTIGRAVITY_* variables. `extra` is merged on top. */
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^ANTIGRAVITY_/i.test(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// ---------- secret paths ----------
const BLOCKED_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.claude', '.gemini']);
const NAME_PATTERNS = [
  /^\.credentials\.json$/,
  /^\.env/,
  /config\.php$/,
  /\.pem$/,
  /\.key$/,
  /\.pfx$/,
  /\.p12$/,
  /^id_/,
  /^\.git-credentials$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^credentials/,
  /^secrets/,
  /\.kdbx$/,
];

/** True for a drive root, the user profile folder, or any folder above it: too broad to hand to an agent. */
export function isTooBroad(p) {
  const norm = path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(norm)) return true;
  const home = path.resolve(process.env.USERPROFILE || os.homedir()).replace(/[\\/]+$/, '').toLowerCase();
  return home === norm || home.startsWith(norm + path.sep);
}

function stripSeg(seg) {
  return seg.replace(/[. ]+$/, '');
}

/** Real path of p, or of its nearest existing ancestor plus the rest. */
function realish(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Returns {path, reason}. reason is set when the path is blocked. path is the normalised real path. */
function inspect(p) {
  const raw = String(p ?? '');
  if (!raw.trim()) return { path: raw, reason: 'empty path' };
  let s = raw.replace(/^\\\\\?\\/, '');
  // Any colon after the drive letter means an NTFS alternate data stream (or an invalid path).
  const drive = /^[A-Za-z]:/.test(s) ? 2 : 0;
  if (s.indexOf(':', drive) !== -1) return { path: raw, reason: 'path contains ":" (alternate data stream)' };
  let abs = path.resolve(s);
  abs = realish(abs);
  const parsed = path.parse(abs);
  const segs = abs.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean).map(stripSeg).filter(Boolean);
  const norm = path.join(parsed.root, ...segs);
  for (const seg of segs) {
    if (BLOCKED_DIRS.has(seg.toLowerCase())) return { path: norm, reason: `path is inside ${seg.toLowerCase()}` };
  }
  const base = (segs[segs.length - 1] || '').toLowerCase();
  if (NAME_PATTERNS.some((re) => re.test(base))) return { path: norm, reason: `file name "${base}" looks like a secret file` };
  const lower = norm.toLowerCase();
  const homes = [path.resolve(home), realish(path.resolve(home))].map((x) => x.toLowerCase());
  if (homes.some((h) => lower === h || lower.startsWith(h + path.sep))) return { path: norm, reason: 'path is inside the claude-sync-antigravity state directory' };
  return { path: norm, reason: null };
}

export function resolveSafe(p) {
  return inspect(p).path;
}

export function secretReason(p) {
  return inspect(p).reason;
}

export function isSecretPath(p) {
  return inspect(p).reason !== null;
}

export function checkPaths(paths) {
  const ok = [];
  const blocked = [];
  for (const p of paths || []) {
    const r = inspect(p).reason;
    if (r) blocked.push({ path: p, reason: r });
    else ok.push(p);
  }
  return { ok, blocked };
}

/** True when child is the same as, or inside, parent (both normalised, case-insensitive). */
export function isInside(child, parent) {
  const c = resolveSafe(child).toLowerCase();
  const p = resolveSafe(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
