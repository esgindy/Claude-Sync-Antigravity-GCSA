import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function callModels(quota) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-mfb-'));
  const quotaFile = path.join(tmp, 'quota.json');
  fs.writeFileSync(quotaFile, JSON.stringify(quota));
  const env = {
    ...process.env,
    CSA_HOME: tmp,
    CSA_AGY_BIN: path.join(tmp, 'no-such-agy'), // agy CLI not installed
    CSA_QUOTA_FILE: quotaFile,
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
    ANTIGRAVITY_CSRF_TOKEN: 'test-token-not-real',
    CSA_AGENTAPI: path.join(tmp, 'no-such-agentapi'),
    CSA_AG_CONFIG: path.join(here, 'fakes', 'orbit-ag-config-safe.json'),
  };
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'fakes', 'atlas-mcp-server.mjs')], env }));
  try {
    const r = await client.callTool({ name: 'agy_models', arguments: {} });
    let data = r.content[0].text;
    try { data = JSON.parse(data); } catch { /* error text */ }
    return { isError: !!r.isError, data };
  } finally { await client.close(); }
}

test('agy_models falls back to the desktop app when the agy CLI is missing', async () => {
  const r = await callModels({ plan: 'Pro', models: [{ label: 'Gemini 3.8 Flash (High)', remaining_pct: 99.1, resets_at: 'r' }] });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.source, 'desktop');
  assert.equal(r.data.models[0].label, 'Gemini 3.8 Flash (High)');
  assert.equal(r.data.models[0].remaining_pct, 99.1);
});

test('agy_models gives a clear error when neither the CLI nor the app is available', async () => {
  const r = await callModels({ plan: null, models: [] });
  assert.equal(r.isError, true);
  assert.match(String(r.data), /agy CLI|setup\.mjs/);
});
