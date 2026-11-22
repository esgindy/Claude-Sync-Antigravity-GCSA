import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcsa-v35-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gcsa-v35-work-'));

const fakeAgy = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
const missingAgentApi = path.join(tmp, 'no-such-agentapi.exe');
const safeAgConfig = path.join(here, 'fakes', 'orbit-ag-config-safe.json');
const statusPath = path.join(tmp, 'status.json');
const quotaFile = path.join(tmp, 'quota.json');

fs.writeFileSync(quotaFile, JSON.stringify({ plan: 'Pro', models: [] }));

process.env.CSA_HOME = tmp;
process.env.CSA_STATUS = statusPath;
process.env.CSA_QUOTA_FILE = quotaFile;
process.env.CSA_AGY_BIN = fakeAgy;
process.env.CSA_AGENTAPI = missingAgentApi;
process.env.CSA_AG_CONFIG = safeAgConfig;
process.env.CSA_DASHBOARD = 'off';
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'v35-csrf-secret-token-112233445566';

const claudeUsage = await import('../src/lib/claude-usage.mjs');
const dashboard = await import('../src/lib/dashboard.mjs');
const messages = await import('../src/lib/messages.mjs');
const store = await import('../src/lib/store.mjs');
const desktopJob = await import('../src/lib/desktop-job.mjs');
const jobsApi = await import('../src/lib/jobs-api.mjs');
const notifications = await import('../src/lib/notifications.mjs');

let dashServer = null;

function setUserConfig(obj) {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(obj, null, 2));
}

function clearUsageFiles() {
  for (const f of [path.join(tmp, 'claude-usage.json'), statusPath, path.join(tmp, 'config.json')]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  claudeUsage.resetClaudeUsageThrottle();
}

function httpGet(port, reqPath, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

after(() => {
  try { if (dashServer && !dashServer.killed) dashServer.kill(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
});

test('1. version 5.0.0 (V5) bump, config defaults, and claude-side instructions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packaging', 'manifest.json'), 'utf8'));
  const defCfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));
  const claudeSide = fs.readFileSync(path.join(repoRoot, 'src', 'servers', 'claude-side.mjs'), 'utf8');
  const agySide = fs.readFileSync(path.join(repoRoot, 'src', 'servers', 'antigravity-side.mjs'), 'utf8');

  assert.equal(pkg.name, 'claude-sync-antigravity');
  assert.equal(pkg.version, '5.0.0');
  assert.equal(manifest.name, 'claude-sync-antigravity');
  assert.equal(manifest.version, '5.0.0');
  assert.equal(defCfg.claude_usage_max_age_s, 600);
  assert.equal(defCfg.claude_usage_command, null);
  assert.equal(defCfg.allow_desktop_auto_exec, false);
  assert.equal(defCfg.allow_desktop_edit, false);

  assert.match(claudeSide, /VERSION = '5\.0\.0'/);
  assert.match(claudeSide, /GCSA/);
  assert.match(claudeSide, /At the start of each delegated task, call csa_board with action="set_usage"/);
  assert.match(agySide, /version: '5\.0\.0'/);
});

test('2. clampUsagePct & validateAndClampUsage validate, clamp 0-100, and redact secrets', () => {
  assert.deepEqual(claudeUsage.clampUsagePct(145.6), { ok: true, value: 100 });
  assert.deepEqual(claudeUsage.clampUsagePct(-18.2), { ok: true, value: 0 });
  assert.deepEqual(claudeUsage.clampUsagePct('73.44'), { ok: true, value: 73.4 });
  assert.deepEqual(claudeUsage.clampUsagePct(null), { ok: true, value: null });
  assert.equal(claudeUsage.clampUsagePct('not-a-number').ok, false);
  assert.equal(claudeUsage.clampUsagePct(NaN).ok, false);
  assert.equal(claudeUsage.clampUsagePct(true).ok, false);
  assert.equal(claudeUsage.clampUsagePct({}).ok, false);

  const v = claudeUsage.validateAndClampUsage({
    five_hour_remaining_pct: 125,
    weekly_remaining_pct: -9,
    resets_at: '2026-11-20T12:00:00Z',
    note: 'Pro sk-ant-api03-SECRETKEY1234567890 --csrf_token TOPSECRET999',
  });
  assert.equal(v.ok, true);
  assert.equal(v.data.five_hour_remaining_pct, 100);
  assert.equal(v.data.weekly_remaining_pct, 0);
  assert.ok(!v.data.note.includes('SECRETKEY1234567890'));
  assert.ok(!v.data.note.includes('TOPSECRET999'));
  assert.ok(v.data.note.includes('[REDACTED]'));

  const bothNull = claudeUsage.validateAndClampUsage({
    five_hour_remaining_pct: null,
    weekly_remaining_pct: null,
  });
  assert.equal(bothNull.ok, false);
});

test('3. atomic write: csa_board set_usage and scripts/push-claude-usage.mjs write <CSA_HOME>/claude-usage.json atomically', async () => {
  clearUsageFiles();

  // 3a. csa_board set_usage writes both status.json and claude-usage.json
  const res = await dashboard.setClaudeUsage({
    five_hour_remaining_pct: 91.5,
    weekly_remaining_pct: 64,
    resets_at: '2026-11-20T09:00:00Z',
    note: 'from set_usage',
  });
  assert.equal(res.ok, true);

  const snapPath = path.join(tmp, 'claude-usage.json');
  assert.equal(fs.existsSync(snapPath), true);
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert.equal(snap.five_hour_remaining_pct, 91.5);
  assert.equal(snap.weekly_remaining_pct, 64);
  assert.equal(snap.resets_at, '2026-11-20T09:00:00Z');
  assert.equal(snap.note, 'from set_usage');
  assert.ok(snap.updated_at);

  // No leftover .tmp files
  const leftovers = fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  // 3b. scripts/push-claude-usage.mjs writes claude-usage.json and clamps values 0-100
  const pushScript = path.join(repoRoot, 'scripts', 'push-claude-usage.mjs');
  const run = spawnSync(
    process.execPath,
    [pushScript, '--five-hour', '115', '--weekly', '-10', '--resets-at', '2026-11-20T14:00:00Z', '--note', 'from cli script'],
    { env: { ...process.env, CSA_HOME: tmp, CSA_STATUS: statusPath }, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(run.status, 0, run.stderr);
  const snap2 = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert.equal(snap2.five_hour_remaining_pct, 100);
  assert.equal(snap2.weekly_remaining_pct, 0);
  assert.equal(snap2.resets_at, '2026-11-20T14:00:00Z');
  assert.equal(snap2.note, 'from cli script');
});

test('4. priority order: (a) fresh snapshot -> (b) claude_usage_command -> (c) stale set_usage -> unavailable', async () => {
  clearUsageFiles();

  // Helper command script that prints valid JSON with out-of-range values to test clamping
  const cmdScript = path.join(tmp, 'fake-usage-cmd.mjs');
  const counterFile = path.join(tmp, 'cmd-counter.txt');
  fs.writeFileSync(
    cmdScript,
    [
      'import fs from "node:fs";',
      `const cf = ${JSON.stringify(counterFile)};`,
      'const n = fs.existsSync(cf) ? Number(fs.readFileSync(cf, "utf8")) + 1 : 1;',
      'fs.writeFileSync(cf, String(n));',
      'console.log(JSON.stringify({ five_hour_remaining_pct: 130, weekly_remaining_pct: 55.5, resets_at: "2026-11-20T16:00:00Z", note: "from command" }));',
    ].join('\n'),
  );

  // 4a. When none of (a), (b), (c) exist -> unavailable with reason & short setup hint
  claudeUsage.resetClaudeUsageThrottle();
  const noneRes = await claudeUsage.refreshClaudeUsage({ reason: 'test_none' });
  assert.equal(noneRes.ok, true);
  assert.equal(noneRes.usage.available, false);
  assert.equal(noneRes.usage.stale, false);
  assert.equal(noneRes.usage.source, 'none');
  assert.ok(typeof noneRes.usage.reason === 'string' && noneRes.usage.reason.length > 0);
  assert.ok(typeof noneRes.usage.hint === 'string' && noneRes.usage.hint.includes('csa_board set_usage'));

  // 4b. Seed old set_usage in status.json AND expired snapshot (older than max_age_s=600)
  const oldIso = new Date(Date.now() - 1200 * 1000).toISOString(); // 20 min ago
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      project: 'Test',
      agents: [],
      log: [],
      claude_usage_last_set: {
        five_hour_remaining_pct: 42,
        weekly_remaining_pct: 33,
        resets_at: '2026-11-20T08:00:00Z',
        note: 'old set_usage',
        updated_at: oldIso,
      },
    }),
  );
  fs.writeFileSync(
    path.join(tmp, 'claude-usage.json'),
    JSON.stringify({
      five_hour_remaining_pct: 42,
      weekly_remaining_pct: 33,
      resets_at: '2026-11-20T08:00:00Z',
      note: 'old set_usage',
      updated_at: oldIso,
    }),
  );

  // Without command (b), expired snapshot falls back to Source (c) marked stale
  claudeUsage.resetClaudeUsageThrottle();
  const staleRes = await claudeUsage.refreshClaudeUsage({ reason: 'test_stale' });
  assert.equal(staleRes.usage.available, true);
  assert.equal(staleRes.usage.stale, true);
  assert.equal(staleRes.usage.source, 'set_usage');
  assert.equal(staleRes.usage.five_hour_remaining_pct, 42);
  assert.equal(staleRes.usage.weekly_remaining_pct, 33);

  // 4c. With command (b) configured and snapshot (a) expired, command (b) wins, clamps 130 -> 100, and updates snapshot
  setUserConfig({ claude_usage_command: [process.execPath, cmdScript], claude_usage_max_age_s: 600 });
  claudeUsage.resetClaudeUsageThrottle();
  const cmdRes = await claudeUsage.refreshClaudeUsage({ reason: 'test_cmd' });
  assert.equal(cmdRes.usage.available, true);
  assert.equal(cmdRes.usage.stale, false);
  assert.equal(cmdRes.usage.source, 'command');
  assert.equal(cmdRes.usage.five_hour_remaining_pct, 100);
  assert.equal(cmdRes.usage.weekly_remaining_pct, 55.5);
  assert.equal(cmdRes.usage.note, 'from command');
  assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');

  // 4d. With fresh snapshot (a) on disk, Source (a) wins over command (b) and does NOT invoke command (b)
  claudeUsage.writeClaudeUsageSnapshot({
    five_hour_remaining_pct: 77,
    weekly_remaining_pct: 66,
    resets_at: '2026-11-20T18:00:00Z',
    note: 'fresh snapshot',
  });
  claudeUsage.resetClaudeUsageThrottle();
  const snapRes = await claudeUsage.refreshClaudeUsage({ reason: 'test_fresh_snap' });
  assert.equal(snapRes.usage.available, true);
  assert.equal(snapRes.usage.stale, false);
  assert.equal(snapRes.usage.source, 'snapshot');
  assert.equal(snapRes.usage.five_hour_remaining_pct, 77);
  assert.equal(snapRes.usage.weekly_remaining_pct, 66);
  // Command counter must still be 1 because Source (a) won first!
  assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');
});

test('5. throttle: refreshClaudeUsage runs at most once per 20 seconds', async () => {
  clearUsageFiles();

  const countFile = path.join(tmp, 'throttle-count.txt');
  const script = path.join(tmp, 'throttle-cmd.mjs');
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      `const f = ${JSON.stringify(countFile)};`,
      'const c = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) + 1 : 1;',
      'fs.writeFileSync(f, String(c));',
      'console.log(JSON.stringify({ five_hour_remaining_pct: 90 - c, weekly_remaining_pct: 50 }));',
    ].join('\n'),
  );
  // Set max_age_s: 0 so snapshot is never fresh and refresh always reaches command if not throttled
  setUserConfig({ claude_usage_command: [process.execPath, script], claude_usage_max_age_s: 0 });
  claudeUsage.resetClaudeUsageThrottle();

  const t0 = 1_700_000_000_000;
  const r1 = await claudeUsage.refreshClaudeUsage({ reason: 'call_1', now: t0 });
  assert.equal(r1.throttled, false);
  assert.equal(r1.usage.five_hour_remaining_pct, 89);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');

  // Call 5s later -> must be throttled
  const r2 = await claudeUsage.refreshClaudeUsage({ reason: 'call_2', now: t0 + 5_000 });
  assert.equal(r2.throttled, true);
  assert.equal(r2.usage.five_hour_remaining_pct, 89);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');

  // Call 19.9s later -> still throttled
  const r3 = await claudeUsage.refreshClaudeUsage({ reason: 'call_3', now: t0 + 19_900 });
  assert.equal(r3.throttled, true);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');

  // Call 20.1s later -> throttle expired, runs again
  const r4 = await claudeUsage.refreshClaudeUsage({ reason: 'call_4', now: t0 + 20_100 });
  assert.equal(r4.throttled, false);
  assert.equal(r4.usage.five_hour_remaining_pct, 88);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
});

test('6. no-throw on source failure: corrupt snapshot, shell string command, failing command, invalid JSON', async () => {
  clearUsageFiles();

  // 6a. Corrupt snapshot file + shell-string command (must reject shell string and not throw)
  fs.writeFileSync(path.join(tmp, 'claude-usage.json'), '{not valid json');
  setUserConfig({ claude_usage_command: 'echo {"five_hour_remaining_pct":50}' });
  claudeUsage.resetClaudeUsageThrottle();
  const rShell = await claudeUsage.refreshClaudeUsage({ reason: 'shell_string_test' });
  assert.equal(rShell.ok, true);
  assert.equal(rShell.usage.available, false);
  assert.match(rShell.usage.reason, /array/i);

  // 6b. Command that exits non-zero -> falls back cleanly without throwing
  const failScript = path.join(tmp, 'fail-cmd.mjs');
  fs.writeFileSync(failScript, 'process.stderr.write("boom"); process.exit(2);\n');
  setUserConfig({ claude_usage_command: [process.execPath, failScript] });
  claudeUsage.resetClaudeUsageThrottle();
  const rFail = await claudeUsage.refreshClaudeUsage({ reason: 'cmd_exit_2' });
  assert.equal(rFail.ok, true);
  assert.equal(rFail.usage.available, false);
  assert.match(rFail.usage.reason, /exit 2|boom/i);

  // 6c. Command that outputs non-JSON -> falls back to last set_usage (marked stale) without throwing
  const badJsonScript = path.join(tmp, 'bad-json-cmd.mjs');
  fs.writeFileSync(badJsonScript, 'console.log("hello not json");\n');
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      project: 'FallbackTest',
      agents: [],
      log: [],
      claude_usage_last_set: {
        five_hour_remaining_pct: 61,
        weekly_remaining_pct: 48,
        resets_at: '2026-11-20T11:00:00Z',
        note: 'fallback note',
        updated_at: new Date(Date.now() - 900_000).toISOString(),
      },
    }),
  );
  setUserConfig({ claude_usage_command: [process.execPath, badJsonScript] });
  claudeUsage.resetClaudeUsageThrottle();
  const rFallback = await claudeUsage.refreshClaudeUsage({ reason: 'cmd_bad_json' });
  assert.equal(rFallback.ok, true);
  assert.equal(rFallback.usage.available, true);
  assert.equal(rFallback.usage.stale, true);
  assert.equal(rFallback.usage.five_hour_remaining_pct, 61);

  // 6d. Command that exceeds 5s timeout is terminated at 5s and falls back without throwing
  const hangScript = path.join(tmp, 'hang-cmd.mjs');
  fs.writeFileSync(hangScript, 'setInterval(() => {}, 1000);\n');
  setUserConfig({ claude_usage_command: [process.execPath, hangScript] });
  claudeUsage.resetClaudeUsageThrottle();
  const t0 = Date.now();
  const rTimeout = await claudeUsage.refreshClaudeUsage({ reason: 'cmd_timeout' });
  const elapsed = Date.now() - t0;
  assert.equal(rTimeout.ok, true);
  assert.equal(rTimeout.usage.available, true);
  assert.equal(rTimeout.usage.stale, true);
  assert.match(rTimeout.usage.reason, /timed out/i);
  assert.ok(elapsed >= 4500 && elapsed < 12000, `expected ~5s timeout, got ${elapsed}ms`);
});

test('7. security: never reads credential files, blocks credential args in claude_usage_command', async () => {
  clearUsageFiles();

  // 7a. Static check on src/lib/claude-usage.mjs and scripts/push-claude-usage.mjs
  const libSrc = fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'claude-usage.mjs'), 'utf8');
  const scriptSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'push-claude-usage.mjs'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(libSrc), 'claude-usage.mjs must not call fetch()');
  assert.ok(!/https?:\/\/api\.anthropic|claude\.ai\/api/i.test(libSrc), 'claude-usage.mjs must not call undocumented endpoints');
  assert.ok(!/\bfetch\s*\(/.test(scriptSrc), 'push-claude-usage.mjs must not call fetch()');

  // 7b. Runtime check: claude_usage_command referencing .credentials.json, .claude, or cookies is refused without executing
  const markerFile = path.join(tmp, 'cred-cmd-ran.txt');
  const spyScript = path.join(tmp, 'spy-cmd.mjs');
  fs.writeFileSync(
    spyScript,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "ran"); console.log(JSON.stringify({five_hour_remaining_pct:50}));\n`,
  );

  for (const forbiddenArg of [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    '.credentials.json',
    'C:\\Users\\test\\.claude\\settings.json',
    'cookies.sqlite',
    '.env.production',
  ]) {
    setUserConfig({ claude_usage_command: [process.execPath, spyScript, forbiddenArg] });
    claudeUsage.resetClaudeUsageThrottle();
    const res = await claudeUsage.refreshClaudeUsage({ reason: 'cred_arg_test' });
    assert.equal(res.usage.available, false);
    assert.match(res.usage.reason, /Refused claude_usage_command/i);
    assert.equal(fs.existsSync(markerFile), false, `command should not have executed for arg: ${forbiddenArg}`);
  }
});

test('8. automatic triggers on message log, job start/state change, and dashboard /api/status + 8-language UI', async () => {
  clearUsageFiles();

  claudeUsage.writeClaudeUsageSnapshot({
    five_hour_remaining_pct: 83,
    weekly_remaining_pct: 71,
    resets_at: '2026-11-20T19:00:00Z',
    note: 'auto refresh test',
  });

  // Trigger via logMessage and store.createJob / updateJob
  claudeUsage.resetClaudeUsageThrottle();
  const beforeCount = claudeUsage.getClaudeUsageRefreshStats().refreshCount;
  messages.logMessage({ direction: 'claude->antigravity', channel: 'cli', kind: 'task', text: 'hello' });
  const afterMsgCount = claudeUsage.getClaudeUsageRefreshStats().refreshCount;
  assert.equal(afterMsgCount, beforeCount + 1, 'logMessage must trigger refreshClaudeUsage');

  claudeUsage.resetClaudeUsageThrottle();
  const jobId = store.createJob({ cwd: work, kind: 'read' });
  assert.equal(claudeUsage.getClaudeUsageRefreshStats().refreshCount, afterMsgCount + 1, 'createJob must trigger refreshClaudeUsage');

  claudeUsage.resetClaudeUsageThrottle();
  store.updateJob(jobId, { state: 'done' });
  assert.equal(claudeUsage.getClaudeUsageRefreshStats().refreshCount, afterMsgCount + 2, 'updateJob state change must trigger refreshClaudeUsage');

  // Pick an unused port (prefer 4318 if free, otherwise a free port in 4750..4950)
  let port = 4318;
  try {
    const existing = await httpGet(port, '/api/status');
    if (existing.code === 200) {
      port = 4750 + Math.floor(Math.random() * 200);
    }
  } catch { /* 4318 is free */ }
  dashServer = spawn(process.execPath, [path.join(repoRoot, 'dashboard', 'server.mjs'), '--port', String(port)], {
    env: {
      ...process.env,
      CSA_HOME: tmp,
      CSA_STATUS: statusPath,
      CSA_QUOTA_FILE: quotaFile,
      CSA_AG_CONFIG: safeAgConfig,
      CSA_PROJECT: work,
      CSA_AGY_BIN: fakeAgy,
      PORT: String(port),
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const probe = await httpGet(port, '/api/status');
      if (probe.code === 200) {
        ready = true;
        break;
      }
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ready, true, `dashboard server failed to start on port ${port}`);

  const apiRes = await httpGet(port, '/api/status');
  assert.equal(apiRes.code, 200);
  const body = JSON.parse(apiRes.body);
  assert.ok(body.claude_usage, 'expected /api/status to expose claude_usage');
  assert.equal(body.claude_usage.five_hour_remaining_pct, 83);
  assert.equal(body.claude_usage.weekly_remaining_pct, 71);
  assert.equal(body.claude_usage.stale, false);
  assert.ok(body.claude_usage.updated_at);

  const htmlRes = await httpGet(port, '/');
  assert.equal(htmlRes.code, 200);
  assert.ok(htmlRes.body.includes('id="claudeFreshness"'), 'expected #claudeFreshness element under Claude icon');
  assert.ok(htmlRes.body.includes('GCSA'), 'expected GCSA short name in dashboard HTML');
  assert.ok(htmlRes.body.includes('rel="icon"'), 'expected favicon link in dashboard HTML');
  assert.ok(htmlRes.body.includes('href="/logo/gcsa'), 'expected GCSA favicon URL');
  assert.ok(htmlRes.body.includes('class="brand-ic"'), 'expected GCSA brand icon beside title in header');
  assert.ok(htmlRes.body.includes('v5.0.0'), 'expected v5.0.0 in dashboard HTML');

  const logoRes = await httpGet(port, '/logo/gcsa');
  assert.equal(logoRes.code, 200);
  assert.ok(logoRes.body.length > 1000, 'expected GCSA icon bytes from /logo/gcsa');
  const favRes = await httpGet(port, '/favicon.ico');
  assert.equal(favRes.code, 200);
  assert.ok(favRes.body.length > 1000, 'expected GCSA favicon bytes from /favicon.ico');

  for (const key of ['updatedMinAgo:', 'stale:', 'unavailNoData:', 'usageHint:']) {
    assert.equal(htmlRes.body.split(key).length - 1, 8, `expected ${key} in all 8 languages`);
  }
});

test('9. approval/permission & exact completion timestamp notifications (notifications.mjs, desktop-job.mjs, runner.mjs)', async () => {
  // 9a. resultInstruction embeds both approval-request protocol, exact completed_at, and notify_session
  const instr = desktopJob.resultInstruction(path.join(tmp, 'agent_result.json'), {
    id: '20261120075000-abcdef',
    notify_session: 'Claude Main [a1b2c3]',
  });
  assert.match(instr, /CLAUDE APPROVAL & COMPLETION NOTIFICATION PROTOCOL/);
  assert.match(instr, /needs_approval/);
  assert.match(instr, /completed_at/);
  assert.match(instr, /Claude Main \[a1b2c3\]/);
  assert.match(instr, /SendMessage/);

  // 9b. fromAgentResult preserves valid completed_at and defaults to ISO-8601 when absent
  const explicitTs = '2026-11-20T07:50:12.000Z';
  const r1 = desktopJob.fromAgentResult({ job_id: 'j1' }, { status: 'done', completed_at: explicitTs, summary: 'ok' });
  assert.equal(r1.completed_at, explicitTs);
  const r2 = desktopJob.fromAgentResult({ job_id: 'j2' }, { status: 'needs_approval', summary: 'need perm' });
  assert.ok(!Number.isNaN(Date.parse(r2.completed_at)));

  // 9c. End-to-end CLI job requiring command approval records approval_needed notification + completed_at
  const startedApproval = await jobsApi.startJob({
    prompt: 'SCENARIO:commands run check',
    cwd: work,
    kind: 'read',
    target: 'cli',
    notify_session: 'Claude Review',
  });
  const waitedApproval = await jobsApi.waitJob(startedApproval.job_id, 30);
  assert.equal(waitedApproval.status, 'needs_approval');
  assert.ok(waitedApproval.completed_at && !Number.isNaN(Date.parse(waitedApproval.completed_at)));

  const notesAfterApproval = notifications.readNotifications({ limit: 20 });
  const appNote = notesAfterApproval.find((n) => n.job_id === startedApproval.job_id);
  assert.ok(appNote, 'expected approval notification in notifications.jsonl');
  assert.equal(appNote.type, 'approval_needed');
  assert.equal(appNote.status, 'needs_approval');
  assert.equal(appNote.target_session, 'Claude Review');
  assert.equal(appNote.completed_at, waitedApproval.completed_at);
  assert.ok(appNote.commands_requested.length >= 1);
  assert.match(appNote.message, /Approval\/Permission Request/);

  // 9d. End-to-end normal CLI job records task_completed notification with exact completed_at
  const startedDone = await jobsApi.startJob({
    prompt: 'simple read task',
    cwd: work,
    kind: 'read',
    target: 'cli',
  });
  const waitedDone = await jobsApi.waitJob(startedDone.job_id, 30);
  assert.equal(waitedDone.status, 'done');
  assert.ok(waitedDone.completed_at && !Number.isNaN(Date.parse(waitedDone.completed_at)));

  const doneNote = notifications.readNotifications({ limit: 20 }).find((n) => n.job_id === startedDone.job_id);
  assert.ok(doneNote, 'expected completion notification in notifications.jsonl');
  assert.equal(doneNote.type, 'task_completed');
  assert.equal(doneNote.completed_at, waitedDone.completed_at);
  assert.match(doneNote.message, /Task Finished/);
});
