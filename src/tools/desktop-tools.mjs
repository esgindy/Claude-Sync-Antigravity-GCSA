// MCP tools: run tasks inside the Antigravity desktop app (visible conversation).
import { z } from 'zod';

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg) }] });

export function register(server) {
  server.registerTool('agy_desktop_task', {
    description: 'Start a task in the Antigravity desktop app (visible there). Returns job_id; use agy_wait/agy_result. Runs with the app\'s own permissions.',
    inputSchema: {
      prompt: z.string().min(1).describe('Task for the app agent'),
      cwd: z.string().describe('Absolute working directory'),
      title: z.string().optional().describe('Conversation title'),
      conversation_id: z.string().optional().describe('Continue an existing app conversation'),
      allow_non_project: z.boolean().optional().describe('Opens a new Desktop conversation in Non-Project when cwd is not bound to an Antigravity project. ONLY when the user explicitly asked for a Non-Project conversation. Never set it on your own: a Non-Project conversation cannot be moved into a project later. If the task is refused with PROJECT_BINDING_REQUIRED, ask the user which Antigravity project/conversation to use and pass conversation_id instead.'),
      tier: z.enum(['fast', 'balanced', 'deep', 'auto']).optional(),
      kind: z.enum(['read', 'edit']).optional().describe('Default read'),
      timeout_s: z.number().int().positive().optional(),
      notify_session: z.string().optional().describe('Optional Claude session name to notify on completion or approval request'),
    },
  }, async (args) => {
    try {
      const { startJob } = await import('../lib/jobs-api.mjs');
      const { desktopGate, assertConversationId } = await import('../lib/desktop.mjs');
      const { DESKTOP_WARNING } = await import('../lib/desktop-job.mjs');
      const { loadConfig } = await import('../lib/paths.mjs');
      if (args.conversation_id) assertConversationId(args.conversation_id);
      const policy = desktopGate({ kind: args.kind || 'read' }, loadConfig());
      const r = await startJob({
        prompt: args.prompt, cwd: args.cwd, kind: args.kind || 'read',
        tier: args.tier && args.tier !== 'auto' ? args.tier : undefined,
        timeout_s: args.timeout_s, conversation: args.conversation_id || undefined,
        allow_non_project: args.allow_non_project,
        target: 'desktop', title: args.title || 'Claude task',
        notify_session: args.notify_session,
      });
      return json({ ...r, warning: DESKTOP_WARNING, unrestricted: policy.auto_exec, ...(policy.policy_warning ? { policy_warning: policy.policy_warning } : {}) });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('agy_desktop_status', {
    description: 'Check whether the Antigravity desktop app is running and reachable.',
    inputSchema: {},
  }, async () => {
    try {
      const { checkApp, desktopPolicy } = await import('../lib/desktop.mjs');
      const { probeCli } = await import('../lib/agy.mjs');
      const { loadConfig } = await import('../lib/paths.mjs');
      const { listWorkspaceBindings } = await import('../lib/workspace-binding.mjs');
      const r = await checkApp();
      const cli = probeCli(loadConfig());
      if (r.running || cli.available) {
        try {
          const { clearTransportError } = await import('../lib/transport.mjs');
          clearTransportError();
        } catch { /* best effort */ }
      }
      return json({
        reachable: r.running,
        error: r.error,
        policy: desktopPolicy(),
        cli: { available: cli.available, source: cli.source, path: cli.path },
        bindings: listWorkspaceBindings(),
      });
    } catch (e) { return fail(e.message); }
  });
}
