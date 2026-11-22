// Fake `language_server.exe agentapi ...` whose probe succeeds (so checkApp reports running)
// but new-conversation / send-message fail with Unavailable (triggering runtime CLI fallback).
import fs from 'node:fs';

const argv = process.argv.slice(2);
const args = argv[0] === 'agentapi' ? argv.slice(1) : argv;
const cmd = args[0];
const log = process.env.FAKE_AGENTAPI_LOG;

if (log) {
  fs.appendFileSync(
    log,
    JSON.stringify({
      args,
      address: process.env.ANTIGRAVITY_LS_ADDRESS,
      has_token: !!process.env.ANTIGRAVITY_CSRF_TOKEN,
    }) + '\n',
  );
}

const out = (o) => {
  process.stdout.write(JSON.stringify(o));
};

if (!process.env.ANTIGRAVITY_CSRF_TOKEN) {
  out({ response: {}, error: 'rpc error: code = Unauthenticated desc = missing CSRF token' });
} else if (cmd === 'get-conversation-metadata') {
  out({ response: { conversationMetadata: { metadata: { workspaces: [], createdAt: 1 } } } });
} else if (cmd === 'new-conversation' || cmd === 'send-message') {
  out({ response: {}, error: 'rpc error: code = Unavailable desc = connection refused' });
} else {
  out({ response: {}, error: 'unknown command' });
}
