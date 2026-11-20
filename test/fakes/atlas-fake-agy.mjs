// Fake agy CLI for tests. Never talks to the network.
import fs from 'node:fs';

const args = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(o) + '\n'); };

if (args[0] === 'models') {
  process.stdout.write('Fetching available models...\n');
  process.stdout.write('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n');
  process.stdout.write('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
  process.stdout.write('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
  process.stdout.write('gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n');
  process.exit(0);
}

const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const prompt = get('-p') || '';
log({ args, env: { chain: process.env.CSA_CHAIN_ID || null, hop: process.env.CSA_HOP || null, ag: Object.keys(process.env).filter((k) => /^ANTIGRAVITY_/i.test(k)) } });
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const conv = get('--conversation') || '11111111-1111-4111-8111-111111111111';

emit({ event: 'init', conversation_id: conv, init: { model: get('--model'), cwd: process.cwd(), tools: [] } });

const step = (index, state, tool, parameters, errorMessage) => ({
  event: 'step_update',
  step_update: {
    conversation_id: conv,
    step_index: index,
    state,
    step_type: 'tool',
    tool_name: tool,
    tool_info: { name: tool, parameters, ...(errorMessage ? { error: { message: errorMessage } } : {}) },
  },
});

if (prompt.includes('SCENARIO:sleep')) {
  setTimeout(() => process.exit(0), 60000);
} else if (prompt.includes('SCENARIO:crash')) {
  process.stderr.write('boom --csrf_token abcdef0123456789abcdef0123456789 failed\n');
  process.exit(3);
} else {
  const structured = { summary: 'fake answer', files_changed: [], commands_requested: [], followups: [], handoff_notes: 'n' };
  if (prompt.includes('SCENARIO:commands')) {
    structured.commands_requested = [{ command: 'Write-Output approved-ok', cwd: process.cwd(), reason: 'test' }];
  }
  if (prompt.includes('SCENARIO:denied-file')) {
    emit(step(1, 'ACTIVE', 'write_to_file', { AbsolutePath: 'C:\\x\\a.txt' }));
    emit(step(1, 'ERROR', 'write_to_file', { AbsolutePath: 'C:\\x\\a.txt' }, 'permission denied'));
  }
  if (prompt.includes('SCENARIO:denied-cmd')) {
    emit(step(2, 'ERROR', 'run_command', { CommandLine: 'whoami', Cwd: 'C:\\x' }, 'permission not granted'));
  }
  if (get('--conversation')) structured.summary = 'continued' + (prompt.includes('approved-ok') ? ' with output' : '');
  emit({
    event: 'result',
    result: {
      conversation_id: conv,
      status: 'SUCCESS',
      response: JSON.stringify(structured),
      structured_output: structured,
      num_turns: 1,
      duration_seconds: 0.1,
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 125 },
    },
  });
  process.exit(0);
}
