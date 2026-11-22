import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-sec-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-secwork-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-secout-'));
const argLog = path.join(tmp, 'args.jsonl');
process.env.CSA_HOME = tmp;
process.env.CSA_AGY_BIN = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
process.env.CSA_QUOTA_FILE = path.join(tmp, 'quota.json');
fs.writeFileSync(process.env.CSA_QUOTA_FILE, JSON.stringify({ plan: 'x', models: [] }));
process.env.FAKE_AGY_LOG = argLog;
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'zzTOKENzz-not-real-0001';
process.env.CSA_AGENTAPI = path.join(tmp, 'no-such-agentapi.exe');
process.env.CSA_AG_CONFIG = path.join(here, 'fakes', 'orbit-ag-config-safe.json');

const safety = await import('../src/lib/safety.mjs');
const api = await import('../src/lib/jobs-api.mjs');
const store = await import('../src/lib/store.mjs');
const messages = await import('../src/lib/messages.mjs');
const usage = await import('../src/lib/usage.mjs');
const agy = await import('../src/lib/agy.mjs');
const tools = await import('../src/tools/core-tools.mjs');

const setConfig = (o) => fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(o));
const lastEntry = () => { const l = fs.readFileSync(argLog, 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };

// ---- M1 ----
test('M1: path bypass strings are blocked', () => {
  const bad = [
    'config.php.', 'config.php ', 'config.php::$DATA', '.git./config', '.git /config', 'C:\\Users\\x\\.ssh', 'C:\\Users\\x\\.ssh\\id_x',
    'wp-config.php', '.git-credentials', '.npmrc', '.netrc', 'a\\Secrets.TXT', 'A\\.ENV', 'k.PFX', 'k.p12', 'id_ed25519', 'id_ecdsa.pub',
    'C:\\u\\.aws\\credentials', 'C:\\u\\.GnuPG\\x', 'C:\\u\\.kube\\config', 'C:\\u\\.docker\\c', 'C:\\u\\.azure\\x', '\\\\?\\C:\\u\\.ssh',
  ];
  for (const p of bad) assert.ok(safety.isSecretPath(p), p);
  for (const p of ['src\\app.js', 'C:\\proj\\notes.txt', 'environment.txt']) assert.ok(!safety.isSecretPath(p), p);
  const r = safety.checkPaths(['ok.txt', '.git./config', 'x.pem']);
  assert.deepEqual(r.ok, ['ok.txt']);
  assert.equal(r.blocked.length, 2);
});

test('M1: csa home dir is blocked; realpath follows 8.3 names', () => {
  assert.ok(safety.isSecretPath(path.join(tmp, 'jobs', 'x')));
  const real = fs.realpathSync.native(work);
  assert.equal(safety.resolveSafe(work).toLowerCase(), real.toLowerCase());
});

test('M1: symlink to a secret dir is caught', (t) => {
  const sshDir = path.join(outside, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const link = path.join(work, 'innocent');
  try { fs.symlinkSync(sshDir, link, 'junction'); } catch { t.skip('cannot create junction'); return; }
  assert.ok(safety.isSecretPath(link));
});

test('M1: jobs-api enforces checkPaths and allowed_roots', async () => {
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, add_dirs: [path.join(work, '.git.')] }), /Refused|does not exist/);
  fs.mkdirSync(path.join(work, '.git'), { recursive: true });
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, add_dirs: [path.join(work, '.git.')] }), /Refused/);
  setConfig({ allowed_roots: [work] });
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: outside }), /allowed_roots/);
  const sub = path.join(work, 'sub');
  fs.mkdirSync(sub);
  const r = await api.startJob({ prompt: 'x', cwd: sub, tier: 'fast' });
  await api.waitJob(r.job_id, 30);
  setConfig({});
});

// ---- M2 ----
test('M2: registerSecret, JSON forms, childEnv', () => {
  safety.registerSecret('S3cr3t-Value-XYZ');
  assert.ok(!safety.redact('out: S3cr3t-Value-XYZ end S3cr3t-Value-XYZ').includes('S3cr3t'));
  const j = safety.redact('{"ANTIGRAVITY_CSRF_TOKEN":"abc def","x-codeium-csrf-token": "tok1","other":"keep"}');
  assert.ok(!j.includes('abc def') && !j.includes('tok1'));
  assert.ok(j.includes('keep'));
  const env = safety.childEnv({ CSA_HOP: 2, GONE: undefined });
  assert.ok(!Object.keys(env).some((k) => /^ANTIGRAVITY_/i.test(k)));
  assert.equal(env.CSA_HOP, '2');
});

test('M2: agy child gets no ANTIGRAVITY_* env', async () => {
  const r = await api.startJob({ prompt: 'hello', cwd: work, tier: 'fast' });
  await api.waitJob(r.job_id, 30);
  assert.deepEqual(lastEntry().env.ag, []);
});

// ---- M4, L1, L4 ----
test('M4: timeout clamp, model/conversation validation', async () => {
  const r = await api.startJob({ prompt: 'x', cwd: work, timeout_s: 999999, tier: 'fast' });
  assert.equal(store.readJob(r.job_id).timeout_s, 3600);
  await api.waitJob(r.job_id, 30);
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, model: 'bad;model$(x)' }), /Invalid model/);
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work, conversation: '../../etc' }), /Invalid conversation/);
});

test('M4: CSA_CHAIN_ID is stamped and passed on with hop+1', async () => {
  process.env.CSA_CHAIN_ID = 'chain-7';
  process.env.CSA_HOP = '1';
  try {
    const r = await api.startJob({ prompt: 'chain', cwd: work, tier: 'fast' });
    const j = store.readJob(r.job_id);
    assert.equal(j.chain_id, 'chain-7');
    assert.equal(j.hop, 1);
    await api.waitJob(r.job_id, 30);
    const e = lastEntry();
    assert.equal(e.env.chain, 'chain-7');
    assert.equal(e.env.hop, '2');
  } finally {
    delete process.env.CSA_CHAIN_ID;
    delete process.env.CSA_HOP;
  }
});

// ---- M5 ----
test('M5: approve refuses outside cwd and re-run, records approved_executed', async () => {
  const r = await api.startJob({ prompt: 'SCENARIO:commands', cwd: work, tier: 'fast' });
  await api.waitJob(r.job_id, 30);
  const resFile = path.join(store.jobDir(r.job_id), 'result.json');
  const res = store.readJson(resFile);
  res.commands_requested.push({ command: 'echo evil', cwd: outside, reason: '' });
  res.commands_requested.push({ command: 'echo rel', cwd: '..', reason: '' });
  store.writeJson(resFile, res);
  const a = await tools.approveJob({ job_id: r.job_id, indexes: [0, 1, 2] });
  assert.deepEqual(a.executed.map((e) => e.index), [0]);
  assert.deepEqual(a.refused.map((e) => e.index), [1, 2]);
  assert.deepEqual(store.readJson(resFile).approved_executed, [0]);
  const b = await tools.approveJob({ job_id: r.job_id, indexes: [0] }).catch((e) => e);
  assert.equal(b.continuation_job_id, null);
  assert.match(b.refused[0].reason, /already executed/);
  const c = await tools.approveJob({ job_id: r.job_id, indexes: [0], rerun: true });
  assert.equal(c.executed.length, 1);
  await api.waitJob(a.continuation_job_id, 30);
});

// ---- L2 ----
test('L2: output cap keeps the tail and kills the process', async () => {
  const code = "const s='x'.repeat(100000);let n=0;const t=setInterval(()=>{process.stdout.write(s);if(++n>200)process.exit(0)},1);";
  const r = await agy.runProcess(process.execPath, ['-e', code], { capBytes: 500000, timeoutMs: 20000 });
  assert.equal(r.capped, true);
  assert.ok(r.stdout.length <= 500000);
});

// ---- L4 / L6 ----
test('L4: by_model has no prototype', () => {
  usage.appendUsage({ model: '__proto__', input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  usage.appendUsage({ model: 'constructor', input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  const r = usage.usageReport();
  assert.equal(Object.getPrototypeOf(r.all_time.by_model), null);
  assert.equal(r.all_time.by_model['__proto__'].jobs, 1);
  assert.equal(r.all_time.by_model.constructor.jobs, 1);
});

test('L6: logs rotate at 5 MB, summary survives, readMessages reads the tail', () => {
  const uf = usage.usageFile();
  fs.appendFileSync(uf, ' '.repeat(5 * 1024 * 1024 + 10));
  const before = usage.usageReport().all_time.jobs;
  usage.appendUsage({ model: 'm', input_tokens: 5, output_tokens: 5, total_tokens: 10 });
  assert.ok(fs.existsSync(uf + '.1'));
  assert.ok(fs.statSync(uf).size < 1000);
  assert.equal(usage.usageReport().all_time.jobs, before + 1);
  assert.ok(fs.existsSync(path.join(tmp, 'usage-summary.json')));

  const mf = messages.messagesFile();
  fs.writeFileSync(mf, '');
  for (let i = 0; i < 3; i++) messages.logMessage({ direction: 'claude->antigravity', channel: 'cli', kind: 'task', text: `old${i}` });
  const big = JSON.stringify({ ts: '2000-01-01T00:00:00.000Z', text: 'o'.repeat(3900) }) + '\n';
  fs.appendFileSync(mf, big.repeat(100)); // ~400 KB, older than the tail window? no: appended after, so tail is these
  messages.logMessage({ direction: 'claude->antigravity', channel: 'cli', kind: 'task', text: 'newest' });
  const all = messages.readMessages({ limit: 0 });
  assert.ok(all.length < 103 && all.length > 10);
  assert.equal(all[all.length - 1].text, 'newest');
  assert.ok(!all.some((m) => m.text === 'old0'));
  fs.writeFileSync(mf, ' '.repeat(5 * 1024 * 1024 + 10));
  messages.logMessage({ direction: 'claude->antigravity', channel: 'cli', kind: 'task', text: 'after-rotate' });
  assert.ok(fs.existsSync(mf + '.1'));
  assert.equal(messages.readMessages({ limit: 5 }).at(-1).text, 'after-rotate');
});

// ---- daily cap (last: it changes config) ----
test('M4: daily_max_jobs is enforced', async () => {
  const n = api.jobsStartedToday();
  setConfig({ daily_max_jobs: n });
  await assert.rejects(() => api.startJob({ prompt: 'x', cwd: work }), /Daily job limit/);
  setConfig({ daily_max_jobs: n + 1000 });
  const r = await api.startJob({ prompt: 'x', cwd: work, tier: 'fast' });
  await api.waitJob(r.job_id, 30);
  setConfig({});
});
