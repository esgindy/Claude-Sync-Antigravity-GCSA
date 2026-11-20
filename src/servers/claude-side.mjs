#!/usr/bin/env node
// csa-claude: MCP server used by Claude Code / Claude Desktop to delegate work to Antigravity.
// Claude is the brain (plans, reviews, decides); Antigravity agents are the muscle (execute).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const VERSION = '4.0.0';

const INSTRUCTIONS = `GCSA (Claude Sync Antigravity): you are the brain, Antigravity agents are the muscle.
Delegate bulky execution (reading many files, research, drafting, routine edits, tests) to Antigravity to save your own tokens; keep planning, judgement and final review for yourself.
Flow: agy_task -> agy_wait (repeat while "running") -> review the result yourself before reporting it as fact.
Model choice: leave tier "auto" (simple -> fast, normal -> balanced, hard -> deep, with quota-aware fallback) or pass tier/model explicitly. agy_models lists every model with its remaining quota; agy_usage shows tokens used and remaining quota.
Target choice: agy_task defaults target to "auto" (automatically selects an available transport: cli or desktop); pass target="cli" or "desktop" to force one. Use agy_desktop_task when the user wants to watch the work inside the Antigravity app (it runs with the app's own permissions). Use agy_swarm to run several agents in parallel (split a task, or compare models).
kind "read" (default) cannot change files. kind "edit" may edit files in cwd; check files_changed yourself.
Permissions & Notifications: headless agy cannot ask interactively, and desktop agents are instructed to notify you immediately (with exact completed_at timestamp on completion, or when needing approval/permission). When status is "needs_approval" or an approval notification arrives, read commands_requested; approve routine, project-local commands with agy_approve; ask the user first for anything that deletes, publishes, touches live systems or sends data out. Pass notify_session if you want desktop agents to address your session directly.
Every message and completion/approval notification in both directions is logged; agy_messages shows both messages and notifications (including exact completed_at timestamps).
Dashboard: a live dashboard opens automatically when a project starts delegating (csa_dashboard opens it again). At the start of a project, use csa_board to set the project name and register your plan: "gindy" is the manager/supervisor (you); add every Claude-side subagent you start (add_agent + add_task) and keep task states current (set_task). At the start of each delegated task, call csa_board with action="set_usage" (five_hour_remaining_pct, weekly_remaining_pct, resets_at, note) using your real Claude Code usage numbers whenever known so the live dashboard usage strip and <CSA_HOME>/claude-usage.json stay fresh — never invent numbers or store secrets. Antigravity jobs and Claude review jobs appear on the board automatically.`;

const server = new McpServer({ name: 'claude-sync-antigravity', version: VERSION }, { instructions: INSTRUCTIONS });

// The live dashboard opens automatically the first time this project starts delegating work.
const { ensureDashboard, boardUpdate, boardActionToArgv } = await import('../lib/dashboard.mjs');
const { redact } = await import('../lib/safety.mjs');
const { z } = await import('zod');
const STARTERS = new Set(['agy_task', 'agy_desktop_task', 'agy_swarm']);
const register = server.registerTool.bind(server);
server.registerTool = (name, def, handler) => register(name, def, STARTERS.has(name)
  ? async (...a) => { ensureDashboard().catch(() => {}); return handler(...a); }
  : handler);

server.registerTool('csa_dashboard', {
  description: 'Open the live project dashboard (agents, tasks, models, messages, files) in the browser.',
  inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: JSON.stringify(await ensureDashboard({ force: true })) }] }));

server.registerTool('csa_board', {
  description: 'Show Claude-side agents, plan, and overall Claude usage on the dashboard. Gindy (id "gindy") is the manager. Actions: project {name}; add_agent {id,name,model,role}; add_task {id(agent),task_id,title}; set_task {id,task_id,state(todo|doing|done|blocked),note}; now {id,note}; set_usage {five_hour_remaining_pct,weekly_remaining_pct,resets_at,note}.',
  inputSchema: {
    action: z.enum(['project', 'add_agent', 'add_task', 'set_task', 'now', 'set_usage']),
    id: z.string().max(40).optional(), name: z.string().max(120).optional(), model: z.string().max(60).optional(),
    role: z.string().max(200).optional(), task_id: z.string().max(20).optional(), title: z.string().max(160).optional(),
    state: z.enum(['todo', 'doing', 'done', 'blocked']).optional(), note: z.string().max(300).nullable().optional(),
    five_hour_remaining_pct: z.number().min(0).max(100).nullable().optional(),
    weekly_remaining_pct: z.number().min(0).max(100).nullable().optional(),
    resets_at: z.string().max(80).nullable().optional(),
  },
}, async (p) => {
  const clean = p.action === 'set_usage'
    ? {
        ...p,
        five_hour_remaining_pct: p.five_hour_remaining_pct ?? null,
        weekly_remaining_pct: p.weekly_remaining_pct ?? null,
        resets_at: p.resets_at == null ? null : redact(p.resets_at),
        note: p.note == null ? null : redact(p.note),
      }
    : p;
  const argv = boardActionToArgv(clean);
  const r = await boardUpdate(argv);
  if (!['now', 'set_usage'].includes(p.action)) ensureDashboard().catch(() => {});
  return r.ok ? { content: [{ type: 'text', text: 'ok' }] } : { isError: true, content: [{ type: 'text', text: r.output }] };
});

for (const mod of ['../tools/core-tools.mjs', '../tools/desktop-tools.mjs', '../tools/swarm-tools.mjs']) {
  try {
    const m = await import(mod);
    m.register(server);
  } catch (e) {
    process.stderr.write(`csa-claude: could not load ${mod}: ${e.message}\n`);
  }
}

await server.connect(new StdioServerTransport());
