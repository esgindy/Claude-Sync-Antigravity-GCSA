import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planEntries, applyEntry, locationWarnings, timestamp } from '../scripts/setup.mjs';

function fakeHome({ claudeCode = true, desktop = true, gemini = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcsa-setup-'));
  const plans = planEntries({ home, node: '/opt/node/bin/node', root: '/opt/GCSA' });
  const byT = Object.fromEntries(plans.map((p) => [p.target, p]));
  if (claudeCode) fs.writeFileSync(byT['claude-code'].file, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
  if (desktop) fs.mkdirSync(path.dirname(byT['claude-desktop'].file), { recursive: true });
  if (gemini) { fs.mkdirSync(path.dirname(byT.antigravity.file), { recursive: true }); fs.writeFileSync(byT.antigravity.file, ''); }
  return { home, plans, byT };
}

test('setup adds entries, keeps other keys, backs up, and is idempotent', () => {
  const { byT } = fakeHome();
  const stamp = timestamp(new Date(2026, 0, 2, 3, 4, 5));
  const r1 = applyEntry(byT['claude-code'], { stamp });
  assert.equal(r1.status, 'added');
  assert.ok(fs.existsSync(r1.backup));
  const cc = JSON.parse(fs.readFileSync(byT['claude-code'].file, 'utf8'));
  assert.equal(cc.numStartups, 3);
  assert.deepEqual(cc.mcpServers.other, { command: 'x' });
  assert.equal(cc.mcpServers.csa.command, '/opt/node/bin/node');
  assert.equal(applyEntry(byT['claude-code'], { stamp }).status, 'unchanged');

  assert.equal(applyEntry(byT['claude-desktop']).status, 'added'); // file created in existing folder
  assert.equal(applyEntry(byT.antigravity).status, 'added');       // empty file accepted
  const ag = JSON.parse(fs.readFileSync(byT.antigravity.file, 'utf8'));
  assert.ok(ag.mcpServers['csa-antigravity'].args[0].endsWith('antigravity-side.mjs'));
});

test('setup updates a moved install and uninstall removes only our key', () => {
  const { home, byT } = fakeHome();
  applyEntry(byT['claude-code']);
  const moved = planEntries({ home, node: '/new/node', root: '/new/GCSA' }).find((p) => p.target === 'claude-code');
  assert.equal(applyEntry(moved).status, 'updated');
  assert.equal(applyEntry(moved, { remove: true }).status, 'removed');
  const cc = JSON.parse(fs.readFileSync(moved.file, 'utf8'));
  assert.equal(cc.mcpServers.csa, undefined);
  assert.deepEqual(cc.mcpServers.other, { command: 'x' });
  assert.equal(applyEntry(moved, { remove: true }).status, 'absent');
});

test('setup skips missing apps and never overwrites unparsable configs', () => {
  const { byT } = fakeHome({ claudeCode: false, desktop: false, gemini: true });
  assert.equal(applyEntry(byT['claude-code']).status, 'skipped');
  assert.equal(applyEntry(byT['claude-desktop']).status, 'skipped');
  fs.writeFileSync(byT.antigravity.file, '{ broken');
  const r = applyEntry(byT.antigravity);
  assert.equal(r.status, 'skipped');
  assert.equal(fs.readFileSync(byT.antigravity.file, 'utf8'), '{ broken');
});

test('dry run reports but writes nothing', () => {
  const { byT } = fakeHome();
  const before = fs.readFileSync(byT['claude-code'].file, 'utf8');
  assert.equal(applyEntry(byT['claude-code'], { dryRun: true }).status, 'added');
  assert.equal(fs.readFileSync(byT['claude-code'].file, 'utf8'), before);
});

test('location warnings flag cloud folders and temporary Node', () => {
  assert.equal(locationWarnings({ root: '/Users/a/Library/CloudStorage/OneDrive-Personal/x', node: '/usr/local/bin/node' }).length, 1);
  assert.equal(locationWarnings({ root: '/Users/a/GCSA', node: '/private/tmp/x/scratchpad/node/bin/node' }).length, 1);
  assert.equal(locationWarnings({ root: '/Users/a/GCSA', node: '/Users/a/.local/node/bin/node' }).length, 0);
});
