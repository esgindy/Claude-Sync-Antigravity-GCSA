// Fake claude CLI for Echo tests. Behaviour via ECHO_FAKE_MODE; invocations logged to ECHO_FAKE_LOG.
import { appendFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.ECHO_FAKE_LOG) appendFileSync(process.env.ECHO_FAKE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), env: { chain: process.env.CSA_CHAIN_ID, hop: process.env.CSA_HOP, ag: process.env.ANTIGRAVITY_CSRF_TOKEN } }) + '\n');
  const mode = process.env.ECHO_FAKE_MODE || 'approve';
  const base = { type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-1', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 } };
  const out = (o) => process.stdout.write(JSON.stringify({ ...base, ...o }));
  const v = { verdict: 'approve', notes: 'looks good', required_changes: [] };
  if (mode === 'sleep') { setTimeout(() => out({ result: 'late' }), 60000); return; }
  if (mode === 'garbage') { process.stdout.write('not json at all'); return; }
  if (mode === 'error') return out({ is_error: true, result: 'boom' });
  if (mode === 'changes') return out({ result: JSON.stringify({ verdict: 'changes', notes: 'bug', required_changes: ['fix x', 'add test'] }) });
  if (mode === 'fenced') return out({ result: 'Here you go:\n```json\n' + JSON.stringify(v) + '\n```\nbye' });
  if (mode === 'structured') return out({ result: '', structured_output: { verdict: 'changes', notes: 's', required_changes: ['a'] } });
  if (mode === 'noverdict') return out({ result: 'I think it is fine.' });
  if (mode === 'task') return out({ result: 'task done: ' + stdin.slice(0, 40) });
  return out({ result: JSON.stringify(v) });
});
