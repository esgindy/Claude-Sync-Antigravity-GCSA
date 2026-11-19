# Claude Sync Antigravity: architecture contract (v1.0.1)

Author: Eslam Elgindy. Unofficial; not affiliated with Anthropic or Google.
This file is the contract between the build agents. Code to these interfaces exactly. If an interface must change, stop and report it to the Lead. Never change it silently.

## Clean-room rule (mandatory)
All code here is written from scratch. Do NOT read, open, search or copy any existing third-party bridge code. That includes `agy-bridge` (and `agy-bridge-main.zip` in the parent folder), `antigravity-claude-mcp` in the npm cache, and any similar repo. Use only this document, Node docs, the MCP SDK docs, and the observed CLI behaviour described below.

## Goal
Claude is the brain: it plans, reviews and decides. Antigravity (Google's agent, many models) is the muscle that executes, which saves Claude tokens. The right model is chosen per task. Both directions are supported:
- **Claude → Antigravity**: `csa-claude` MCP server, used by Claude Code and Claude Desktop.
- **Antigravity → Claude**: `csa-antigravity` MCP server, used by Antigravity. It asks Claude Code to review or to take over a task.
- **Visibility**: every message in either direction is appended to the message log (see `messages.mjs`). The dashboard shows that log live. With target `desktop`, the conversation is also visible inside the Antigravity app.

## Runtime
Node >= 20, ESM (`"type": "module"`), Windows first. Dependencies: `@modelcontextprotocol/sdk`, `zod` only. Spawn processes with argument arrays (`spawn`/`spawnSync`, never `shell: true`), `windowsHide: true`.

## Layout and ownership
```
src/lib/paths.mjs        Atlas   home dir + config
src/lib/store.mjs        Atlas   atomic JSON files, jobs
src/lib/agy.mjs          Atlas   agy CLI runner + stream parsing
src/lib/models.mjs       Atlas   model list
src/lib/quota.mjs        Atlas   remaining quota (uses desktop.discoverLs)
src/lib/router.mjs       Atlas   auto model choice
src/lib/usage.mjs        Atlas   token usage + savings
src/lib/messages.mjs     Atlas   message log (both directions)
src/lib/safety.mjs       Atlas   secret-file filter, redaction
src/lib/jobs-api.mjs     Atlas   startJob / waitJob / cancelJob used by every tool
src/runner.mjs           Atlas   detached worker for one job
src/tools/core-tools.mjs Atlas   register(server) core tools
src/lib/desktop.mjs      Orbit   Antigravity desktop app (agentapi)
src/lib/desktop-job.mjs  Orbit   runDesktopJob(job, ctx)
src/lib/swarm.mjs        Orbit   parallel multi-agent runs
src/tools/desktop-tools.mjs Orbit register(server)
src/tools/swarm-tools.mjs   Orbit register(server)
src/lib/claude.mjs       Echo    Claude Code CLI runner
src/lib/hops.mjs         Echo    loop guard
src/servers/antigravity-side.mjs Echo  MCP server for Antigravity
src/servers/claude-side.mjs      Lead  MCP server for Claude (imports all register())
packaging/, README*, LICENSE, CHANGELOG.md  Quill
dashboard/               Lead
test/<agent>-*.test.mjs  each agent writes its own tests; fakes in test/fakes/<agent>-*.mjs
```
Only touch files you own. Shared test helper: none. Each test file sets its own env.

## Environment overrides (for tests)
`CSA_HOME` (state dir, default `%LOCALAPPDATA%\claude-sync-antigravity`), `CSA_AGY_BIN` (path to agy; a `.mjs` path is run with node), `CSA_AGENTAPI` (path to language_server.exe or a `.mjs` fake), `CSA_CLAUDE_BIN` (path to claude; `.mjs` = fake), `CSA_QUOTA_FILE` (JSON file used instead of the live quota call), `ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN` (skip discovery).

## Verified external facts (observed on this machine, Nov 2026)
**agy CLI** (`%LOCALAPPDATA%\agy\bin\agy.exe`):
- Flags: `-p <prompt>`, `--mode plan|accept-edits|auto`, `--model <id or label>`, `--conversation <id>` (resume), `--output-format text|json|stream-json`, `--json-schema <json or file>`, `--print-timeout <dur e.g. 600s>`, `--add-dir <dir>` (repeatable), `--settings <json>` (one session only, never saved; e.g. `{"permissions":{"allow":["command(hostname)"]}}`), `--project <id or name>`, `--effort low|medium|high|xhigh|max`, `--dangerously-skip-permissions` (**forbidden in this project**).
- With **no `--mode`, agy auto-runs shell commands** (it ran `mkdir`). Always pass `--mode`.
- Headless mode cannot ask for permission. Anything not allowed is auto-denied.
- `agy models` prints `Fetching available models...` and then one `<id>\t<label>` line per model, e.g. `gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)`.
- stream-json is NDJSON:
  - `{"event":"init","conversation_id":"...","init":{"model":"...","cwd":"...","tools":[...]}}`
  - `{"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE|DONE|ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name","parameters":{"CommandLine":"whoami"},"output":"...","error":{"message":"permission ..."}}}}`. A denied tool has `state:"ERROR"` and an error message containing "permission". File tools use parameters like `Path` / `AbsolutePath`.
  - `{"event":"result","result":{"conversation_id","status":"SUCCESS","response":"text","structured_output":{...}?,"num_turns":1,"duration_seconds":42.1,"usage":{"input_tokens","output_tokens","thinking_tokens","cache_read_tokens","total_tokens"},"denied_actions":[{"action":"command","display_name":"Bash"}]?}}`
- CLI conversations are stored in `~\.gemini\antigravity-cli` under "CLI Project". **The desktop app does not show them.**

**Antigravity desktop app (internal, undocumented)**:
- Language server process: `language_server.exe` whose command line contains `--subclient_type hub` and `--csrf_token <token>`. Find its listening ports with `Get-NetTCPConnection -OwningProcess <pid> -State Listen` (PowerShell, `-NoProfile -NonInteractive`).
- `language_server.exe agentapi <cmd>` with env `ANTIGRAVITY_LS_ADDRESS=127.0.0.1:<port>` and `ANTIGRAVITY_CSRF_TOKEN=<token>`:
  - `get-conversation-metadata <id>` returns JSON `{"response":{"conversationMetadata":{"metadata":{"workspaces":[...],"createdAt":...}}}}`. Use this as a read-only probe. A wrong port returns `{"response":{},"error":"rpc error: code = Unavailable ..."}`. Without a token it returns `Unauthenticated ... missing CSRF token`.
  - `new-conversation [--model=<flash_lite|flash|pro|model_id>] [--title=<t>] [--profile=<p>] <prompt>` creates a visible conversation in the app and returns its id. Find the id field in the JSON response; the expected shape is `response.newConversation.conversationId`, but verify it against the fake.
  - `send-message [--title=<t>] <conversation_id> <content>` returns `{"response":{"sendMessage":{"recipientId","content"}}}`. Verified live: the message appeared in the app session.
  - agentapi does **not** return the agent's reply. Protocol: append to the prompt an instruction to write a JSON result file at an absolute path inside the job dir, then poll for that file.
- Quota: `POST http://127.0.0.1:<same port>/exa.language_server_pb.LanguageServerService/GetUserStatus`, headers `content-type: application/json`, `connect-protocol-version: 1`, `x-codeium-csrf-token: <token>`, body `{}`. The response has `userStatus.planStatus.{availablePromptCredits,availableFlowCredits,planInfo.{planName,monthlyPromptCredits,monthlyFlowCredits}}` and `userStatus.cascadeModelConfigData.clientModelConfigs[].{label,quotaInfo.{remainingFraction,resetTime}}`. Labels equal the `agy models` labels. **Never return or log any other field of the response (it contains the account's email and name).**
- The app's own permission preset may auto-run commands. Desktop-target jobs must warn about this in their result (`warning` field).

**Claude Code CLI** (`claude`, v2.1.x): `claude -p "<prompt>" --output-format json --permission-mode plan --model <alias> --resume <session_id> --allowedTools <...> --add-dir <dir> --append-system-prompt <text> --max-budget-usd <n>`. The JSON result has `result`, `session_id`, `usage`, `total_cost_usd`, `is_error`. Never pass `--dangerously-skip-permissions`.

## Security rules (all agents)
1. Never use `--dangerously-skip-permissions` (agy or claude). Read jobs use `--mode plan`; edit jobs use `--mode accept-edits`. Never omit `--mode`.
2. The CSRF token travels only in a child process env or an HTTP header. Never write it to a file, log, result, error or message log. Every error string that may contain a command line passes through `safety.redact()`.
3. Quota output keeps only plan name, credits and per-model label/remaining/reset.
4. `safety.isSecretPath(p)` blocks `config.php`, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`, `*.kdbx`, plus any path under `.git/`. Tools refuse such paths in `add_dirs`/`paths` and say why.
5. Approved commands (from `commands_requested`) are executed only through `agy_approve` with explicit indexes chosen by the caller (Claude).
6. Loop guard: a task chain may cross between Claude and Antigravity at most `max_hops` (default 3) times.

## Module interfaces

### paths.mjs (Atlas)
`export const home: string` (CSA_HOME or default; created on first write).
`export function loadConfig(): Config`, which merges `config.default.json` (package root) with `<home>/config.json` (shallow merge, `tiers` merged per key).
Config keys: `tiers: {fast: string[], balanced: string[], deep: string[]}`, `default_tier: "auto"`, `quota_min_fraction: 0.1`, `default_timeout_s: 600`, `max_hops: 3`, `swarm_max_parallel: 4`, `desktop_model_map: {fast:"flash", balanced:"flash", deep:"pro"}`, `approved_command_timeout_s: 120`, `max_inline_prompt_chars: 20000`.
Default tiers: fast `["gemini-3.8-flash-low","gemini-3.8-flash-medium"]`, balanced `["gemini-3.8-flash-high","gemini-4-neon-medium"]`, deep `["gemini-4-neon-xhigh","gemini-4-neon-high","gemini-4-argon-high"]`.

### store.mjs (Atlas)
`writeJson(file, obj)` (atomic: tmp + rename), `readJson(file) -> obj|null`, `jobDir(id)`, `createJob(fields) -> id` (id = `YYYYMMDDHHMMSS-<6 hex>`), `readJob(id)`, `updateJob(id, patch) -> job`, `listJobs({limit}) -> job[]` (newest first; a job whose runner pid is dead while queued or running becomes `failed`).
Job fields: `id, state ('queued'|'running'|'done'|'failed'|'cancelled'), target ('cli'|'desktop'), kind ('read'|'edit'), cwd, model, tier, tier_reason, add_dirs, timeout_s, conversation_id|null, title|null, chain_id|null, hop|0, swarm_id|null, created, started, ended, runner_pid, error`.
Result file `<jobDir>/result.json`: `{job_id, state, status ('done'|'needs_approval'|'blocked'|'failed'), summary, files_changed[], commands_requested[{command,cwd,reason}], denied_files[{tool,path}], followups[], handoff_notes, conversation_id, usage|null, model, tier, tier_reason, warning?, error?}`.

### agy.mjs (Atlas)
`findAgy() -> path`, `buildAgyArgs({prompt, kind, model, conversation, addDirs, timeoutS, schema, allow}) -> string[]` (always includes `--mode`, `--output-format stream-json`; `allow` = list of exact command strings, turned into `--settings` allow rules), `runAgy(args, {cwd, timeoutMs}) -> Promise<{code, stdout, stderr, timedOut}>`, `parseStream(stdout) -> {result, denied:[{tool, kind:'command'|'file', target, cwd}], steps:[{tool, params, state}]}`.

### models.mjs (Atlas)
`parseModels(stdout) -> [{id,label}]`, `listModels({refresh}) -> [{id,label}]` (cached in `<home>/models-cache.json` for 10 minutes), `findModel(idOrLabel, models) -> {id,label}|null` (case-insensitive).

### quota.mjs (Atlas)
`summarizeStatus(raw) -> {plan, credits:{prompt_available,prompt_monthly,flow_available,flow_monthly}, models:[{label, remaining_pct, resets_at}]}`, `getQuota() -> Promise<that>` (uses `CSA_QUOTA_FILE` if set, else `desktop.discoverLs()` + fetch with a 10 s timeout), `quotaById(quota, models) -> {[id]: fraction}`.

### router.mjs (Atlas)
`autoTier({prompt, kind, addDirs}) -> {tier, reason}`. deep: security, audit, vulnerabilities, architecture, refactor, migration, root cause, debugging, performance (English and Arabic keywords), prompt > 6000 chars, or a big edit. fast: a short read-only task (< 300 chars) or < 600 chars with summary/translate/list keywords. Otherwise balanced.
`pickModel(config, {tier, model, prompt, kind, addDirs}, quotaMap) -> {model, tier, reason}`. An explicit model wins. Otherwise use the first model in the tier list whose quota is >= `quota_min_fraction`; an unknown quota counts as available.

### usage.mjs (Atlas)
`appendUsage({job_id, day, model, tier, input_tokens, output_tokens, thinking_tokens, total_tokens, target})` writes to `<home>/usage.jsonl`. `usageReport() -> {today:{tokens,jobs,by_model:{}}, all_time:{tokens,jobs,by_model:{}}, claude_tokens_saved_estimate}`. The savings estimate is the sum of Antigravity input+output tokens; label it an estimate.

### messages.mjs (Atlas)
`logMessage({direction:'claude->antigravity'|'antigravity->claude', channel:'cli'|'desktop'|'claude-cli', job_id?, chain_id?, conversation_id?, model?, kind:'task'|'reply'|'approval'|'review'|'error', text})` appends to `<home>/messages.jsonl` with `ts` (ISO). Text is truncated to 4000 chars and passed through `redact`. `readMessages({limit, since}) -> []`.

### safety.mjs (Atlas)
`redact(text) -> text` (masks `--csrf_token X`, `ANTIGRAVITY_CSRF_TOKEN=X`, `x-codeium-csrf-token: X`, and any 32+ char hex/uuid-like token that follows `token`), `isSecretPath(p) -> boolean`, `checkPaths(paths) -> {ok:string[], blocked:[{path,reason}]}`.

### jobs-api.mjs (Atlas)
`startJob({prompt, cwd, kind='read', tier, model, add_dirs, timeout_s, conversation, target='cli', title, chain_id, hop, swarm_id}) -> Promise<{job_id, model, tier, tier_reason}>`. It validates cwd and paths (safety), resolves the model (router + quota, ignoring quota errors), writes `prompt.txt` (with the read/edit preamble), logs a `task` message, and spawns `src/runner.mjs <jobDir>` detached.
`waitJob(id, waitS<=50) -> Promise<compact>`, `getCompact(id) -> compact`, `cancelJob(id)`, `fullResponse(id, maxChars)`.
The compact view has the result.json fields plus `state` and `elapsed_s`.

### runner.mjs (Atlas)
Reads the job. target `cli`: runs agy and writes `stdout.ndjson`, `response.txt` and `result.json`; appends usage; logs a `reply` message. target `desktop`: `await (await import('./lib/desktop-job.mjs')).runDesktopJob(job, ctx)`, where `ctx = {jobDir, writeResult(obj), logMessage, config}`.

### desktop.mjs (Orbit)
`discoverLs() -> {ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN}` (env first; else PowerShell process scan + port probe with get-conversation-metadata on an all-zero uuid; result cached in memory only), `agentapi(args, env) -> {code, json, stdout, stderr}`, `newConversation({prompt, title, model}) -> id`, `sendMessage(conversationId, content, {title})`, `getMetadata(id) -> obj`, `isAppRunning() -> boolean`.

### desktop-job.mjs (Orbit)
`runDesktopJob(job, ctx)`: builds the prompt with the result-file instruction (`<jobDir>/agent_result.json`, same fields as result.json), then calls newConversation (named `job.title`), or sendMessage when `job.conversation_id` is set. It polls every 2 s until `timeout_s`, writes result.json with `warning: "Runs with the Antigravity app's own permissions; the app may run commands without asking."`, and logs messages.

### swarm.mjs (Orbit)
`startSwarm({mode:'split'|'compare', parts:[{prompt, tier?, model?, kind?}], cwd, target, title}) -> {swarm_id, jobs:[job_id]}`. `compare` runs the same prompt on 2-3 different models. At most `swarm_max_parallel` jobs run at once (queue the rest). Parallel `edit` parts must not share files: refuse if two edit parts name the same file in their prompt's `files` list. `swarmStatus(swarm_id) -> {state, parts:[compact]}`.

### Tools for Claude (`csa-claude`)
core-tools (Atlas): `agy_task`, `agy_wait`, `agy_result`, `agy_approve` (indexes; runs approved commands with PowerShell; continues the conversation with their output via a new job), `agy_cancel`, `agy_list`, `agy_models` (list + remaining quota + tier membership), `agy_usage` (usageReport + quota), `agy_messages` (readMessages).
desktop-tools (Orbit): `agy_desktop_task` (title, prompt, conversation_id?) and `agy_desktop_status`.
swarm-tools (Orbit): `agy_swarm` and `agy_swarm_status`.
Every tool description is short and English. Errors use `{isError:true}`.

### claude.mjs (Echo)
`findClaude()`, `runClaude({prompt, mode:'review'|'task', cwd, sessionId, model, addDirs, maxBudgetUsd}) -> Promise<{result, session_id, usage, cost_usd, is_error}>`. review: `--permission-mode plan`. task: `--permission-mode acceptEdits` plus `--allowedTools "Read Grep Glob Edit Write"` (no Bash). Always `--output-format json`.

### hops.mjs (Echo)
`nextHop(chain_id|null) -> {chain_id, hop}` (persisted in `<home>/chains.json`), `assertHopAllowed(chain_id, max_hops)` (throws a clear error at the limit).

### Tools for Antigravity (`csa-antigravity`, Echo)
`claude_review` (summary of what Antigravity did + files; Claude reviews read-only and returns verdict `approve|changes` + notes), `claude_task` (hand a task to Claude), `claude_wait`, `claude_result`. Jobs run detached, like agy jobs, under `<home>/claude-jobs/`. Every call logs messages with direction `antigravity->claude`, and replies log `claude->antigravity`.

## Progress reporting (dashboard)
After you start, finish or block on each of your tasks, run:
`node "<project>/dashboard/progress.mjs" <agent> <taskId> <todo|doing|done|blocked> "<short note>"`
and to show what you are doing right now:
`node "<project>/dashboard/progress.mjs" <agent> --now "<what you are doing>"`
Keep notes under 120 characters. This costs a few tokens; do it at every task boundary, not more often.
