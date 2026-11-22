# Automatic Claude Code Usage Refresh — GCSA V5 (5.0.0)

GCSA (Claude Sync Antigravity) v5.0.0 automatically refreshes the Claude Code usage section on the live dashboard's bottom usage strip (`src/lib/claude-usage.mjs`).

## 1. What Is Automatic vs. What Needs a Source

- **Automatic refresh triggers (`refreshClaudeUsage({reason})`)**:
  GCSA triggers a non-blocking, fire-and-forget usage refresh (throttled to once every 20 seconds, never throws) on:
  1. Every job start (`startJob`, `createJob`, `startClaudeJob`)
  2. Every job finish or state transition (`updateJob`, `runner.mjs`, `claude-runner.mjs`)
  3. Every logged message in either direction (`logMessage` for both `claude->antigravity` and `antigravity->claude`)
  4. Dashboard server startup and `/api/status` polls
- **MCP server instruction (`src/servers/claude-side.mjs`)**:
  The `csa-claude` MCP server instructions explicitly tell Claude to call `csa_board` `action="set_usage"` with real numbers at the start of each delegated task, which atomically writes both `<CSA_HOME>/claude-usage.json` and `status.json`.
- **Why an external push or command is still needed if Claude does not call `set_usage`**:
  Unlike Antigravity Desktop (which exposes a local loopback `GetUserStatus` RPC), Claude Code CLI does **not** expose a local unauthenticated quota endpoint. Because GCSA strictly refuses to read `.credentials.json`, OAuth tokens, or cookies, refuses to call undocumented remote endpoints with user tokens, and refuses to fabricate estimates from transcripts, accurate numbers must originate from one of the three sanctioned sources below.

## 2. Sanctioned Sources (First Valid Wins)

`<CSA_HOME>` is the state folder (the `CSA_HOME` environment variable overrides it):

| OS | Default `<CSA_HOME>` |
|---|---|
| Windows | `%LOCALAPPDATA%\claude-sync-antigravity` |
| macOS | `~/Library/Application Support/claude-sync-antigravity` |
| Linux | `~/.local/share/claude-sync-antigravity` |

1. **Snapshot file `<CSA_HOME>/claude-usage.json`**:
   ```json
   {
     "five_hour_remaining_pct": 84,
     "weekly_remaining_pct": 62,
     "resets_at": "2026-11-20T12:00:00Z",
     "note": "Claude Code Pro",
     "updated_at": "2026-11-20T07:20:00.000Z"
   }
   ```
   Considered fresh while its age is within `claude_usage_max_age_s` (default `600` seconds = 10 minutes).
2. **Optional `claude_usage_command` in `<CSA_HOME>/config.json`**:
   An array of strings `[executable, ...args]` (never a shell string), run with `shell: false` and a 5-second timeout. It must print a JSON object with `{five_hour_remaining_pct, weekly_remaining_pct, resets_at, note}` to `stdout`. Numeric values are validated and clamped to `0..100`, secrets are redacted, and the output is saved atomically to `<CSA_HOME>/claude-usage.json`.
3. **Last value from `csa_board` `set_usage` (marked `stale`)**:
   When the snapshot is older than `claude_usage_max_age_s` and no command is configured (or the command fails), GCSA falls back to the last value from `csa_board` `set_usage` and marks it `stale: true`.
4. **Unavailable**:
   When none of the three sources has data, `/api/status` and the dashboard display `Unavailable: <reason>` under the Claude icon along with a short setup hint.

## 3. Pushing Usage with `scripts/push-claude-usage.mjs`

You can write `<CSA_HOME>/claude-usage.json` atomically at any time using `scripts/push-claude-usage.mjs`:

Windows (PowerShell):

```powershell
node "D:\path\to\Claude-Sync-Antigravity\scripts\push-claude-usage.mjs" --five-hour 84 --weekly 62 --resets-at "2026-11-20T12:00:00Z" --note "Claude Pro"
```

macOS / Linux:

```bash
node "/path/to/Claude-Sync-Antigravity/scripts/push-claude-usage.mjs" --five-hour 84 --weekly 62 --resets-at "2026-11-20T12:00:00Z" --note "Claude Pro"
```

### Optional Manual Wiring to Claude Code `statusLine` or Hooks (`~/.claude/settings.json`)

> **Important:** GCSA **never** modifies `~/.claude/settings.json` automatically. If you want automatic background pushes from your own Claude Code environment, you can wire `scripts/push-claude-usage.mjs` yourself:

- **Option A — From your own `statusLine` wrapper script:**
  If you already use a custom `statusLine` command in `~/.claude/settings.json` that formats or tracks your session status, add a non-blocking call inside your wrapper script:
  ```powershell
  node "D:\path\to\Claude-Sync-Antigravity\scripts\push-claude-usage.mjs" --five-hour $FiveHourPct --weekly $WeeklyPct --resets-at $ResetsAt
  ```
  macOS / Linux (bash/zsh wrapper):
  ```bash
  node "/path/to/Claude-Sync-Antigravity/scripts/push-claude-usage.mjs" --five-hour "$FIVE_HOUR_PCT" --weekly "$WEEKLY_PCT" --resets-at "$RESETS_AT"
  ```
- **Option B — Using `claude_usage_command` in `<CSA_HOME>/config.json`** (see the table above for the folder on your OS):
  Point `claude_usage_command` to your own local script that outputs JSON:
  ```json
  {
    "claude_usage_max_age_s": 600,
    "claude_usage_command": [
      "node",
      "D:\\path\\to\\my-usage-script.mjs"
    ]
  }
  ```
  On macOS / Linux, use a forward-slash path, e.g. `"/Users/you/scripts/my-usage-script.mjs"`.

  Note: GCSA blocks any `claude_usage_command` whose arguments reference `.credentials.json`, `.claude`, `.env`, cookies, or private keys.
