import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptLateResult } from '../src/lib/desktop-job.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-late-'));
const job = { id: 'j1', target: 'desktop', state: 'failed' };
const timedOut = { job_id: 'j1', state: 'failed', status: 'failed', error: 'Timed out after 300s waiting for the app agent', model: 'flash' };

test('no agent result yet: nothing adopted', () => {
  assert.equal(adoptLateResult(job, dir, timedOut), null);
});

test('late agent result after a timeout is adopted', () => {
  fs.writeFileSync(path.join(dir, 'agent_result.json'), JSON.stringify({ status: 'done', summary: 'late answer' }));
  const r = adoptLateResult(job, dir, timedOut);
  assert.equal(r.state, 'done');
  assert.equal(r.summary, 'late answer');
  assert.equal(r.late_result, true);
  assert.equal(r.error, undefined);
  assert.equal(r.model, 'flash');
});

test('other failures and cli jobs are left alone', () => {
  assert.equal(adoptLateResult(job, dir, { ...timedOut, error: 'Could not reach the Antigravity app' }), null);
  assert.equal(adoptLateResult({ ...job, target: 'cli' }, dir, timedOut), null);
  assert.equal(adoptLateResult({ ...job, state: 'done' }, dir, timedOut), null);
});
