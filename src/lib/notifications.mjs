// Structured task-completion & approval/permission notifications from Antigravity to Claude.
// Stored in <CSA_HOME>/notifications.jsonl (redacted, rotated at 5 MB).
import fs from 'node:fs';
import path from 'node:path';
import { home as defaultHomePath } from './paths.mjs';
import { redact } from './safety.mjs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;

function activeHome() {
  return process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : defaultHomePath;
}

export function notificationsFile() {
  return path.join(activeHome(), 'notifications.jsonl');
}

export function formatApprovalNotice(n) {
  const cmds = Array.isArray(n.commands_requested) ? n.commands_requested : [];
  const denied = Array.isArray(n.denied_files) ? n.denied_files : [];
  const lines = [
    `[GCSA Approval/Permission Request] job=${n.job_id || 'unknown'} status=${n.status || 'needs_approval'} at=${n.completed_at || n.ts}`,
  ];
  if (cmds.length) {
    lines.push('Commands requesting Claude approval (use agy_approve with job_id + indexes if safe):');
    cmds.forEach((c, i) => {
      lines.push(`  [${i}] ${redact(String(c.command || ''))} (cwd: ${c.cwd || ''})${c.reason ? ` — ${redact(String(c.reason))}` : ''}`);
    });
  }
  if (denied.length) {
    lines.push('Blocked/denied files or permissions:');
    denied.forEach((d) => {
      lines.push(`  - ${d.tool || 'tool'}: ${redact(String(d.path || ''))}`);
    });
  }
  if (n.summary) lines.push(`Summary: ${redact(String(n.summary)).slice(0, 800)}`);
  return lines.join('\n');
}

export function formatCompletionNotice(n) {
  const files = Array.isArray(n.files_changed) ? n.files_changed : [];
  const parts = [
    `[GCSA Task Finished] job=${n.job_id || 'unknown'} status=${n.status || 'done'} completed_at=${n.completed_at || n.ts}`,
  ];
  if (n.elapsed_s != null) parts.push(`elapsed=${n.elapsed_s}s`);
  if (n.model) parts.push(`model=${n.model}`);
  if (n.transport) parts.push(`transport=${n.transport}`);
  if (files.length) parts.push(`files_changed=${files.length}`);
  const header = parts.join(' | ');
  return n.summary ? `${header}\n${redact(String(n.summary)).slice(0, 1000)}` : header;
}

export function recordNotification(input = {}) {
  try {
    const dir = activeHome();
    fs.mkdirSync(dir, { recursive: true });
    const nowIso = new Date().toISOString();
    const completedAt = typeof input.completed_at === 'string' && !Number.isNaN(Date.parse(input.completed_at))
      ? new Date(Date.parse(input.completed_at)).toISOString()
      : nowIso;
    const type = input.type || (input.status === 'needs_approval' || input.status === 'blocked' ? 'approval_needed' : 'task_completed');
    const commands = Array.isArray(input.commands_requested)
      ? input.commands_requested.map((c) => ({
          command: redact(String(c?.command || '')).slice(0, 500),
          cwd: c?.cwd ? String(c.cwd) : null,
          reason: c?.reason ? redact(String(c.reason)).slice(0, 300) : '',
        }))
      : [];
    const denied = Array.isArray(input.denied_files)
      ? input.denied_files.map((d) => ({
          tool: String(d?.tool || ''),
          path: redact(String(d?.path || '')).slice(0, 400),
        }))
      : [];
    const filesChanged = Array.isArray(input.files_changed) ? input.files_changed.map(String).slice(0, 200) : [];
    const entry = {
      ts: nowIso,
      type,
      job_id: input.job_id || null,
      chain_id: input.chain_id || null,
      conversation_id: input.conversation_id || null,
      target_session: input.target_session ? redact(String(input.target_session)).slice(0, 120) : null,
      status: input.status || 'done',
      completed_at: completedAt,
      started_at: input.started_at || null,
      elapsed_s: typeof input.elapsed_s === 'number' && Number.isFinite(input.elapsed_s) ? input.elapsed_s : null,
      model: input.model || null,
      transport: input.transport || null,
      commands_requested: commands,
      denied_files: denied,
      files_changed: filesChanged,
      summary: input.summary ? redact(String(input.summary)).slice(0, 1500) : '',
    };
    entry.message = type === 'approval_needed' || type === 'permission_requested'
      ? formatApprovalNotice(entry)
      : formatCompletionNotice(entry);

    const file = notificationsFile();
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return entry;
  } catch {
    return null;
  }
}

export function readNotifications({ limit = 50, since, type } = {}) {
  let raw;
  try {
    const fd = fs.openSync(notificationsFile(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  let out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  if (since) out = out.filter((e) => e.ts > since);
  if (type) out = out.filter((e) => e.type === type);
  return limit > 0 ? out.slice(-limit) : out;
}
