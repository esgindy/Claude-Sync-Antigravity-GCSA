# Installation — GCSA (Claude Sync Antigravity)

GCSA (Claude Sync Antigravity) 3.5.0. Unofficial tool by Eslam Elgindy, not affiliated with Anthropic or Google.

## Before you start

- Windows
- Node.js 20 or newer (`node --version`)
- The Antigravity desktop app, with the `agy` CLI installed and signed in
- Claude Code and/or Claude Desktop

## 1. Install the project

Open PowerShell in the project folder:

```powershell
cd "<path>\Claude-Sync-Antigravity"
npm install
```

Replace `<path>` with the folder where the project is stored.

## 2. Register with Claude Code

Run this command once. Replace `<path>` with your project folder:

```powershell
claude mcp add --scope user csa -- node "<path>\src\servers\claude-side.mjs"
```

Check that it was added:

```powershell
claude mcp list
```

## 3. Register with Claude Desktop

You have two options.

**Option A: the .mcpb extension (recommended, verify the steps).**

1. Build the staging folder:
   ```powershell
   node packaging\build-mcpb.mjs
   ```
2. Pack the extension. Verify the exact CLI flags first with `npx @anthropic-ai/mcpb --help`, then run:
   ```powershell
   npx @anthropic-ai/mcpb pack dist/csa dist/claude-sync-antigravity-3.5.0.mcpb
   ```
3. Open the `.mcpb` file with Claude Desktop, or install it from Claude Desktop's extension settings. The exact menu names depend on your Claude Desktop version. Verify them in the app.

**Option B: manual config.**

Open `claude_desktop_config.json` (usually in `%APPDATA%\Claude\`; verify the menu path in your Claude Desktop version). Add the `csa` entry. The full example is in `packaging/claude-desktop.example.json`:

```json
{
  "mcpServers": {
    "csa": {
      "command": "node",
      "args": ["C:\\path\\to\\Claude-Sync-Antigravity\\src\\servers\\claude-side.mjs"]
    }
  }
}
```

Use double backslashes in the path. Restart Claude Desktop after saving.

## 4. Register with Antigravity

Antigravity needs the `csa-antigravity` server so that it can ask Claude for a review or a handover.

1. Open this file. Create it if it does not exist:
   `%USERPROFILE%\.gemini\config\mcp_config.json`
2. Add the `csa-antigravity` entry. The example is in `packaging/antigravity-mcp_config.example.json`. The format is:

   ```json
   {"mcpServers":{"csa-antigravity":{"command":"node","args":["<path>\\src\\servers\\antigravity-side.mjs"]}}}
   ```

   Replace `<path>` with your project folder, and keep the double backslashes.

3. If the file already has other servers, add `csa-antigravity` inside the existing `mcpServers` object. Do not delete the others.
4. Restart Antigravity.

## 5. Open the dashboard

```powershell
npm run dashboard
```

Then open http://localhost:4317 in your browser. The dashboard shows the message log and the progress of running tasks.

## 6. Check that it works

In Claude Code, ask Claude to call `agy_models`. You should see the list of Antigravity models with their remaining quota. If the list is empty or shows an error, make sure the Antigravity desktop app is open and signed in.

## 7. Automatic Claude Code Usage Refresh (v3.5.0)

GCSA v3.5.0 automatically refreshes Claude Code usage on the dashboard bottom usage strip (throttled to once per 20 seconds) on:
- Every job start (`agy_task`, `agy_desktop_task`, `agy_swarm`, `claude_review`, `claude_task`)
- Every job finish or state change
- Every logged message in either direction (`claude->antigravity` or `antigravity->claude`)
- Dashboard server startup and status polling

### Usage Sources (First Valid Wins)

1. **Snapshot file `<CSA_HOME>/claude-usage.json`** (`%LOCALAPPDATA%\claude-sync-antigravity\claude-usage.json`):
   `{ "five_hour_remaining_pct": 85, "weekly_remaining_pct": 60, "resets_at": "2026-11-20T12:00:00Z", "note": "Claude Pro", "updated_at": "..." }`
   Used immediately when fresh (within `claude_usage_max_age_s`, default `600` seconds).
   Both `csa_board` `set_usage` and `scripts/push-claude-usage.mjs` write this snapshot atomically.
2. **Optional `claude_usage_command` in `config.json`**:
   An array `[executable, ...args]` (never a shell string), executed with a 5-second timeout (`shell: false`), that prints the same JSON to `stdout`. Values are validated and clamped to `0..100`.
3. **Last value from `csa_board` `set_usage` (marked `stale`)**:
   If the snapshot has expired and no command is configured (or the command fails), GCSA displays the last known value marked as `stale`.
4. **If none is available**:
   The dashboard shows `Unavailable: <reason>` under the Claude icon along with a short setup hint.

> **Privacy & Security Guarantee:** GCSA **never** reads credentials, OAuth tokens, `.credentials.json`, or cookies, **never** calls undocumented endpoints with your tokens, **never** modifies `~/.claude` settings automatically, and **never** fabricates usage numbers from transcripts.

### Optional: Wiring `scripts/push-claude-usage.mjs` to a Claude Code `statusLine` or Hook

You can push real usage snapshots manually or from your own Claude Code `statusLine` / hook script (GCSA does **not** install hooks into `~/.claude` automatically):

```powershell
node "<path>\Claude-Sync-Antigravity\scripts\push-claude-usage.mjs" --five-hour 84 --weekly 62 --resets-at "2026-11-20T12:00:00Z" --note "Claude Code"
```

If you maintain a custom script in `~/.claude/settings.json` (for example a `statusLine` script or a `PostToolUse` / `Stop` hook that already receives or knows your current remaining percentages), have your script invoke `scripts/push-claude-usage.mjs` with `--five-hour`, `--weekly`, and `--resets-at`, or configure `claude_usage_command` in `%LOCALAPPDATA%\claude-sync-antigravity\config.json`:

```json
{
  "claude_usage_max_age_s": 600,
  "claude_usage_command": [
    "node",
    "D:\\path\\to\\your-own-usage-reporter.mjs"
  ]
}
```

See [docs/CLAUDE-USAGE.md](CLAUDE-USAGE.md) for complete examples.

## Troubleshooting

- **Quota is missing:** the Antigravity app must be running.
- **Claude usage shows `Unavailable` or `Stale`:** Claude Code does not expose an unauthenticated local quota API. Have Claude call `csa_board` `set_usage` at the start of delegated tasks, run `scripts/push-claude-usage.mjs`, or configure `claude_usage_command` in `config.json`.
- **`agy` not found:** make sure the `agy` CLI is installed and signed in. The default location is `%LOCALAPPDATA%\agy\bin\agy.exe`.
- **Server does not appear in Claude:** check the path in the config. It must point to the real file location, with double backslashes in JSON.
