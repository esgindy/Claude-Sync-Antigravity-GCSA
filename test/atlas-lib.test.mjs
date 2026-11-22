import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-lib-'));
process.env.CSA_HOME = tmp;
process.env.CSA_AGY_BIN = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
const quotaFile = path.join(tmp, 'quota.json');
process.env.CSA_QUOTA_FILE = quotaFile;

const safety = await import('../src/lib/safety.mjs');
const store = await import('../src/lib/store.mjs');
const { loadConfig, home } = await import('../src/lib/paths.mjs');
const messages = await import('../src/lib/messages.mjs');
const usage = await import('../src/lib/usage.mjs');
const router = await import('../src/lib/router.mjs');
const models = await import('../src/lib/models.mjs');
const quota = await import('../src/lib/quota.mjs');
const agy = await import('../src/lib/agy.mjs');

test('paths: home and config merge', () => {
  assert.equal(home, path.resolve(tmp));
  let c = loadConfig();
  assert.equal(c.max_hops, 3);
  assert.equal(c.tiers.fast[0], 'gemini-3.8-flash-low');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ max_hops: 5, tiers: { fast: ['x'] } }));
  c = loadConfig();
  assert.equal(c.max_hops, 5);
  assert.deepEqual(c.tiers.fast, ['x']);
  assert.ok(c.tiers.deep.length === 3);
  fs.rmSync(path.join(tmp, 'config.json'));
});

test('safety: redact', () => {
  const t = 'x --csrf_token abc123def456abc123def456abc123def456 y ANTIGRAVITY_CSRF_TOKEN=secretvalue1 x-codeium-csrf-token: tok999 token: 0123456789abcdef0123456789abcdef';
  const r = safety.redact(t);
  assert.ok(!r.includes('abc123def456'));
  assert.ok(!r.includes('secretvalue1'));
  assert.ok(!r.includes('tok999'));
  assert.ok(!r.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(r.includes('[REDACTED]'));
});

test('safety: secret paths', () => {
  for (const p of ['C:\\a\\config.php', '/x/.env', '/x/.env.local', 'a/b.pem', 'a/b.key', 'id_rsa', 'id_rsa.pub', 'credentials.json', 'secrets.yml', 'x.kdbx', 'repo/.git/config', 'C:\\r\\.git']) {
    assert.ok(safety.isSecretPath(p), p);
  }
  for (const p of ['src/index.js', 'README.md', 'C:\\proj\\environment.txt']) assert.ok(!safety.isSecretPath(p), p);
  const r = safety.checkPaths(['a.txt', '.env', 'k/.git/x']);
  assert.deepEqual(r.ok, ['a.txt']);
  assert.equal(r.blocked.length, 2);
  assert.ok(r.blocked[0].reason);
});

test('store: atomic json, jobs, dead runner becomes failed', () => {
  const f = path.join(tmp, 'sub', 'a.json');
  store.writeJson(f, { a: 1 });
  assert.deepEqual(store.readJson(f), { a: 1 });
  assert.equal(store.readJson(path.join(tmp, 'nope.json')), null);
  const id = store.createJob({ cwd: 'c', kind: 'edit' });
  assert.match(id, /^\d{14}-[0-9a-f]{6}$/);
  const j = store.readJob(id);
  assert.equal(j.state, 'queued');
  assert.equal(j.kind, 'edit');
  assert.equal(store.updateJob(id, { state: 'running' }).state, 'running');
  store.updateJob(id, { runner_pid: 2147483000 });
  const list = store.listJobs({ limit: 5 });
  assert.equal(list[0].id, id);
  assert.equal(list[0].state, 'failed');
  const id2 = store.createJob({});
  assert.equal(store.listJobs({ limit: 5 })[0].id, id2);
  assert.throws(() => store.jobDir('../evil'));
});

test('messages: log, redact, truncate, read', () => {
  messages.logMessage({ direction: 'claude->antigravity', channel: 'cli', kind: 'task', text: 'hi --csrf_token abcdefghijklmnop' });
  messages.logMessage({ direction: 'antigravity->claude', channel: 'cli', kind: 'reply', text: 'z'.repeat(9000) });
  const all = messages.readMessages({ limit: 10 });
  assert.equal(all.length, 2);
  assert.ok(!all[0].text.includes('abcdefghijklmnop'));
  assert.equal(all[1].text.length, 4000);
  assert.ok(all[0].ts);
  assert.equal(messages.readMessages({ limit: 1 }).length, 1);
  assert.equal(messages.readMessages({ since: '2999-01-01' }).length, 0);
});

test('usage: report', () => {
  usage.appendUsage({ job_id: 'a', model: 'm1', tier: 'fast', input_tokens: 100, output_tokens: 10, thinking_tokens: 0, total_tokens: 110, target: 'cli' });
  usage.appendUsage({ job_id: 'b', day: '2000-01-01', model: 'm2', tier: 'deep', input_tokens: 50, output_tokens: 5, total_tokens: 55, target: 'cli' });
  const r = usage.usageReport();
  assert.equal(r.today.jobs, 1);
  assert.equal(r.today.tokens, 110);
  assert.equal(r.all_time.jobs, 2);
  assert.equal(r.all_time.by_model.m2.tokens, 55);
  assert.equal(r.claude_tokens_saved_estimate, 165);
});

test('router: autoTier', () => {
  assert.equal(router.autoTier({ prompt: 'what is in this file?', kind: 'read' }).tier, 'fast');
  assert.equal(router.autoTier({ prompt: 'do a security audit of the login', kind: 'read' }).tier, 'deep');
  assert.equal(router.autoTier({ prompt: 'راجع الأمان في هذا الكود', kind: 'read' }).tier, 'deep');
  assert.equal(router.autoTier({ prompt: 'x'.repeat(7000), kind: 'read' }).tier, 'deep');
  assert.equal(router.autoTier({ prompt: 'x'.repeat(400), kind: 'read' }).tier, 'balanced');
  assert.equal(router.autoTier({ prompt: 'summary ' + 'x'.repeat(400), kind: 'read' }).tier, 'fast');
  assert.equal(router.autoTier({ prompt: 'add a button', kind: 'edit' }).tier, 'balanced');
  assert.equal(router.autoTier({ prompt: 'x'.repeat(3000), kind: 'edit' }).tier, 'deep');
});

test('router: pickModel', () => {
  const cfg = loadConfig();
  assert.equal(router.pickModel(cfg, { model: 'foo', prompt: 'x' }, {}).model, 'foo');
  const p = router.pickModel(cfg, { tier: 'fast', prompt: 'x' }, {});
  assert.equal(p.model, 'gemini-3.8-flash-low');
  const q = router.pickModel(cfg, { tier: 'fast', prompt: 'x' }, { 'gemini-3.8-flash-low': 0.02 });
  assert.equal(q.model, 'gemini-3.8-flash-medium');
  assert.match(q.reason, /low quota/);
  const all = router.pickModel(cfg, { tier: 'fast', prompt: 'x' }, { 'gemini-3.8-flash-low': 0.01, 'gemini-3.8-flash-medium': 0.05 });
  assert.equal(all.model, 'gemini-3.8-flash-medium');
  const auto = router.pickModel(cfg, { tier: 'auto', prompt: 'architecture review', kind: 'read' }, {});
  assert.equal(auto.tier, 'deep');
});

test('models: parse, list (fake agy), cache, find', async () => {
  const parsed = models.parseModels('Fetching available models...\na-1\tAlpha One\nb-2\tBeta (X)\n\n');
  assert.deepEqual(parsed, [{ id: 'a-1', label: 'Alpha One' }, { id: 'b-2', label: 'Beta (X)' }]);
  const list = await models.listModels({ refresh: true });
  assert.equal(list.length, 4);
  assert.ok(fs.existsSync(path.join(tmp, 'models-cache.json')));
  assert.equal((await models.listModels()).length, 4);
  assert.equal(models.findModel('GEMINI 4 NEON (XHIGH)', list).id, 'gemini-4-neon-xhigh');
  assert.equal(models.findModel('gemini-4-neon-xhigh', list).label, 'Gemini 4 Neon (XHigh)');
  assert.equal(models.findModel('zzz', list), null);
});

const RAW = {
  userStatus: {
    email: 'secret@example.com',
    name: 'Secret Person',
    planStatus: { availablePromptCredits: 500, availableFlowCredits: 100, planInfo: { planName: 'Pro', monthlyPromptCredits: 1000, monthlyFlowCredits: 200, teamsTier: 'x' } },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 3.8 Flash (Low)', modelOrAlias: { model: 'zzz' }, quotaInfo: { remainingFraction: 0.05, resetTime: '2026-11-21T00:00:00Z' } },
        { label: 'Gemini 4 Neon (XHigh)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-22T00:00:00Z' } },
      ],
    },
  },
};

test('quota: summarize keeps only allowed fields; file override; quotaById', async () => {
  const s = quota.summarizeStatus(RAW);
  assert.equal(s.plan, 'Pro');
  assert.deepEqual(s.credits, { prompt_available: 500, prompt_monthly: 1000, flow_available: 100, flow_monthly: 200 });
  assert.equal(s.models[0].remaining_pct, 5);
  assert.ok(!JSON.stringify(s).includes('secret'));
  fs.writeFileSync(quotaFile, JSON.stringify(RAW));
  const q = await quota.getQuota();
  assert.equal(q.models.length, 2);
  const list = await models.listModels({ refresh: true });
  const m = quota.quotaById(q, list);
  assert.equal(m['gemini-3.8-flash-low'], 0.05);
  assert.equal(m['gemini-4-neon-xhigh'], 0.8);
  assert.equal(m['gemini-3.8-flash-high'], undefined);
});

test('agy: buildAgyArgs always has --mode, never the forbidden flag', () => {
  const a = agy.buildAgyArgs({ prompt: 'p', kind: 'read', model: 'm', conversation: 'c', addDirs: ['d1', 'd2'], timeoutS: 90, schema: { type: 'object' }, allow: ['hostname'] });
  assert.equal(a[a.indexOf('--mode') + 1], 'plan');
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(a.filter((x) => x === '--add-dir').length, 2);
  assert.equal(a[a.indexOf('--print-timeout') + 1], '90s');
  assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]), { permissions: { allow: ['command(hostname)'] } });
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  assert.equal(agy.buildAgyArgs({ prompt: 'p', kind: 'edit' })[3], 'accept-edits');
  assert.ok(agy.buildAgyArgs({ prompt: 'p' }).includes('--mode'));
});

test('agy: parseStream', () => {
  const ev = [
    { event: 'init', conversation_id: 'c1', init: {} },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'whoami', Cwd: 'C:\\w' } } } },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ERROR', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'whoami', Cwd: 'C:\\w' }, error: { message: 'permission denied' } } } },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'ERROR', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { AbsolutePath: 'C:\\w\\f.txt' }, error: { message: 'permission denied' } } } },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 3, state: 'DONE', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'x' } } } },
    { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'hi' } },
  ];
  const lines = ev.map((o) => JSON.stringify(o)).join('\n') + '\nnot json\n';
  const r = agy.parseStream(lines);
  assert.equal(r.result.response, 'hi');
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.denied, [
    { tool: 'run_command', kind: 'command', target: 'whoami', cwd: 'C:\\w' },
    { tool: 'write_to_file', kind: 'file', target: 'C:\\w\\f.txt', cwd: null },
  ]);
});
