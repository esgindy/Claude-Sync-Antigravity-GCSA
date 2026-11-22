import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sec-'));
process.env.CSA_HOME = path.join(tmp, 'home');
process.env.CSA_AGENTAPI = path.join(here, 'fakes', 'orbit-fake-agentapi.mjs');
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'dummy-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cfgFile = path.join(tmp, 'ag-config.json');
process.env.CSA_AG_CONFIG = cfgFile;

const desktop = await import('../src/lib/desktop.mjs');
const swarm = await import('../src/lib/swarm.mjs');
const tools = new Map();
(await import('../src/tools/desktop-tools.mjs')).register({ registerTool: (n, d, h) => tools.set(n, h) });
const text = (r) => r.content[0].text;
const setCfg = (o) => fs.writeFileSync(cfgFile, typeof o === 'string' ? o : JSON.stringify(o));
const writeUserConfig = (o) => { fs.mkdirSync(process.env.CSA_HOME, { recursive: true }); fs.writeFileSync(path.join(process.env.CSA_HOME, 'config.json'), JSON.stringify(o)); };

test('desktopPolicy: detects AUTO in either field, tolerant parsing', () => {
  setCfg({ autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' });
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  setCfg({ permissionPreset: 'Always proceed (AUTO)' });
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  setCfg({ autoExecutionPolicy: 'REQUEST_REVIEW', permissionPreset: 'Request review' });
  assert.equal(desktop.desktopPolicy().auto_exec, false);
  setCfg('{"autoExecutionPolicy":"AUTO",}'); // trailing comma
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  setCfg({ userSettings: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO' } }); // real app layout
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  setCfg({ userSettings: { autoExecutionPolicy: 'REQUEST_REVIEW', permissionPreset: 'Request review' } });
  assert.equal(desktop.desktopPolicy().auto_exec, false);
  setCfg({ userSettings: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF', permissionPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' } }); // real 2.34 safe values
  assert.equal(desktop.desktopPolicy().auto_exec, false);
  setCfg({ userSettings: { autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF', permissionPreset: 'AGENT_PERMISSION_PRESET_AUTO' } });
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  setCfg('not json at all'); // unreadable settings fail closed
  assert.equal(desktop.desktopPolicy().auto_exec, true);
  fs.rmSync(cfgFile);
  assert.equal(desktop.desktopPolicy().auto_exec, true);
});

test('agy_desktop_task runs with a policy_warning when the app auto-executes', async () => {
  setCfg({ autoExecutionPolicy: 'AUTO' });
  process.env.CSA_DESKTOP_POLL_MS = '100';
  const r = await tools.get('agy_desktop_task')({ prompt: 'x', cwd: tmp });
  assert.notEqual(r.isError, true, text(r));
  const body = JSON.parse(text(r));
  assert.equal(body.unrestricted, true);
  assert.match(body.policy_warning, /without asking/);
  assert.match(body.policy_warning, /Request review/);
});

test('agy_desktop_task accepts edit jobs without allow_desktop_edit', async () => {
  setCfg({ autoExecutionPolicy: 'REQUEST_REVIEW' });
  process.env.CSA_DESKTOP_POLL_MS = '100';
  const r = await tools.get('agy_desktop_task')({ prompt: 'x', cwd: tmp, kind: 'edit' });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(JSON.parse(text(r)).policy_warning, undefined);
});

test('start response carries warning and unrestricted flag (allowed auto exec)', async () => {
  setCfg({ autoExecutionPolicy: 'AUTO' });
  writeUserConfig({ allow_desktop_auto_exec: true });
  process.env.CSA_DESKTOP_POLL_MS = '100';
  const r = await tools.get('agy_desktop_task')({ prompt: 'x', cwd: tmp });
  assert.notEqual(r.isError, true, text(r));
  const body = JSON.parse(text(r));
  assert.match(body.warning, /own permissions/);
  assert.equal(body.unrestricted, true);
  fs.rmSync(path.join(process.env.CSA_HOME, 'config.json'));
});

test('agy_desktop_status shows the policy', async () => {
  setCfg({ autoExecutionPolicy: 'AUTO' });
  const body = JSON.parse(text(await tools.get('agy_desktop_status')({})));
  assert.equal(body.policy.auto_exec, true);
});

test('swarm with desktop target warns on auto and allows edit', async () => {
  setCfg({ permissionPreset: 'AUTO' });
  const sw = await swarm.startSwarm({ mode: 'split', cwd: tmp, target: 'desktop', parts: [{ prompt: 'a' }] });
  assert.equal(sw.unrestricted, true);
  assert.match(sw.policy_warning, /Request review/);
  setCfg({ permissionPreset: 'Request review' });
  const sw2 = await swarm.startSwarm({ mode: 'split', cwd: tmp, target: 'desktop', parts: [{ prompt: 'a', kind: 'edit', files: ['a.js'] }] });
  assert.ok(sw2.swarm_id);
  assert.equal(sw2.policy_warning, undefined);
});

test('L1: conversation_id must be a UUID', async () => {
  setCfg({ autoExecutionPolicy: 'REQUEST_REVIEW' });
  const r = await tools.get('agy_desktop_task')({ prompt: 'x', cwd: tmp, conversation_id: '--profile=evil' });
  assert.equal(r.isError, true);
  assert.match(text(r), /UUID/);
  await assert.rejects(desktop.sendMessage('--title=x', 'hi'), /UUID/);
  await assert.rejects(desktop.getMetadata('abc'), /UUID/);
  await assert.rejects(desktop.sendMessage('-'.repeat(36), 'hi'), /UUID/);
});

test('L2: output is capped at 8 MB', async () => {
  const r = await desktop.runProc(process.execPath, ['-e', 'const b=Buffer.alloc(65536,97);for(let i=0;i<200;i++)process.stdout.write(b)'], { timeoutMs: 30000 });
  assert.ok(r.stdout.length >= 8 * 1024 * 1024);
  assert.ok(r.stdout.length <= 8 * 1024 * 1024 + 70000);
});

test('L3: timeout kills the process tree and returns', async () => {
  const t0 = Date.now();
  const r = await desktop.runProc(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10000);
});

test('M2: redactText delegates to safety.redact and masks tokens', () => {
  const s = desktop.redactText('run --csrf_token SECRETVALUE123 now');
  assert.ok(!s.includes('SECRETVALUE123'));
});
