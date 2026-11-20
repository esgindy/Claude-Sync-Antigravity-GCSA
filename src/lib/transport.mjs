// Transport selection (auto / desktop / cli), runtime state persistence, and bilingual diagnostics.
import path from 'node:path';
import { home, loadConfig } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { redact } from './safety.mjs';
import { checkApp, desktopGate, desktopPolicy } from './desktop.mjs';
import { probeCli } from './agy.mjs';
import { logMessage } from './messages.mjs';

function redactDeep(val) {
  if (typeof val === 'string') return redact(val);
  if (Array.isArray(val)) return val.map(redactDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = redactDeep(v);
    return out;
  }
  return val;
}

export function transportStateFile() {
  return path.join(home, 'transport-state.json');
}

export function readTransportState() {
  return readJson(transportStateFile());
}

export function recordTransportSuccess({ transport, transport_reason, fallback_from = null, fallback_reason = null }) {
  const next = {
    updated: new Date().toISOString(),
    transport,
    transport_reason: redact(String(transport_reason || '')),
    fallback_from,
    fallback_reason: fallback_reason ? redact(String(fallback_reason)) : null,
    last_error: null,
  };
  writeJson(transportStateFile(), next);
  return next;
}

export function recordTransportError(errObj) {
  const safeErr = redactDeep(errObj && typeof errObj === 'object' ? errObj : { reason: String(errObj || 'no transport available') });
  const next = {
    updated: new Date().toISOString(),
    transport: 'none',
    transport_reason: redact(String(safeErr?.reason || 'no transport available')),
    last_error: safeErr,
  };
  writeJson(transportStateFile(), next);
  return next;
}

export function clearTransportError() {
  const cur = readTransportState();
  if (!cur || !cur.last_error) return cur;
  const next = {
    ...cur,
    updated: new Date().toISOString(),
    last_error: null,
  };
  writeJson(transportStateFile(), next);
  return next;
}

export function buildNoTransportError({ desktopCheck, desktopPolicyInfo, cliCheck } = {}) {
  const detail = redact(String(desktopCheck?.error || 'Antigravity Desktop app not running / agentapi unreachable'));
  const policyInfo = redactDeep(desktopPolicyInfo ?? null);
  const checked = Array.isArray(cliCheck?.checked)
    ? cliCheck.checked.map((c) => ({
        label: String(c?.label || ''),
        path: redact(String(c?.path || '')),
        found: !!c?.found,
      }))
    : [];

  const steps_ar = [
    '(أ) افتح تطبيق Antigravity وسجّل الدخول ثم أعد المحاولة.',
    '(ب) ثبّت أداة agy CLI أو أضِف مجلدها إلى PATH، أو ضع المسار الكامل في إعداد agy_path الجديد داخل ملف config.json.',
    '(ج) تحقّق بالأمر: agy --version',
    '(د) تأكّد من تسجيل الدخول في agy.',
    '(هـ) بعد الإصلاح استخدم أداة agy_desktop_status للتأكد.',
  ];
  const steps_en = [
    '(a) Open the Antigravity Desktop app, sign in, and retry.',
    '(b) Install the agy CLI or add its folder to PATH, or set its full path in the new agy_path setting in config.json.',
    '(c) Verify with: agy --version',
    '(d) Make sure you are signed in to agy.',
    '(e) After fixing, run agy_desktop_status to verify.',
  ];

  const policySummary = policyInfo
    ? `policy=${policyInfo.policy || policyInfo.preset || 'unknown'}, auto_exec=${!!policyInfo.auto_exec}, readable=${policyInfo.readable !== false}`
    : 'policy=unknown';
  const cliLinesAr = checked.length
    ? checked.map((c) => `  - [${c.label}] ${c.path}: ${c.found ? 'موجود' : 'غير موجود'}`).join('\n')
    : '  - لم يتم العثور على مسارات CLI مفحوصة';
  const cliLinesEn = checked.length
    ? checked.map((c) => `  - [${c.label}] ${c.path}: ${c.found ? 'found' : 'not found'}`).join('\n')
    : '  - No CLI locations checked';

  const message = [
    'تعذّر العثور على وسيلة تشغيل متاحة: لا تطبيق Antigravity Desktop ولا أداة agy CLI متاحان.',
    'ما تم فحصه:',
    `- تطبيق Antigravity Desktop: غير متاح (${detail}) [${policySummary}]`,
    '- أداة agy CLI (المسارات المفحوصة):',
    cliLinesAr,
    'خطوات الإصلاح:',
    ...steps_ar,
    '',
    'No transport available: Neither Antigravity Desktop nor agy CLI is available.',
    'What was checked:',
    `- Antigravity Desktop: unavailable (${detail}) [${policySummary}]`,
    '- agy CLI (checked locations):',
    cliLinesEn,
    'How to fix:',
    ...steps_en,
  ].join('\n');

  return {
    code: 'NO_TRANSPORT',
    ts: new Date().toISOString(),
    reason: 'Neither Antigravity Desktop nor agy CLI is available',
    desktop: {
      available: false,
      detail,
      policy: policyInfo,
    },
    cli: {
      available: false,
      checked,
    },
    steps_ar,
    steps_en,
    message,
  };
}

/**
 * Select execution transport for a task:
 * - "desktop": applies desktopGate without pre-probing checkApp (preserves immediate cancellation tests)
 * - "cli": uses CLI directly
 * - "auto": prefers Desktop when running and policy-allowed, otherwise falls back to CLI
 *   (NEVER falls back to CLI on DESKTOP_AUTO_EXEC_REFUSED).
 */
export async function selectTransport({ requestedTarget = 'auto', kind = 'read', config = loadConfig(), deps = {} } = {}) {
  const checkAppFn = deps.checkApp || checkApp;
  const gateFn = deps.desktopGate || desktopGate;
  const policyFn = deps.desktopPolicy || desktopPolicy;
  const probeCliFn = deps.probeCli || probeCli;
  const logMsgFn = deps.logMessage || logMessage;

  if (requestedTarget === 'desktop') {
    const policy = gateFn({ kind }, config);
    return {
      transport: 'desktop',
      requested_target: 'desktop',
      transport_reason: 'explicit target "desktop"',
      policy,
    };
  }

  if (requestedTarget === 'cli') {
    const cli = probeCliFn(config);
    return {
      transport: 'cli',
      requested_target: 'cli',
      transport_reason: cli.available ? `explicit target "cli" (${cli.source})` : 'explicit target "cli"',
      policy: null,
    };
  }

  const app = await checkAppFn();
  if (app.running) {
    try {
      const policy = gateFn({ kind }, config);
      return {
        transport: 'desktop',
        requested_target: 'auto',
        transport_reason: 'auto: Antigravity Desktop app is running and reachable',
        policy,
      };
    } catch (e) {
      if (e?.code === 'DESKTOP_AUTO_EXEC_REFUSED' || /without asking|auto_exec/i.test(String(e?.message || ''))) {
        throw e;
      }
      if (e?.code === 'DESKTOP_EDIT_REFUSED') {
        const cli = probeCliFn(config);
        if (cli.available) {
          return {
            transport: 'cli',
            requested_target: 'auto',
            transport_reason: `auto: desktop edit disabled (allow_desktop_edit=false); fell back to cli (${cli.source})`,
            policy: null,
          };
        }
        throw e;
      }
      throw e;
    }
  }

  const cli = probeCliFn(config);
  if (cli.available) {
    return {
      transport: 'cli',
      requested_target: 'auto',
      transport_reason: `auto: desktop unavailable (${redact(app.error || 'not running')}); selected cli (${cli.source})`,
      policy: null,
    };
  }

  const errObj = buildNoTransportError({
    desktopCheck: app,
    desktopPolicyInfo: policyFn(),
    cliCheck: cli,
  });
  recordTransportError(errObj);
  try {
    logMsgFn({
      direction: 'claude->antigravity',
      channel: 'auto',
      transport: 'none',
      transport_reason: errObj.reason,
      kind: 'error',
      text: errObj.message,
    });
  } catch { /* logging is best effort */ }

  const err = new Error(errObj.message);
  err.code = 'NO_TRANSPORT';
  err.details = errObj;
  throw err;
}
