// Runs one job inside the Antigravity desktop app (visible conversation) and polls for a result file.
import fs from 'node:fs';
import path from 'node:path';
import { newConversation, sendMessage, redactText } from './desktop.mjs';
import { recordNotification } from './notifications.mjs';

export const DESKTOP_WARNING = "Runs with the Antigravity app's own permissions; the app may run commands without asking.";
export const DESKTOP_READONLY_NOTICE = 'CRITICAL READ-ONLY NOTICE: Antigravity Desktop does NOT enforce plan-mode restrictions. You MUST NOT create, modify, overwrite, or delete any files, and you MUST keep files_changed as [].';
const DESKTOP_MODELS = new Set(['flash_lite', 'flash', 'pro']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function workspaceContextHeader(job) {
  if (!job?.cwd) return '';
  const added = Array.isArray(job.add_dirs) && job.add_dirs.length ? job.add_dirs.join(', ') : 'none';
  return [
    'WORKSPACE CONTEXT:',
    `- Working Directory (cwd): ${job.cwd}`,
    `- Added Directories: ${added}`,
    'Operate strictly inside this Working Directory and do not search outside it.',
  ].join('\n');
}

export function resultInstruction(resultPath, job = null) {
  const targetSession = job?.notify_session ? ` (target session: "${job.notify_session}")` : '';
  const jobTag = job?.id ? ` for job ${job.id}` : '';
  return [
    '',
    '---',
    'CLAUDE APPROVAL & COMPLETION NOTIFICATION PROTOCOL:',
    '1. Approval / Permission Requests: If a command approval, elevated action, or permission prompt is required during execution, do NOT bypass permissions or stall silently. Record the needed command(s) in commands_requested (or denied_files) with status "needs_approval" (or "blocked"), include the exact current ISO-8601 timestamp in "completed_at", write the result file, AND immediately notify the delegating Claude session' + targetSession + ' (using claude-code MCP ListAgents + SendMessage if available) to ask whether Claude can grant approval (via agy_approve or reply) before proceeding.',
    '2. Exact Completion Notification: When you finish the task' + jobTag + ', record the exact ISO-8601 finish timestamp in "completed_at", write the result JSON file below, AND immediately notify the delegating Claude session' + targetSession + ' (using claude-code MCP ListAgents + SendMessage if available) with the job_id, status, exact completed_at timestamp, files_changed, and a concise summary so Claude knows the exact moment you finished.',
    '',
    'When you have finished (or need approval), write your result as a single JSON file at this exact absolute path:',
    resultPath,
    'The JSON object must have these fields:',
    '{"status":"done"|"needs_approval"|"blocked"|"failed","completed_at":"<ISO-8601 timestamp>","summary":"short text","files_changed":["path"],',
    '"commands_requested":[{"command":"...","cwd":"...","reason":"..."}],"denied_files":[{"tool":"...","path":"..."}],',
    '"followups":["..."],"handoff_notes":"anything the reviewer must know"}',
    'Write the file last, only when the work is complete or waiting for Claude approval. Do not stall waiting for user input; if blocked or needing permission, set status to "needs_approval" or "blocked", explain in summary, and notify Claude immediately.',
  ].join('\n');
}

export function desktopModel(job, config) {
  const map = (config && config.desktop_model_map) || { fast: 'flash', balanced: 'flash', deep: 'pro' };
  const explicit = job.model && (DESKTOP_MODELS.has(job.model) || /explicit/i.test(job.tier_reason || '') || !job.tier);
  if (explicit) return job.model;
  return map[job.tier] || map.balanced || 'flash';
}

function readAgentResult(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const arr = (v) => (Array.isArray(v) ? v : []);
const STATUSES = new Set(['done', 'needs_approval', 'blocked', 'failed']);

// Normalises what the app agent wrote into a result.json object.
export function fromAgentResult(base, r) {
  const status = STATUSES.has(r.status) ? r.status : 'done';
  const completed_at = typeof r.completed_at === 'string' && !Number.isNaN(Date.parse(r.completed_at))
    ? new Date(Date.parse(r.completed_at)).toISOString()
    : new Date().toISOString();
  return {
    ...base,
    state: status === 'failed' ? 'failed' : 'done',
    status,
    completed_at,
    summary: String(r.summary ?? ''),
    files_changed: arr(r.files_changed),
    commands_requested: arr(r.commands_requested),
    denied_files: arr(r.denied_files),
    followups: arr(r.followups),
    handoff_notes: String(r.handoff_notes ?? ''),
  };
}

function applyReadOnlyCheck(out, job) {
  if ((job?.kind || 'read') === 'read' && Array.isArray(out.files_changed) && out.files_changed.length > 0) {
    out.read_only_violation = true;
    out.read_only_warning = `WARNING: Desktop read-only task does not guarantee plan mode; files_changed reported: ${out.files_changed.join(', ')}`;
    out.handoff_notes = [out.read_only_warning, out.handoff_notes].filter(Boolean).join('\n');
  }
  return out;
}

// The app agent can finish after our timeout. If it wrote its result late, adopt it instead of
// leaving the job failed. Returns the new result, or null when there is nothing to adopt.
export function adoptLateResult(job, jobDir, previous) {
  if (job?.target !== 'desktop' || job.state !== 'failed' || !/Timed out/i.test(previous?.error || '')) return null;
  const r = readAgentResult(path.resolve(jobDir, 'agent_result.json'));
  if (!r) return null;
  const { error, ...rest } = previous;
  const out = fromAgentResult({
    ...rest,
    warning: DESKTOP_WARNING,
    transport: previous?.transport || job?.transport || 'desktop',
    transport_reason: previous?.transport_reason ?? job?.transport_reason ?? null,
  }, r);
  applyReadOnlyCheck(out, job);
  return { ...out, late_result: true };
}

export async function runDesktopJob(job, ctx) {
  const { jobDir, writeResult, logMessage } = ctx;
  const config = ctx.config || {};
  const resultFile = path.resolve(jobDir, 'agent_result.json');
  const pollMs = Number(process.env.CSA_DESKTOP_POLL_MS) || 2000;
  const timeoutMs = (Number(job.timeout_s) || Number(config.default_timeout_s) || 600) * 1000;
  const model = desktopModel(job, config);
  const transport = job.transport || 'desktop';
  const transportReason = job.transport_reason || null;
  const base = {
    job_id: job.id,
    conversation_id: job.conversation_id || null,
    model,
    tier: job.tier || null,
    tier_reason: job.tier_reason || null,
    usage: null,
    warning: DESKTOP_WARNING,
    transport,
    transport_reason: transportReason,
  };
  const fail = (msg, extra = {}) => {
    const error = redactText(msg).slice(0, 500);
    writeResult({ ...base, ...extra, state: 'failed', status: 'failed', summary: error, files_changed: [], commands_requested: [], denied_files: [], followups: [], handoff_notes: '', error });
    try {
      logMessage({
        direction: 'antigravity->claude',
        channel: 'desktop',
        transport,
        transport_reason: transportReason,
        job_id: job.id,
        chain_id: job.chain_id || undefined,
        conversation_id: extra.conversation_id ?? base.conversation_id,
        model,
        kind: 'error',
        text: error,
      });
    } catch {}
  };

  let promptText;
  try { promptText = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8'); } catch { promptText = job.prompt || ''; }
  if (!promptText) return fail('No prompt found for the desktop job.');
  // Very long prompts exceed the Windows command-line limit: point the app agent at the prompt file instead.
  let body = promptText.length > 12000
    ? `Your full task is in this file. Read it first, then carry it out exactly as written there:\n${path.resolve(jobDir, 'prompt.txt')}`
    : promptText;
  if (job.cwd) {
    body = `${workspaceContextHeader(job)}\n\n${body}`;
  }
  if ((job.kind || 'read') === 'read') {
    body = `${DESKTOP_READONLY_NOTICE}\n\n${body}`;
  }
  const full = body + '\n' + resultInstruction(resultFile, job);

  try { fs.rmSync(resultFile, { force: true }); } catch {}

  try {
    logMessage({
      direction: 'claude->antigravity',
      channel: 'desktop',
      transport,
      transport_reason: transportReason,
      job_id: job.id,
      chain_id: job.chain_id || undefined,
      conversation_id: base.conversation_id || undefined,
      model,
      kind: 'task',
      text: promptText,
    });
  } catch {}

  let convId = job.conversation_id || null;
  try {
    if (convId) {
      await sendMessage(convId, full, job.title ? { title: job.title } : {});
    } else {
      convId = await newConversation({ prompt: full, title: job.title || 'Claude task', model });
    }
  } catch (e) {
    if (ctx.allowCliFallback) {
      return { fallbackNeeded: true, reason: redactText(e?.message || e).slice(0, 300) };
    }
    return fail(`Could not reach the Antigravity app: ${e.message}`);
  }
  base.conversation_id = convId;
  if (typeof ctx.onConversation === 'function') { try { ctx.onConversation(convId); } catch {} }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
      if (cur && cur.state === 'cancelled') return null;
    } catch {}
    const r = readAgentResult(resultFile);
    if (r) {
      const out = applyReadOnlyCheck(fromAgentResult(base, r), job);
      writeResult(out);
      const startMs = Date.parse(job.started || job.created || '') || Date.now();
      const endMs = Date.parse(out.completed_at || '') || Date.now();
      const elapsedS = Math.max(0, Math.round((endMs - startMs) / 100) / 10);
      const needsApproval = out.status === 'needs_approval' || out.status === 'blocked' || (out.commands_requested?.length > 0);
      recordNotification({
        type: needsApproval ? 'approval_needed' : 'task_completed',
        job_id: job.id,
        chain_id: job.chain_id || null,
        conversation_id: convId,
        target_session: job.notify_session || null,
        status: out.status,
        completed_at: out.completed_at,
        started_at: job.started || job.created || null,
        elapsed_s: elapsedS,
        model,
        transport,
        commands_requested: out.commands_requested,
        denied_files: out.denied_files,
        files_changed: out.files_changed,
        summary: out.summary,
      });
      const replyText = out.read_only_violation
        ? `${out.read_only_warning}\n${out.summary}`
        : out.summary;
      try {
        logMessage({
          direction: 'antigravity->claude',
          channel: 'desktop',
          transport,
          transport_reason: transportReason,
          job_id: job.id,
          chain_id: job.chain_id || undefined,
          conversation_id: convId,
          model,
          kind: 'reply',
          status: out.status,
          completed_at: out.completed_at,
          text: replyText,
        });
      } catch {}
      return out;
    }
    await sleep(pollMs);
  }
  return fail(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the app agent to write its result. The conversation may still be running in the app.`, { conversation_id: convId });
}
