# Changelog — GCSA (Claude Sync Antigravity)

All notable changes to this project are recorded here.

## 5.0.0 (GCSA V5) - cross-platform

- **One codebase for Windows and macOS (Linux best-effort).** The OS is detected at runtime; nothing is tied to one machine.
- New `src/lib/platform.mjs` holds every OS difference: state folder (`%LOCALAPPDATA%` / `~/Library/Application Support` / `~/.local/share`), `agy` and `claude` lookup (no `.exe` suffix handling off Windows), Antigravity `language_server` location, shell for approved commands (PowerShell / zsh / sh), opening the dashboard (`rundll32` / `open` / `xdg-open`), process-tree kill (`taskkill` / process group), and the Antigravity hub scan (PowerShell CIM / `ps` + `lsof`).
- Path safety: Windows-only rules (drive roots, NTFS alternate data streams, case folding) are now applied only where relevant; added broad-folder protection for `/`, `/Users`, `/Applications`, `/Library` and similar.
- Dashboard: Antigravity/Claude logos are read from the macOS app bundles when running on macOS.
- `package.json` `os` and `packaging/manifest.json` `platforms` now list `win32`, `darwin`, `linux`; added macOS config examples.
- **One-step installer `scripts/setup.mjs`** (`npm run setup`, `setup:check`, `uninstall-mcp`): installs deps, registers the MCP servers in Claude Code, Claude Desktop and Antigravity with backups and atomic writes, is idempotent, skips missing apps, refuses to touch unparsable configs, verifies both servers, and warns about cloud-synced folders, temporary Node and Antigravity's auto-run policy. Config locations per OS added to `platform.mjs`.
- Security hardening for macOS/Linux paths (firmlinks, `/private/var`, `~/Library` keychains/cookies, symlinked home, process-group kill of timed-out approved commands).
- `docs/INSTALL-LOG-macOS.ar.md`: log of the first real macOS install and the lessons behind the installer.
- Version bumped to `5.0.0` (GCSA V5).
- **Setup installs the `agy` CLI** when it is missing, with Google's official installer (`antigravity.google/cli/install.sh` / `install.ps1`, SHA-512 verified by the installer). `--skip-agy` opts out; on failure GCSA keeps working through the desktop app and prints the manual command.
- **Automatic Claude usage on the dashboard:** (terminal Claude Code) setup sets a Claude Code statusLine (`scripts/claude-statusline.mjs`) that turns Claude Code's `rate_limits` (5-hour / weekly) into the usage snapshot. An existing statusLine is chained (still shown) and restored by `--uninstall`; `--skip-statusline` opts out.
- Claude desktop app: its Code tab does not run statusLine commands (verified), so the MCP instructions now tell Claude to push real usage from the host's plan-usage data with `csa_board set_usage` when delegating and at every `agy_wait`. `statusline-last-run.json` records each statusLine run for diagnosis.
- `agy_models` works without the `agy` CLI: it falls back to the models and quota reported by the Antigravity desktop app (`"source": "desktop"`).
- Desktop jobs: when the app agent writes an estimated `completed_at` more than 10 s away from when its result file was really written, the real time is used (the agent's claim is kept as `agent_completed_at`), so elapsed times and notifications are accurate.
- Model choice (CLI): models the account's `agy` doesn't offer are skipped, and a tier with none available falls back to the nearest tier (e.g. `deep` → `balanced`) instead of failing. Found on a Pro account whose CLI has no `gemini-4-*` models.
- Setup adds the `node`/`agy` folder to PATH in the shell profile on macOS/Linux when missing (never duplicates a line you wrote; `--skip-path`), and prints next-step commands with the full Node path.
- Project binding guard: the `allow_non_project` description, the MCP instructions and the PROJECT_BINDING_REQUIRED message now tell Claude never to open a Non-Project conversation on its own (it cannot be moved into a project later) and to ask the user which project to use. Verified on macOS: an unbound cwd is refused and the user's projects are listed.
- Dashboard (macOS): the Claude hub icon now uses the colored app icon from the `.icns` instead of the black menu-bar template, which looked switched off on the dark background.

## 4.0.0 (GCSA V4) - 2026-11-20

- **Version bumped to `4.0.0` (GCSA V4)** across `package.json`, `packaging/manifest.json`, `src/servers/claude-side.mjs`, `src/servers/antigravity-side.mjs`, `scripts/push-claude-usage.mjs`, `dashboard/index.html`, `dashboard/status.json`, `README.md`, `README.ar.md`, `docs/INSTALL.md`, `docs/CLAUDE-USAGE.md`, and `CHANGELOG.md`.
- **GCSA Brand Icon & Favicon in Dashboard**:
  - Added `dashboard/gcsa-icon.webp` served by `dashboard/server.mjs` at `/logo/gcsa`, `/favicon.ico`, and `/gcsa-icon.webp`.
  - Displayed the GCSA icon beside the app name in `<header>` (`.brand` / `.brand-ic`) and configured it as the browser `favicon` (`<link rel="icon">` / `<link rel="shortcut icon">`) in `dashboard/index.html`.
- **Proactive Completion & Approval/Permission Notifications (`src/lib/notifications.mjs`)**:
  - Every completed job (CLI and Desktop) stamps an exact ISO-8601 `completed_at` timestamp in `result.json`, `agy_wait`/`agy_result`, `agy_list`, `messages.jsonl`, and `<CSA_HOME>/notifications.jsonl` so Claude knows precisely when execution finished.
  - Whenever an approval or permission request occurs (`needs_approval`, `commands_requested`, `blocked`, or desktop permission prompts), GCSA records an `approval_needed` notification (also exposed via `agy_messages` and `/api/status`) and desktop task instructions (`resultInstruction`) explicitly direct Antigravity to immediately notify/ask the delegating Claude session (via `claude-code` `ListAgents` + `SendMessage` if available, targeting optional `notify_session`) so Claude can grant approval (`agy_approve` or reply) and receive exact completion notifications.

## 3.5.0 (GCSA v3.5.0) - 2026-11-20

- Project short name standardized to **GCSA** (**Claude Sync Antigravity**) across titles, dashboard header/footer, MCP instructions, and documentation while keeping npm/MCP package names (`claude-sync-antigravity`, `csa-claude`, `csa-antigravity`) unchanged.
- Automatic refresh of Claude Code usage (`src/lib/claude-usage.mjs`):
  - Added `refreshClaudeUsage({reason})` — fire-and-forget, never throws, throttled to once per 20 seconds (`CLAUDE_USAGE_THROTTLE_MS = 20_000`).
  - Automatically invoked on job start (`startJob`, `createJob`, `startClaudeJob`), job finish or state change (`updateJob`, `runner.mjs`, `claude-runner.mjs`), every logged message in either direction (`logMessage`), and dashboard server startup + `/api/status` polls.
  - Evaluates three sanctioned sources in strict priority order (first valid wins):
    1. Snapshot file `<CSA_HOME>/claude-usage.json` (`{five_hour_remaining_pct, weekly_remaining_pct, resets_at, note, updated_at}`) when fresh within `claude_usage_max_age_s` (default `600` seconds).
    2. Optional `claude_usage_command` in `config.json` (array `[executable, ...args]`, no shell string, `shell: false`, 5-second timeout) printing the same JSON, with percentage values validated and clamped to `0..100` and texts redacted.
    3. Last value from `csa_board` `set_usage`, marked `stale: true`.
    If none of the sources has data, returns `available: false` (`unavailable`) with the reason and a short setup hint.
  - Strict privacy & credential safety: never reads `.credentials.json`, OAuth tokens, cookies, or `~/.claude` settings, never calls undocumented remote endpoints with user tokens, never modifies `~/.claude`, never fabricates numbers from transcripts, and blocks any `claude_usage_command` argument referencing credential/secret files.
- Atomic snapshot writing & CLI helper:
  - `csa_board` `set_usage` (`dashboard/progress.mjs --set-usage`) now writes `<CSA_HOME>/claude-usage.json` atomically alongside `status.json`.
  - Added `scripts/push-claude-usage.mjs` (`--five-hour`, `--weekly`, `--resets-at`, `--note`, `--json`) to validate, clamp (`0..100`), and write `<CSA_HOME>/claude-usage.json` atomically.
  - Documented optional user wiring to a Claude Code `statusLine` or hook in `docs/INSTALL.md` and `docs/CLAUDE-USAGE.md` without installing anything into `~/.claude`.
- Dashboard & MCP instructions updates:
  - Added freshness badge/text (`#claudeFreshness`) directly under the Claude icon on the bottom usage strip (`updated N min ago` / `stale` / `unavailable: reason`) plus setup hints in all 8 languages (`ar`, `en`, `zh`, `hi`, `es`, `fr`, `pt`, `ru`), both themes, RTL, and mobile.
  - `/api/status` now exposes `claude_usage` with `updated_at` and `stale` (while keeping `claudeUsage` for backward compatibility), plus `notifications` (`task_completed` and `approval_needed`).
  - Updated `src/servers/claude-side.mjs` MCP instructions so Claude calls `csa_board` `set_usage` with real numbers at the start of each delegated task.
- Proactive Completion & Approval/Permission Notifications (`src/lib/notifications.mjs`):
  - Every completed job (CLI and Desktop) now stamps an exact ISO-8601 `completed_at` timestamp in `result.json`, `agy_wait`/`agy_result`, `agy_list`, `messages.jsonl`, and `<CSA_HOME>/notifications.jsonl` so Claude knows precisely when execution finished.
  - Whenever an approval or permission request occurs (`needs_approval`, `commands_requested`, `blocked`, or desktop permission prompts), GCSA records an `approval_needed` notification (also returned by `agy_messages` and `/api/status`) and desktop task instructions (`resultInstruction`) explicitly direct Antigravity to notify/ask the delegating Claude session immediately (via `claude-code` `ListAgents` + `SendMessage` if available, targeting optional `notify_session`) so Claude can grant approval (`agy_approve` or reply) and receive the exact `completed_at` completion notice.
- Bumped version from `3.0.0` to `3.5.0` across `package.json`, `packaging/manifest.json`, `src/servers/claude-side.mjs`, `src/servers/antigravity-side.mjs`, `README.md`, `README.ar.md`, and `CHANGELOG.md`, and added `CHANGES-v3.5.md` and `test/v35-claude-usage.test.mjs`.

## 3.0.0 (v3) - 2026-11-20

- Default `agy_task` target changed to `auto` (`default_target: "auto"`): checks Antigravity Desktop availability (`agy_desktop_status`) and prefers Desktop first (subject to `allow_desktop_auto_exec`, `allow_desktop_edit`, and fail-closed safety checks), falling back to `agy` CLI (`agy_path` in `config.json`, `%LOCALAPPDATA%\agy\bin\agy.exe`, or `PATH`). Explicit `target="cli"` and `target="desktop"` remain supported.
- Automatic runtime fallback in `auto` mode (non-security failures only): if Desktop fails or rejects execution due to non-security errors (such as the app becoming unavailable or connection timeout), execution falls back automatically to `agy` CLI with `transport` and `transport_reason` recorded in results, messages, and the dashboard. Refusals from the `auto-run` security gate never fall back automatically to CLI.
- Desktop Project & Folder Binding Guard (`require_desktop_project_binding: true`): because `agentapi new-conversation` does not accept a `--workspace` flag and otherwise drops new conversations into `Non-Project` without a bound workspace folder, desktop tasks (`agy_desktop_task` or `agy_task` choosing desktop via `auto`) targeting `cwd` check saved workspace bindings (`workspace-bindings.json`) and auto-discover recent Antigravity Desktop project conversations (`get-conversation-metadata`) matching `cwd`. If `cwd` is not bound or registered in Antigravity yet, CSA stops the task and returns a bilingual question (`PROJECT_BINDING_REQUIRED`) asking Claude/the user which Antigravity project/conversation and folder (`cwd`) to bind to (options: pass `conversation_id`, open the folder as a project in Antigravity Desktop, or pass `allow_non_project: true`). All Desktop tasks also inject an explicit `WORKSPACE CONTEXT` header (`Working Directory (cwd)` and `Added Directories`) so the Antigravity agent always knows the exact target folder immediately.
- Desktop read-only protection: because Desktop mode does not enforce CLI plan mode, `kind="read"` desktop jobs inject an explicit no-modification warning and verify `files_changed` afterward, flagging unexpected modifications (`read_only_violation`, `read_only_warning`).
- Bilingual (Arabic + English) no-transport guidance error: when neither Desktop nor CLI is available, returns a structured diagnostic detailing Desktop and CLI checks plus ordered remediation steps (`agy_path` in `config.json`, `agy --version`, login check, `agy_desktop_status`) and surfaces it in the dashboard.
- Configuration additions: added `default_target` (`"auto"`), `agy_path` (`""`), and `require_desktop_project_binding` (`true`); kept `allow_desktop_auto_exec` (`false`) and `allow_desktop_edit` (`false`) disabled by default in `config.default.json` (enabled only in the user's `config.json`).
- Live dashboard and `csa_board` enhancements:
  - Added `csa_board` `set_usage {five_hour_remaining_pct, weekly_remaining_pct, resets_at, note}` action.
  - Added prominent auto-exec warning banner in all 8 languages when `allow_desktop_auto_exec` or app auto-run policy is active.
  - Surfaced `transport` and `transport_reason` across task results, message logs, and the dashboard.
  - Added bottom usage bar showing Claude Code overall quota (`Unavailable` / `غير متاح` until pushed via `csa_board` `set_usage`, never fabricated or storing tokens/secrets) and an Antigravity per-model dropdown (remaining %, reset time, today/total tokens & jobs from `usage.by_model`, highest-consumption model in the collapsed summary line, and `Unavailable` / `غير متاح` for models without quota percentages such as Gemini 4 Carbon).
  - Updated dashboard layout (Gindy pinned first, followed by active agents, full-width messages feed, 3-column activity/files/commits row, and bottom usage bar), upgraded the 3 avatar themes (`char` 🤖 space robots kept intact, `pixel` 👾 upgraded to 16×16 16-Bit Arcade Heroes, and `simple` 🦊 upgraded to Chibi Cartoon Heroes), and fixed `claudeLogo()` resolution on Windows.
- Updated program version to `3.0.0` across `package.json`, `src/servers/claude-side.mjs`, `src/servers/antigravity-side.mjs`, `packaging/manifest.json`, `README.md`, `README.ar.md`, and `CHANGELOG.md`.

## 2.0.0 - 2026-11-20

- New live dashboard: space bridge with the real Claude and Antigravity icons (read from the installed apps, not bundled), fiber lines that light up with every message in either direction.
- Every agent on one board: Claude-side agents (registered with `csa_board`), Antigravity jobs and Claude review jobs appear automatically, with all their tasks, model and state. Gindy is the manager and supervisor.
- Three avatar styles (cartoon robots, pixel characters, simple), dark/light theme, 8 languages.
- Agents that are idle or finished turn grey and stop moving.
- The dashboard opens automatically the first time a project delegates work (`dashboard_auto_open`); `csa_dashboard` reopens it.

## 1.0.1 - 2026-11-20

Initial release. Unofficial tool by Eslam Elgindy, not affiliated with Anthropic or Google.

- Two-way bridge: `csa-claude` (for Claude Code and Claude Desktop) and `csa-antigravity` (for Antigravity).
- Task delegation with automatic model choice by task size and quota-aware fallback.
- Choice of any available model.
- Usage report: tokens used, remaining quota per model and reset time.
- Desktop mode: tasks appear inside the Antigravity app.
- Swarm mode: parallel split runs and compare runs.
- Reverse direction: Antigravity can ask Claude to review or take over a task, with a hop limit (default 3).
- Message log for both directions, shown in the dashboard.
- Safety: read-only by default, no skip-permissions, command approval, secret files blocked, CSRF token never stored.
- Claude Desktop extension packaging (`packaging/manifest.json`, `packaging/build-mcpb.mjs`).
