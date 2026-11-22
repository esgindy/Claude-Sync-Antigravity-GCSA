# Security

Claude Sync Antigravity is an unofficial tool by Eslam Elgindy. It runs AI agents on your computer, so it follows the safety rules below. Read them before you use the tool.

## The rules

1. **Read-only by default.** Read tasks run in plan mode and cannot change your files. Edit tasks use accept-edits mode.
2. **No skip-permissions.** The tool never uses `--dangerously-skip-permissions`, for Claude or for Antigravity. Every run keeps the normal permission checks.
3. **Commands need your approval.** When an agent asks to run a command, the command is listed in the result and is not run. It runs only when you approve it by its index with `agy_approve`.
4. **Secret files are blocked.** The tool refuses to read or pass these files to an agent:
   - `config.php`
   - `.env` and files that start with `.env`
   - `*.pem` and `*.key`
   - `id_rsa*`
   - files that start with `credentials` or `secrets`
   - `*.kdbx`
   - anything inside a `.git/` folder

   The tool tells you which file was blocked and why.
5. **The Antigravity token is never stored.** The CSRF token needed to talk to the Antigravity app is passed only to a child process or an HTTP header. It is never written to a file, a log, a result or a message.
6. **Output is cleaned.** Error text that may contain a command line or a token is redacted before it is shown or saved.
7. **Limited hand-offs.** A task can move between Claude and Antigravity at most 3 times by default. This stops endless loops.
8. **Quota data is limited.** The tool keeps only your plan name, your credits, and the remaining quota and reset time for each model. Other account details are not kept.

9. **Desktop auto-run is refused.** Desktop mode is refused while the Antigravity app is set to auto-run commands. Either switch the app to "Request review", or set `allow_desktop_auto_exec` to `true` to accept the risk.
10. **Desktop edit jobs are off by default.** They run only when `allow_desktop_edit` is `true`.
11. **Fail closed.** If the app's permission settings cannot be read, the tool treats them as auto-run and refuses desktop mode.
12. **Reverse-direction Claude runs are restricted.** Claude runs started from Antigravity use `--setting-sources user`, deny Bash and PowerShell, and load no MCP servers.
13. **Blocked locations.** The `.claude`, `.gemini`, `.ssh`, `.aws` and `.git` folders are refused, and so are credential files, drive roots and the user profile folder itself.
14. **Server-issued chain ids.** Chain ids are created by the server, not by the caller. Daily limits apply to the number of jobs (`daily_max_jobs`) and to Claude cost (`daily_max_claude_usd`).
15. **Local dashboard only.** The dashboard answers only requests that come from localhost.

Set `allowed_roots` in the configuration (see README, Configuration section) to limit the folders tasks may use. This is strongly recommended.

## Desktop mode warning

Desktop mode runs tasks inside the Antigravity desktop app. Those tasks use the app's own permission settings, not the tool's safety rules. **The app may run commands without asking you.** Before you use desktop mode:

- Check the permission settings in the Antigravity app.
- Use desktop mode only for tasks you would allow the app to do by itself.
- Keep an eye on the dashboard while a desktop task runs.

Every desktop result includes this warning.

## Your responsibilities

- Only register the tool with Claude and Antigravity on your own computer.
- Do not put passwords, API keys or tokens in task prompts.
- Review every edit an agent made before you keep it. The result lists the changed files.
- Keep Node.js, Claude and Antigravity updated.

## Reporting a problem

If you find a security problem, contact the author, Eslam Elgindy, before you share it publicly.
