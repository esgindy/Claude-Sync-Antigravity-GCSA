import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'echo-lib-'));
const fake = resolve('test/fakes/echo-fake-claude.mjs');
const log = join(tmp, 'calls.jsonl');
process.env.CSA_HOME = join(tmp, 'home');
process.env.CSA_CLAUDE_BIN = fake;
process.env.ECHO_FAKE_LOG = log;

let C, H;
before(async () => {
  C = await import('../src/lib/claude.mjs');
  H = await import('../src/lib/hops.mjs');
});
const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('findClaude honours CSA_CLAUDE_BIN', () => {
  assert.equal(C.findClaude(), fake);
});

test('review args: plan mode, json, never skip-permissions', () => {
  const a = C.buildClaudeArgs({ mode: 'review', model: 'opus', sessionId: 's1', addDirs: ['d1', 'd2'], maxBudgetUsd: 1.5 });
  assert.deepEqual(a.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.ok(a.includes('plan'));
  assert.ok(!a.includes('--allowedTools'));
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--resume') + 1], 's1');
  assert.equal(a.filter((x) => x === '--add-dir').length, 2);
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '1.5');
  assert.ok(!a.some((x) => x.includes('dangerously')));
});

test('task args: acceptEdits, no Bash', () => {
  const a = C.buildClaudeArgs({ mode: 'task' });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read Grep Glob Edit Write');
  assert.equal(a[a.indexOf('--allowedTools') + 1].includes('Bash'), false);
});

test('runClaude parses JSON result', async () => {
  process.env.ECHO_FAKE_MODE = 'approve';
  const r = await C.runClaude({ prompt: 'hello world', mode: 'review', cwd: tmp });
  assert.equal(r.session_id, 'fake-session-1');
  assert.equal(r.cost_usd, 0.0123);
  assert.equal(r.is_error, false);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
  const c = calls().at(-1);
  assert.equal(c.stdin, 'hello world');
  assert.ok(c.args.includes('plan'));
});

test('runClaude reports errors and garbage', async () => {
  process.env.ECHO_FAKE_MODE = 'error';
  assert.equal((await C.runClaude({ prompt: 'x', cwd: tmp })).is_error, true);
  process.env.ECHO_FAKE_MODE = 'garbage';
  const g = await C.runClaude({ prompt: 'x', cwd: tmp });
  assert.equal(g.is_error, true);
  assert.match(g.result, /no JSON/);
});

test('runClaude timeout kills the process', async () => {
  process.env.ECHO_FAKE_MODE = 'sleep';
  const t0 = Date.now();
  const r = await C.runClaude({ prompt: 'x', cwd: tmp, timeoutMs: 700 });
  assert.equal(r.is_error, true);
  assert.equal(r.timed_out, true);
  assert.ok(Date.now() - t0 < 15000);
});

test('parseVerdict: plain, fenced, structured, missing', async () => {
  const mk = async (mode) => { process.env.ECHO_FAKE_MODE = mode; return C.parseVerdict(await C.runClaude({ prompt: 'x', cwd: tmp })); };
  assert.equal((await mk('approve')).verdict, 'approve');
  const ch = await mk('changes');
  assert.deepEqual(ch.required_changes, ['fix x', 'add test']);
  assert.equal((await mk('fenced')).verdict, 'approve');
  assert.equal((await mk('structured')).notes, 's');
  assert.equal(await mk('noverdict'), null);
});

test('hops: new chain starts at 1, increments, refuses at limit', () => {
  const a = H.nextHop(null);
  assert.equal(a.hop, 1);
  assert.match(a.chain_id, /^chain-/);
  H.assertHopAllowed(a.chain_id, 3);
  assert.equal(H.nextHop(a.chain_id).hop, 2);
  assert.equal(H.nextHop(a.chain_id).hop, 3);
  assert.throws(() => H.assertHopAllowed(a.chain_id, 3), /Hop limit reached.*report to the user/);
  H.assertHopAllowed('unknown-chain', 3);
  const u = H.nextHop('mine');
  assert.notEqual(u.chain_id, 'mine');
  assert.equal(u.hop, 1);
});
