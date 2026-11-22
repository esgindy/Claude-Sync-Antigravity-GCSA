// Builds the staging folder dist/csa for the Claude Desktop extension (.mcpb).
// Run from the project root: node packaging/build-mcpb.mjs
// This script does not run npx and does not install packages from the network.
// It copies files, then prunes dev dependencies inside dist/csa with npm.

import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'csa');

const required = ['src', 'config.default.json', 'package.json', 'LICENSE', 'README.md', 'node_modules'];
const manifest = join(root, 'packaging', 'manifest.json');

for (const item of [...required, 'packaging/manifest.json']) {
  if (!existsSync(join(root, item))) {
    console.error(`Missing: ${item}. Run "npm install" first if node_modules is missing.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, 'src'), join(out, 'src'), { recursive: true });
for (const file of ['config.default.json', 'package.json', 'LICENSE', 'README.md']) {
  copyFileSync(join(root, file), join(out, file));
}
if (existsSync(join(root, 'package-lock.json'))) {
  copyFileSync(join(root, 'package-lock.json'), join(out, 'package-lock.json'));
}
cpSync(join(root, 'node_modules'), join(out, 'node_modules'), { recursive: true });
copyFileSync(manifest, join(out, 'manifest.json'));

// Keep production dependencies only. Uses the npm that runs this script.
const npmCli = process.env.npm_execpath;
const prune = npmCli
  ? spawnSync(process.execPath, [npmCli, 'prune', '--omit=dev'], { cwd: out, stdio: 'inherit' })
  : spawnSync('npm', ['prune', '--omit=dev'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
if (prune.status !== 0) {
  console.error('npm prune --omit=dev failed. Check the output above.');
  process.exit(prune.status ?? 1);
}

console.log(`Staging folder ready: ${out}`);
console.log('Next step (verify the exact mcpb CLI flags with: npx @anthropic-ai/mcpb --help):');
console.log('  npx @anthropic-ai/mcpb pack dist/csa dist/claude-sync-antigravity-1.0.1.mcpb');
