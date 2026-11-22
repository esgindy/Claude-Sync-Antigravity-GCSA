// Model list from `agy models`, cached for 10 minutes.
import path from 'node:path';
import { home, ensureHome } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { runAgy } from './agy.mjs';

const TTL_MS = 10 * 60 * 1000;

export function parseModels(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || /^fetching available models/i.test(line.trim())) continue;
    let id;
    let label;
    if (line.includes('\t')) {
      const i = line.indexOf('\t');
      id = line.slice(0, i).trim();
      label = line.slice(i + 1).trim();
    } else {
      const m = line.trim().match(/^(\S+)\s{2,}(.+)$/);
      if (!m) continue;
      id = m[1];
      label = m[2].trim();
    }
    if (!id || /\s/.test(id)) continue;
    out.push({ id, label: label || id });
  }
  return out;
}

export async function listModels({ refresh = false } = {}) {
  const cacheFile = path.join(home, 'models-cache.json');
  if (!refresh) {
    const c = readJson(cacheFile);
    if (c && Array.isArray(c.models) && c.models.length && Date.now() - c.fetched_at < TTL_MS) return c.models;
  }
  const r = await runAgy(['models'], { timeoutMs: 30000 });
  const models = parseModels(r.stdout);
  if (!models.length) {
    const stale = readJson(cacheFile);
    if (stale && Array.isArray(stale.models) && stale.models.length) return stale.models;
    throw new Error(`agy models returned no models (exit ${r.code}). ${String(r.stderr || '').slice(0, 300)}`.trim());
  }
  ensureHome();
  writeJson(cacheFile, { fetched_at: Date.now(), models });
  return models;
}

export function findModel(idOrLabel, models) {
  if (!idOrLabel) return null;
  const q = String(idOrLabel).trim().toLowerCase();
  for (const m of models || []) {
    if (m.id.toLowerCase() === q || String(m.label).toLowerCase() === q) return { id: m.id, label: m.label };
  }
  return null;
}
