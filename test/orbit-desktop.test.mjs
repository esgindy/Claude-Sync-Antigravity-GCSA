import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-desktop-'));
const log = path.join(tmp, 'agentapi.log');
process.env.CSA_HOME = path.join(tmp, 'home');
process.env.CSA_AGENTAPI = path.join(here, 'fakes', 'orbit-fake-agentapi.mjs');
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'dummy-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.FAKE_AGENTAPI_LOG = log;
process.env.CSA_DESKTOP_POLL_MS = '100';
process.env.CSA_AG_CONFIG = path.join(here, 'fakes', 'orbit-ag-config-safe.json');

const desktop = await import('../src/lib/desktop.mjs');
const { runDesktopJob, desktopModel, DESKTOP_WARNING } = await import('../src/lib/desktop-job.mjs');

const logs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function makeCtx(name) {
  const jobDir = path.join(tmp, name);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'Do the thing');
  const msgs = [];
  let result = null;
  return {
    jobDir, msgs,
    get result() { return result; },
    writeResult: (r) => { result = r; fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify(r)); },
    logMessage: (m) => msgs.push(m),
    config: { desktop_model_map: { fast: 'flash', balanced: 'flash', deep: 'pro' }, default_timeout_s: 5 },
  };
}

test('discoverLs uses env without spawning anything', async () => {
  const r = await desktop.discoverLs();
  assert.equal(r.ANTIGRAVITY_LS_ADDRESS, '127.0.0.1:9999');
});

test('isAppRunning true with fake, false when unavailable', async () => {
  assert.equal(await desktop.isAppRunning(), true);
  process.env.FAKE_AGENTAPI_MODE = 'unavail';
  const s = await desktop.checkApp();
  delete process.env.FAKE_AGENTAPI_MODE;
  assert.equal(s.running, false);
  assert.ok(!JSON.stringify(s).includes('dummy-token'));
});

test('newConversation returns id and passes model/title', async () => {
  const id = await desktop.newConversation({ prompt: 'hello', title: 'T1', model: 'pro' });
  assert.equal(id, 'conv-fake-1234');
  const last = logs().filter((l) => l.args[0] === 'new-conversation').pop();
  assert.deepEqual(last.args.slice(0, 3), ['new-conversation', '--model=pro', '--title=T1']);
  assert.equal(last.has_token, true);
});

test('redactText masks tokens', () => {
  const s = desktop.redactText('x --csrf_token abc123def ANTIGRAVITY_CSRF_TOKEN=zzz9 x-codeium-csrf-token: q1w2');
  assert.ok(!/abc123def|zzz9|q1w2/.test(s));
});

test('parseScanOutput keeps only hub processes and extracts token/ports', () => {
  const json = JSON.stringify([
    { pid: 1, cmd: 'language_server.exe --subclient_type hub --csrf_token tok-hub', ports: [1234, 5678] },
    { pid: 2, cmd: 'language_server.exe --subclient_type other --csrf_token tok-x', ports: 99 },
    { pid: 3, cmd: 'language_server.exe --subclient_type hub', ports: [1] },
  ]);
  const r = desktop.parseScanOutput(json);
  assert.deepEqual(r, [{ token: 'tok-hub', ports: [1234, 5678] }]);
});

test('runDesktopJob new conversation: result, warning, messages', async () => {
  const ctx = makeCtx('job1');
  const r = await runDesktopJob({ id: 'j1', tier: 'deep', title: 'My title', timeout_s: 5 }, ctx);
  assert.equal(r.status, 'done');
  assert.equal(r.summary, 'fake agent finished');
  assert.equal(r.conversation_id, 'conv-fake-1234');
  assert.equal(r.warning, DESKTOP_WARNING);
  assert.equal(r.model, 'pro');
  assert.deepEqual(r.files_changed, ['a.txt']);
  assert.equal(ctx.msgs[0].direction, 'claude->antigravity');
  assert.equal(ctx.msgs[0].channel, 'desktop');
  assert.equal(ctx.msgs[1].direction, 'antigravity->claude');
  assert.ok(fs.existsSync(path.join(ctx.jobDir, 'result.json')));
  const call = logs().filter((l) => l.args[0] === 'new-conversation').pop();
  assert.ok(call.args.includes('--title=My title'));
  assert.ok(call.args.at(-1).includes(path.resolve(ctx.jobDir, 'agent_result.json')));
});

test('runDesktopJob default title and delayed result', async () => {
  process.env.FAKE_AGENTAPI_DELAY_MS = '600';
  const ctx = makeCtx('job2');
  const r = await runDesktopJob({ id: 'j2', tier: 'fast', timeout_s: 10 }, ctx);
  delete process.env.FAKE_AGENTAPI_DELAY_MS;
  assert.equal(r.status, 'done');
  assert.equal(r.model, 'flash');
  const call = logs().filter((l) => l.args[0] === 'new-conversation').pop();
  assert.ok(call.args.includes('--title=Claude task'));
});

test('runDesktopJob existing conversation uses send-message', async () => {
  const ctx = makeCtx('job3');
  const r = await runDesktopJob({ id: 'j3', tier: 'balanced', conversation_id: '11111111-2222-3333-4444-555555555555', timeout_s: 5 }, ctx);
  assert.equal(r.status, 'done');
  assert.equal(r.conversation_id, '11111111-2222-3333-4444-555555555555');
  const call = logs().filter((l) => l.args[0] === 'send-message').pop();
  assert.ok(call.args.includes('11111111-2222-3333-4444-555555555555'));
});

test('runDesktopJob times out with failed result', async () => {
  process.env.FAKE_AGENTAPI_MODE = 'never';
  const ctx = makeCtx('job4');
  await runDesktopJob({ id: 'j4', tier: 'fast', timeout_s: 1 }, ctx);
  delete process.env.FAKE_AGENTAPI_MODE;
  assert.equal(ctx.result.state, 'failed');
  assert.equal(ctx.result.status, 'failed');
  assert.match(ctx.result.error, /Timed out/);
  assert.equal(ctx.result.warning, DESKTOP_WARNING);
});

test('runDesktopJob app unreachable gives failed result without secrets', async () => {
  process.env.FAKE_AGENTAPI_MODE = 'unavail';
  const ctx = makeCtx('job5');
  await runDesktopJob({ id: 'j5', tier: 'fast', timeout_s: 2 }, ctx);
  delete process.env.FAKE_AGENTAPI_MODE;
  assert.equal(ctx.result.status, 'failed');
  assert.ok(!JSON.stringify(ctx.result).includes('dummy-token'));
});

test('desktopModel mapping', () => {
  const cfg = { desktop_model_map: { fast: 'flash', balanced: 'flash', deep: 'pro' } };
  assert.equal(desktopModel({ tier: 'deep', model: 'gemini-4-neon-high', tier_reason: 'auto' }, cfg), 'pro');
  assert.equal(desktopModel({ tier: 'deep', model: 'gemini-4-neon-high', tier_reason: 'explicit model' }, cfg), 'gemini-4-neon-high');
  assert.equal(desktopModel({ tier: 'fast' }, cfg), 'flash');
});
