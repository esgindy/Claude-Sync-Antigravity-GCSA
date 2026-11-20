// MCP tools: run several Antigravity jobs in parallel (split a task, or compare models).
import { z } from 'zod';

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg) }] });

export function register(server) {
  server.registerTool('agy_swarm', {
    description: 'Run several Antigravity jobs in parallel. mode "split": parts[] with own prompt/tier/model/kind/files. mode "compare": one prompt on 2-3 models (read-only). Parallel edit parts must not share files. Returns swarm_id; poll with agy_swarm_status.',
    inputSchema: {
      mode: z.enum(['split', 'compare']),
      cwd: z.string().describe('Absolute working directory'),
      parts: z.array(z.object({
        prompt: z.string().min(1),
        tier: z.enum(['fast', 'balanced', 'deep', 'auto']).optional(),
        model: z.string().optional(),
        kind: z.enum(['read', 'edit']).optional(),
        files: z.array(z.string()).optional().describe('Files this part may edit'),
      })).optional().describe('split mode'),
      prompt: z.string().optional().describe('compare mode: the shared prompt'),
      models: z.array(z.string()).min(2).max(3).optional().describe('compare mode: 2-3 model ids'),
      target: z.enum(['auto', 'cli', 'desktop']).optional(),
      title: z.string().optional(),
    },
  }, async (a) => {
    try {
      const { startSwarm } = await import('../lib/swarm.mjs');
      return json(await startSwarm({ mode: a.mode, parts: a.parts, cwd: a.cwd, target: a.target || 'cli', title: a.title, models: a.models, prompt: a.prompt }));
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('agy_swarm_status', {
    description: "Status of a swarm: overall state and each part's compact result. Also starts queued parts.",
    inputSchema: { swarm_id: z.string() },
  }, async ({ swarm_id }) => {
    try {
      const { swarmStatus } = await import('../lib/swarm.mjs');
      return json(await swarmStatus(swarm_id));
    } catch (e) { return fail(e.message); }
  });
}
