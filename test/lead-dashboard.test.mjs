import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-dash-'));
const port = 4400 + Math.floor(Math.random() * 400);
const env = { ...process.env, CSA_HOME: home, CSA_STATUS: path.join(home, 'status.json'), PORT: String(port), CSA_PROJECT: home };
let srv;

function job(sub, id, j, prompt) {
  const d = path.join(home, sub, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ id, created: new Date().toISOString(), ...j }));
  fs.writeFileSync(path.join(d, 'prompt.txt'), prompt);
}
const get = (p, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); }).on('error', reject);
});

before(async () => {
  job('jobs', '20261120000001-aaaaaa', { state: 'running', model: 'gemini-4-neon-high', target: 'cli', cwd: home }, 'preamble\nTASK:\nWrite the booking API\n');
  job('jobs', '20261120000002-bbbbbb', { state: 'done', model: 'flash', target: 'desktop', title: 'UI builder', cwd: home }, 'TASK:\nBuild the page\n');
  job('claude-jobs', '20261120000003-cccccc', { state: 'done', model: 'sonnet', kind: 'review' }, 'Review the API');
  const p = (args) => spawnSync(process.execPath, [path.join(here, '..', 'dashboard', 'progress.mjs'), ...args], { env, encoding: 'utf8' });
  assert.equal(p(['--project', 'Demo']).status, 0);
  assert.equal(p(['--add', 'gindy', 'Gindy', 'Opus 5.5', 'manager']).status, 0);
  assert.equal(p(['--task', 'gindy', 'G1', 'Plan']).status, 0);
  assert.equal(p(['gindy', 'G1', 'doing', 'planning']).status, 0);
  assert.notEqual(p(['gindy', 'G1', 'bogus']).status, 0);
  srv = spawn(process.execPath, [path.join(here, '..', 'dashboard', 'server.mjs')], { env, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await get('/api/status')).code === 200) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
});
after(() => { srv?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

test('status merges manual agents and job agents from both sides', async () => {
  const d = JSON.parse((await get('/api/status')).body);
  assert.equal(d.status.project, 'Demo');
  assert.equal(d.status.agents[0].tasks[0].state, 'doing');
  const names = d.jobAgents.map((a) => a.name);
  assert.ok(names.includes('Antigravity · gemini-4-neon-high'));
  assert.ok(names.includes('UI builder'));
  assert.ok(names.includes('Claude · sonnet'));
  const neon = d.jobAgents.find((a) => a.name === 'Antigravity · gemini-4-neon-high');
  assert.equal(neon.active, true);
  assert.equal(neon.tasks[0].title, 'Write the booking API');
  assert.equal(d.jobAgents.find((a) => a.name === 'UI builder').active, false);
  assert.equal(d.jobAgents.find((a) => a.name === 'Claude · sonnet').side, 'claude');
});

test('foreign Host header is refused and unknown paths 404', async () => {
  assert.equal((await get('/api/status', 'evil.example:80')).code, 403);
  assert.equal((await get('/../package.json')).code, 404);
  assert.equal((await get('/')).code, 200);
});
