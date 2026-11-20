import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-tools-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-twork-'));
const quotaFile = path.join(tmp, 'quota.json');
fs.writeFileSync(quotaFile, JSON.stringify({
  userStatus: {
    email: 'leak@example.com',
    planStatus: { availablePromptCredits: 10, planInfo: { planName: 'Test', monthlyPromptCredits: 20 } },
    cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 4 Neon (XHigh)', quotaInfo: { remainingFraction: 0.5, resetTime: 'r' } }] },
  },
}));

let client;

before(async () => {
  const env = {
    ...process.env,
    CSA_HOME: tmp,
    CSA_AGY_BIN: path.join(here, 'fakes', 'atlas-fake-agy.mjs'),
    CSA_QUOTA_FILE: quotaFile,
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
    ANTIGRAVITY_CSRF_TOKEN: 'test-token-not-real',
    CSA_AGENTAPI: path.join(tmp, 'no-such-agentapi.exe'),
    CSA_AG_CONFIG: path.join(here, 'fakes', 'orbit-ag-config-safe.json'),
  };
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'fakes', 'atlas-mcp-server.mjs')], env }));
});

after(async () => {
  await client?.close();
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let data = text;
  try { data = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!r.isError, data, text };
};

test('lists the nine core tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agy_approve', 'agy_cancel', 'agy_list', 'agy_messages', 'agy_models', 'agy_result', 'agy_task', 'agy_usage', 'agy_wait']);
});

test('agy_models returns tiers and quota, no account data', async () => {
  const r = await call('agy_models', {});
  assert.equal(r.isError, false);
  const neon = r.data.models.find((m) => m.id === 'gemini-4-neon-xhigh');
  assert.deepEqual(neon.tiers, ['deep']);
  assert.equal(neon.remaining_pct, 50);
  assert.ok(!r.text.includes('leak@example.com'));
});

test('task -> wait -> result -> approve -> continuation', async () => {
  const t = await call('agy_task', { prompt: 'SCENARIO:commands please check', cwd: work, kind: 'read', tier: 'balanced', title: 'T1' });
  assert.equal(t.isError, false);
  assert.ok(t.data.job_id);
  assert.equal(t.data.tier, 'balanced');
  assert.ok(t.data.model);
  assert.ok(t.data.tier_reason);

  const w = await call('agy_wait', { job_id: t.data.job_id, wait_s: 30 });
  assert.equal(w.data.state, 'done');
  assert.equal(w.data.status, 'needs_approval');
  assert.equal(w.data.commands_requested[0].command, 'Write-Output approved-ok');

  const full = await call('agy_result', { job_id: t.data.job_id, full: true });
  assert.ok(full.data.response.includes('fake answer'));

  const bad = await call('agy_approve', { job_id: t.data.job_id, indexes: [5] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /out of range/);

  const ap = await call('agy_approve', { job_id: t.data.job_id, indexes: [0] });
  assert.equal(ap.isError, false);
  assert.equal(ap.data.executed[0].exit_code, 0);
  assert.match(ap.data.executed[0].output, /approved-ok/);
  const cont = await call('agy_wait', { job_id: ap.data.continuation_job_id, wait_s: 30 });
  assert.equal(cont.data.state, 'done');
  assert.equal(cont.data.summary, 'continued with output');
  assert.equal(cont.data.conversation_id, '11111111-1111-4111-8111-111111111111');

  const t2 = await call('agy_task', { prompt: 'follow up', cwd: work, continue_job: t.data.job_id });
  const w2 = await call('agy_wait', { job_id: t2.data.job_id, wait_s: 30 });
  assert.equal(w2.data.summary, 'continued');
});

test('agy_list, agy_usage, agy_messages', async () => {
  const l = await call('agy_list', { limit: 5 });
  assert.ok(l.data.jobs.length >= 3);
  assert.ok(l.data.jobs.every((j) => j.job_id && j.state));
  const u = await call('agy_usage', {});
  assert.ok(u.data.usage.all_time.jobs >= 3);
  assert.equal(u.data.quota.plan, 'Test');
  assert.ok(!u.text.includes('leak@example.com'));
  const m = await call('agy_messages', { limit: 50 });
  assert.ok(m.data.messages.some((x) => x.kind === 'approval'));
  assert.ok(m.data.messages.some((x) => x.direction === 'antigravity->claude'));
});

test('errors use isError: secret path, unknown job, cancel', async () => {
  const gitDir = path.join(work, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  const e1 = await call('agy_task', { prompt: 'x', cwd: work, add_dirs: [gitDir] });
  assert.equal(e1.isError, true);
  assert.match(e1.text, /\.git/);
  const e2 = await call('agy_wait', { job_id: '20000101000000-aaaaaa', wait_s: 0 });
  assert.equal(e2.isError, true);
  const s = await call('agy_task', { prompt: 'SCENARIO:sleep', cwd: work });
  const c = await call('agy_cancel', { job_id: s.data.job_id });
  assert.equal(c.data.state, 'cancelled');
});
