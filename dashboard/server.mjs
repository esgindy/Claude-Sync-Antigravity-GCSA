#!/usr/bin/env node
// Local live dashboard. Zero model tokens: it only reads files.
// Serves the page, /api/status (dashboard/status.json + git commits + message log tail).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 4317);
const csaHome = process.env.CSA_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'claude-sync-antigravity');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function commits() {
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'log', '--pretty=format:%h|%ad|%s', '--date=format:%H:%M', '-n', '30'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => { const [hash, time, ...s] = l.split('|'); return { hash, time, subject: s.join('|') }; });
}

function messages() {
  try {
    return fs.readFileSync(path.join(csaHome, 'messages.jsonl'), 'utf8').trim().split('\n').slice(-60).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function files() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dashboard'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  try { walk(root); } catch { /* ignore */ }
  return out;
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/status')) {
    const body = JSON.stringify({ status: readJson(path.join(here, 'status.json')), commits: commits(), messages: messages(), files: files(), now: new Date().toISOString() });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(here, 'index.html')));
}).listen(port, '127.0.0.1', () => console.log(`dashboard on http://127.0.0.1:${port}`));
