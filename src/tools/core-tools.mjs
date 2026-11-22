// Core MCP tools for Claude: agy_task, agy_wait, agy_result, agy_approve, agy_cancel, agy_list, agy_models, agy_usage, agy_messages.
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../lib/paths.mjs';
import { readJob, listJobs, jobDir, readJson } from '../lib/store.mjs';
import { startJob, waitJob, cancelJob, getCompact, fullResponse, TERMINAL } from '../lib/jobs-api.mjs';
import { listModels } from '../lib/models.mjs';
import { getQuota, quotaById } from '../lib/quota.mjs';
import { usageReport } from '../lib/usage.mjs';
import { readMessages, logMessage } from '../lib/messages.mjs';
import { readNotifications } from '../lib/notifications.mjs';
import { runProcess } from '../lib/agy.mjs';
import { redact, childEnv, resolveSafe, isInside } from '../lib/safety.mjs';
import { writeJson } from '../lib/store.mjs';
import { shellInvocation } from '../lib/platform.mjs';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: redact(String(e?.message || e)) }] });
const guard = (fn) => async (args) => {
  try { return ok(await fn(args || {})); } catch (e) { return fail(e); }
};

const OUT_LIMIT = 8000;

function trunc(s) {
  const t = redact(String(s || ''));
  return t.length > OUT_LIMIT ? t.slice(0, OUT_LIMIT) + '\n... [truncated]' : t;
}

export async function approveJob({ job_id, indexes, rerun = false }) {
  const job = readJob(job_id);
  if (!job) throw new Error(`Unknown job: ${job_id}`);
  const resFile = path.join(jobDir(job_id), 'result.json');
  const result = readJson(resFile);
  const cmds = result?.commands_requested || [];
  if (!cmds.length) throw new Error('This job has no commands_requested.');
  const uniq = [...new Set(indexes)];
  for (const i of uniq) {
    if (!Number.isInteger(i) || i < 0 || i >= cmds.length) throw new Error(`Index ${i} is out of range (0..${cmds.length - 1}).`);
  }
  if (!uniq.length) throw new Error('indexes is empty.');
  // Make sure the app's token is known to redact() before any command output is collected.
  try { await (await import('../lib/desktop.mjs')).discoverLs(); } catch { /* app not running: nothing to mask */ }
  const config = loadConfig();
  const already = new Set(result.approved_executed || []);
  const allowedDirs = [job.cwd, ...(job.add_dirs || [])];
  const executed = [];
  const refused = [];
  for (const i of uniq) {
    const c = cmds[i];
    if (already.has(i) && !rerun) {
      refused.push({ index: i, reason: 'already executed; pass rerun=true to run it again' });
      continue;
    }
    const cwd = resolveSafe(path.resolve(job.cwd, c.cwd && c.cwd !== '' ? c.cwd : '.'));
    if (!allowedDirs.some((d) => isInside(cwd, d))) {
      refused.push({ index: i, reason: `cwd ${cwd} is outside the job directories` });
      continue;
    }
    logMessage({
      direction: 'claude->antigravity',
      channel: job.target,
      transport: job.transport || job.target,
      transport_reason: job.transport_reason || null,
      job_id,
      chain_id: job.chain_id,
      conversation_id: result.conversation_id,
      model: job.model,
      kind: 'approval',
      text: `Approved command #${i}: ${c.command}`,
    });
    const sh = shellInvocation(c.command);
    const r = await runProcess(sh.cmd, sh.args, {
      cwd,
      timeoutMs: (config.approved_command_timeout_s || 120) * 1000,
      env: childEnv(),
    });
    already.add(i);
    writeJson(resFile, { ...readJson(resFile), approved_executed: [...already].sort((x, y) => x - y) });
    executed.push({
      index: i,
      command: c.command,
      cwd,
      exit_code: r.code,
      timed_out: r.timedOut,
      output: trunc(`${r.stdout}${r.stderr ? `
[stderr]
${r.stderr}` : ''}`),
    });
  }
  if (!executed.length) return { executed, refused, continuation_job_id: null };
  const report = executed
    .map((e) => `Command: ${e.command}\nExit code: ${e.exit_code}${e.timed_out ? ' (timed out)' : ''}\nOutput:\n${e.output}`)
    .join('\n\n---\n');
  const next = await startJob({
    prompt: `The following commands you requested were approved and run by the reviewer. Here are their results. Continue the task using them.\n\n${report}`,
    cwd: job.cwd,
    kind: job.kind,
    tier: job.tier === 'explicit' ? undefined : job.tier,
    model: job.model,
    add_dirs: job.add_dirs,
    timeout_s: job.timeout_s,
    conversation: result.conversation_id || job.conversation_id || undefined,
    target: job.target,
    title: job.title || undefined,
    chain_id: job.chain_id || undefined,
    hop: job.hop || 0,
  });
  return { executed, refused, continuation_job_id: next.job_id, model: next.model };
}

export function register(server) {
  server.registerTool(
    'agy_task',
    {
      description: 'Start an Antigravity agent job (runs in background). Returns job_id and the chosen model, tier and reason. Use agy_wait to get the result.',
      inputSchema: {
        prompt: z.string().describe('The task for the agent.'),
        cwd: z.string().describe('Absolute working directory.'),
        kind: z.enum(['read', 'edit']).default('read').describe('read = no file changes; edit = may edit files.'),
        tier: z.enum(['auto', 'fast', 'balanced', 'deep']).default('auto'),
        model: z.string().optional().describe('Model id or label; overrides tier.'),
        add_dirs: z.array(z.string()).optional().describe('Extra directories the agent may access.'),
        timeout_s: z.number().int().positive().optional(),
        continue_job: z.string().optional().describe('Job id whose conversation to continue.'),
        conversation_id: z.string().optional().describe('Existing Antigravity project conversation UUID to bind/continue for this cwd.'),
        allow_non_project: z.boolean().optional().describe('Set true to allow opening a new Desktop conversation in Non-Project when cwd is not bound to an Antigravity project.'),
        target: z.enum(['auto', 'cli', 'desktop']).optional().describe('Execution target: auto (default: desktop if available, else cli), cli, or desktop.'),
        title: z.string().optional(),
        notify_session: z.string().optional().describe('Optional Claude session name to notify on completion (with exact completed_at) or approval/permission request.'),
      },
    },
    guard(async (a) => {
      let conversation;
      let chain_id;
      let hop;
      let inheritedTarget;
      if (a.continue_job) {
        const prev = readJob(a.continue_job);
        if (!prev) throw new Error(`Unknown job to continue: ${a.continue_job}`);
        const res = readJson(path.join(jobDir(prev.id), 'result.json'));
        conversation = res?.conversation_id || prev.conversation_id || undefined;
        if (!conversation) throw new Error('The job to continue has no conversation id (it may still be running).');
        chain_id = prev.chain_id || undefined;
        hop = prev.hop || 0;
        inheritedTarget = prev.transport || prev.target || undefined;
      }
      const r = await startJob({
        prompt: a.prompt,
        cwd: a.cwd,
        kind: a.kind,
        tier: a.tier,
        model: a.model,
        add_dirs: a.add_dirs,
        timeout_s: a.timeout_s,
        conversation: conversation || a.conversation_id || undefined,
        allow_non_project: a.allow_non_project,
        target: a.target || inheritedTarget,
        title: a.title,
        notify_session: a.notify_session,
        chain_id,
        hop,
      });
      return { ...r, state: 'queued', next: 'Call agy_wait with this job_id.' };
    }),
  );

  server.registerTool(
    'agy_wait',
    {
      description: 'Wait up to wait_s (max 50) for a job; returns its compact state/result.',
      inputSchema: { job_id: z.string(), wait_s: z.number().min(0).max(50).default(30) },
    },
    guard(({ job_id, wait_s }) => waitJob(job_id, wait_s ?? 30)),
  );

  server.registerTool(
    'agy_result',
    {
      description: 'Get a job result. full=true also returns the agent\'s complete response text.',
      inputSchema: { job_id: z.string(), full: z.boolean().default(false), max_chars: z.number().int().positive().max(100000).default(20000) },
    },
    guard(({ job_id, full, max_chars }) => {
      const c = getCompact(job_id);
      if (full) c.response = fullResponse(job_id, max_chars ?? 20000);
      return c;
    }),
  );

  server.registerTool(
    'agy_approve',
    {
      description: 'Run commands the agent requested (by index in commands_requested) via the system shell (PowerShell on Windows, zsh/sh on macOS/Linux), then continue the conversation with their output as a new job.',
      inputSchema: { job_id: z.string(), indexes: z.array(z.number().int().min(0)).min(1), rerun: z.boolean().default(false).describe('Allow re-running an index that was already executed.') },
    },
    guard(approveJob),
  );

  server.registerTool(
    'agy_cancel',
    { description: 'Cancel a queued or running job.', inputSchema: { job_id: z.string() } },
    guard(({ job_id }) => cancelJob(job_id)),
  );

  server.registerTool(
    'agy_list',
    {
      description: 'List recent jobs, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
    },
    guard(({ limit }) => ({
      jobs: listJobs({ limit: limit ?? 10 }).map((j) => ({
        job_id: j.id,
        state: j.state,
        target: j.target,
        transport: j.transport || j.target,
        transport_reason: j.transport_reason || null,
        kind: j.kind,
        model: j.model,
        tier: j.tier,
        tier_reason: j.tier_reason || null,
        title: j.title,
        created: j.created,
        ended: j.ended,
        completed_at: j.ended || null,
        terminal: TERMINAL.has(j.state),
      })),
    })),
  );

  server.registerTool(
    'agy_models',
    {
      description: 'List Antigravity models with remaining quota and the tiers they belong to.',
      inputSchema: { refresh: z.boolean().default(false) },
    },
    guard(async ({ refresh }) => {
      const config = loadConfig();
      const models = await listModels({ refresh: !!refresh });
      let quota = null;
      let quota_error;
      try { quota = await getQuota(); } catch (e) { quota_error = e.message; }
      const map = quota ? quotaById(quota, models) : {};
      return {
        models: models.map((m) => ({
          ...m,
          tiers: Object.keys(config.tiers).filter((t) => (config.tiers[t] || []).includes(m.id)),
          remaining_pct: map[m.id] !== undefined ? Math.round(map[m.id] * 1000) / 10 : null,
        })),
        quota_error,
      };
    }),
  );

  server.registerTool(
    'agy_usage',
    { description: 'Token usage, estimated Claude tokens saved, and remaining Antigravity quota.', inputSchema: {} },
    guard(async () => {
      let quota = null;
      let quota_error;
      try { quota = await getQuota(); } catch (e) { quota_error = e.message; }
      return { usage: usageReport(), quota, quota_error };
    }),
  );

  server.registerTool(
    'agy_messages',
    {
      description: 'Read the message log between Claude and Antigravity.',
      inputSchema: { limit: z.number().int().min(1).max(500).default(30), since: z.string().optional().describe('ISO timestamp') },
    },
    guard(({ limit, since }) => ({
      messages: readMessages({ limit: limit ?? 30, since }),
      notifications: readNotifications({ limit: Math.min(limit ?? 30, 50), since }),
    })),
  );
}
