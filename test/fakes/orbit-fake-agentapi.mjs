// Fake `language_server.exe agentapi ...` for tests. Plays the app agent by writing the result file named in the prompt.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === '--writer') {
  // detached helper: --writer <file> <delayMs> <json>
  setTimeout(() => { fs.writeFileSync(argv[1], argv[3]); }, Number(argv[2]));
} else {
  const args = argv[0] === 'agentapi' ? argv.slice(1) : argv;
  const mode = process.env.FAKE_AGENTAPI_MODE || 'ok';
  const log = process.env.FAKE_AGENTAPI_LOG;
  const cmd = args[0];
  if (log) fs.appendFileSync(log, JSON.stringify({ args, address: process.env.ANTIGRAVITY_LS_ADDRESS, has_token: !!process.env.ANTIGRAVITY_CSRF_TOKEN }) + '\n');
  const out = (o) => { process.stdout.write(JSON.stringify(o)); };
  if (!process.env.ANTIGRAVITY_CSRF_TOKEN) {
    out({ response: {}, error: 'rpc error: code = Unauthenticated desc = missing CSRF token' });
  } else if (mode === 'unavail') {
    out({ response: {}, error: 'rpc error: code = Unavailable desc = connection refused' });
  } else if (cmd === 'get-conversation-metadata') {
    out({ response: { conversationMetadata: { metadata: { workspaces: [], createdAt: 1 } } } });
  } else if (cmd === 'new-conversation' || cmd === 'send-message') {
    const prompt = args[args.length - 1];
    const m = prompt.match(/exact absolute path:\r?\n(.+)\r?\n/);
    const result = JSON.stringify({
      status: process.env.FAKE_AGENTAPI_STATUS || 'done', summary: 'fake agent finished',
      files_changed: ['a.txt'], commands_requested: [], denied_files: [], followups: ['check it'], handoff_notes: 'n/a',
    });
    if (m && mode !== 'never') {
      const delay = Number(process.env.FAKE_AGENTAPI_DELAY_MS || 0);
      if (delay > 0) {
        spawn(process.execPath, [fileURLToPath(import.meta.url), '--writer', m[1], String(delay), result], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else fs.writeFileSync(m[1], result);
    }
    if (cmd === 'new-conversation') out({ response: { newConversation: { conversationId: 'conv-fake-1234' } } });
    else out({ response: { sendMessage: { recipientId: args[args.length - 2], content: 'ok' } } });
  } else {
    out({ response: {}, error: 'unknown command' });
  }
}
