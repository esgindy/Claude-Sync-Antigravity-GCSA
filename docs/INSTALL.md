# Installation — GCSA (Claude Sync Antigravity)

GCSA (Claude Sync Antigravity) 5.0.0 (V5). Unofficial tool by Eslam Elgindy, not affiliated with Anthropic or Google.

## Quick install (recommended, any OS)

1. Install Node.js 20+ (https://nodejs.org; macOS can also use `brew install node`).
2. Put the project in a **local** folder, not a cloud-synced one (OneDrive/Dropbox/iCloud can lock or evict files while the servers run). For example `~/GCSA` or `C:\GCSA`.
3. From that folder (if `node` is "command not found" because Node was installed without a package manager, use its full path, e.g. `~/.local/node/bin/node scripts/setup.mjs`; setup then fixes PATH for new terminals):

```bash
node scripts/setup.mjs --dry-run   # preview: what would change, nothing is written
node scripts/setup.mjs             # install deps, register the MCP servers, verify them
```

The setup script:
- checks Node 20+, warns about cloud-synced folders and Node running from a temporary folder;
- runs `npm ci --omit=dev`;
- registers `csa` in Claude Code (`~/.claude.json`) and Claude Desktop, and `csa-antigravity` in Antigravity (`~/.gemini/config/mcp_config.json`), using the absolute path of the Node that ran it;
- backs up every config it changes (`<file>.bak-gcsa-<timestamp>`), never overwrites a config it can't parse, skips apps that aren't installed, and is safe to re-run (unchanged entries are left alone, a moved install is updated);
- sets a Claude Code **statusLine** (`scripts/claude-statusline.mjs`) in `~/.claude/settings.json` so the dashboard's Claude usage stays fresh automatically (see section 7). If you already have a statusLine it is kept and still shown (GCSA runs it for you), and `--uninstall` puts it back;
- installs the official Antigravity **`agy` CLI** when it is missing, using Google's own installer (`https://antigravity.google/cli/install.sh` on macOS/Linux → `~/.local/bin/agy`; `https://antigravity.google/cli/install.ps1` on Windows → `%LOCALAPPDATA%\agy\bin\agy.exe`; the installer verifies the SHA-512 of the download). If that fails, GCSA still works through the Antigravity desktop app and setup prints the manual command;
- on macOS/Linux, adds the folders of `node` and `agy` (usually `~/.local/bin`) to `PATH` in your shell profile (`~/.zshrc` on macOS) with one marked block, only if they are missing and not already exported by you, so `node`, `npm` and `agy` work in new terminal windows. `--skip-path` opts out. GCSA itself never needs PATH: every config uses absolute paths;
- starts both servers once to check they answer, then reports Antigravity's command policy and whether `agy` / `claude` CLIs are present.

Options: `--only claude-code,claude-desktop,antigravity`, `--skip-deps`, `--skip-verify`, `--skip-agy` (don't install the agy CLI), `--skip-statusline` (don't touch `~/.claude/settings.json`), `--skip-path` (don't touch your shell profile), `--uninstall` (removes only the GCSA entries and the GCSA statusLine). npm shortcuts: `npm run setup`, `npm run setup:check`, `npm run uninstall-mcp`.

Afterwards restart Claude Desktop and Antigravity and open a new Claude Code session. The manual steps below do the same thing by hand.

## Before you start

- Windows or macOS (Linux is best-effort). V5 detects the OS automatically.
- Node.js 20 or newer (`node --version`). Install it from https://nodejs.org, or on macOS with `brew install node`.
- The Antigravity desktop app, with the `agy` CLI installed and signed in
- Claude Code and/or Claude Desktop

### Where things live

| | Windows | macOS | Linux |
|---|---|---|---|
| State folder (`CSA_HOME` overrides) | `%LOCALAPPDATA%\claude-sync-antigravity` | `~/Library/Application Support/claude-sync-antigravity` | `~/.local/share/claude-sync-antigravity` |
| User config | `<state folder>\config.json` | `<state folder>/config.json` | `<state folder>/config.json` |
| `agy` CLI (default lookup) | `%LOCALAPPDATA%\agy\bin\agy.exe` | `~/.local/bin/agy`, `~/.gemini/antigravity/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, then `PATH` | same as macOS |
| Claude Desktop config | `%APPDATA%\Claude\claude_desktop_config.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` | — |
| Antigravity MCP config | `%USERPROFILE%\.gemini\config\mcp_config.json` | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/mcp_config.json` |
| Shell for approved commands | PowerShell | zsh | sh |

## 1. Install the project

**Windows** — open PowerShell in the project folder:

```powershell
cd "<path>\Claude-Sync-Antigravity"
npm install
```

**macOS / Linux** — open Terminal:

```bash
cd "<path>/Claude-Sync-Antigravity"
npm install
```

Replace `<path>` with the folder where the project is stored.

## 2. Register with Claude Code

Run this command once. Replace `<path>` with your project folder.

Windows:

```powershell
claude mcp add --scope user csa -- node "<path>\src\servers\claude-side.mjs"
```

macOS / Linux:

```bash
claude mcp add --scope user csa -- node "<path>/src/servers/claude-side.mjs"
```

Check that it was added:

```bash
claude mcp list
```

## 3. Register with Claude Desktop

You have two options.

**Option A: the .mcpb extension (recommended, verify the steps).**

1. Build the staging folder:
   ```powershell
   node packaging\build-mcpb.mjs
   ```
   On macOS / Linux:
   ```bash
   node packaging/build-mcpb.mjs
   ```
2. Pack the extension. Verify the exact CLI flags first with `npx @anthropic-ai/mcpb --help`, then run:
   ```bash
   npx @anthropic-ai/mcpb pack dist/csa dist/claude-sync-antigravity-5.0.0.mcpb
   ```
3. Open the `.mcpb` file with Claude Desktop, or install it from Claude Desktop's extension settings. The exact menu names depend on your Claude Desktop version. Verify them in the app.

**Option B: manual config.**

Open `claude_desktop_config.json` (verify the menu path in your Claude Desktop version):

- Windows: usually `%APPDATA%\Claude\claude_desktop_config.json`. Example: `packaging/claude-desktop.example.json`.
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. Example: `packaging/claude-desktop.macos.example.json`.

Add the `csa` entry.

Windows:

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

macOS:

```json
{
  "mcpServers": {
    "csa": {
      "command": "node",
      "args": ["/path/to/Claude-Sync-Antigravity/src/servers/claude-side.mjs"]
    }
  }
}
```

On Windows, use double backslashes in the path. On macOS / Linux, use normal forward slashes. Restart Claude Desktop after saving.

> **macOS tip:** Claude Desktop does not start from your shell, so it may not find `node` if it was installed by a version manager. If the server fails to start, put the full path of `node` in `command` (run `which node` to get it, e.g. `/opt/homebrew/bin/node`).

## 4. Register with Antigravity

Antigravity needs the `csa-antigravity` server so that it can ask Claude for a review or a handover.

1. Open this file. Create it if it does not exist:
   - Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`
   - macOS / Linux: `~/.gemini/config/mcp_config.json`
2. Add the `csa-antigravity` entry. The examples are `packaging/antigravity-mcp_config.example.json` (Windows) and `packaging/antigravity-mcp_config.macos.example.json` (macOS). The format is:

   Windows:

   ```json
   {"mcpServers":{"csa-antigravity":{"command":"node","args":["<path>\\src\\servers\\antigravity-side.mjs"]}}}
   ```

   macOS / Linux:

   ```json
   {"mcpServers":{"csa-antigravity":{"command":"node","args":["<path>/src/servers/antigravity-side.mjs"]}}}
   ```

   Replace `<path>` with your project folder (keep the double backslashes on Windows).

3. If the file already has other servers, add `csa-antigravity` inside the existing `mcpServers` object. Do not delete the others.
4. Restart Antigravity.

## 5. Open the dashboard

```bash
npm run dashboard
```

Then open http://localhost:4317 in your browser. The dashboard shows the message log and the progress of running tasks. (When GCSA opens the dashboard for you, it uses the default browser: `open` on macOS, `xdg-open` on Linux.)

## 6. Check that it works

In Claude Code, ask Claude to call `agy_desktop_status` (should say `reachable: true`) and then `agy_models`. You should see the list of Antigravity models with their remaining quota. Without the `agy` CLI, `agy_models` still answers from the desktop app (`"source": "desktop"`). If both fail, make sure the Antigravity desktop app is open and signed in.

## 7. Automatic Claude Code Usage Refresh (v3.5.0)

GCSA v3.5.0 automatically refreshes Claude Code usage on the dashboard bottom usage strip (throttled to once per 20 seconds) on:
- Every job start (`agy_task`, `agy_desktop_task`, `agy_swarm`, `claude_review`, `claude_task`)
- Every job finish or state change
- Every logged message in either direction (`claude->antigravity` or `antigravity->claude`)
- Dashboard server startup and status polling

### Automatic: the GCSA statusLine (set by setup)

Claude Code runs its statusLine command after each message and passes it JSON that, for Pro/Max subscribers, contains `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`). `scripts/claude-statusline.mjs` turns those into the snapshot below, at most once a minute unless the numbers change. It reads only that stdin: no credentials, no files under `~/.claude`. Claude also calls `csa_board set_usage` when it delegates work, which covers sessions where no statusLine runs.

### Usage Sources (First Valid Wins)

1. **Snapshot file `<CSA_HOME>/claude-usage.json`** (Windows: `%LOCALAPPDATA%\claude-sync-antigravity\claude-usage.json`; macOS: `~/Library/Application Support/claude-sync-antigravity/claude-usage.json`; Linux: `~/.local/share/claude-sync-antigravity/claude-usage.json`):
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

Windows:

```powershell
node "<path>\Claude-Sync-Antigravity\scripts\push-claude-usage.mjs" --five-hour 84 --weekly 62 --resets-at "2026-11-20T12:00:00Z" --note "Claude Code"
```

macOS / Linux:

```bash
node "<path>/Claude-Sync-Antigravity/scripts/push-claude-usage.mjs" --five-hour 84 --weekly 62 --resets-at "2026-11-20T12:00:00Z" --note "Claude Code"
```

If you maintain a custom script in `~/.claude/settings.json` (for example a `statusLine` script or a `PostToolUse` / `Stop` hook that already receives or knows your current remaining percentages), have your script invoke `scripts/push-claude-usage.mjs` with `--five-hour`, `--weekly`, and `--resets-at`, or configure `claude_usage_command` in `<state folder>/config.json` (Windows: `%LOCALAPPDATA%\claude-sync-antigravity\config.json`; macOS: `~/Library/Application Support/claude-sync-antigravity/config.json`):

```json
{
  "claude_usage_max_age_s": 600,
  "claude_usage_command": [
    "node",
    "D:\\path\\to\\your-own-usage-reporter.mjs"
  ]
}
```

On macOS / Linux, use a normal path such as `"/Users/you/scripts/your-own-usage-reporter.mjs"`.

See [docs/CLAUDE-USAGE.md](CLAUDE-USAGE.md) for complete examples.

## Troubleshooting

- **Quota is missing:** the Antigravity app must be running. On macOS, GCSA finds the desktop hub (`/Applications/Antigravity.app/Contents/Resources/bin/language_server`) with `ps` and `lsof`; both ship with macOS.
- **Claude usage shows `Unavailable` or `Stale`:** Claude Code does not expose an unauthenticated local quota API. Have Claude call `csa_board` `set_usage` at the start of delegated tasks, run `scripts/push-claude-usage.mjs`, or configure `claude_usage_command` in `config.json`.
- **`agy` not found:** re-run `node scripts/setup.mjs` (it installs it), or run Google's installer by hand: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (macOS/Linux) or `irm https://antigravity.google/cli/install.ps1 | iex` (Windows PowerShell). Make sure it is signed in. The default location is `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows. On macOS/Linux GCSA checks `~/.local/bin/agy`, `~/.gemini/antigravity/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, then `PATH`. Set `CSA_AGY_BIN` or `agy_path` to override.
- **Server does not appear in Claude:** check the path in the config. It must point to the real file location (double backslashes in JSON on Windows; forward slashes on macOS/Linux). On macOS, if Claude Desktop cannot find `node`, use the full path from `which node` as `command`.
- **Approved commands behave differently on macOS:** commands you approve run in zsh on macOS (sh on Linux), not PowerShell, so use shell syntax for your OS.
