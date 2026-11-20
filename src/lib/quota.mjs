// Remaining quota. Keeps only plan, credits and per-model label/remaining/reset.
import fs from 'node:fs';
import { redact } from './safety.mjs';

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function summarizeStatus(raw) {
  const us = raw?.userStatus || {};
  const ps = us.planStatus || {};
  const info = ps.planInfo || {};
  const cfgs = us.cascadeModelConfigData?.clientModelConfigs || [];
  const models = [];
  for (const c of cfgs) {
    if (!c?.label) continue;
    const q = c.quotaInfo || {};
    const f = num(q.remainingFraction);
    models.push({
      label: String(c.label),
      remaining_pct: f === null ? null : Math.round(f * 1000) / 10,
      resets_at: q.resetTime ?? null,
    });
  }
  return {
    plan: info.planName ?? null,
    credits: {
      prompt_available: num(ps.availablePromptCredits),
      prompt_monthly: num(info.monthlyPromptCredits),
      flow_available: num(ps.availableFlowCredits),
      flow_monthly: num(info.monthlyFlowCredits),
    },
    models,
  };
}

export async function getQuota() {
  if (process.env.CSA_QUOTA_FILE) {
    const raw = JSON.parse(fs.readFileSync(process.env.CSA_QUOTA_FILE, 'utf8'));
    // Accept either a raw GetUserStatus response or an already-summarized object.
    return raw?.userStatus ? summarizeStatus(raw) : { plan: raw.plan ?? null, credits: raw.credits ?? {}, models: raw.models ?? [] };
  }
  try {
    const { discoverLs } = await import('./desktop.mjs');
    const ls = await discoverLs();
    const addr = ls.ANTIGRAVITY_LS_ADDRESS;
    const token = ls.ANTIGRAVITY_CSRF_TOKEN;
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': token,
      },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GetUserStatus failed with HTTP ${res.status}`);
    return summarizeStatus(await res.json());
  } catch (e) {
    throw new Error(`Quota unavailable: ${redact(String(e?.message || e))}`);
  }
}

/** Map model id -> remaining fraction (0..1), matching quota labels to model labels. */
export function quotaById(quota, models) {
  const byLabel = new Map();
  for (const m of quota?.models || []) {
    if (m.remaining_pct !== null && m.remaining_pct !== undefined) byLabel.set(String(m.label).toLowerCase(), m.remaining_pct / 100);
  }
  const out = {};
  for (const m of models || []) {
    const f = byLabel.get(String(m.label).toLowerCase());
    if (f !== undefined) out[m.id] = f;
  }
  return out;
}
