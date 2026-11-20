// Home directory and configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Package root (folder that holds package.json and config.default.json). */
export const packageRoot = path.resolve(here, '..', '..');

function defaultHome() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'claude-sync-antigravity');
}

/** State directory. Created on first write (see ensureHome). */
export const home = process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : defaultHome();

export function ensureHome() {
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Merge default config with <home>/config.json (shallow; tiers merged per key). */
export function loadConfig() {
  const def = readJsonSafe(path.join(packageRoot, 'config.default.json')) || {};
  const user = readJsonSafe(path.join(home, 'config.json')) || {};
  const cfg = { ...def, ...user };
  cfg.tiers = { ...(def.tiers || {}), ...(user.tiers || {}) };
  if (def.desktop_model_map || user.desktop_model_map) {
    cfg.desktop_model_map = { ...(def.desktop_model_map || {}), ...(user.desktop_model_map || {}) };
  }
  return cfg;
}
