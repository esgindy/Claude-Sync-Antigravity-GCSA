// Shared paths for the dashboard server and progress.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const csaHome = process.env.CSA_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'claude-sync-antigravity');

// Manual agents/tasks (Claude-side agents, Gindy's plan) live in a status file:
// CSA_STATUS, else <CSA_HOME>/status.json, else the repo's own dashboard/status.json (build tracking).
export function statusFile() {
  if (process.env.CSA_STATUS) return path.resolve(process.env.CSA_STATUS);
  const home = path.join(csaHome, 'status.json');
  if (process.env.CSA_HOME || fs.existsSync(home)) return home;
  const repo = path.join(here, 'status.json');
  return fs.existsSync(repo) ? repo : home;
}

export const emptyStatus = () => ({ project: null, owner: 'Eslam Elgindy', agents: [], log: [] });
