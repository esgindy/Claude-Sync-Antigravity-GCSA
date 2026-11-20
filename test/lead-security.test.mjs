// Fixes from the second security review (N1-N5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-lead-sec-'));
const agCfg = path.join(tmp, 'ag-config.json');
process.env.CSA_HOME = path.join(tmp, 'home');
process.env.CSA_AGY_BIN = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
process.env.CSA_AG_CONFIG = agCfg;
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'lead-test-token-0123456789abcdef';
process.env.CSA_QUOTA_FILE = path.join(tmp, 'quota.json');
fs.writeFileSync(process.env.CSA_QUOTA_FILE, '{}');

const { startJob } = await import('../src/lib/jobs-api.mjs');
const { checkPaths, isTooBroad, redact } = await import('../src/lib/safety.mjs');
const { DENIED_TOOLS } = await import('../src/lib/claude.mjs');
const { discoverLs } = await import('../src/lib/desktop.mjs');
const work = fs.mkdtempSync(path.join(tmp, 'proj-'));

test('N1: startJob with target desktop is refused while the app auto-runs commands', async () => {
  fs.writeFileSync(agCfg, JSON.stringify({ userSettings: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO' } }));
  await assert.rejects(startJob({ prompt: 'hi', cwd: work, target: 'desktop' }), /without asking/);
});

test('N1: startJob refuses desktop edit jobs even when review is on', async () => {
  fs.writeFileSync(agCfg, JSON.stringify({ userSettings: { autoExecutionPolicy: 'REQUEST_REVIEW' } }));
  await assert.rejects(startJob({ prompt: 'hi', cwd: work, target: 'desktop', kind: 'edit' }), /edit jobs on the desktop/);
});

test('N2: Claude/Gemini credential locations are blocked; home and drive roots are too broad', () => {
  const blocked = checkPaths([
    path.join(work, '.claude', '.credentials.json'),
    path.join(work, '.gemini', 'config', 'config.json'),
    path.join(work, '.credentials.json'),
  ]).blocked;
  assert.equal(blocked.length, 3);
  assert.equal(isTooBroad(process.env.USERPROFILE || os.homedir()), true);
  assert.equal(isTooBroad('C:\\'), true);
  assert.equal(isTooBroad(work), false);
});

test('N3: a token supplied through env is registered for literal masking', async () => {
  await discoverLs();
  assert.equal(redact('line\nlead-test-token-0123456789abcdef\n').includes('lead-test-token-0123456789abcdef'), false);
});

test('N4: PowerShell is denied to Claude runs', () => {
  assert.ok(DENIED_TOOLS.includes('PowerShell'));
  assert.ok(DENIED_TOOLS.includes('Bash'));
});

test('M4: every agy job gets a server-issued chain id', async () => {
  fs.writeFileSync(agCfg, JSON.stringify({ userSettings: { autoExecutionPolicy: 'REQUEST_REVIEW' } }));
  const r = await startJob({ prompt: 'Reply with OK', cwd: work });
  const job = JSON.parse(fs.readFileSync(path.join(process.env.CSA_HOME, 'jobs', r.job_id, 'job.json'), 'utf8'));
  assert.match(job.chain_id, /^chain-[0-9a-f]{8}$/);
});
