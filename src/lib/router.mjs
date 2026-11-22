// Automatic tier and model choice.

const DEEP_WORDS = [
  'security', 'audit', 'vulnerabilit', 'architecture', 'refactor', 'migration', 'root cause', 'debugging', 'performance',
  'أمن', 'أمان', 'امان', 'ثغرة', 'ثغرات', 'تدقيق', 'مراجعة أمنية', 'معمارية', 'هيكلة', 'ترحيل', 'السبب الجذري', 'تصحيح الأخطاء', 'تتبع الأخطاء', 'أداء', 'الأداء',
];
const FAST_WORDS = ['summary', 'summarize', 'summarise', 'translate', 'list', 'ملخص', 'لخص', 'تلخيص', 'ترجم', 'ترجمة', 'قائمة', 'اعرض'];

export function autoTier({ prompt = '', kind = 'read', addDirs = [] } = {}) {
  const text = String(prompt);
  const low = text.toLowerCase();
  const hit = DEEP_WORDS.find((w) => low.includes(w));
  if (hit) return { tier: 'deep', reason: `keyword "${hit}" suggests a complex task` };
  if (text.length > 6000) return { tier: 'deep', reason: 'very long prompt (over 6000 chars)' };
  if (kind === 'edit' && (text.length > 2500 || (addDirs || []).length > 1)) {
    return { tier: 'deep', reason: 'large edit task' };
  }
  if (kind === 'read' && text.length < 300) return { tier: 'fast', reason: 'short read-only task' };
  if (kind === 'read' && text.length < 600) {
    const f = FAST_WORDS.find((w) => low.includes(w));
    if (f) return { tier: 'fast', reason: `short read-only task with keyword "${f}"` };
  }
  return { tier: 'balanced', reason: 'default for a medium task' };
}

const TIER_FALLBACK = { deep: ['balanced', 'fast'], balanced: ['fast', 'deep'], fast: ['balanced', 'deep'] };

/**
 * available: ids the agy CLI reports for this account (empty/omitted = unknown, use the config as is).
 * Models the account doesn't have are skipped; if a whole tier is unavailable, the nearest tier is used.
 */
export function pickModel(config, { tier, model, prompt, kind, addDirs } = {}, quotaMap = {}, available = []) {
  if (model) return { model, tier: tier && tier !== 'auto' ? tier : 'explicit', reason: 'model chosen explicitly by the caller' };
  let t = tier && tier !== 'auto' ? tier : null;
  let why = t ? `tier "${t}" chosen by the caller` : null;
  if (!t) {
    const a = autoTier({ prompt, kind, addDirs });
    t = a.tier;
    why = `auto: ${a.reason}`;
  }
  const configured = config?.tiers?.[t];
  if (!Array.isArray(configured) || !configured.length) throw new Error(`No models configured for tier "${t}".`);
  const avail = new Set((available || []).map((x) => String(x)));
  let list = avail.size ? configured.filter((id) => avail.has(id)) : configured;
  if (!list.length) {
    const alt = (TIER_FALLBACK[t] || []).find((x) => (config?.tiers?.[x] || []).some((id) => avail.has(id)));
    if (!alt) throw new Error(`None of the models configured for tier "${t}" (${configured.join(', ')}) are available to this Antigravity account. Run agy_models and update "tiers" in config.json.`);
    why = `${why}; tier "${t}" has no model available to this account, using "${alt}"`;
    t = alt;
    list = config.tiers[alt].filter((id) => avail.has(id));
  }
  const min = config.quota_min_fraction ?? 0.1;
  for (const id of list) {
    const f = quotaMap?.[id];
    if (f === undefined || f === null || f >= min) {
      const skipped = list.indexOf(id);
      return {
        model: id,
        tier: t,
        reason: skipped > 0 ? `${why}; skipped ${skipped} model(s) with low quota` : why,
      };
    }
  }
  // Everything in the tier is low: use the one with the most quota left.
  const best = [...list].sort((a, b) => (quotaMap[b] ?? 0) - (quotaMap[a] ?? 0))[0];
  return { model: best, tier: t, reason: `${why}; all models in this tier are below the quota threshold` };
}
