import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-jobs-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-work-'));
const argLog = path.join(tmp, 'agy-args.jsonl');
process.env.CSA_HOME = tmp;
process.env.CSA_AGY_BIN = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
process.env.CSA_QUOTA_FILE = path.join(tmp, 'quota.json');
process.env.FAKE_AGY_LOG = argLog;
// Safety net: a desktop runner must never find the real Antigravity app.
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-token-not-real';
process.env.CSA_AGENTAPI = path.join(tmp, 'no-such-agentapi.mjs');
process.env.CSA_AG_CONFIG = path.join(here, 'fakes', 'orbit-ag-config-safe.json'); // never read the real app settings
fs.writeFileSync(process.env.CSA_QUOTA_FILE, JSON.stringify({
  userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3.8 Flash (Low)', quotaInfo: { remainingFraction: 0.01, resetTime: 'x' } }] } },
}));

const api = await import('../src/lib/jobs-api.mjs');
const store = await import('../src/lib/store.mjs');
const { readMessages } = await import('../src/lib/messages.mjs');
const { usageReport } = await import('../src/lib/usage.mjs');

const lastArgs = () => {
  const lines = fs.readFileSync(argLog, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).args;
};

test('read job end to end: routing skips low-quota model, uses plan mode, writes result', async () => {
  const r = await api.startJob({ prompt: 'what is here?', cwd: work, kind: 'read' });
  assert.equal(r.tier, 'fast');
  assert.equal(r.model, 'gemini-3.8-flash-medium'); // low model has 1% quota
  assert.match(r.tier_reason, /auto/);
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.state, 'done');
  assert.equal(c.status, 'done');
  assert.equal(c.summary, 'fake answer');
  assert.equal(c.conversation_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(c.usage.total_tokens, 125);
  assert.ok(c.elapsed_s >= 0);
  const a = lastArgs();
  assert.equal(a[a.indexOf('--mode') + 1], 'plan');
  assert.equal(a[a.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  assert.ok(a.includes('--json-schema'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  const prompt = a[a.indexOf('-p') + 1];
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /commands_requested/);
  const dir = store.jobDir(r.job_id);
  for (const f of ['prompt.txt', 'stdout.ndjson', 'response.txt', 'result.json', 'job.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(store.readJob(r.job_id).state, 'done');
  const msgs = readMessages({ limit: 50 }).filter((m) => m.job_id === r.job_id);
  assert.deepEqual(msgs.map((m) => m.kind), ['task', 'reply']);
  assert.equal(msgs[0].direction, 'claude->antigravity');
  assert.equal(msgs[1].direction, 'antigravity->claude');
  assert.equal(usageReport().all_time.jobs >= 1, true);
  assert.equal(api.fullResponse(r.job_id, 10).length > 0, true);
});

test('edit job uses accept-edits, explicit model by label wins', async () => {
  const r = await api.startJob({ prompt: 'add a file', cwd: work, kind: 'edit', model: 'gemini 4 neon (xhigh)' });
  assert.equal(r.model, 'gemini-4-neon-xhigh');
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.state, 'done');
  const a = lastArgs();
  assert.equal(a[a.indexOf('--mode') + 1], 'accept-edits');
  assert.match(a[a.indexOf('-p') + 1], /may create and edit files/);
});

test('unknown model is rejected', async () => {
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, model: 'nope-model' }), /Unknown model/);
});

test('commands requested -> needs_approval; denied command/file merged', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:commands SCENARIO:denied-cmd SCENARIO:denied-file', cwd: work, tier: 'balanced' });
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.status, 'needs_approval');
  assert.equal(c.state, 'done');
  assert.equal(c.commands_requested.length, 2);
  assert.equal(c.commands_requested[0].command, 'echo approved-ok');
  assert.equal(c.commands_requested[1].command, 'whoami');
  assert.deepEqual(c.denied_files, [{ tool: 'write_to_file', path: 'C:\\x\\a.txt' }]);
});

test('denied file only -> blocked', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:denied-file', cwd: work });
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.status, 'blocked');
});

test('agy crash -> failed, error redacted, no token leaks anywhere', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:crash', cwd: work });
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.state, 'failed');
  assert.equal(c.status, 'failed');
  assert.ok(!c.error.includes('abcdef0123456789abcdef0123456789'));
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : all.push(p); } };
  walk(tmp);
  for (const f of all) {
    if (f.endsWith('agy-args.jsonl')) continue;
    assert.ok(!fs.readFileSync(f, 'utf8').includes('abcdef0123456789abcdef0123456789'), f);
  }
});

test('long prompt is passed by file reference', async () => {
  const r = await api.startJob({ prompt: 'long ' + 'y'.repeat(21000), cwd: work });
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.state, 'done');
  const a = lastArgs();
  assert.match(a[a.indexOf('-p') + 1], /prompt\.txt/);
  assert.ok(a.includes(store.jobDir(r.job_id)));
});

test('continue conversation passes --conversation', async () => {
  const r = await api.startJob({ prompt: 'again', cwd: work, conversation: '22222222-2222-4222-8222-222222222222' });
  const c = await api.waitJob(r.job_id, 30);
  assert.equal(c.conversation_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(c.summary, 'continued');
  const a = lastArgs();
  assert.equal(a[a.indexOf('--conversation') + 1], '22222222-2222-4222-8222-222222222222');
});

test('secret add_dirs and bad cwd are refused', async () => {
  const secret = path.join(work, '.git');
  fs.mkdirSync(secret, { recursive: true });
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, add_dirs: [secret] }), /Refused/);
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: path.join(work, 'missing') }), /does not exist/);
  await assert.rejects(() => api.startJob({ prompt: '  ', cwd: work }), /empty/);
});

test('cancel a running job', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:sleep', cwd: work });
  const mid = await api.waitJob(r.job_id, 2);
  assert.ok(['queued', 'running'].includes(mid.state));
  const c = api.cancelJob(r.job_id);
  assert.equal(c.state, 'cancelled');
  assert.equal(store.readJob(r.job_id).state, 'cancelled');
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(store.readJob(r.job_id).state, 'cancelled');
});

test('timeout_s is stored on the job', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:sleep', cwd: work, timeout_s: 10 });
  assert.equal(store.readJob(r.job_id).timeout_s, 10);
  api.cancelJob(r.job_id);
});

test('waitJob on unknown id throws; desktop target maps tier to app alias', async () => {
  await assert.rejects(() => api.waitJob('20000101000000-aaaaaa', 0), /Unknown job/);
  const r = await api.startJob({ prompt: 'x', cwd: work, target: 'desktop', tier: 'deep' });
  assert.equal(r.model, 'pro');
  assert.equal(store.readJob(r.job_id).target, 'desktop');
  api.cancelJob(r.job_id); // never let the real desktop runner talk to the app in tests
});
