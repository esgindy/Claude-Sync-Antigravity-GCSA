import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusLinePlan, statusLineCommand, applyStatusLine, AGY_INSTALL } from '../scripts/setup.mjs';
import { usageFromStatusJson } from '../scripts/claude-statusline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'claude-statusline.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setupHome(settings) {
  const home = tmp('gcsa-sl-');
  fs.mkdirSync(path.join(home, '.claude'));
  if (settings !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const plan = statusLinePlan({ home, node: '/opt/node/bin/node', root: '/opt/GCSA', csaHome: path.join(home, 'state') });
  const read = () => JSON.parse(fs.readFileSync(plan.file, 'utf8'));
  return { home, plan, read };
}

test('usageFromStatusJson converts used% to remaining% and epoch to ISO', () => {
  const u = usageFromStatusJson({ rate_limits: { five_hour: { used_percentage: 6, resets_at: 1795500600 }, seven_day: { used_percentage: 52.4 } } });
  assert.equal(u.five_hour_remaining_pct, 94);
  assert.equal(u.weekly_remaining_pct, 47.6);
  assert.equal(u.resets_at, new Date(1795500600 * 1000).toISOString());
  assert.equal(usageFromStatusJson({}), null);
  assert.equal(usageFromStatusJson(null), null);
  assert.equal(usageFromStatusJson({ rate_limits: { five_hour: { used_percentage: 'x' } } }), null);
  assert.equal(usageFromStatusJson({ rate_limits: { five_hour: { used_percentage: 140 } } }).five_hour_remaining_pct, 0);
});

test('statusLine script writes the snapshot, survives bad input, and always exits 0', () => {
  const csaHome = tmp('gcsa-slrun-');
  const env = { ...process.env, CSA_HOME: csaHome };
  const ok = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 40 } } }), env, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /GCSA · Opus · 5h 90% left · week 60% left/);
  const snap = JSON.parse(fs.readFileSync(path.join(csaHome, 'claude-usage.json'), 'utf8'));
  assert.equal(snap.five_hour_remaining_pct, 90);
  assert.equal(snap.weekly_remaining_pct, 60);
  for (const input of ['', 'not json', '{}', '[]']) {
    const r = spawnSync(process.execPath, [SCRIPT], { input, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}`);
  }
});

test('statusLine script shows a chained (pre-existing) status line with the same stdin', () => {
  const csaHome = tmp('gcsa-slchain-');
  const cmd = `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdin.pipe(process.stdout)"`;
  fs.writeFileSync(path.join(csaHome, 'statusline-chain.json'), JSON.stringify({ command: cmd }));
  const r = spawnSync(process.execPath, [SCRIPT], { input: '{"hello":1}', env: { ...process.env, CSA_HOME: csaHome }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '{"hello":1}');
});

test('applyStatusLine adds, is idempotent, keeps other settings, and removes cleanly', () => {
  const { plan, read } = setupHome({ theme: 'dark' });
  assert.equal(applyStatusLine(plan, { dryRun: true }).status, 'added');
  assert.equal(read().statusLine, undefined, 'dry run writes nothing');
  const r = applyStatusLine(plan);
  assert.equal(r.status, 'added');
  assert.ok(fs.existsSync(r.backup));
  assert.equal(read().theme, 'dark');
  assert.match(read().statusLine.command, /claude-statusline\.mjs/);
  assert.equal(applyStatusLine(plan).status, 'unchanged');
  assert.equal(applyStatusLine(plan, { remove: true }).status, 'removed');
  assert.equal(read().statusLine, undefined);
  assert.equal(read().theme, 'dark');
  assert.equal(applyStatusLine(plan, { remove: true }).status, 'absent');
});

test('applyStatusLine chains an existing statusLine and restores it on uninstall', () => {
  const mine = { type: 'command', command: 'bash ~/my-status.sh' };
  const { plan, read } = setupHome({ statusLine: mine });
  assert.equal(applyStatusLine(plan).status, 'chained');
  assert.equal(JSON.parse(fs.readFileSync(plan.chainFile, 'utf8')).command, 'bash ~/my-status.sh');
  assert.match(read().statusLine.command, /claude-statusline\.mjs/);
  // re-running setup must not chain our own command onto itself
  assert.equal(applyStatusLine(plan).status, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(plan.chainFile, 'utf8')).command, 'bash ~/my-status.sh');
  assert.equal(applyStatusLine(plan, { remove: true }).status, 'restored');
  assert.deepEqual(read().statusLine, mine);
  assert.ok(!fs.existsSync(plan.chainFile));
});

test('applyStatusLine updates a moved install and never touches broken or missing configs', () => {
  const { home, plan, read } = setupHome();
  assert.equal(applyStatusLine(plan).status, 'added'); // creates settings.json
  const moved = statusLinePlan({ home, node: '/opt/node/bin/node', root: '/srv/GCSA2', csaHome: path.join(home, 'state') });
  assert.equal(applyStatusLine(moved).status, 'updated');
  assert.match(read().statusLine.command, /GCSA2/);

  const broken = setupHome();
  fs.writeFileSync(broken.plan.file, '{ not json');
  assert.equal(applyStatusLine(broken.plan).status, 'skipped');
  assert.equal(fs.readFileSync(broken.plan.file, 'utf8'), '{ not json');

  const noClaude = statusLinePlan({ home: tmp('gcsa-noclaude-'), csaHome: tmp('gcsa-s-') });
  assert.equal(applyStatusLine(noClaude).status, 'skipped');
});

test('statusLineCommand quotes paths and uses forward slashes on Windows', () => {
  assert.equal(statusLineCommand({ node: '/a b/node', root: '/x/G', win: false }), '"/a b/node" "/x/G/scripts/claude-statusline.mjs"');
  const w = statusLineCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', root: 'C:\\GCSA', win: true });
  assert.ok(!w.includes('\\'), w);
  assert.match(w, /^"C:\/Program Files\/nodejs\/node\.exe" "C:\/GCSA/);
});

test('agy installer uses only the official antigravity.google scripts', () => {
  assert.match(AGY_INSTALL.unix[1].join(' '), /https:\/\/antigravity\.google\/cli\/install\.sh/);
  assert.match(AGY_INSTALL.win[1].join(' '), /https:\/\/antigravity\.google\/cli\/install\.ps1/);
});

test('desktop result: an invented completed_at is replaced by when the file was really written', async () => {
  const { fromAgentResult } = await import('../src/lib/desktop-job.mjs');
  const observedAt = '2026-11-22T11:49:28.000Z';
  const off = fromAgentResult({}, { status: 'done', completed_at: '2026-11-22T15:47:30+04:00' }, { observedAt });
  assert.equal(off.completed_at, observedAt);
  assert.equal(off.agent_completed_at, '2026-11-22T11:47:30.000Z');
  const close = fromAgentResult({}, { status: 'done', completed_at: '2026-11-22T11:49:25.000Z' }, { observedAt });
  assert.equal(close.completed_at, '2026-11-22T11:49:25.000Z');
  assert.equal(close.agent_completed_at, undefined);
  const none = fromAgentResult({}, { status: 'done' }, { observedAt });
  assert.equal(none.completed_at, observedAt);
});
