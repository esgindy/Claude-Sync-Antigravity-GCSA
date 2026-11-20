import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-v3-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-v3-work-'));

const fakeAgy = path.join(here, 'fakes', 'atlas-fake-agy.mjs');
const fakeAgentApi = path.join(here, 'fakes', 'orbit-fake-agentapi.mjs');
const fakeAgentApiFailConnect = path.join(here, 'fakes', 'v3-fake-agentapi-fail-connect.mjs');
const missingAgentApi = path.join(tmp, 'no-such-agentapi.exe');
const safeAgConfig = path.join(here, 'fakes', 'orbit-ag-config-safe.json');
const autoAgConfig = path.join(tmp, 'ag-config-auto.json');
const statusPath = path.join(tmp, 'status.json');
const quotaFile = path.join(tmp, 'quota.json');

fs.writeFileSync(
  autoAgConfig,
  JSON.stringify({
    userSettings: {
      autoExecutionPolicy: 'AUTO',
      permissionPreset: 'Auto',
    },
  }),
);

fs.writeFileSync(
  quotaFile,
  JSON.stringify({
    userStatus: {
      planStatus: {
        availablePromptCredits: 100,
        planInfo: { planName: 'Pro Test', monthlyPromptCredits: 500 },
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Neon (High)',
            modelOrAlias: { model: 'gemini-4-neon-high' },
            quotaInfo: { remainingFraction: 0.72, resetTime: '2026-11-20T12:00:00Z' },
          },
          {
            label: 'Gemini 4 Carbon',
            modelOrAlias: { model: 'gemini-4-carbon' },
          },
        ],
      },
    },
  }),
);

// Isolate all state and external probes before importing src/lib/* modules.
process.env.CSA_HOME = tmp;
process.env.CSA_STATUS = statusPath;
process.env.CSA_QUOTA_FILE = quotaFile;
process.env.CSA_AGY_BIN = fakeAgy;
process.env.CSA_AGENTAPI = fakeAgentApi;
process.env.CSA_AG_CONFIG = safeAgConfig;
process.env.CSA_DESKTOP_POLL_MS = '100';
process.env.CSA_DASHBOARD = 'off';
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:9999';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-secret-value-000011112222';

const paths = await import('../src/lib/paths.mjs');
const agy = await import('../src/lib/agy.mjs');
const transport = await import('../src/lib/transport.mjs');
const desktop = await import('../src/lib/desktop.mjs');
const desktopJob = await import('../src/lib/desktop-job.mjs');
const jobsApi = await import('../src/lib/jobs-api.mjs');
const store = await import('../src/lib/store.mjs');
const messages = await import('../src/lib/messages.mjs');
const usage = await import('../src/lib/usage.mjs');
const dashboard = await import('../src/lib/dashboard.mjs');
const workspaceBinding = await import('../src/lib/workspace-binding.mjs');
const { fileUriToPath, discoverAntigravityProjects, resolveDesktopProjectBinding } = workspaceBinding;

let dashServer = null;

function setUserConfig(obj) {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(obj, null, 2));
}

async function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  desktop.resetDiscoveryCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    desktop.resetDiscoveryCache();
  }
}

function httpGet(port, reqPath, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

after(() => {
  try {
    if (dashServer && !dashServer.killed) dashServer.kill();
  } catch { /* ignore */ }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

// 1. config.default.json defaults
test('1. config.default.json sets safe v3 defaults', () => {
  const def = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));
  assert.equal(def.default_target, 'auto');
  assert.equal(def.agy_path, '');
  assert.equal(def.allow_desktop_auto_exec, false);
  assert.equal(def.allow_desktop_edit, false);

  const loaded = paths.loadConfig();
  assert.equal(loaded.default_target, 'auto');
  assert.equal(loaded.agy_path, '');
  assert.equal(loaded.allow_desktop_auto_exec, false);
  assert.equal(loaded.allow_desktop_edit, false);
});

// 2. probeCli & agy_path
test('2. probeCli respects CSA_AGY_BIN and config.agy_path', async () => {
  await withEnv({ CSA_AGY_BIN: fakeAgy }, () => {
    const ok = agy.probeCli();
    assert.equal(ok.available, true);
    assert.equal(ok.source, 'CSA_AGY_BIN');
    assert.equal(ok.path, fakeAgy);
    assert.equal(ok.checked[0].found, true);
  });

  const missingBin = path.join(tmp, 'nonexistent-agy.mjs');
  await withEnv({ CSA_AGY_BIN: missingBin }, () => {
    const bad = agy.probeCli();
    assert.equal(bad.available, false);
    assert.equal(bad.source, null);
    assert.equal(bad.path, null);
    assert.equal(bad.checked[0].found, false);
  });

  const dummyAgy = path.join(tmp, 'custom-agy-path.mjs');
  fs.writeFileSync(dummyAgy, '// dummy agy binary for probeCli test\n');
  await withEnv({ CSA_AGY_BIN: undefined }, () => {
    const byCfg = agy.probeCli({ agy_path: dummyAgy });
    assert.equal(byCfg.available, true);
    assert.equal(byCfg.source, 'config.agy_path');
    assert.equal(byCfg.path, dummyAgy);
    assert.equal(byCfg.checked[0].label, 'config.agy_path');
    assert.equal(byCfg.checked[0].found, true);
    assert.equal(agy.findAgy({ agy_path: dummyAgy }), dummyAgy);
  });
});

// 3a. auto selection -> desktop available
test('3a. auto selects desktop when reachable with safe policy and logs transport metadata', async () => {
  await withEnv(
    { CSA_AGENTAPI: fakeAgentApi, CSA_AG_CONFIG: safeAgConfig, CSA_AGY_BIN: fakeAgy },
    async () => {
      const sel = await transport.selectTransport({ requestedTarget: 'auto', kind: 'read' });
      assert.equal(sel.transport, 'desktop');
      assert.equal(sel.requested_target, 'auto');
      assert.match(sel.transport_reason, /desktop/i);

      const started = await jobsApi.startJob({ prompt: 'auto desktop check', cwd: work, kind: 'read' });
      assert.equal(started.transport, 'desktop');
      assert.match(started.transport_reason, /desktop/i);
      assert.equal(started.warning, desktopJob.DESKTOP_WARNING);
      assert.equal(started.unrestricted, false);

      const finished = await jobsApi.waitJob(started.job_id, 30);
      assert.equal(finished.state, 'done');
      assert.equal(finished.transport, 'desktop');
      assert.match(finished.transport_reason, /desktop/i);

      const jobRec = store.readJob(started.job_id);
      assert.equal(jobRec.transport, 'desktop');
      assert.match(jobRec.transport_reason, /desktop/i);

      const jobMsgs = messages.readMessages({ limit: 50 }).filter((m) => m.job_id === started.job_id);
      assert.ok(jobMsgs.length >= 1);
      assert.ok(jobMsgs.some((m) => m.transport === 'desktop' && /desktop/i.test(m.transport_reason || '')));
    },
  );
});

// 3b. auto selection -> desktop unavailable, CLI available
test('3b. auto selects cli when desktop is unavailable and records transport in getCompact', async () => {
  await withEnv(
    { CSA_AGENTAPI: missingAgentApi, CSA_AG_CONFIG: safeAgConfig, CSA_AGY_BIN: fakeAgy },
    async () => {
      const sel = await transport.selectTransport({ requestedTarget: 'auto', kind: 'read' });
      assert.equal(sel.transport, 'cli');
      assert.match(sel.transport_reason, /desktop unavailable/i);
      assert.match(sel.transport_reason, /cli/i);

      const started = await jobsApi.startJob({ prompt: 'auto cli check', cwd: work, kind: 'read' });
      assert.equal(started.transport, 'cli');
      assert.match(started.transport_reason, /desktop unavailable/i);
      assert.match(started.transport_reason, /cli/i);
      assert.equal(started.warning, undefined);

      const waited = await jobsApi.waitJob(started.job_id, 30);
      assert.equal(waited.state, 'done');
      assert.equal(waited.status, 'done');
      assert.equal(waited.summary, 'fake answer');

      const compact = jobsApi.getCompact(started.job_id);
      assert.equal(compact.transport, 'cli');
      assert.match(compact.transport_reason, /desktop unavailable/i);
      assert.match(compact.transport_reason, /cli/i);
    },
  );
});

// 3c. auto selection -> neither desktop nor CLI available
test('3c. auto rejects with bilingual NO_TRANSPORT error, writes transport-state.json, and logs error without secrets', async () => {
  const secretToken = 'super-secret-csrf-token-998877665544';
  const missingCli = path.join(tmp, 'no-such-agy-cli.mjs');

  await withEnv(
    {
      CSA_AGENTAPI: missingAgentApi,
      CSA_AG_CONFIG: safeAgConfig,
      CSA_AGY_BIN: missingCli,
      ANTIGRAVITY_CSRF_TOKEN: secretToken,
    },
    async () => {
      let caught = null;
      try {
        await jobsApi.startJob({ prompt: 'nobody home', cwd: work, kind: 'read' });
      } catch (e) {
        caught = e;
      }

      assert.ok(caught, 'expected startJob to reject when no transport is available');
      assert.equal(caught.code, 'NO_TRANSPORT');

      const msg = caught.message;
      // Arabic section
      assert.ok(msg.includes('تعذّر العثور على وسيلة تشغيل متاحة'));
      assert.ok(msg.includes('ما تم فحصه:'));
      assert.ok(msg.includes('تطبيق Antigravity Desktop'));
      assert.ok(msg.includes('أداة agy CLI'));
      for (const marker of ['(أ)', '(ب)', '(ج)', '(د)', '(هـ)']) {
        assert.ok(msg.includes(marker), `missing Arabic step ${marker}`);
      }

      // English section
      assert.ok(msg.includes('No transport available'));
      assert.ok(msg.includes('What was checked:'));
      assert.ok(msg.includes('Antigravity Desktop'));
      assert.ok(msg.includes('agy CLI'));
      for (const marker of ['(a)', '(b)', '(c)', '(d)', '(e)']) {
        assert.ok(msg.includes(marker), `missing English step ${marker}`);
      }

      // Required remediation commands/settings
      assert.ok(msg.includes('agy_path'));
      assert.ok(msg.includes('agy --version'));
      assert.ok(msg.includes('agy_desktop_status'));
      assert.ok(!msg.includes(secretToken), 'error message must never leak CSRF token');

      // transport-state.json persisted without secrets
      const st = transport.readTransportState();
      assert.ok(st);
      assert.equal(st.transport, 'none');
      assert.equal(st.last_error?.code, 'NO_TRANSPORT');
      assert.ok(!JSON.stringify(st).includes(secretToken), 'transport-state.json must never leak CSRF token');

      // messages.jsonl logged the error
      const recent = messages.readMessages({ limit: 20 });
      assert.ok(
        recent.some((m) => m.kind === 'error' && m.transport === 'none' && String(m.text || '').includes('No transport available')),
      );
    },
  );
});

// 3d. explicit targets still work
test('3d. explicit target cli and explicit target desktop still work as before', async () => {
  await withEnv(
    { CSA_AGENTAPI: fakeAgentApi, CSA_AG_CONFIG: safeAgConfig, CSA_AGY_BIN: fakeAgy },
    async () => {
      const rCli = await jobsApi.startJob({ prompt: 'explicit cli task', cwd: work, kind: 'read', target: 'cli' });
      assert.equal(rCli.transport, 'cli');
      assert.match(rCli.transport_reason, /explicit target "cli"/i);
      const wCli = await jobsApi.waitJob(rCli.job_id, 30);
      assert.equal(wCli.state, 'done');
      assert.equal(wCli.transport, 'cli');
      assert.equal(wCli.summary, 'fake answer');

      const rDesk = await jobsApi.startJob({ prompt: 'explicit desktop task', cwd: work, kind: 'read', target: 'desktop' });
      assert.equal(rDesk.transport, 'desktop');
      assert.match(rDesk.transport_reason, /explicit target "desktop"/i);
      assert.equal(rDesk.warning, desktopJob.DESKTOP_WARNING);
      const wDesk = await jobsApi.waitJob(rDesk.job_id, 30);
      assert.equal(wDesk.state, 'done');
      assert.equal(wDesk.transport, 'desktop');
      assert.equal(wDesk.summary, 'fake agent finished');
    },
  );
});

// 4. Auto-run security gate is NEVER bypassed by auto fallback
test('4. desktop auto-exec security gate refuses without falling back to CLI unless explicitly opted in', async () => {
  setUserConfig({ allow_desktop_auto_exec: false });
  try {
    // 4a. AUTO policy + allow_desktop_auto_exec: false + CLI available -> MUST reject
    await withEnv(
      { CSA_AGENTAPI: fakeAgentApi, CSA_AG_CONFIG: autoAgConfig, CSA_AGY_BIN: fakeAgy },
      async () => {
        await assert.rejects(
          () => jobsApi.startJob({ prompt: 'should refuse auto policy', cwd: work, kind: 'read', target: 'auto' }),
          (err) => {
            assert.match(err.message, /without asking/i);
            assert.equal(err.code, 'DESKTOP_AUTO_EXEC_REFUSED');
            return true;
          },
        );
      },
    );

    // 4b. Unreadable/missing CSA_AG_CONFIG (fail-closed) + allow_desktop_auto_exec: false + CLI available -> MUST reject
    await withEnv(
      {
        CSA_AGENTAPI: fakeAgentApi,
        CSA_AG_CONFIG: path.join(tmp, 'missing-ag-config.json'),
        CSA_AGY_BIN: fakeAgy,
      },
      async () => {
        await assert.rejects(
          () => jobsApi.startJob({ prompt: 'should refuse unreadable config', cwd: work, kind: 'read', target: 'auto' }),
          (err) => {
            assert.match(err.message, /without asking/i);
            assert.equal(err.code, 'DESKTOP_AUTO_EXEC_REFUSED');
            return true;
          },
        );
      },
    );

    // 4c. AUTO policy + allow_desktop_auto_exec: true -> succeeds on desktop with unrestricted: true & warning
    setUserConfig({ allow_desktop_auto_exec: true });
    await withEnv(
      { CSA_AGENTAPI: fakeAgentApi, CSA_AG_CONFIG: autoAgConfig, CSA_AGY_BIN: fakeAgy },
      async () => {
        const started = await jobsApi.startJob({ prompt: 'opted in auto exec', cwd: work, kind: 'read', target: 'auto' });
        assert.equal(started.transport, 'desktop');
        assert.equal(started.unrestricted, true);
        assert.equal(started.warning, desktopJob.DESKTOP_WARNING);

        const done = await jobsApi.waitJob(started.job_id, 30);
        assert.equal(done.state, 'done');
        assert.equal(done.transport, 'desktop');
      },
    );
  } finally {
    setUserConfig({});
  }
});

// 5. Runtime automatic fallback (non-security failure)
test('5. runner automatically falls back from desktop to CLI on runtime Unavailable error', async () => {
  await withEnv(
    { CSA_AGENTAPI: fakeAgentApiFailConnect, CSA_AG_CONFIG: safeAgConfig, CSA_AGY_BIN: fakeAgy },
    async () => {
      const started = await jobsApi.startJob({ prompt: 'fallback test', cwd: work, kind: 'read', target: 'auto' });
      assert.equal(started.transport, 'desktop');

      const waited = await jobsApi.waitJob(started.job_id, 30);
      assert.equal(waited.state, 'done');
      assert.equal(waited.status, 'done');
      assert.equal(waited.transport, 'cli');
      assert.equal(waited.fallback_from, 'desktop');
      assert.ok(typeof waited.fallback_reason === 'string' && waited.fallback_reason.length > 0);
      assert.match(waited.fallback_reason, /Unavailable|connection refused|new-conversation/i);
      assert.match(waited.transport_reason, /fell back|fallback/i);
      assert.equal(waited.summary, 'fake answer');

      const jobMsgs = messages.readMessages({ limit: 50 }).filter((m) => m.job_id === started.job_id);
      assert.ok(jobMsgs.some((m) => m.kind === 'fallback' && m.transport === 'cli'));
    },
  );
});

// 6. Desktop kind: 'read' protection & files_changed check
test('6. desktop read job prepends DESKTOP_READONLY_NOTICE and flags files_changed violation', async () => {
  const roLog = path.join(tmp, 'desktop-readonly-agentapi.jsonl');
  await withEnv(
    {
      CSA_AGENTAPI: fakeAgentApi,
      CSA_AG_CONFIG: safeAgConfig,
      FAKE_AGENTAPI_LOG: roLog,
    },
    async () => {
      const started = await jobsApi.startJob({ prompt: 'inspect files only', cwd: work, kind: 'read', target: 'desktop' });
      const waited = await jobsApi.waitJob(started.job_id, 30);

      assert.equal(waited.state, 'done');
      assert.equal(waited.read_only_violation, true);
      assert.ok(typeof waited.read_only_warning === 'string');
      assert.match(waited.read_only_warning, /a\.txt/);
      assert.deepEqual(waited.files_changed, ['a.txt']);
      assert.ok(String(waited.handoff_notes || '').includes('a.txt'));

      const entries = fs
        .readFileSync(roLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const newConv = entries.find((e) => e.args[0] === 'new-conversation');
      assert.ok(newConv, 'expected new-conversation call in agentapi log');
      const sentPrompt = newConv.args[newConv.args.length - 1];
      assert.ok(sentPrompt.includes(desktopJob.DESKTOP_READONLY_NOTICE));
    },
  );
});

// 7. csa_board set_usage + Dashboard /api/status & HTML UI
test('7. csa_board set_usage redacts secrets, validates percentages, and dashboard API/HTML expose v3 fields', async () => {
  // 7a. applyBoardAction set_usage writes claude_usage and redacts secrets
  const setRes = await dashboard.applyBoardAction(
    {
      action: 'set_usage',
      five_hour_remaining_pct: 62.5,
      weekly_remaining_pct: 80,
      resets_at: '2026-11-20T10:00:00Z',
      note: 'ok token --csrf_token SECRET999999',
    },
    { openDashboard: false },
  );
  assert.equal(setRes.ok, true);

  const savedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(savedStatus.claude_usage.five_hour_remaining_pct, 62.5);
  assert.equal(savedStatus.claude_usage.weekly_remaining_pct, 80);
  assert.equal(savedStatus.claude_usage.resets_at, '2026-11-20T10:00:00Z');
  assert.ok(!String(savedStatus.claude_usage.note || '').includes('SECRET999999'));
  assert.ok(String(savedStatus.claude_usage.note || '').includes('[REDACTED]'));

  // 7b. invalid percentages fail cleanly without clobbering stored usage
  const badHigh = await dashboard.setClaudeUsage({ five_hour_remaining_pct: 150 });
  assert.equal(badHigh.ok, false);
  const badNeg = await dashboard.setClaudeUsage({ weekly_remaining_pct: -5 });
  assert.equal(badNeg.ok, false);

  const afterInvalid = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(afterInvalid.claude_usage.five_hour_remaining_pct, 62.5);
  assert.equal(afterInvalid.claude_usage.weekly_remaining_pct, 80);

  // 7c. Seed usage.jsonl + transport-state.json (NO_TRANSPORT) for dashboard server
  usage.appendUsage({
    job_id: 'dash-u1',
    model: 'gemini-4-neon-high',
    tier: 'deep',
    input_tokens: 4000,
    output_tokens: 1000,
    thinking_tokens: 500,
    total_tokens: 5500,
    target: 'cli',
  });
  usage.appendUsage({
    job_id: 'dash-u2',
    model: 'gemini-4-carbon',
    tier: 'deep',
    input_tokens: 9000,
    output_tokens: 2000,
    thinking_tokens: 1000,
    total_tokens: 12000,
    target: 'cli',
  });
  transport.recordTransportError(
    transport.buildNoTransportError({
      desktopCheck: { running: false, error: 'app not running' },
      desktopPolicyInfo: { auto_exec: true, policy: 'AUTO', preset: 'Auto', readable: true },
      cliCheck: { available: false, checked: [{ label: 'CSA_AGY_BIN', path: 'missing', found: false }] },
    }),
  );

  // 7d. Start dashboard server on a random port in 4450..4749 (never 4317)
  const port = 4450 + Math.floor(Math.random() * 300);
  const dashEnv = {
    ...process.env,
    CSA_HOME: tmp,
    CSA_STATUS: statusPath,
    CSA_QUOTA_FILE: quotaFile,
    CSA_AG_CONFIG: autoAgConfig,
    CSA_PROJECT: work,
    CSA_AGY_BIN: path.join(tmp, 'no-such-agy-for-dash.mjs'),
    PORT: String(port),
  };
  dashServer = spawn(process.execPath, [path.join(repoRoot, 'dashboard', 'server.mjs')], {
    env: dashEnv,
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
    } catch { /* wait for server to bind */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ready, true, `dashboard server failed to start on port ${port}`);

  // Verify /api/status payload
  const apiRes = await httpGet(port, '/api/status');
  assert.equal(apiRes.code, 200);
  const data = JSON.parse(apiRes.body);

  assert.equal(data.security.auto_exec_warning, true);
  assert.equal(data.transportState?.last_error?.code, 'NO_TRANSPORT');
  assert.equal(data.claudeUsage?.five_hour_remaining_pct, 62.5);
  assert.equal(data.claudeUsage?.weekly_remaining_pct, 80);
  assert.ok(!String(data.claudeUsage?.note || '').includes('SECRET999999'));

  const models = data.antigravityUsage?.models || [];
  const carbon = models.find((m) => m.label === 'Gemini 4 Carbon');
  assert.ok(carbon, 'expected Gemini 4 Carbon in antigravityUsage.models');
  assert.equal(carbon.remaining_pct, null);
  assert.equal(carbon.today_tokens, 12000);
  assert.equal(carbon.total_tokens, 12000);
  assert.equal(carbon.total_jobs, 1);

  const neon = models.find((m) => m.label === 'Gemini 4 Neon (High)');
  assert.ok(neon, 'expected Gemini 4 Neon (High) in antigravityUsage.models');
  assert.equal(neon.remaining_pct, 72);
  assert.equal(neon.today_tokens, 5500);
  assert.equal(neon.total_tokens, 5500);
  assert.equal(neon.total_jobs, 1);

  assert.ok(data.antigravityUsage?.top_model, 'expected antigravityUsage.top_model');
  assert.equal(data.antigravityUsage.top_model.label, 'Gemini 4 Carbon');
  assert.equal(data.antigravityUsage.top_model.total_tokens, 12000);

  // Verify GET / HTML UI and approved layout structure
  const htmlRes = await httpGet(port, '/');
  assert.equal(htmlRes.code, 200);
  assert.ok(htmlRes.body.includes('وضع التنفيذ التلقائي مفعّل: قد ينفّذ التطبيق أوامر دون موافقتك'));
  assert.ok(htmlRes.body.includes('agyModelsDd'));
  assert.ok(htmlRes.body.includes('class="card msgs-full"'));
  assert.ok(htmlRes.body.includes('class="cols3"'));
  assert.ok(htmlRes.body.includes('const working=others.filter(a=>a.active),inactive=others.filter(a=>!a.active);'));
  const iAgents = htmlRes.body.indexOf('id="agents"');
  const iMsgs = htmlRes.body.indexOf('id="msgs"');
  const iCols3 = htmlRes.body.indexOf('class="cols3"');
  const iUsage = htmlRes.body.indexOf('class="usage-bar"');
  assert.ok(iAgents > 0 && iMsgs > iAgents && iCols3 > iMsgs && iUsage > iCols3);
  for (const lang of ['ar', 'en', 'zh', 'hi', 'es', 'fr', 'pt', 'ru']) {
    assert.ok(htmlRes.body.includes(`value="${lang}"`), `missing language option ${lang}`);
    assert.match(htmlRes.body, new RegExp(`\\b${lang}:\\{dir:`), `missing language dictionary ${lang}`);
  }
});

// 8. Desktop project & folder binding guard
test('8. desktop project & folder binding guard stops unbound projects, supports allow_non_project, explicit binding, and auto-discovery', async () => {
  const unboundWorkDir = fs.realpathSync.native(fs.mkdtempSync(path.join(work, 'unbound-')));
  const boundWorkDir = fs.realpathSync.native(fs.mkdtempSync(path.join(work, 'bound-')));
  const autoWorkDir = fs.realpathSync.native(fs.mkdtempSync(path.join(work, 'auto-')));
  const emptyAnnDir = fs.mkdtempSync(path.join(tmp, 'empty-ann-'));
  const emptyBrainDir = fs.mkdtempSync(path.join(tmp, 'empty-brain-'));
  const annotationsDir = fs.mkdtempSync(path.join(tmp, 'auto-ann-'));
  const nonProjLog = path.join(tmp, 'desktop-nonproj-agentapi.jsonl');

  await withEnv(
    {
      CSA_ENFORCE_PROJECT_BINDING: '1',
      CSA_AGENTAPI: fakeAgentApi,
      CSA_AG_CONFIG: safeAgConfig,
      CSA_AGY_BIN: fakeAgy,
      CSA_ANNOTATIONS_DIR: emptyAnnDir,
      CSA_BRAIN_DIR: emptyBrainDir,
      FAKE_AGENTAPI_LOG: nonProjLog,
    },
    async () => {
      // 8a. Unbound project stops and asks first (PROJECT_BINDING_REQUIRED), without falling back to CLI
      await assert.rejects(
        () => jobsApi.startJob({ prompt: 'unbound task', cwd: unboundWorkDir, kind: 'read', target: 'auto' }),
        (err) => {
          assert.equal(err.code, 'PROJECT_BINDING_REQUIRED');
          assert.ok(err.message.includes('Which Antigravity project / conversation should this task be bound to?'));
          assert.ok(err.message.includes('أي مشروع أو محادثة في Antigravity سيتم ربط المهمة عليها؟'));
          assert.ok(err.message.includes('And which folder (cwd) should be worked on?'));
          assert.ok(err.message.includes('وأي فولدر (cwd) سيتم العمل عليه؟'));
          assert.ok(err.message.includes('allow_non_project: true'));
          return true;
        },
      );

      // 8b. allow_non_project: true allows new conversation in Non-Project and injects WORKSPACE CONTEXT (cwd)
      const startedNonProj = await jobsApi.startJob({
        prompt: 'allowed non-project',
        cwd: unboundWorkDir,
        kind: 'read',
        target: 'auto',
        allow_non_project: true,
      });
      assert.equal(startedNonProj.transport, 'desktop');
      assert.equal(startedNonProj.binding_mode, 'allow_non_project');

      const doneNonProj = await jobsApi.waitJob(startedNonProj.job_id, 30);
      assert.equal(doneNonProj.state, 'done');

      const ctxHeader = desktopJob.workspaceContextHeader({ cwd: unboundWorkDir, add_dirs: [] });
      assert.ok(ctxHeader.includes('WORKSPACE CONTEXT:'));
      assert.ok(ctxHeader.includes(`Working Directory (cwd): ${unboundWorkDir}`));

      const logEntries = fs
        .readFileSync(nonProjLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const newConvEntry = logEntries.find((e) => e.args[0] === 'new-conversation');
      assert.ok(newConvEntry, 'expected new-conversation call in agentapi log for allow_non_project');
      const sentPrompt = newConvEntry.args[newConvEntry.args.length - 1];
      assert.ok(sentPrompt.includes('WORKSPACE CONTEXT:'));
      assert.ok(sentPrompt.includes(`Working Directory (cwd): ${unboundWorkDir}`));

      // 8c. Explicit conversation_id binds cwd and persists in workspace-bindings.json for subsequent tasks
      const explicitConvId = '22222222-3333-4444-8555-666666666666';
      const started1 = await jobsApi.startJob({
        prompt: 'first bound task',
        cwd: boundWorkDir,
        kind: 'read',
        target: 'desktop',
        conversation_id: explicitConvId,
      });
      assert.equal(started1.transport, 'desktop');
      assert.equal(started1.binding_mode, 'explicit_conversation');
      assert.equal(started1.conversation_id, explicitConvId);
      const done1 = await jobsApi.waitJob(started1.job_id, 30);
      assert.equal(done1.state, 'done');

      const bindingsPath = path.join(tmp, 'workspace-bindings.json');
      assert.equal(fs.existsSync(bindingsPath), true);
      const savedData = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
      assert.ok(
        Array.isArray(savedData.bindings) &&
          savedData.bindings.some((b) => b.conversation_id === explicitConvId && b.cwd === boundWorkDir),
      );

      const started2 = await jobsApi.startJob({
        prompt: 'second task on same cwd',
        cwd: boundWorkDir,
        kind: 'read',
        target: 'auto',
      });
      assert.equal(started2.transport, 'desktop');
      assert.equal(started2.binding_mode, 'saved_binding');
      assert.equal(started2.conversation_id, explicitConvId);
      const done2 = await jobsApi.waitJob(started2.job_id, 30);
      assert.equal(done2.state, 'done');
    },
  );

  // 8d. Unit check of discoverAntigravityProjects + fileUriToPath + resolveDesktopProjectBinding
  const autoConvId = '33333333-4444-4555-8666-777777777777';
  fs.writeFileSync(path.join(annotationsDir, `${autoConvId}.pbtxt`), '# dummy annotation\n');
  const autoUri = 'file:///' + encodeURI(autoWorkDir.replace(/\\/g, '/'));
  assert.equal(
    workspaceBinding.normalizeCwdKey(fileUriToPath(autoUri)),
    workspaceBinding.normalizeCwdKey(autoWorkDir),
  );

  const mockGetMetadata = async () => ({
    response: {
      conversationMetadata: {
        metadata: {
          projectId: 'proj-123',
          workspaceUris: [autoUri],
        },
      },
    },
  });

  await withEnv(
    {
      CSA_ENFORCE_PROJECT_BINDING: '1',
      CSA_ANNOTATIONS_DIR: annotationsDir,
      CSA_BRAIN_DIR: emptyBrainDir,
    },
    async () => {
      const discovered = await discoverAntigravityProjects({ getMetadataFn: mockGetMetadata });
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].conversation_id, autoConvId);
      assert.equal(discovered[0].project_id, 'proj-123');

      const resolved = await resolveDesktopProjectBinding({
        cwd: autoWorkDir,
        config: {},
        deps: { getMetadata: mockGetMetadata },
      });
      assert.equal(resolved.mode, 'auto_discovered');
      assert.equal(resolved.conversation_id, autoConvId);
      assert.equal(resolved.project_id, 'proj-123');
    },
  );
});
