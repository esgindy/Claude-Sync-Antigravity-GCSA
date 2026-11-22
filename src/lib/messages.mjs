// Message log for both directions (shown live in the dashboard).
import fs from 'node:fs';
import path from 'node:path';
import { home, ensureHome } from './paths.mjs';
import { redact } from './safety.mjs';
import { refreshClaudeUsage } from './claude-usage.mjs';

const MAX_TEXT = 4000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;

export function messagesFile() {
  return path.join(home, 'messages.jsonl');
}

export function logMessage(m) {
  ensureHome();
  const text = redact(String(m.text ?? '')).slice(0, MAX_TEXT);
  const entry = {
    ts: new Date().toISOString(),
    direction: m.direction,
    channel: m.channel,
    transport: m.transport || m.channel || null,
    transport_reason: m.transport_reason ? redact(String(m.transport_reason)).slice(0, 400) : null,
    job_id: m.job_id ?? null,
    chain_id: m.chain_id ?? null,
    conversation_id: m.conversation_id ?? null,
    model: m.model ?? null,
    kind: m.kind,
    ...(m.status ? { status: m.status } : {}),
    ...(m.completed_at ? { completed_at: m.completed_at } : {}),
    text,
  };
  const f = messagesFile();
  try {
    if (fs.statSync(f).size > MAX_LOG_BYTES) fs.renameSync(f, `${f}.1`);
  } catch { /* no file yet */ }
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  try { refreshClaudeUsage({ reason: `message:${entry.direction || 'unknown'}:${entry.kind || 'msg'}` }); } catch { /* never throw */ }
  return entry;
}

export function readMessages({ limit = 100, since } = {}) {
  let raw;
  try {
    const fd = fs.openSync(messagesFile(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // drop the partial first line
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
  return limit > 0 ? out.slice(-limit) : out;
}
