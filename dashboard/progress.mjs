#!/usr/bin/env node
// Updates dashboard/status.json. Usage:
//   node progress.mjs <agent> <taskId> <todo|doing|done|blocked> "<note>"
//   node progress.mjs <agent> --now "<what the agent is doing right now>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'status.json');
const [agentId, a2, a3, a4] = process.argv.slice(2);
const STATES = ['todo', 'doing', 'done', 'blocked'];

function update(mutate) {
  for (let i = 0; i < 20; i++) { // tiny retry loop: several agents may write at once
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      mutate(s);
      const tmp = `${file}.${process.pid}.${i}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i === 19) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

update((s) => {
  const agent = s.agents.find((x) => x.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const ts = new Date().toISOString();
  if (a2 === '--now') {
    agent.now = String(a3 || '').slice(0, 160);
    s.log.unshift({ ts, agent: agentId, text: `الآن: ${agent.now}` });
  } else {
    const task = agent.tasks.find((t) => t.id === a2);
    if (!task) throw new Error(`unknown task ${a2}`);
    if (!STATES.includes(a3)) throw new Error(`state must be one of ${STATES.join(', ')}`);
    task.state = a3;
    if (a4 !== undefined) task.note = String(a4).slice(0, 160);
    task.updated = ts;
    s.log.unshift({ ts, agent: agentId, text: `${task.id} ${task.title} → ${a3}${a4 ? `: ${a4}` : ''}` });
  }
  s.log = s.log.slice(0, 300);
  s.updated = ts;
});
console.log('ok');
