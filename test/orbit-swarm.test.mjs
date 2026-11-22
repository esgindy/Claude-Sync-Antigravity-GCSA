import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-swarm-'));
const homeDir = path.join(tmp, 'home');
fs.mkdirSync(homeDir, { recursive: true });
fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ swarm_max_parallel: 2 }));
process.env.CSA_HOME = homeDir;
process.env.CSA_AGENTAPI = path.join(here, 'fakes', 'orbit-fake-agentapi.mjs');
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'dummy-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.CSA_DESKTOP_POLL_MS = '100';
process.env.CSA_AG_CONFIG = path.join(here, 'fakes', 'orbit-ag-config-safe.json');
process.env.CSA_SWARM_TICK_MS = '200';

const swarm = await import('../src/lib/swarm.mjs');
const messages = await import('../src/lib/messages.mjs');

// Fake jobs API used for the scheduling unit tests.
function makeFakeApi() {
  const jobs = new Map();
  let n = 0;
  return {
    jobs,
    async startJob(input) {
      const id = `job-${++n}`;
      jobs.set(id, { input, state: 'running' });
      return { job_id: id, model: input.model || 'm-' + (input.tier || 'auto'), tier: input.tier || 'balanced', tier_reason: 'fake' };
    },
    getCompact(id) {
      const j = jobs.get(id);
      return { job_id: id, state: j.state, status: j.state === 'done' ? 'done' : j.state, summary: j.state === 'done' ? `summary of ${id}` : '' };
    },
  };
}

test('split: queues beyond swarm_max_parallel and starts the rest as jobs finish', async () => {
  const api = makeFakeApi();
  swarm.setDeps({ jobsApi: api });
  const r = await swarm.startSwarm({
    mode: 'split', cwd: tmp, title: 'T',
    parts: [1, 2, 3, 4, 5].map((i) => ({ prompt: `part ${i}`, tier: 'fast' })),
  });
  assert.match(r.swarm_id, /^sw-\d{14}-[0-9a-f]{6}$/);
  assert.equal(r.jobs.length, 2);
  assert.equal(r.queued, 3);
  let st = await swarm.swarmStatus(r.swarm_id);
  assert.equal(st.state, 'running');
  assert.equal(st.parts.filter((p) => p.state === 'queued').length, 3);
  assert.equal(api.jobs.size, 2);

  api.jobs.get('job-1').state = 'done';
  st = await swarm.swarmStatus(r.swarm_id);
  assert.equal(api.jobs.size, 3);
  assert.equal(st.parts[0].summary, 'summary of job-1');

  for (const j of api.jobs.values()) j.state = 'done';
  await swarm.swarmStatus(r.swarm_id);
  for (const j of api.jobs.values()) j.state = 'done';
  await swarm.swarmStatus(r.swarm_id);
  for (const j of api.jobs.values()) j.state = 'done';
  st = await swarm.swarmStatus(r.swarm_id);
  assert.equal(api.jobs.size, 5);
  assert.equal(st.state, 'done');
  assert.ok(fs.existsSync(path.join(homeDir, 'swarms', `${r.swarm_id}.json`)));
  // concurrency never exceeded 2 at any status check (checked implicitly by sizes above)
  const all = messages.readMessages({ limit: 0 }).filter((m) => m.text.startsWith(`Swarm ${r.swarm_id}`));
  assert.equal(all.length, 5);
});

test('background tick starts queued parts without a status call', async () => {
  const api = makeFakeApi();
  swarm.setDeps({ jobsApi: api });
  const r = await swarm.startSwarm({ mode: 'split', cwd: tmp, parts: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] });
  assert.equal(api.jobs.size, 2);
  api.jobs.get('job-1').state = 'done';
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(api.jobs.size, 3);
  for (const j of api.jobs.values()) j.state = 'done';
  assert.equal((await swarm.swarmStatus(r.swarm_id)).state, 'done');
});

test('parallel edit parts sharing a file are refused', async () => {
  const api = makeFakeApi();
  swarm.setDeps({ jobsApi: api });
  await assert.rejects(
    swarm.startSwarm({ mode: 'split', cwd: tmp, parts: [
      { prompt: 'a', kind: 'edit', files: ['src/a.js', 'src/b.js'] },
      { prompt: 'b', kind: 'edit', files: [process.platform === 'win32' ? 'SRC\\B.js' : (process.platform === 'darwin' ? 'SRC/B.js' : 'src/./b.js')] },
    ] }),
    /both list/,
  );
  assert.equal(api.jobs.size, 0);
  // read parts may overlap; disjoint edits are fine
  await swarm.startSwarm({ mode: 'split', cwd: tmp, parts: [
    { prompt: 'a', kind: 'edit', files: ['a.js'] },
    { prompt: 'b', kind: 'edit', files: ['b.js'] },
    { prompt: 'c', kind: 'read', files: ['a.js'] },
  ] });
  const prompts = [...api.jobs.values()].map((j) => j.input.prompt);
  assert.ok(prompts[0].includes('a.js'));
});

test('secret files are refused', async () => {
  swarm.setDeps({ jobsApi: makeFakeApi() });
  await assert.rejects(
    swarm.startSwarm({ mode: 'split', cwd: tmp, parts: [{ prompt: 'x', kind: 'edit', files: ['.env'] }] }),
    /secret/,
  );
});

test('compare: same prompt on distinct models, read-only', async () => {
  const api = makeFakeApi();
  swarm.setDeps({ jobsApi: api });
  const r = await swarm.startSwarm({ mode: 'compare', cwd: tmp, prompt: 'who wins?', models: ['model-a', 'model-b'] });
  assert.equal(r.jobs.length, 2);
  const inputs = [...api.jobs.values()].map((j) => j.input);
  assert.deepEqual(inputs.map((i) => i.model), ['model-a', 'model-b']);
  assert.ok(inputs.every((i) => i.prompt === 'who wins?' && i.kind === 'read' && i.swarm_id === r.swarm_id));
  await assert.rejects(swarm.startSwarm({ mode: 'compare', cwd: tmp, prompt: 'p', models: ['one'] }), /2-3/);
  await assert.rejects(swarm.startSwarm({ mode: 'compare', cwd: tmp, prompt: 'p', models: ['x', 'X'] }), /different/);
  await assert.rejects(swarm.startSwarm({ mode: 'compare', cwd: tmp, prompt: 'p', models: ['a', 'b'], parts: [{ prompt: 'p', kind: 'edit' }] }), /read-only/);
});

test('a failing startJob marks only that part failed', async () => {
  const api = makeFakeApi();
  const orig = api.startJob;
  api.startJob = async (input) => { if (input.prompt === 'bad') throw new Error('cwd does not exist'); return orig(input); };
  swarm.setDeps({ jobsApi: api });
  const r = await swarm.startSwarm({ mode: 'split', cwd: tmp, parts: [{ prompt: 'good' }, { prompt: 'bad' }] });
  for (const j of api.jobs.values()) j.state = 'done';
  const st = await swarm.swarmStatus(r.swarm_id);
  assert.equal(st.state, 'partial');
  assert.equal(st.parts[1].state, 'failed');
  assert.match(st.parts[1].error, /cwd/);
});

test('invalid swarm id and unknown swarm', async () => {
  swarm.setDeps({ jobsApi: makeFakeApi() });
  await assert.rejects(swarm.swarmStatus('../../etc/passwd'), /Invalid/);
  await assert.rejects(swarm.swarmStatus('sw-20200101000000-abcdef'), /not found/);
});

test('integration: desktop-target swarm with real jobs-api and fake agentapi', async () => {
  swarm.setDeps({});
  const r = await swarm.startSwarm({
    mode: 'split', cwd: tmp, target: 'desktop', title: 'Int',
    parts: [{ prompt: 'one', tier: 'fast' }, { prompt: 'two', tier: 'deep' }, { prompt: 'three', tier: 'fast' }],
  });
  assert.equal(r.jobs.length, 2);
  let st;
  const deadline = Date.now() + 40000;
  do {
    await new Promise((res) => setTimeout(res, 400));
    st = await swarm.swarmStatus(r.swarm_id);
  } while (st.state === 'running' && Date.now() < deadline);
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.equal(st.parts.length, 3);
  assert.ok(st.parts.every((p) => p.summary === 'fake agent finished' && p.warning));
  assert.deepEqual(st.parts.map((p) => p.model), ['flash', 'pro', 'flash']);
});
