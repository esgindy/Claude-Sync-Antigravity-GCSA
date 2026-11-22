#!/usr/bin/env node
// csa-antigravity: MCP stdio server used by Antigravity to ask Claude Code (Echo).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../lib/paths.mjs';
import { claimHop } from '../lib/hops.mjs';
import {
  startClaudeJob, getClaudeCompact, waitClaudeJob, vetFiles, buildReviewPrompt, buildTaskPrompt,
} from '../lib/claude-jobs.mjs';

const INSTRUCTIONS = [
  'This server lets you (Antigravity) call Claude Code, which acts as the brain: careful reasoning, review and security.',
  'Call claude_review after you finish a meaningful change (several files, risky logic, anything touching auth, data or money). Pass the original goal, your summary and the files changed. If the verdict is "changes", apply required_changes and ask for review again only if the change was substantial.',
  'Call claude_task to hand over work that needs careful reasoning, a security audit or a deep review, rather than doing it yourself. Default is read-only; set allow_edits true only when Claude should edit files (it never runs shell commands).',
  'Both calls start a background job and return job_id. Use claude_wait (up to 50 s per call, repeat while state is running), then claude_result for the full answer.',
  'APPROVAL & COMPLETION NOTIFICATIONS: Whenever you encounter a permission/approval prompt during a delegated task, notify Claude immediately with the job_id and requested command/permission so Claude can review and grant approval (via agy_approve or reply). Upon finishing any delegated task, always include the exact ISO-8601 completed_at timestamp in agent_result.json and notify Claude immediately so Claude knows the exact moment you finished.',
  'HOP LIMIT: every call returns chain_id and hop. Pass the same chain_id on follow-up calls in one piece of work. When a call is refused because the hop limit was reached, stop and report to the user; do not retry or start a new chain to get around it.',
].join('\n');

const server = new McpServer({ name: 'csa-antigravity', version: '5.0.0' }, { instructions: INSTRUCTIONS });

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg) }] });

function guardHop(chain_id) {
  const cfg = loadConfig();
  return claimHop(chain_id, cfg.max_hops ?? 3);
}

server.registerTool('claude_review', {
  description: 'Ask Claude Code to review work you finished. Returns job_id; Claude answers verdict approve|changes + notes.',
  inputSchema: {
    goal: z.string().describe('The original goal of the work'),
    summary: z.string().describe('What you did'),
    files_changed: z.array(z.string()).default([]).describe('Files you changed (paths relative to cwd)'),
    cwd: z.string().describe('Absolute working directory'),
    chain_id: z.string().optional().describe('Chain id from a previous call, to respect the hop limit'),
    model: z.string().optional().describe('Claude model alias (haiku|sonnet|opus) or full id. Default from config claude_models.review'),
  },
}, async ({ goal, summary, files_changed, cwd, chain_id, model }) => {
  try {
    const { ok, blocked } = vetFiles(files_changed, cwd);
    const hop = guardHop(chain_id);
    const prompt = buildReviewPrompt({ goal, summary, files: ok, cwd });
    const started = startClaudeJob({
      kind: 'review', prompt, cwd, chain_id: hop.chain_id, hop: hop.hop, model,
      request_text: `Review request\nGoal: ${goal}\nSummary: ${summary}\nFiles: ${ok.join(', ')}`,
    });
    const out = { ...started, state: 'queued', note: 'Use claude_wait with job_id.' };
    if (blocked.length) out.skipped_files = blocked;
    return text(out);
  } catch (e) { return err(e.message); }
});

server.registerTool('claude_task', {
  description: 'Hand a task to Claude Code (careful reasoning, review, security). Read-only unless allow_edits is true. Returns job_id.',
  inputSchema: {
    task: z.string().describe('The task for Claude'),
    cwd: z.string().describe('Absolute working directory'),
    chain_id: z.string().optional(),
    allow_edits: z.boolean().default(false).describe('Let Claude edit files (no shell). Default false = read-only plan mode'),
    model: z.string().optional().describe('Claude model alias (haiku|sonnet|opus) or full id. Default from config claude_models.task'),
  },
}, async ({ task, cwd, chain_id, allow_edits, model }) => {
  try {
    const hop = guardHop(chain_id);
    const prompt = buildTaskPrompt({ task, allowEdits: allow_edits, cwd });
    const started = startClaudeJob({
      kind: 'task', prompt, cwd, chain_id: hop.chain_id, hop: hop.hop, allow_edits, model,
      request_text: `Task handed to Claude${allow_edits ? ' (edits allowed)' : ' (read-only)'}\n${task}`,
    });
    return text({ ...started, state: 'queued', mode: allow_edits ? 'edit' : 'read-only', note: 'Use claude_wait with job_id.' });
  } catch (e) { return err(e.message); }
});

server.registerTool('claude_wait', {
  description: 'Wait up to wait_s (max 50) for a Claude job; returns its compact status/verdict.',
  inputSchema: { job_id: z.string(), wait_s: z.number().min(0).max(50).default(30) },
}, async ({ job_id, wait_s }) => {
  try {
    const c = await waitClaudeJob(job_id, wait_s);
    return c ? text(c) : err(`Unknown job_id: ${job_id}`);
  } catch (e) { return err(e.message); }
});

server.registerTool('claude_result', {
  description: 'Get the full result of a Claude job (verdict, notes, required_changes, full text).',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  try {
    const c = getClaudeCompact(job_id, { full: true });
    return c ? text(c) : err(`Unknown job_id: ${job_id}`);
  } catch (e) { return err(e.message); }
});

await server.connect(new StdioServerTransport());
