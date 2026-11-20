// Token usage log and savings estimate. Totals live in a small summary file; the log rotates at 5 MB.
import fs from 'node:fs';
import path from 'node:path';
import { home, ensureHome } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 14;

export function usageFile() {
  return path.join(home, 'usage.jsonl');
}
function summaryFile() {
  return path.join(home, 'usage-summary.json');
}

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bucket() {
  return { tokens: 0, jobs: 0, saved: 0, by_model: Object.create(null) };
}

function add(b, e) {
  const t = e.total_tokens || e.input_tokens + e.output_tokens + e.thinking_tokens;
  b.tokens += t;
  b.jobs += 1;
  b.saved += (e.input_tokens || 0) + (e.output_tokens || 0);
  const name = String(e.model);
  const m = (b.by_model[name] ||= { tokens: 0, jobs: 0 });
  m.tokens += t;
  m.jobs += 1;
}

function revive(b) {
  const out = bucket();
  if (!b) return out;
  out.tokens = b.tokens || 0;
  out.jobs = b.jobs || 0;
  out.saved = b.saved || 0;
  for (const [k, v] of Object.entries(b.by_model || {})) out.by_model[k] = { tokens: v.tokens || 0, jobs: v.jobs || 0 };
  return out;
}

function rotateIfBig(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no file yet */ }
}

function loadSummary() {
  const s = readJson(summaryFile());
  if (s && s.all) {
    return { all: revive(s.all), days: Object.fromEntries(Object.entries(s.days || {}).map(([d, b]) => [d, revive(b)])) };
  }
  // Rebuild from the log(s) (first run after upgrade).
  const sum = { all: bucket(), days: {} };
  for (const f of [`${usageFile()}.1`, usageFile()]) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        add(sum.all, e);
        add((sum.days[e.day] ||= bucket()), e);
      } catch { /* skip */ }
    }
  }
  return sum;
}

export function appendUsage(u) {
  ensureHome();
  const entry = {
    job_id: u.job_id ?? null,
    day: u.day || localDay(),
    model: u.model ?? 'unknown',
    tier: u.tier ?? null,
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    thinking_tokens: Number(u.thinking_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    target: u.target ?? 'cli',
  };
  const sum = loadSummary();
  rotateIfBig(usageFile());
  fs.appendFileSync(usageFile(), JSON.stringify(entry) + '\n');
  add(sum.all, entry);
  add((sum.days[entry.day] ||= bucket()), entry);
  const keep = Object.keys(sum.days).sort().slice(-KEEP_DAYS);
  sum.days = Object.fromEntries(keep.map((d) => [d, sum.days[d]]));
  writeJson(summaryFile(), sum);
  return entry;
}

/** Number of jobs recorded in the usage log for today. */
export function usageJobsToday() {
  return loadSummary().days[localDay()]?.jobs || 0;
}

export function usageReport() {
  const sum = loadSummary();
  const t = sum.days[localDay()] || bucket();
  const strip = (b) => ({ tokens: b.tokens, jobs: b.jobs, by_model: b.by_model });
  return {
    today: strip(t),
    all_time: strip(sum.all),
    claude_tokens_saved_estimate: sum.all.saved,
    note: 'Estimate only: the sum of Antigravity input + output tokens.',
  };
}
