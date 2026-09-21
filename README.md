# Atbash Safety for ChatGPT and Codex

Atbash Safety evaluates supported Codex tool calls against your Atbash agent's policy before execution. This repository distributes the complete local plugin: a `PreToolUse` hook, the production npm SDK `@atbash/sdk@0.7.1`, native binaries, and an `atbash-setup` skill. It has no MCP server.

Only `allow: true` with verdict `ALLOW` permits the pending call. `HOLD`, `BLOCK`, invalid configuration, timeout, and service errors deny that attempt. Coverage is limited to tools exposed to the host's `PreToolUse` hook; plain text responses and tools outside that lifecycle are not covered.

### The host boundary

A `PreToolUse` host lets a tool call proceed when the hook times out or exits without a decision. This is Claude Code's documented hook contract (exit 0 with a decision, exit 2 blocking, any other exit or a timeout non-blocking); Codex 0.154.0 was measured on 2026-09-17 and does not share it: with marker files proving the hook ran, exit 2 with a reason on standard error let the tool call proceed, and so did exit 2 with a deny on standard output, exit 1, and exit 0 with an empty standard output - only a deny on standard output with exit 0 blocked. Every fail-closed path below therefore ends as a deny on standard output with exit 0; the exit-2 paths that remain are cases where standard output could not be written, which no hook can turn into a block on this host. Two failures that would silently remove the gate are therefore handled by the entry point itself (`plugins/atbash/runtime/pre-tool-use.cjs`, a small un-bundled shim that loads the bundled hook `runtime/pre-tool-use-main.cjs`):

- **Hard deadline.** The SDK budget (`ATBASH_CODEX_TIMEOUT_MS`, default 30,000 ms) applies per request, and one judgment is several requests, so a slow but alive judge could outlive the 35 s hook timeout in `hooks/hooks.json`. The shim denies the call at `ATBASH_HOOK_DEADLINE_MS` (default 28,000 ms; accepted range 1,000-30,000, so that node start-up and the bundle load always fit under the host timeout) unless the bundled hook has already written its decision. An invalid value denies every call rather than running without a deadline.
- **Runtime failure.** A bundled hook that cannot load, throws asynchronously, or leaves a promise rejected exits with a deny (exit code 0) instead of exit code 1 and no output. The deny text is fixed; nothing from the failure is echoed to the host.
- **Only the decision reaches standard output.** The bundled hook hands its decision to the shim over a private in-process channel (`Symbol.for("atbash.hook.answer")`, installed by the shim before the bundle loads), never over standard output; the shim diverts everything the bundle or its library loggers (`console.log` sinks) write to standard output to standard error (the host transcript), so a stray log line can neither corrupt the decision nor count as one, however well shaped. The channel accepts exactly one thing, a PreToolUse deny as the bundle serializes it, never an allow (the bundle's allow is silence, which leaves the host's own rules and other hooks in force); anything else on it is a deny, a stray empty answer neither disarms the deadline nor outranks a later deny, the bundle's deny is written synchronously to file descriptor 1 and a standard output that cannot take it ends as a blocking exit rather than a lost decision, and an exit-time backstop turns a bundle that returns without answering (or a library calling `process.exit(0)`) into a deny instead of an empty, permit-shaped exit. Library diagnostics therefore appear in the transcript rather than on the decision channel; a closed standard error drops them. A bundle that wrote its decision is ended right behind the synchronous write; the deny written to the host is bounded at 3.5 KiB of serialized bytes (not characters: JSON escaping doubles a quote or a newline and a non-ASCII character is up to three bytes; the judge's own reason is capped at 800 characters upstream) - under the smallest pipe buffer a host hands a hook, so the write always completes whether or not the host has read yet; a larger deny to a host that never reads blocks the writing thread on Windows and nothing in-process can interrupt that (measured through a real OS pipe whose consumer never reads). The deny is written to file descriptor 1 synchronously and is bounded in bytes under the smallest pipe a host hands a hook, so it is out before anything else in the process can run, whether or not the host has read yet. A channel slot that cannot be read (a preloaded accessor that throws) is refused like a taken one, never node's exit 1; the `fs.writeSync` binding is taken when the shim loads, so a bundle (or a dependency inside it) that replaces it afterwards cannot lose the deny; the "decision on standard output" mark counts only on the channel function the shim itself installed (a preloaded decoy carrying that mark, or an accessor that reads undefined once and a marked function afterwards, is no evidence that anything reached the host); a refusal whose own write fails exits 2 whatever the function on the channel claims, so a genuine first load's deny can sit on standard output behind that 2 (a Codex permit) only when `process.exit` was made a no-op in-process. Inside the in-process boundary the shim states, and listed in its header: `process.exit` made a no-op (a delivered deny with the process alive until the host's timeout; a second copy of the shim loaded after that deny appends its refusal), the channel function marked as decided by code running after it exists, and a host pipe smaller than the bound. Anything already on the channel when the shim loads (a function some preloaded module put there through `NODE_OPTIONS=--require`, a second copy of the shim, any value at all) is refused with a canonical deny on standard output and exit 0 - the only answer Codex 0.154.0 blocks on (measured on the real host with marker files on 2026-09-17: exit 2 with a reason on standard error, and even exit 2 with a deny on standard output, let the tool call run; exit 1 and an empty standard output with exit 0 did too). Every fail-closed path therefore writes the deny to standard output and exits 0 whenever standard output can take one; exit 2 with the reason on standard error remains only for a standard output that cannot be written at all, which no hook can turn into a block on this host. A process-wide marker records that a decision is on standard output, so a refused second load and the first load's exit backstop never produce two decisions - there is no second-load exemption, because nothing in-process can tell the shim's own copy from a decoy that copied it - and the deny is on standard output before the exit is attempted, so a `process.exit` patched away in-process changes nothing. In-process code that makes `process.exit` throw ends the hook at node's exit 1, whatever the shim does - the same in-process control as patching the file system, documented as out of scope.
- **What the shim cannot close.** The deny is written synchronously, and if standard output cannot be written at all the shim exits with code 2 rather than 0 with an empty, permit-shaped output - a blocking error for Claude Code, and on Codex 0.154.0 a permit that no hook can prevent (measured; see above). A synchronous hang inside the bundle or the native SDK addon keeps the event loop from running the deadline timer at all; only the host timeout ends that, and that case is fail open at the host. A write straight to file descriptor 1 (not through `process.stdout`) is not intercepted; the JavaScript bundle has none, and the native SDK addon is assumed not to print to it. On POSIX a momentarily full pipe can make the synchronous deny write fail with `EAGAIN`; it is retried while bytes keep being accepted, for at most two seconds without one and never past two seconds after the configured deadline (every write is tried once whatever the clock says, so a bundle that stalled the event loop past the give-up but under the host's timeout still puts its deny on a healthy standard output; a first attempt that came that late keeps up to two seconds of retries of its own, and in no case does any write run past 32 s of uptime - two seconds after the largest accepted deadline; a transport that dribbles the deny a byte at a time is not a stall and gets the whole deny; a write that reports zero bytes accepted is waited out like a refusal, and one that reports a count that is not a number, negative, or larger than what was offered is an error, never progress), then takes the exit-2 path with the reason on standard error - a blocking error for Claude Code, a permit on Codex 0.154.0, where only a deny on standard output blocks.

## Install the complete plugin

Use Node.js 22.13.0 or newer on macOS arm64, Linux x64/arm64 (glibc), or Windows x64. The SDK and its native bindings are bundled; end users do not need to run npm install or compile the plugin.

Add this repository as a marketplace:

```bash
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref main
```

Then open the Plugins Directory in the desktop app, select the Atbash AI marketplace, and install Atbash Safety. If you already registered another marketplace named `atbash-ai`, choose the source that points to this repository. Configure credentials before enabling and trusting its hook. Review the Atbash hook through `/hooks` and start a new task after installation.

On Codex 0.154 or newer, installing the plugin does **not** activate its hook: Codex no longer loads hooks shipped inside a plugin. Register the hook at the user level with the installer described in the next section, or nothing is enforced.

## Codex 0.154+: plugin hooks are not loaded

Verified 2026-09-17 on Codex CLI 0.154.0: `codex features list` reports `plugin_hooks: removed`, the plugin manifest validator rejects a `hooks` field in `.codex-plugin/plugin.json`, and with this plugin installed and enabled a shell command ran with no hook activity at all. On that Codex, `plugins/atbash/hooks/hooks.json` enforces nothing, and that includes the copy of this plugin in OpenAI's curated marketplace. The file still ships for hosts that load plugin hooks; do not treat the plugin listing itself as enforcement.

Codex does run the very same hook when it is registered at the user level (`~/.codex/hooks.json`, or `[hooks]` in `~/.codex/config.toml`) or at the project level (`<project>/.codex/hooks.json`). The plugin ships an installer that writes that entry:

```bash
node plugins/atbash/runtime/install-hook.cjs
```

Run it with the node you want the hook to use, from a clone of this repository or from the directory Codex installed the plugin into. The command it registers is `"<absolute node>" "<absolute pre-tool-use.cjs>"`: the real path of the `runtime/pre-tool-use.cjs` next to the installer and the real path of the node that ran it (`process.execPath`), so the hook does not depend on the `PATH` of whatever launched Codex (a launcher or Dock icon whose `PATH` lacks an nvm node could not spawn a bare `node` hook, and a hook that cannot spawn returns no decision). Codex on Windows runs hook commands through PowerShell (verified on 0.154.0: the plain quoted form `"<node>" "<script>"` ran the tool with no hook activity at all, the call-operator form ran the hook), so on Windows both `command` (forward slashes) and `commandWindows` (backslashes) start with PowerShell's call operator: `& "<node>" "<script>"`. On macOS and Linux the command is `"<node>" "<script>"` for `sh` (assumed from Claude Code's documented hook contract; not verified on a POSIX Codex host). The entry has the same matcher, timeout and status message as `hooks/hooks.json`. The bundled `hooks/hooks.json` entry, by contrast, runs a bare `node` and a `$PLUGIN_ROOT` / `%PLUGIN_ROOT%` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own, even on a host that still loads plugin hooks; on Windows its `%PLUGIN_ROOT%` form is `cmd.exe` syntax that PowerShell, the shell Codex uses there, never expands. Both paths go into a shell string unescaped, so they are allowlisted (letters, digits, space, `_ . : / + @ ( ) -`, plus `\` on Windows); a plugin or node under any other path is refused with exit `1`, and after building the entry the installer parses both paths back out of the command and refuses unless they resolve to the same two files. It then runs that exact string through the host's shell (Windows PowerShell `-NoProfile -NonInteractive -Command` with `commandWindows` and again with `command` on Windows, `/bin/sh -c` with `command` elsewhere) with a synthetic `PreToolUse` payload, no PATH, no home and no configuration, and writes only if the hook exits 0 with one deny decision on standard output within 15 s; a string the shell cannot run would be a hook that never answers. (PowerShell runs a native program only when `PATHEXT` is set; with it unset it silently runs nothing and exits 0, so the probe supplies the system default rather than inherit an empty one.) Codex runs several `PreToolUse` hooks; verified on 0.154.0 on 2026-09-17: a hook that answers `permissionDecision: "allow"` registered ahead of the Atbash hook did not outrank the Atbash deny, and neither did one registered after it - a deny wins in either order, so the installer appending the Atbash entry last is not a gap. Verified in the same session: the host honours each hook's `timeout` in seconds and proceeds with the tool call when it expires (a hook sleeping 20 s under `timeout: 5` was cut off and the command ran), which is why the shim's own deadline stays under the registered 35 s.

Options: `--dry-run` prints the Atbash entry that would be written plus a count of what is kept (never the rest of the file, whose foreign commands may carry tokens) and writes nothing; `--scope project` writes `<project>/.codex/hooks.json` instead of the user file; `--dir <path>` names the Codex home (user scope; the default is `$CODEX_HOME`, then `~/.codex`) or the project directory; `--uninstall` removes only the Atbash entry. An existing file is touched only if it is valid JSON in the documented hook shape (a parse error is reported by position, never by content), and then other hooks, other events, and unknown keys are preserved verbatim. An existing Atbash entry is recognised by one signal only: a command naming this very hook script (trailing arguments tolerated), and it is replaced rather than duplicated. The `statusMessage` is not proof of ownership: an entry carrying Atbash's status message but another script is a look-alike, kept, counted and mentioned on standard error, never replaced; another vendor's hook that happens to be called `pre-tool-use.cjs` is likewise left alone. A symlinked `hooks.json` is updated through the link (the real file is replaced, the link stays); the replacement is atomic (temp file in the real directory, then rename), happens only if the file still holds the bytes that were read, and gets mode `0600` on macOS/Linux, where a hooks directory writable by other users also draws a warning (Windows permissions are ACLs; no mode check is made there). Exit codes: `0` done or nothing to do, `1` refused or failed with the file left as it was, `2` usage.

Before running it, know the blast radius: a user-level registration (the default) subjects every Codex session and every project on this machine to Atbash judgment, and with no configuration in place every tool call is denied. Try `--scope project` first (it writes `<project>/.codex/hooks.json` for one project only; the project is the directory Codex is started in, not the repository root - measured on 0.154.0: a session opened in a subdirectory of a repository whose root carries the file ran its tool calls with no hook activity, while the same file in that subdirectory gated them - so install where you start Codex, and expect a session started elsewhere in the same repository to be ungated) and widen to user scope once you have seen it work. Because the interpreter is pinned to the node that ran the installer, re-run the installer after changing node versions or moving the plugin; `node plugins/atbash/runtime/status.cjs` warns when the registered interpreter or hook script no longer exists. To get out: untrust the hook in `/hooks`, or from a shell outside Codex run `node plugins/atbash/runtime/install-hook.cjs --uninstall` (add `--scope project` or `--dir` to match how it was installed), then restart Codex.

Two steps remain yours, and the installer prints them:

1. Restart Codex so it reads the hooks file.
2. In Codex, run `/hooks` and trust the Atbash `PreToolUse` hook. Codex does not run an untrusted hook; `--dangerously-bypass-hook-trust` exists for CI only and is not a substitute.

Manual fallback, if you would rather write the file yourself (`~/.codex/hooks.json`; replace the path with the absolute path of your copy of the plugin):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/node\" \"/absolute/path/to/plugins/atbash/runtime/pre-tool-use.cjs\"",
            "timeout": 35,
            "statusMessage": "Checking action with Atbash"
          }
        ]
      }
    ]
  }
}
```

Use the absolute path of your node (`node -p process.execPath`) rather than a bare `node`, for the `PATH` reason above. On Windows both fields need PowerShell's call operator: `"command": "& \"C:/path/to/node.exe\" \"C:/path/to/plugins/atbash/runtime/pre-tool-use.cjs\""` and `"commandWindows": "& \"C:\\path\\to\\node.exe\" \"C:\\path\\to\\plugins\\atbash\\runtime\\pre-tool-use.cjs\""`; without the `&` Codex evaluates the quoted path as a string and runs nothing. Then trust the hook in `/hooks` and restart Codex, exactly as above.

## Configure your agent locally

Create `~/.config/atbash/config.json` on macOS/Linux or `%USERPROFILE%\.config\atbash\config.json` on Windows, using a local editor outside the conversation:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Protect the directory and file with permissions `700` and `600` on macOS/Linux. The organization is required and must match the organization where your agent is registered. Each user supplies their own credentials. Never upload the configuration or paste a private key into chat.

The SDK uses the key locally for identity and signing. The hook calls `auditToolCall()` with the tool name, arguments, and limited execution context. The SDK handles redaction and communication with Atbash. Network access to Atbash and the configured chain services must be available in the hook's execution environment.

Try: “Run pwd, then list the files in this repository.” The setup skill can explain activation, status results, and key rotation. Disabling the plugin or its hook deactivates enforcement for later calls.

## Source and distribution

`main` is the public release source. Initial plugin code and runtime are based on source commit `5cdeb7d66def9a94e387f129a9f0744cbf818515` (production SDK 0.7.1). This repository starts with fresh Git history and contains no agent configuration or previous debugging history.

| Path                                       | Purpose                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`         | Catalog used by Git-based installation                                                                           |
| `plugins/atbash/.codex-plugin/plugin.json` | Plugin identity and presentation                                                                                 |
| `plugins/atbash/hooks/hooks.json`          | Catch-all `PreToolUse` registration (not loaded by Codex 0.154+; see above)                                      |
| `plugins/atbash/src/`                      | SDK adapter, hook protocol, and user-level hook installer implementation                                         |
| `plugins/atbash/runtime/`                  | Committed JavaScript bundles (hook, status, `install-hook.cjs`), native SDK bindings, checksums, and SDK license |
| `plugins/atbash/skills/atbash-setup/`      | Local setup and troubleshooting instructions                                                                     |
| `submission/`                              | Listing and reviewer preparation                                                                                 |

## Develop and package

```bash
npm ci
npm run verify
npm run build:marketplace
npm run package:submission
```

The last command generates a full plugin ZIP, a separate setup-skill ZIP, and a manifest with the Git commit, SDK version, and archive hashes under `artifacts/`. Packaging requires the `zip` command (macOS/Linux; CI uses Ubuntu). The full ZIP includes the hook and runtime. The setup-only ZIP contains instructions and does not provide automatic enforcement.

For a live read-only status check after configuring your own agent:

```bash
node plugins/atbash/runtime/status.cjs
```

Its JSON carries `hookRegistration` next to the agent state: `registered` counts the Atbash `PreToolUse` entries found in the user-level and project-level hooks files, `spawnable` those the host would run as the installer wrote them (`type` `command`, matcher `*`, a timeout of at least 33 s, a pinned interpreter and hook script that exist), `degraded` the difference, and `enforcing` whether at least one entry is spawnable. The process exits 0 only for `ready` with `enforcing` true and `degraded` 0; a degraded entry is a gate that looks installed and is not, and the `warning:` lines on standard error say which entry and why. Paths from the plugin's own entries are echoed in those warnings only when they pass the path allowlist below and are at most 512 characters; everything else from a hooks file is described by type and length, because a project-level file is repository content and the warning lands in the transcript. Each entry in `scopes` carries its own `registered` / `spawnable` / `degraded`, so a wrapper reading the scopes cannot average a broken project-level entry away behind a healthy user-level one, and `inspected` false (the inspection itself failed) is never exit 0. The path filter is shape-based by decision, not a secret detector: a segment made only of letters, digits and path punctuation is shown even if it happens to be secret-shaped, because the user must be able to see which node went missing; a segment carrying `=`, `?`, `&`, quotes or any non-path character is described by length.

Automated tests use synthetic fixtures and need no credentials. CI verifies the source, native checksums, generated runtime, and submission archives.

## OpenAI directory submission

This public repository is an installation and review source. Creating it does not publish the plugin in OpenAI's directory or automatically update an existing portal draft.

OpenAI documents Skills-only and remote MCP submission paths. Its packaging guidance supports lifecycle hooks in local execution environments, but installing on the web does not deploy hook scripts. Confirm that the approved distribution path delivers and executes the full hook package before advertising automatic enforcement in a public directory listing. See [submission preparation](submission/README.md), [OpenAI submission guidance](https://developers.openai.com/plugins/deploy/submission), and [hook packaging guidance](https://developers.openai.com/plugins/build/plugins).

## Licensing

The bundled SDK retains its own [license](plugins/atbash/runtime/licenses/atbash-sdk.LICENSE). This repository does not change the licensing of SDK or other bundled dependencies.
