// Detached worker for one job. Usage: node runner.mjs <jobDir>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/paths.mjs';
import { readJson, writeJson, updateJob } from './lib/store.mjs';
import { buildAgyArgs, runAgy, parseStream, probeCli, RESULT_SCHEMA } from './lib/agy.mjs';
import { logMessage } from './lib/messages.mjs';
import { appendUsage } from './lib/usage.mjs';
import { redact, childEnv } from './lib/safety.mjs';
import { resolveModel } from './lib/jobs-api.mjs';
import { buildNoTransportError, recordTransportError, recordTransportSuccess } from './lib/transport.mjs';
import { desktopPolicy } from './lib/desktop.mjs';
import { refreshClaudeUsage } from './lib/claude-usage.mjs';
import { recordNotification } from './lib/notifications.mjs';

const jobDir = path.resolve(process.argv[2] || '');
const jobFile = path.join(jobDir, 'job.json');
const resultFile = path.join(jobDir, 'result.json');

function nowIso() { return new Date().toISOString(); }

function baseResult(job) {
  return {
    job_id: job.id,
    state: 'done',
    status: 'done',
    summary: '',
    files_changed: [],
    commands_requested: [],
    denied_files: [],
    followups: [],
    handoff_notes: '',
    conversation_id: job.conversation_id || null,
    usage: null,
    model: job.model,
    tier: job.tier,
    tier_reason: job.tier_reason,
    transport: job.transport || job.target,
    transport_reason: job.transport_reason || null,
    fallback_from: job.fallback_from || null,
    fallback_reason: job.fallback_reason || null,
  };
}

function writeResult(job, obj) {
  const doneAt = obj.completed_at || nowIso();
  const res = { ...baseResult(job), ...obj, completed_at: doneAt };
  if (!obj.state) res.state = res.status === 'failed' ? 'failed' : 'done';
  if (res.error) res.error = redact(String(res.error));
  writeJson(resultFile, res);
  const cur = readJson(jobFile);
  if (cur && cur.state === 'cancelled') return res; // cancellation wins
  updateJob(job.id, {
    state: res.state,
    ended: doneAt,
    conversation_id: res.conversation_id || cur?.conversation_id || null,
    error: res.error || null,
  });
  try { refreshClaudeUsage({ reason: `job_finish:${res.state}` }); } catch { /* never throw */ }
  return res;
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function runCli(job) {
  const config = loadConfig();
  let promptText = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8');
  const addDirs = [...(job.add_dirs || [])];
  const maxInline = config.max_inline_prompt_chars || 20000;
  if (promptText.length > maxInline) {
    const p = path.join(jobDir, 'prompt.txt');
    promptText = `Your full instructions are in the file ${p}. Read it first, then carry out the task exactly as written there.`;
    addDirs.push(jobDir);
  }
  const schemaFile = path.join(jobDir, 'schema.json');
  writeJson(schemaFile, RESULT_SCHEMA);
  const args = buildAgyArgs({
    prompt: promptText,
    kind: job.kind,
    model: job.model,
    conversation: job.conversation_id,
    addDirs,
    timeoutS: job.timeout_s,
    schema: schemaFile,
  });
  const env = childEnv(job.chain_id ? { CSA_CHAIN_ID: job.chain_id, CSA_HOP: String((job.hop || 0) + 1) } : {});
  const run = await runAgy(args, { cwd: job.cwd, timeoutMs: (job.timeout_s || 600) * 1000 + 15000, env });
  fs.writeFileSync(path.join(jobDir, 'stdout.ndjson'), run.stdout || '');
  const parsed = parseStream(run.stdout);
  const r = parsed.result;

  if (run.timedOut) {
    return writeResult(job, { status: 'failed', error: `Timed out after ${job.timeout_s}s.` });
  }
  if (!r) {
    if (run.capped) return writeResult(job, { status: 'failed', error: 'agy output exceeded 8 MB; the process was stopped.' });
    const err = redact((run.stderr || run.stdout || `agy exited with code ${run.code}`).toString().slice(0, 1500));
    return writeResult(job, { status: 'failed', error: `agy produced no result (exit ${run.code}). ${err}` });
  }

  const response = typeof r.response === 'string' ? r.response : '';
  fs.writeFileSync(path.join(jobDir, 'response.txt'), response);
  const so = (r.structured_output && typeof r.structured_output === 'object' ? r.structured_output : null) || tryParseJson(response) || {};

  const commands = asArray(so.commands_requested)
    .map((c) => (typeof c === 'string' ? { command: c } : c))
    .filter((c) => c && typeof c.command === 'string' && c.command.trim())
    .map((c) => ({ command: redact(c.command), cwd: c.cwd || job.cwd, reason: c.reason || '' }));
  const deniedFiles = [];
  for (const d of parsed.denied) {
    if (d.kind === 'command') {
      if (!commands.some((c) => c.command === d.target)) {
        commands.push({ command: d.target, cwd: d.cwd || job.cwd, reason: 'Denied in headless mode; needs approval.' });
      }
    } else if (d.target) {
      deniedFiles.push({ tool: d.tool, path: d.target });
    }
  }

  const failed = r.status && r.status !== 'SUCCESS';
  let status = 'done';
  if (failed) status = 'failed';
  else if (commands.length) status = 'needs_approval';
  else if (deniedFiles.length) status = 'blocked';

  const u = r.usage || null;
  const usage = u
    ? {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        thinking_tokens: u.thinking_tokens || 0,
        cache_read_tokens: u.cache_read_tokens || 0,
        total_tokens: u.total_tokens || 0,
      }
    : null;

  const res = writeResult(job, {
    status,
    state: status === 'failed' ? 'failed' : 'done',
    summary: typeof so.summary === 'string' && so.summary ? so.summary : response,
    files_changed: asArray(so.files_changed).map(String),
    commands_requested: commands,
    denied_files: deniedFiles,
    followups: asArray(so.followups).map(String),
    handoff_notes: typeof so.handoff_notes === 'string' ? so.handoff_notes : '',
    conversation_id: r.conversation_id || job.conversation_id || null,
    usage,
    error: failed ? `agy reported status ${r.status}` : undefined,
  });

  if (usage) {
    appendUsage({ job_id: job.id, model: job.model, tier: job.tier, target: 'cli', ...usage });
  }
  const startMs = Date.parse(job.started || job.created || '') || Date.now();
  const endMs = Date.parse(res.completed_at || '') || Date.now();
  const elapsedS = Math.max(0, Math.round((endMs - startMs) / 100) / 10);
  const needsApproval = status === 'needs_approval' || status === 'blocked' || commands.length > 0;
  recordNotification({
    type: needsApproval ? 'approval_needed' : 'task_completed',
    job_id: job.id,
    chain_id: job.chain_id || null,
    conversation_id: res.conversation_id,
    target_session: job.notify_session || null,
    status,
    completed_at: res.completed_at,
    started_at: job.started || job.created || null,
    elapsed_s: elapsedS,
    model: job.model,
    transport: job.transport || 'cli',
    commands_requested: commands,
    denied_files: deniedFiles,
    files_changed: res.files_changed,
    summary: res.summary || res.error || '',
  });
  logMessage({
    direction: 'antigravity->claude',
    channel: 'cli',
    transport: job.transport || 'cli',
    transport_reason: job.transport_reason || null,
    job_id: job.id,
    chain_id: job.chain_id,
    conversation_id: res.conversation_id,
    model: job.model,
    kind: status === 'failed' ? 'error' : 'reply',
    status,
    completed_at: res.completed_at,
    text: res.summary || res.error || '',
  });
  return res;
}

async function main() {
  const job = readJson(jobFile);
  if (!job) process.exit(2);
  if (job.state === 'cancelled') return;
  updateJob(job.id, { state: 'running', started: nowIso(), runner_pid: process.pid });
  try {
    if (job.target === 'desktop') {
      const { runDesktopJob } = await import('./lib/desktop-job.mjs');
      const fresh = readJson(jobFile);
      const cfg = loadConfig();
      const dr = await runDesktopJob(fresh, {
        jobDir,
        writeResult: (obj) => writeResult(fresh, obj),
        logMessage,
        config: cfg,
        allowCliFallback: fresh.requested_target === 'auto',
      });
      if (dr && dr.fallbackNeeded) {
        const cli = probeCli(cfg);
        if (cli.available) {
          let promptText = '';
          try { promptText = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8'); } catch {}
          const baseModelInput = {
            prompt: promptText,
            kind: fresh.kind,
            add_dirs: fresh.add_dirs,
            tier: fresh.tier === 'explicit' ? undefined : fresh.tier,
          };
          let picked;
          try {
            picked = await resolveModel(cfg, { ...baseModelInput, model: fresh.requested_model || undefined }, 'cli');
          } catch {
            picked = await resolveModel(cfg, baseModelInput, 'cli');
          }
          const fallbackReason = redact(String(dr.reason || 'desktop unreachable')).slice(0, 300);
          const transportReason = `auto: desktop failed (${fallbackReason}); fell back to cli (${cli.source})`;
          updateJob(fresh.id, {
            target: 'cli',
            transport: 'cli',
            fallback_from: 'desktop',
            fallback_reason: fallbackReason,
            transport_reason: transportReason,
            model: picked.model,
            tier: picked.tier,
            tier_reason: picked.reason,
          });
          recordTransportSuccess({
            transport: 'cli',
            transport_reason: transportReason,
            fallback_from: 'desktop',
            fallback_reason: fallbackReason,
          });
          logMessage({
            direction: 'claude->antigravity',
            channel: 'cli',
            transport: 'cli',
            transport_reason: transportReason,
            job_id: fresh.id,
            chain_id: fresh.chain_id,
            model: picked.model,
            kind: 'fallback',
            text: `Desktop unavailable/refused (${fallbackReason}); fell back automatically to CLI`,
          });
          await runCli(readJson(jobFile));
          return;
        }
        const errObj = buildNoTransportError({
          desktopCheck: { running: false, error: dr.reason || 'Desktop unreachable' },
          desktopPolicyInfo: desktopPolicy(),
          cliCheck: cli,
        });
        recordTransportError(errObj);
        const failedJob = updateJob(fresh.id, {
          transport: 'none',
          transport_reason: errObj.reason,
          fallback_from: 'desktop',
          fallback_reason: redact(String(dr.reason || '')).slice(0, 300) || null,
        });
        writeResult(failedJob, {
          status: 'failed',
          summary: errObj.message,
          error: errObj.message,
        });
        logMessage({
          direction: 'antigravity->claude',
          channel: 'desktop',
          transport: 'none',
          transport_reason: errObj.reason,
          job_id: fresh.id,
          chain_id: fresh.chain_id,
          model: fresh.model,
          kind: 'error',
          text: errObj.message,
        });
        return;
      }
      const after = readJson(jobFile);
      if (after && (after.state === 'running' || after.state === 'queued')) {
        writeResult(fresh, { status: 'failed', error: 'Desktop job finished without writing a result.' });
      }
    } else {
      await runCli(readJson(jobFile));
    }
  } catch (e) {
    const cur = readJson(jobFile) || job;
    try {
      writeResult(cur, { status: 'failed', error: `Runner error: ${e?.message || e}` });
      logMessage({
        direction: 'antigravity->claude',
        channel: cur.target || job.target,
        transport: cur.transport || cur.target || job.target,
        transport_reason: cur.transport_reason || job.transport_reason || null,
        job_id: job.id,
        chain_id: job.chain_id,
        model: cur.model || job.model,
        kind: 'error',
        text: String(e?.message || e),
      });
    } catch { /* nothing more to do */ }
  }
}

main().then(() => process.exit(0), () => process.exit(1));
