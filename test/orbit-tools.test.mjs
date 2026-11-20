import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tools-'));
process.env.CSA_HOME = path.join(tmp, 'home');
process.env.CSA_AGENTAPI = path.join(here, 'fakes', 'orbit-fake-agentapi.mjs');
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'dummy-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.CSA_DESKTOP_POLL_MS = '100';
process.env.CSA_AG_CONFIG = path.join(here, 'fakes', 'orbit-ag-config-safe.json');

const tools = new Map();
const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
(await import('../src/tools/desktop-tools.mjs')).register(server);
(await import('../src/tools/swarm-tools.mjs')).register(server);
const text = (r) => JSON.parse(r.content[0].text);

test('all four tools are registered with english descriptions', () => {
  for (const n of ['agy_desktop_task', 'agy_desktop_status', 'agy_swarm', 'agy_swarm_status']) {
    assert.ok(tools.has(n), n);
    assert.match(tools.get(n).def.description, /^[\x20-\x7e]+$/);
  }
});

test('agy_desktop_status reports reachable', async () => {
  const r = await tools.get('agy_desktop_status').handler({});
  assert.equal(text(r).reachable, true);
});

test('agy_desktop_status unreachable has no secrets', async () => {
  process.env.FAKE_AGENTAPI_MODE = 'unavail';
  const r = await tools.get('agy_desktop_status').handler({});
  delete process.env.FAKE_AGENTAPI_MODE;
  const body = text(r);
  assert.equal(body.reachable, false);
  assert.ok(!r.content[0].text.includes('dummy-token'));
});

test('agy_desktop_task runs end to end through the runner', async () => {
  const start = text(await tools.get('agy_desktop_task').handler({ prompt: 'hi', cwd: tmp, title: 'Tool test', tier: 'deep' }));
  assert.ok(start.job_id);
  const { waitJob } = await import('../src/lib/jobs-api.mjs');
  let c;
  const deadline = Date.now() + 30000;
  do { c = await waitJob(start.job_id, 5); } while (c.state !== 'done' && c.state !== 'failed' && Date.now() < deadline);
  assert.equal(c.state, 'done', JSON.stringify(c));
  assert.equal(c.summary, 'fake agent finished');
  assert.equal(c.model, 'pro');
  assert.equal(c.conversation_id, 'conv-fake-1234');
  assert.match(c.warning, /app's own permissions/);
});

test('agy_desktop_task with bad cwd returns isError', async () => {
  const r = await tools.get('agy_desktop_task').handler({ prompt: 'hi', cwd: path.join(tmp, 'nope') });
  assert.equal(r.isError, true);
});

test('agy_swarm refuses shared edit files and returns isError', async () => {
  const r = await tools.get('agy_swarm').handler({ mode: 'split', cwd: tmp, parts: [
    { prompt: 'a', kind: 'edit', files: ['x.js'] }, { prompt: 'b', kind: 'edit', files: ['x.js'] },
  ] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /share files/);
});

test('agy_swarm_status unknown id returns isError', async () => {
  const r = await tools.get('agy_swarm_status').handler({ swarm_id: 'nope' });
  assert.equal(r.isError, true);
});
