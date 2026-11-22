#!/usr/bin/env node
// Atomically writes <CSA_HOME>/claude-usage.json (and updates status.json) for GCSA v5.0.0 (V5).
// Usage:
//   node scripts/push-claude-usage.mjs --five-hour <0-100> [--weekly <0-100>] [--resets-at "<ISO-or-text>"] [--note "<text>"]
// Security: NEVER reads credentials, OAuth tokens, .credentials.json, cookies, or ~/.claude settings.
import { writeClaudeUsageSnapshot, snapshotFile } from '../src/lib/claude-usage.mjs';

const args = process.argv.slice(2);

function printHelp() {
  console.log([
    'GCSA (Claude Sync Antigravity) v5.0.0 (V5) — push-claude-usage',
    'Usage:',
    '  node scripts/push-claude-usage.mjs --five-hour <pct> [--weekly <pct>] [--resets-at "<time>"] [--note "<text>"]',
    '',
    'Options:',
    '  --five-hour <number>   5-hour remaining quota percentage (validated & clamped 0-100)',
    '  --weekly <number>      Weekly remaining quota percentage (validated & clamped 0-100)',
    '  --resets-at <string>   Quota reset timestamp or label (optional)',
    '  --note <string>        Short note (optional, redacted for safety)',
    '  --json <json-object>   Provide fields as a JSON object string',
    '  --help, -h             Show this help message',
  ].join('\n'));
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const payload = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eqIdx = a.indexOf('=');
  const key = eqIdx >= 0 ? a.slice(0, eqIdx) : a;
  const nextVal = () => {
    if (eqIdx >= 0) return a.slice(eqIdx + 1);
    if (i + 1 >= args.length) {
      process.stderr.write(`Missing value for ${key}\n`);
      process.exit(1);
    }
    return args[++i];
  };

  if (key === '--five-hour' || key === '--five_hour_remaining_pct') {
    payload.five_hour_remaining_pct = nextVal();
  } else if (key === '--weekly' || key === '--weekly_remaining_pct') {
    payload.weekly_remaining_pct = nextVal();
  } else if (key === '--resets-at' || key === '--resets_at') {
    payload.resets_at = nextVal();
  } else if (key === '--note') {
    payload.note = nextVal();
  } else if (key === '--json') {
    let parsed;
    try {
      parsed = JSON.parse(nextVal());
    } catch {
      process.stderr.write('Invalid JSON passed to --json\n');
      process.exit(1);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write('--json must be a JSON object\n');
      process.exit(1);
    }
    Object.assign(payload, parsed);
  } else {
    process.stderr.write(`Unknown option: ${a}\n`);
    process.exit(1);
  }
}

try {
  const written = writeClaudeUsageSnapshot(payload, { updateStatus: true });
  process.stdout.write(JSON.stringify({ ok: true, file: snapshotFile(), usage: written }) + '\n');
} catch (e) {
  process.stderr.write(`push-claude-usage error: ${e?.message || e}\n`);
  process.exit(1);
}
