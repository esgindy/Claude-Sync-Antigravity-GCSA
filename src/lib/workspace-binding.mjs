// Workspace-to-Project binding for Antigravity Desktop tasks.
// Prevents opening new conversations in Non-Project when a folder (cwd) is not registered/bound to an Antigravity project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { isInside, redact } from './safety.mjs';
import { getMetadata, assertConversationId } from './desktop.mjs';

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bindingsFile() {
  const baseHome = process.env.CSA_HOME ? path.resolve(process.env.CSA_HOME) : home;
  return path.join(baseHome, 'workspace-bindings.json');
}

export function normalizeCwdKey(p) {
  const abs = path.resolve(String(p || ''));
  const root = path.parse(abs).root;
  const trimmed = abs.length > root.length ? abs.replace(/[\\/]+$/, '') : abs;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const raw = uri.trim();
  if (!/^file:\/\//i.test(raw)) return null;
  if (raw.replace(/^file:\/*/i, '').trim() === '') return null;
  let rest = raw.replace(/^file:\/\//i, '');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (/^\/+[A-Za-z]:/.test(rest)) {
    rest = rest.replace(/^\/+/, '');
  }
  if (!rest || !rest.trim()) return null;
  try {
    return path.resolve(rest);
  } catch {
    return null;
  }
}

export function listWorkspaceBindings() {
  const data = readJson(bindingsFile());
  const list = Array.isArray(data?.bindings) ? data.bindings : (Array.isArray(data) ? data : []);
  return list.filter((b) => b && typeof b === 'object' && b.cwd && b.conversation_id);
}

export function getSavedBinding(cwd) {
  if (!cwd) return null;
  const targetKey = normalizeCwdKey(cwd);
  const bindings = listWorkspaceBindings();
  for (const b of bindings) {
    if (normalizeCwdKey(b.cwd) === targetKey) return b;
  }
  let best = null;
  let bestLen = -1;
  for (const b of bindings) {
    try {
      if (isInside(cwd, b.cwd)) {
        const len = normalizeCwdKey(b.cwd).length;
        if (len > bestLen) {
          best = b;
          bestLen = len;
        }
      }
    } catch { /* ignore invalid paths */ }
  }
  return best;
}

export function saveWorkspaceBinding({ cwd, conversation_id, project_id = null, title = null, source = 'manual' } = {}) {
  assertConversationId(conversation_id);
  if (!cwd || !String(cwd).trim()) throw new Error('cwd is required for workspace binding.');
  const cleanCwd = path.resolve(String(cwd));
  const key = normalizeCwdKey(cleanCwd);
  const bindings = listWorkspaceBindings();
  const entry = {
    cwd: cleanCwd,
    conversation_id,
    project_id: project_id || null,
    title: title || null,
    source: source || 'manual',
    updated_at: new Date().toISOString(),
  };
  const idx = bindings.findIndex((b) => normalizeCwdKey(b.cwd) === key);
  if (idx >= 0) bindings[idx] = entry;
  else bindings.push(entry);
  writeJson(bindingsFile(), { bindings });
  return entry;
}

export async function discoverAntigravityProjects({ maxCheck = 12, getMetadataFn = getMetadata } = {}) {
  const candidates = new Map();
  const annDir = process.env.CSA_ANNOTATIONS_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'annotations');
  try {
    for (const name of fs.readdirSync(annDir)) {
      if (!name.toLowerCase().endsWith('.pbtxt')) continue;
      const id = name.slice(0, -6);
      if (!UUID_ONLY_RE.test(id)) continue;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(annDir, name)).mtimeMs || 0; } catch {}
      candidates.set(id.toLowerCase(), { id, mtimeMs });
    }
  } catch { /* annotations dir optional */ }

  if (candidates.size === 0 || process.env.CSA_BRAIN_DIR) {
    const brainDir = process.env.CSA_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    try {
      for (const name of fs.readdirSync(brainDir)) {
        if (!UUID_ONLY_RE.test(name)) continue;
        let mtimeMs = 0;
        try {
          const st = fs.statSync(path.join(brainDir, name));
          if (!st.isDirectory()) continue;
          mtimeMs = st.mtimeMs || 0;
        } catch {
          continue;
        }
        const key = name.toLowerCase();
        if (!candidates.has(key) || mtimeMs > candidates.get(key).mtimeMs) {
          candidates.set(key, { id: name, mtimeMs });
        }
      }
    } catch { /* brain dir optional */ }
  }

  const limit = Math.max(1, Number(maxCheck) || 12);
  const sorted = [...candidates.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  const discovered = [];

  for (const cand of sorted) {
    try {
      const res = await getMetadataFn(cand.id);
      const meta = res?.response?.conversationMetadata?.metadata || res?.conversationMetadata?.metadata || {};
      const projectId = String(meta.projectId || '').trim();
      const rawUris = [
        ...(Array.isArray(meta.workspaceUris) ? meta.workspaceUris : []),
        ...((Array.isArray(meta.workspaces) ? meta.workspaces : []).map((w) => w?.workspaceFolderAbsoluteUri).filter(Boolean)),
      ];
      const seen = new Set();
      const paths = [];
      for (const u of rawUris) {
        const p = fileUriToPath(u);
        if (!p) continue;
        const k = normalizeCwdKey(p);
        if (!seen.has(k)) {
          seen.add(k);
          paths.push(p);
        }
      }
      if (paths.length > 0 || projectId) {
        discovered.push({
          conversation_id: cand.id,
          project_id: projectId || null,
          workspaces: paths,
          created_at: meta.createdAt || null,
        });
      }
    } catch { /* ignore conversations without metadata */ }
  }

  return discovered;
}

export function buildProjectBindingRequiredError({ cwd, discovered = [] } = {}) {
  const cleanCwd = path.resolve(String(cwd || process.cwd()));
  const projectLines = discovered.length > 0
    ? discovered.map((d) => `  - project_id: ${d.project_id || 'n/a'} | conversation_id: ${d.conversation_id} | folders: ${(d.workspaces || []).join(', ') || 'none'}`).join('\n')
    : '  (No registered Antigravity project conversations were discovered / لم يتم العثور على مشاريع مسجلة حالياً)';

  const rawMsg = [
    `Refused (PROJECT_BINDING_REQUIRED): The folder "${cleanCwd}" is not bound to any registered Antigravity Desktop project/conversation.`,
    `رفض (PROJECT_BINDING_REQUIRED): الفولدر "${cleanCwd}" غير مربوط بأي مشروع أو محادثة مسجلة في Antigravity Desktop، ولذلك تم إيقاف فتح محادثة عشوائية في Non-Project.`,
    '',
    'Before starting this task, please confirm / قبل بدء المهمة يرجى تحديد:',
    '1. أي مشروع أو محادثة في Antigravity سيتم ربط المهمة عليها؟ (Which Antigravity project / conversation should this task be bound to?)',
    '2. وأي فولدر (cwd) سيتم العمل عليه؟ (And which folder (cwd) should be worked on?)',
    '',
    'Discovered Antigravity projects/conversations (المشاريع والمحادثات المكتشفة):',
    projectLines,
    '',
    'How to proceed (طرق المتابعة):',
    `  (a / أ) Pass conversation_id: "<uuid>" of an existing conversation inside the target Antigravity project (CSA will bind and save it automatically for "${cleanCwd}").`,
    `  (b / ب) Open "${cleanCwd}" as a Project in Antigravity Desktop and start a conversation there, so CSA discovers and binds it automatically.`,
    '  (c / ج) Pass allow_non_project: true in agy_task / agy_desktop_task if you explicitly want to open a new conversation in Non-Project (with cwd injected into the prompt header).',
  ].join('\n');

  const message = redact(rawMsg);
  return {
    code: 'PROJECT_BINDING_REQUIRED',
    cwd: cleanCwd,
    discovered_projects: discovered,
    message,
  };
}

export function shouldEnforceProjectBinding(config = {}) {
  if (process.env.CSA_ENFORCE_PROJECT_BINDING === '1') return true;
  if (process.env.CSA_ENFORCE_PROJECT_BINDING === '0') return false;
  if (config.require_desktop_project_binding === false) return false;
  if (process.env.CSA_AGENTAPI) return false;
  return true;
}

export async function resolveDesktopProjectBinding({
  cwd,
  conversation_id = null,
  allow_non_project = false,
  config = {},
  deps = {},
} = {}) {
  const cleanCwd = path.resolve(String(cwd || process.cwd()));

  if (conversation_id) {
    assertConversationId(conversation_id);
    saveWorkspaceBinding({ cwd: cleanCwd, conversation_id, source: 'explicit' });
    return {
      conversation_id,
      mode: 'explicit_conversation',
      reason: `bound to explicit conversation_id ${conversation_id}`,
    };
  }

  const saved = getSavedBinding(cleanCwd);
  if (saved) {
    return {
      conversation_id: saved.conversation_id,
      project_id: saved.project_id || null,
      mode: 'saved_binding',
      reason: `bound to saved project conversation ${saved.conversation_id} for ${saved.cwd}`,
    };
  }

  if (!shouldEnforceProjectBinding(config)) {
    return { conversation_id: null, mode: 'unenforced', reason: null };
  }

  const discovered = await discoverAntigravityProjects({
    getMetadataFn: deps.getMetadata || getMetadata,
  });

  const targetKey = normalizeCwdKey(cleanCwd);
  let match = null;
  let wsMatched = null;

  for (const entry of discovered) {
    for (const ws of entry.workspaces || []) {
      if (normalizeCwdKey(ws) === targetKey) {
        match = entry;
        wsMatched = ws;
        break;
      }
    }
    if (match) break;
  }

  if (!match) {
    for (const entry of discovered) {
      for (const ws of entry.workspaces || []) {
        try {
          if (isInside(cleanCwd, ws)) {
            match = entry;
            wsMatched = ws;
            break;
          }
        } catch { /* ignore */ }
      }
      if (match) break;
    }
  }

  if (match && wsMatched) {
    saveWorkspaceBinding({
      cwd: wsMatched,
      conversation_id: match.conversation_id,
      project_id: match.project_id,
      source: 'auto_discovered',
    });
    return {
      conversation_id: match.conversation_id,
      project_id: match.project_id || null,
      mode: 'auto_discovered',
      reason: `auto-discovered Antigravity project conversation ${match.conversation_id} for ${wsMatched}`,
    };
  }

  if (allow_non_project === true || config.allow_desktop_non_project === true) {
    return {
      conversation_id: null,
      mode: 'allow_non_project',
      reason: 'allow_non_project=true (new conversation in Non-Project with cwd header)',
    };
  }

  const info = buildProjectBindingRequiredError({ cwd: cleanCwd, discovered });
  const err = new Error(info.message);
  err.code = 'PROJECT_BINDING_REQUIRED';
  err.details = info;
  throw err;
}
