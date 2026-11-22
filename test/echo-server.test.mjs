import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'echo-srv-'));
const home = join(tmp, 'home');
const work = join(tmp, 'work');
const log = join(tmp, 'calls.jsonl');
mkdirSync(work);
writeFileSync(join(work, 'a.js'), 'console.log("hi")\n');
writeFileSync(join(work, '.env'), 'SECRET=1\n');
writeFileSync(join(tmp, 'outside.txt'), 'x');
const fake = resolve('test/fakes/echo-fake-claude.mjs');
const server = resolve('src/servers/antigravity-side.mjs');
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ claude_max_parallel: 50 })); // tests fire many jobs at once

let client;
async function connect(mode) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server],
    env: { ...process.env, CSA_HOME: home, CSA_CLAUDE_BIN: fake, ECHO_FAKE_LOG: log, ECHO_FAKE_MODE: mode },
  });
  const c = new Client({ name: 'echo-test', version: '1' });
  await c.connect(transport);
  return c;
}
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { isError: !!r.isError, text: t, json: j };
};
async function finish(job_id) {
  for (let i = 0; i < 20; i++) {
    const w = await call('claude_wait', { job_id, wait_s: 5 });
    if (w.json.state !== 'running' && w.json.state !== 'queued') return w.json;
  }
  throw new Error('job did not finish');
}
const msgs = () => readFileSync(join(home, 'messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(async () => { client = await connect('changes'); });
after(async () => { await client.close(); });

test('lists the four tools and instructions', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['claude_result', 'claude_review', 'claude_task', 'claude_wait']);
  assert.match(client.getInstructions(), /HOP LIMIT/);
});

test('claude_review: verdict changes, files vetted, messages logged', async () => {
  const s = await call('claude_review', { goal: 'g', summary: 's', files_changed: ['a.js', '.env', '../outside.txt'], cwd: work });
  assert.equal(s.isError, false);
  assert.equal(s.json.hop, 1);
  assert.equal(s.json.skipped_files.length, 2);
  const r = await finish(s.json.job_id);
  assert.equal(r.state, 'done');
  assert.equal(r.verdict, 'changes');
  assert.deepEqual(r.required_changes, ['fix x', 'add test']);
  const full = await call('claude_result', { job_id: s.json.job_id });
  assert.equal(full.json.session_id, 'fake-session-1');
  const call0 = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.ok(call0.args.includes('plan'));
  assert.ok(call0.stdin.includes('console.log("hi")'));
  assert.ok(!call0.stdin.includes('SECRET=1'));
  const m = msgs().filter((x) => x.job_id === s.json.job_id);
  assert.equal(m[0].direction, 'antigravity->claude');
  assert.equal(m[0].channel, 'claude-cli');
  assert.equal(m[1].direction, 'claude->antigravity');
  assert.match(m[1].text, /changes/);
});

test('claude_task read-only uses plan mode; allow_edits uses acceptEdits', async () => {
  const a = await call('claude_task', { task: 'audit this', cwd: work });
  await finish(a.json.job_id);
  let c = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.ok(c.args.includes('plan'));
  const b = await call('claude_task', { task: 'fix it', cwd: work, allow_edits: true });
  await finish(b.json.job_id);
  c = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.ok(c.args.includes('acceptEdits'));
  assert.equal(c.args[c.args.indexOf('--allowedTools') + 1].includes('Bash'), false);
});

test('hop limit refuses the fourth call in a chain', async () => {
  const first = await call('claude_task', { task: 't1', cwd: work });
  const chain = first.json.chain_id;
  assert.equal((await call('claude_task', { task: 't2', cwd: work, chain_id: chain })).json.hop, 2);
  assert.equal((await call('claude_task', { task: 't3', cwd: work, chain_id: chain })).json.hop, 3);
  const r = await call('claude_task', { task: 't4', cwd: work, chain_id: chain });
  assert.equal(r.isError, true);
  assert.match(r.text, /Hop limit reached/);
});

test('errors: unknown job, bad cwd', async () => {
  assert.equal((await call('claude_wait', { job_id: 'nope', wait_s: 0 })).isError, true);
  assert.equal((await call('claude_result', { job_id: '20200101000000-abcdef' })).isError, true);
  assert.equal((await call('claude_task', { task: 't', cwd: join(tmp, 'missing') })).isError, true);
});

test('unparsable review verdict fails the job clearly', async () => {
  const c2 = await connect('noverdict');
  const prev = client; client = c2;
  try {
    const s = await call('claude_review', { goal: 'g', summary: 's', files_changed: [], cwd: work });
    const r = await finish(s.json.job_id);
    assert.equal(r.state, 'failed');
    assert.match(r.error, /verdict/);
  } finally { client = prev; await c2.close(); }
});

test('claude error is surfaced as failed job', async () => {
  const c2 = await connect('error');
  const prev = client; client = c2;
  try {
    const s = await call('claude_task', { task: 't', cwd: work });
    const r = await finish(s.json.job_id);
    assert.equal(r.state, 'failed');
    assert.match(r.error, /boom/);
  } finally { client = prev; await c2.close(); }
});
