// Loop guard (Echo): counts crossings between Claude and Antigravity per chain.
// Chain ids are server-issued. A caller id is honoured only if it already exists.
// CSA_CHAIN_ID / CSA_HOP in this process's env (inherited from an agy child that csa-claude started) are authoritative.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { home, ensureHome } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';

const file = () => join(home, 'chains.json');
const lockFile = () => `${file()}.lock`;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !BAD_KEYS.has(id);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function loadChains() {
  const raw = readJson(file());
  const m = Object.create(null);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) if (validId(k) && raw[k] && typeof raw[k] === 'object') m[k] = { hop: Number(raw[k].hop) || 0, updated: raw[k].updated };
  }
  return m;
}

function withLock(fn) {
  try { ensureHome?.(); } catch { /* ignore */ }
  const lf = lockFile();
  const deadline = Date.now() + 8000;
  let fd = null;
  for (;;) {
    try { fd = openSync(lf, 'wx'); writeSync(fd, String(process.pid)); break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { if (existsSync(lf) && Date.now() - statSync(lf).mtimeMs > 10000) unlinkSync(lf); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error('could not lock chains.json');
      sleepSync(15);
    }
  }
  try { return fn(); } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lf); } catch { /* ignore */ }
  }
}

function envChain(env = process.env) {
  const id = env.CSA_CHAIN_ID;
  if (!validId(id)) return null;
  return { chain_id: id, hop: Math.max(0, parseInt(env.CSA_HOP, 10) || 0) };
}

const newId = () => `chain-${randomBytes(4).toString('hex')}`;

/**
 * Atomically check the limit and take the next hop.
 * Returns {chain_id, hop}; throws at the limit.
 */
export function claimHop(chain_id, max_hops = 3, env = process.env) {
  const max = Number(max_hops) || 3;
  return withLock(() => {
    const chains = loadChains();
    const e = envChain(env);
    let id, cur;
    if (e) { id = e.chain_id; cur = Math.max(e.hop, chains[id]?.hop || 0); }
    else if (validId(chain_id) && chains[chain_id]) { id = chain_id; cur = chains[id].hop; }
    else { id = newId(); cur = 0; }
    if (cur + 1 > max) {
      throw new Error(`Hop limit reached (chain ${id}, max ${max}). Stop now and report to the user instead of calling Claude again.`);
    }
    chains[id] = { hop: cur + 1, updated: new Date().toISOString() };
    writeJson(file(), chains);
    return { chain_id: id, hop: cur + 1 };
  });
}

/** Start or extend a chain. Unknown or invalid ids start a new server-issued chain. */
export function nextHop(chain_id, env = process.env) {
  return withLock(() => {
    const chains = loadChains();
    const e = envChain(env);
    let id, cur;
    if (e) { id = e.chain_id; cur = Math.max(e.hop, chains[id]?.hop || 0); }
    else if (validId(chain_id) && chains[chain_id]) { id = chain_id; cur = chains[id].hop; }
    else { id = newId(); cur = 0; }
    chains[id] = { hop: cur + 1, updated: new Date().toISOString() };
    writeJson(file(), chains);
    return { chain_id: id, hop: cur + 1 };
  });
}

/** Throws when one more hop on this chain would exceed max_hops. */
export function assertHopAllowed(chain_id, max_hops = 3, env = process.env) {
  const max = Number(max_hops) || 3;
  const chains = loadChains();
  const e = envChain(env);
  let id = chain_id, cur = 0;
  if (e) { id = e.chain_id; cur = Math.max(e.hop, chains[id]?.hop || 0); }
  else if (validId(chain_id) && chains[chain_id]) cur = chains[chain_id].hop;
  if (cur + 1 > max) {
    throw new Error(`Hop limit reached (chain ${id}, max ${max}). Stop now and report to the user instead of calling Claude again.`);
  }
}
