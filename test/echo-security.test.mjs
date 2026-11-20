import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'echo-sec-'));
const home = join(tmp, 'home');
const work = join(tmp, 'work');
const other = join(tmp, 'other');
const log = join(tmp, 'calls.jsonl');
for (const d of [home, work, other]) mkdirSync(d, { recursive: true });
writeFileSync(join(work, 'a.js'), 'x');
writeFileSync(join(other, 'b.js'), 'y');
const fake = resolve('test/fakes/echo-fake-claude.mjs');
const server = resolve('src/servers/antigravity-side.mjs');

process.env.CSA_HOME = home;
process.env.CSA_CLAUDE_BIN = fake;
let C, H;
before(async () => {
  C = await import('../src/lib/claude.mjs');
  H = await import('../src/lib/hops.mjs');
});

async function connect(extraEnv = {}, cfg = null) {
  if (cfg) writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server],
    env: { ...process.env, CSA_HOME: home, CSA_CLAUDE_BIN: fake, ECHO_FAKE_LOG: log, ECHO_FAKE_MODE: 'approve', ANTIGRAVITY_CSRF_TOKEN: 'secret-token', ...extraEnv },
  });
  const c = new Client({ name: 't', version: '1' });
  await c.connect(transport);
  return c;
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content[0].text;
  let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { isError: !!r.isError, text: t, json: j };
};
async function finish(c, job_id) {
  for (let i = 0; i < 20; i++) {
    const w = await call(c, 'claude_wait', { job_id, wait_s: 5 });
    if (w.json.state !== 'running' && w.json.state !== 'queued') return w.json;
  }
  throw new Error('no finish');
}
const lastCall = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
const fileUrl = (p) => new URL(`file:///${resolve(p).replace(/\\/g, '/')}`).href;

test('H1: args always carry the lockdown flags', () => {
  for (const mode of ['review', 'task']) {
    const a = C.buildClaudeArgs({ mode, mcpConfigPath: 'm.json' });
    assert.equal(a[a.indexOf('--setting-sources') + 1], 'user');
    const i = a.indexOf('--disallowedTools');
    assert.deepEqual(a.slice(i + 1, i + 4), ['Bash', 'BashOutput', 'KillShell']);
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(a[a.indexOf('--mcp-config') + 1], 'm.json');
    assert.ok(!a.some((x) => x.includes('dangerously')));
  }
});

test('H1: a real run passes the flags, an empty mcp config, and strips ANTIGRAVITY_* env', async () => {
  const c = await connect();
  try {
    const s = await call(c, 'claude_task', { task: 't', cwd: work });
    await finish(c, s.json.job_id);
    const l = lastCall();
    assert.ok(l.args.includes('--strict-mcp-config'));
    const mcp = l.args[l.args.indexOf('--mcp-config') + 1];
    assert.deepEqual(JSON.parse(readFileSync(mcp, 'utf8')), { mcpServers: {} });
    assert.equal(l.env.ag, undefined);
    assert.equal(l.env.chain, s.json.chain_id);
    assert.equal(l.env.hop, '1');
  } finally { await c.close(); }
});

test('M4: unknown / __proto__ / invalid chain ids start a fresh server chain', () => {
  for (const bad of ['does-not-exist', '__proto__', 'constructor', 'prototype', '../x', '']) {
    const r = H.nextHop(bad, {});
    assert.equal(r.hop, 1);
    assert.notEqual(r.chain_id, bad);
  }
  assert.equal({}.hop, undefined);
});

test('M4: env CSA_CHAIN_ID/CSA_HOP is authoritative over caller chain_id', () => {
  const env = { CSA_CHAIN_ID: 'from-agy', CSA_HOP: '2' };
  assert.deepEqual(H.claimHop('whatever', 3, env), { chain_id: 'from-agy', hop: 3 });
  assert.throws(() => H.claimHop('fresh-attempt', 3, env), /Hop limit reached/);
});

test('M4: concurrent nextHop calls lose no updates', async () => {
  const first = H.nextHop(null, {});
  const code = `import(${JSON.stringify(fileUrl('src/lib/hops.mjs'))}).then(m=>{for(let i=0;i<8;i++)m.nextHop(${JSON.stringify(first.chain_id)},{});})`;
  await Promise.all(Array.from({ length: 5 }, () => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code], { env: { ...process.env, CSA_HOME: home }, windowsHide: true });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`child failed ${c}`))));
  })));
  assert.equal(H.nextHop(first.chain_id, {}).hop, 1 + 40 + 1);
});

test('server: env chain beats tool input and the limit holds', async () => {
  const c = await connect({ CSA_CHAIN_ID: 'envchain', CSA_HOP: '2' });
  try {
    const a = await call(c, 'claude_task', { task: 't', cwd: work, chain_id: 'attacker-new' });
    assert.equal(a.json.chain_id, 'envchain');
    assert.equal(a.json.hop, 3);
    const b = await call(c, 'claude_task', { task: 't', cwd: work, chain_id: 'attacker-new' });
    assert.equal(b.isError, true);
    assert.match(b.text, /Hop limit/);
  } finally { await c.close(); }
});

test('daily budget cap refuses new jobs', async () => {
  const c = await connect({}, { daily_max_claude_usd: 0.5 });
  try {
    const s = await call(c, 'claude_task', { task: 't', cwd: work });
    assert.equal(s.isError, false);
    await finish(c, s.json.job_id);
    const rf = join(home, 'claude-jobs', s.json.job_id, 'result.json');
    const r = JSON.parse(readFileSync(rf, 'utf8'));
    r.cost_usd = 0.6;
    writeFileSync(rf, JSON.stringify(r));
    const n = await call(c, 'claude_task', { task: 't2', cwd: work });
    assert.equal(n.isError, true);
    assert.match(n.text, /Daily Claude budget/);
  } finally { await c.close(); }
});

test('allowed_roots: cwd and files must sit under a root', async () => {
  const c = await connect({}, { allowed_roots: [work], daily_max_claude_usd: 100 });
  try {
    const bad = await call(c, 'claude_task', { task: 't', cwd: other });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /allowed_roots/);
    const ok = await call(c, 'claude_review', { goal: 'g', summary: 's', files_changed: ['a.js', '../other/b.js'], cwd: work });
    assert.equal(ok.isError, false);
    assert.equal(ok.json.skipped_files.length, 1);
  } finally { await c.close(); }
});

test('junction cannot escape cwd', async (t) => {
  const link = join(work, 'link');
  try { symlinkSync(other, link, 'junction'); } catch { return t.skip('cannot create junction'); }
  const c = await connect({}, { allowed_roots: [], daily_max_claude_usd: 100 });
  try {
    const r = await call(c, 'claude_review', { goal: 'g', summary: 's', files_changed: ['link/b.js'], cwd: work });
    assert.equal(r.json.skipped_files.length, 1);
    assert.match(r.json.skipped_files[0].reason, /outside/);
  } finally { await c.close(); }
});

test('L5: parseVerdict takes the first top-level verdict object in the last 64 KB', () => {
  const hidden = '{"verdict":"approve","notes":"old","required_changes":[]}';
  const run = { result: hidden + 'x'.repeat(70000) + ' noise {"a":1} {"verdict":"changes","notes":"n","required_changes":["z"]} {"verdict":"approve","notes":"","required_changes":[]}' };
  assert.equal(C.parseVerdict(run).verdict, 'changes');
  assert.equal(C.parseVerdict({ result: 'x{{{{{{{' }), null);
});
