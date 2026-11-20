#!/usr/bin/env node
// Updates the dashboard status file (see common.mjs for its location). Usage:
//   node progress.mjs --project "<name>"                         set the project title
//   node progress.mjs --add <id> "<name>" "<model>" "<role>"     register an agent (e.g. a Claude subagent)
//   node progress.mjs --task <agent> <taskId> "<title>"           add a task to an agent
//   node progress.mjs <agent> <taskId> <todo|doing|done|blocked> "<note>"
//   node progress.mjs <agent> --now "<what the agent is doing right now>"
//   node progress.mjs --set-usage '<json>'                        set overall Claude remaining quota
import fs from 'node:fs';
import path from 'node:path';
import { csaHome, statusFile, emptyStatus } from './common.mjs';
import { redact } from '../src/lib/safety.mjs';
import { atomicWriteJson } from '../src/lib/claude-usage.mjs';

const file = statusFile();
const args = process.argv.slice(2);
const STATES = ['todo', 'doing', 'done', 'blocked'];

function update(mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 20; i++) { // several agents may write at once
    try {
      let s;
      try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') s = emptyStatus(); else throw e; }
      s.agents ||= []; s.log ||= [];
      mutate(s);
      const tmp = `${file}.${process.pid}.${i}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (e.userError || i === 19) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
const fail = (m) => { const e = new Error(m); e.userError = true; throw e; };
const clip = (v, n = 160) => String(v ?? '').slice(0, n);

function cleanUsageText(value, maxLen) {
  if (value === null || value === undefined) return null;
  let s = redact(String(value));
  s = s.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/gi, '[REDACTED]');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]');
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]');
  s = s.replace(/((?:api[_-]?key|secret|password|auth|token)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED]');
  return s.trim().slice(0, maxLen) || null;
}

function normPct(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(`${field} must be null or a finite number between 0 and 100`);
  }
  return Math.round(value * 10) / 10;
}

update((s) => {
  const ts = new Date().toISOString();
  const findAgent = (id) => s.agents.find((x) => x.id === id) || fail(`unknown agent ${id}`);
  const [a1, a2, a3, a4, a5] = args;
  if (a1 === '--project') {
    s.project = clip(a2, 120);
  } else if (a1 === '--add') {
    if (!/^[a-z0-9_-]{1,40}$/i.test(a2 || '')) fail('agent id must be letters, digits, - or _');
    const ex = s.agents.find((x) => x.id === a2);
    const fields = { id: a2, name: clip(a3 || a2, 60), model: clip(a4, 60), role: clip(a5, 200) };
    if (ex) Object.assign(ex, fields); else s.agents.push({ ...fields, now: '', tasks: [] });
    s.log.unshift({ ts, agent: a2, text: `+ ${fields.name} (${fields.model})` });
  } else if (a1 === '--task') {
    const agent = findAgent(a2);
    if (!a3) fail('task id required');
    const t = agent.tasks.find((x) => x.id === a3);
    if (t) t.title = clip(a4); else agent.tasks.push({ id: clip(a3, 20), title: clip(a4), state: 'todo', note: '' });
  } else if (a1 === '--set-usage') {
    let payload;
    try { payload = JSON.parse(a2 || ''); } catch { fail('invalid usage JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid usage JSON');
    const snap = {
      five_hour_remaining_pct: normPct(payload.five_hour_remaining_pct, 'five_hour_remaining_pct'),
      weekly_remaining_pct: normPct(payload.weekly_remaining_pct, 'weekly_remaining_pct'),
      resets_at: cleanUsageText(payload.resets_at, 80),
      note: cleanUsageText(payload.note, 300),
      updated_at: ts,
    };
    s.claude_usage = { ...snap, available: snap.five_hour_remaining_pct !== null || snap.weekly_remaining_pct !== null, stale: false, source: 'set_usage' };
    if (snap.five_hour_remaining_pct !== null || snap.weekly_remaining_pct !== null) {
      s.claude_usage_last_set = { ...snap };
      atomicWriteJson(path.join(csaHome, 'claude-usage.json'), snap);
    }
    s.log.unshift({ ts, agent: 'claude', text: 'Claude usage updated' });
  } else if (a2 === '--now') {
    const agent = findAgent(a1);
    agent.now = clip(a3);
    s.log.unshift({ ts, agent: a1, text: `→ ${agent.now}` });
  } else {
    const agent = findAgent(a1);
    const task = agent.tasks.find((t) => t.id === a2) || fail(`unknown task ${a2}`);
    if (!STATES.includes(a3)) fail(`state must be one of ${STATES.join(', ')}`);
    task.state = a3;
    if (a4 !== undefined) task.note = clip(a4);
    task.updated = ts;
    s.log.unshift({ ts, agent: a1, text: `${task.id} ${task.title} → ${a3}${a4 ? `: ${a4}` : ''}` });
  }
  s.log = s.log.slice(0, 300);
  s.updated = ts;
});
console.log('ok');
