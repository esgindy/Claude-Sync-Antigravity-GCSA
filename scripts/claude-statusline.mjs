#!/usr/bin/env node
// GCSA Claude Code statusLine: keeps the dashboard's Claude usage fresh automatically.
//
// Claude Code runs this command for its status line and passes session JSON on stdin.
// For Pro/Max subscribers that JSON carries `rate_limits.five_hour` / `rate_limits.seven_day`
// ({ used_percentage, resets_at (epoch s) }). We turn those into the GCSA usage snapshot
// (<CSA_HOME>/claude-usage.json) and print a one-line status.
//
// If the user already had a statusLine, setup.mjs stores it in <CSA_HOME>/statusline-chain.json;
// we run it with the same stdin and print ITS output instead of ours, so nothing the user had is lost.
//
// Security: reads only stdin. Never reads credentials, tokens, cookies or ~/.claude files.
// Never throws: a broken status line must not disturb Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_REWRITE_MS = 60_000; // rewrite at least once a minute even if values are unchanged

export function usageFromStatusJson(input) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const pct = (w) => {
    const u = Number(w?.used_percentage);
    return Number.isFinite(u) ? Math.max(0, Math.min(100, Math.round((100 - u) * 10) / 10)) : null;
  };
  const iso = (w) => {
    const s = Number(w?.resets_at);
    if (!Number.isFinite(s) || s <= 0) return null;
    return new Date(s < 1e12 ? s * 1000 : s).toISOString();
  };
  const five = pct(rl.five_hour), week = pct(rl.seven_day);
  if (five === null && week === null) return null;
  const out = { note: 'Claude Code (statusLine)' };
  if (five !== null) out.five_hour_remaining_pct = five;
  if (week !== null) out.weekly_remaining_pct = week;
  const r = iso(rl.five_hour) || iso(rl.seven_day);
  if (r) out.resets_at = r;
  return out;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    // fs.readFileSync(0) blocks until EOF; Claude Code closes stdin after writing the JSON.
    return fs.readFileSync(0, 'utf8');
  } catch { return ''; }
}

function shouldWrite(file, usage) {
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const same = prev.five_hour_remaining_pct === (usage.five_hour_remaining_pct ?? null)
      && prev.weekly_remaining_pct === (usage.weekly_remaining_pct ?? null);
    const age = Date.now() - Date.parse(prev.updated_at || 0);
    return !same || !(age < MIN_REWRITE_MS);
  } catch { return true; }
}

async function main() {
  const raw = readStdin();
  let input = null;
  try { input = raw ? JSON.parse(raw) : null; } catch { input = null; }

  let usage = null;
  try {
    usage = usageFromStatusJson(input);
    // Diagnostics only (no content): proves Claude Code runs the statusLine and whether it sent rate_limits.
    const { stateHome } = await import('../src/lib/platform.mjs');
    const home = process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : stateHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'statusline-last-run.json'), JSON.stringify({
      at: new Date().toISOString(),
      got_json: !!input,
      has_rate_limits: !!(input && input.rate_limits),
      usage_written: !!usage,
      claude_code_version: typeof input?.version === 'string' ? input.version.slice(0, 40) : null,
    }, null, 2) + '\n');
    if (usage) {
      const lib = await import('../src/lib/claude-usage.mjs');
      if (shouldWrite(lib.snapshotFile(), usage)) lib.writeClaudeUsageSnapshot(usage, { updateStatus: true });
    }
  } catch { /* never disturb Claude Code */ }

  // Chained (pre-existing) status line wins the display.
  try {
    const { stateHome } = await import('../src/lib/platform.mjs');
    const home = process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : stateHome();
    const chain = JSON.parse(fs.readFileSync(path.join(home, 'statusline-chain.json'), 'utf8'));
    if (chain && typeof chain.command === 'string' && chain.command.trim()) {
      const r = spawnSync(chain.command, { input: raw, shell: true, encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.stdout) { process.stdout.write(r.stdout); return; }
    }
  } catch { /* no chain */ }

  const model = input?.model?.display_name || '';
  const bits = [];
  if (usage?.five_hour_remaining_pct != null) bits.push(`5h ${usage.five_hour_remaining_pct}% left`);
  if (usage?.weekly_remaining_pct != null) bits.push(`week ${usage.weekly_remaining_pct}% left`);
  process.stdout.write(['GCSA', model, ...bits].filter(Boolean).join(' · ') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
