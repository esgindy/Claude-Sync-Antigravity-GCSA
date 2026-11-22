// Detached worker for one Claude job (Echo). Usage: node claude-runner.mjs <jobDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './lib/store.mjs';
import { runClaude, parseVerdict, VERDICT_SCHEMA } from './lib/claude.mjs';
import { logMessage } from './lib/messages.mjs';
import { redact } from './lib/safety.mjs';
import { loadConfig } from './lib/paths.mjs';
import { refreshClaudeUsage } from './lib/claude-usage.mjs';

const dir = process.argv[2];
const jobFile = join(dir, 'job.json');
const patch = (p) => writeJson(jobFile, { ...readJson(jobFile), ...p });

async function main() {
  const job = readJson(jobFile);
  patch({ state: 'running', started: new Date().toISOString(), runner_pid: process.pid });
  try { refreshClaudeUsage({ reason: 'claude_job_running' }); } catch { /* never throw */ }
  const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  const mcpFile = join(dir, 'mcp-empty.json');
  writeFileSync(mcpFile, '{"mcpServers":{}}');
  const review = job.kind === 'review';
  const config = loadConfig();
  const model = job.model || config.claude_models?.[job.kind] || undefined;
  patch({ model: model || null });
  const run = await runClaude({
    prompt, mode: job.mode, cwd: job.cwd, addDirs: job.add_dirs, model, mcpConfigPath: mcpFile,
    env: { ...(job.chain_id ? { CSA_CHAIN_ID: job.chain_id } : {}), CSA_HOP: String(job.hop || 0) },
    maxBudgetUsd: config.claude_max_budget_usd,
    schema: review ? VERDICT_SCHEMA : undefined, timeoutMs: (job.timeout_s || 900) * 1000,
  });
  let res = { job_id: job.id, kind: job.kind, result: redact(run.result || ''), session_id: run.session_id, usage: run.usage, cost_usd: run.cost_usd, is_error: run.is_error };
  let state = run.is_error ? 'failed' : 'done';
  if (run.is_error) res.error = redact(run.result || 'claude reported an error');
  if (review && !run.is_error) {
    const v = parseVerdict(run);
    if (v) Object.assign(res, v);
    else { state = 'failed'; res.error = 'Claude did not return a parsable verdict; see result text.'; }
  }
  res.state = state;
  writeJson(join(dir, 'result.json'), res);
  patch({ state, ended: new Date().toISOString(), error: res.error || null });
  try { refreshClaudeUsage({ reason: `claude_job_${state}` }); } catch { /* never throw */ }
  const text = res.verdict
    ? `verdict: ${res.verdict}\n${res.notes}\n${(res.required_changes || []).map((c) => `- ${c}`).join('\n')}`
    : res.result || res.error || '';
  try {
    logMessage({ direction: 'claude->antigravity', channel: 'claude-cli', job_id: job.id, chain_id: job.chain_id || undefined, kind: state === 'failed' ? 'error' : 'reply', text });
  } catch { /* ignore */ }
}

main().catch((e) => {
  try {
    writeJson(join(dir, 'result.json'), { state: 'failed', error: redact(String(e && e.message || e)) });
    patch({ state: 'failed', ended: new Date().toISOString(), error: redact(String(e && e.message || e)) });
  } catch { /* ignore */ }
  process.exit(1);
});
