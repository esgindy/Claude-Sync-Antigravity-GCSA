import test from 'node:test';
import assert from 'node:assert/strict';
import * as plat from '../src/lib/platform.mjs';

test('platform flags are mutually consistent', () => {
  assert.equal([plat.isWin, plat.isMac, plat.isLinux].filter(Boolean).length <= 1, true);
  assert.equal(plat.isWin, process.platform === 'win32');
});

test('state home is absolute and ends with the app folder', () => {
  const h = plat.stateHome();
  assert.ok(h.endsWith('claude-sync-antigravity'));
  assert.ok(h.length > 'claude-sync-antigravity'.length);
});

test('shellInvocation passes the command as one argument', () => {
  const s = plat.shellInvocation('echo "a b"; ls');
  assert.equal(s.args[s.args.length - 1], 'echo "a b"; ls');
  if (plat.isWin) assert.equal(s.cmd, 'powershell.exe');
  else assert.ok(/\/(zsh|sh)$/.test(s.cmd));
});

test('executable lookup rules per OS', () => {
  if (plat.isWin) assert.deepEqual(plat.pathExts(), ['.exe', '.com', '']);
  else assert.deepEqual(plat.pathExts(), ['']);
  assert.equal(plat.hasKnownExt('x.mjs'), true);
  assert.equal(plat.hasKnownExt('agy'), false);
});

test('candidate lists are non-empty and OS-appropriate', () => {
  for (const list of [plat.agyCandidates(), plat.claudeCandidates(), plat.languageServerCandidates()]) {
    assert.ok(list.length > 0);
    if (!plat.isWin) assert.ok(list.every((p) => !p.endsWith('.exe')));
  }
});

test('scanLanguageServers parses ps/lsof output on POSIX', async () => {
  if (plat.isWin) return;
  const fake = async (cmd) => {
    if (cmd === 'ps') return { code: 0, stdout: '  101 /Applications/Antigravity.app/Contents/Resources/bin/language_server --subclient_type hub --csrf_token abc\n  102 /usr/bin/vim language_server.txt\n', stderr: '' };
    return { code: 0, stdout: 'p101\nn127.0.0.1:5555\nn*:6666\n', stderr: '' };
  };
  const r = await plat.scanLanguageServers(fake);
  assert.equal(r.length, 1);
  assert.equal(r[0].pid, 101);
  assert.deepEqual(r[0].ports.sort(), [5555, 6666]);
});

test('killProcessTree tolerates missing pid', () => {
  plat.killProcessTree(undefined);
  plat.killProcessTree(99999999);
});

test('macOS firmlink form of home/Library is too broad (direct isTooBroad call)', async () => {
  if (!plat.isMac) return;
  const { isTooBroad } = await import('../src/lib/safety.mjs');
  const os = await import('node:os');
  const h = os.homedir();
  assert.equal(isTooBroad('/System/Volumes/Data' + h), true);
  assert.equal(isTooBroad('/System/Volumes/Data' + h + '/Library'), true);
  assert.equal(isTooBroad('/var'), true);
  assert.equal(isTooBroad(h + '/Projects/some-project'), false);
});
