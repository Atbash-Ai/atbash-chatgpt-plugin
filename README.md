# Atbash Safety for ChatGPT and Codex

Atbash Safety evaluates supported Codex tool calls against your Atbash agent's policy before execution. This repository distributes the complete local plugin: a `PreToolUse` hook, the production npm SDK `@atbash/sdk@0.7.1`, native binaries, and an `atbash-setup` skill. It has no MCP server.

The adapter returns an allow result only for `allow: true` with verdict `ALLOW`. It returns or attempts to deliver a deny for `HOLD`, `BLOCK`, invalid configuration, timeout and service errors; actual tool blocking depends on the host contract described below. Coverage is limited to tools exposed to the host's `PreToolUse` hook; plain text responses and tools outside that lifecycle are not covered.

### The host boundary

A passing hook-process test does not establish that the host blocked a protected tool. Current [official Codex documentation](https://learn.chatgpt.com/docs/hooks) supports a `PreToolUse` deny decision on standard output and exit code `2` with a reason on standard error. Earlier repository notes claimed that Codex 0.154.0 consumed an exit-2 denial and still ran the tool. Review on 2026-09-18 could not substantiate that claim from the retained hook-execution and tool-execution evidence; it is withdrawn pending a valid host probe.

The entry point (`plugins/atbash/runtime/pre-tool-use.cjs`) is an unbundled shim that loads `pre-tool-use-main.cjs`. It attempts to deliver a bounded deny before the registered timeout when the SDK is slow, the bundle cannot load, an asynchronous error occurs, or the bundle returns without answering. It diverts library diagnostics from standard output to standard error, bounds the serialized deny, and handles repeated channel initialization conservatively. The synchronous writer has a bounded stall period and rejects zero or impossible progress. Failed output delivery ends with an error exit. These are local runtime behaviors covered by process tests, not a guarantee of host enforcement.

A synchronous native hang can prevent an in-process deadline callback from running. Failed decision delivery, process termination and host timeout therefore require independent host-level verification. The necessary evidence is a successful allow control, a marker proving the hook ran, and a protected-tool marker that remains absent for each deny/failure case. Keep the invocation, fixture, host output and both markers. A process exit code or a missing tool marker alone is insufficient.

The fresh 0.154.0 diagnostic on 2026-09-18 was inconclusive: automatic approval review rejected its marker-write command before either hook or tool marker appeared. An isolated 0.155.0 binary was version-checked but not tested for tool enforcement. No confirmed host bypass or successful fail-closed activation is established by these results. Release and live-protection verification remain pending; do not equate installation or enrollment with protection. Other historical host observations below are not a substitute for a valid probe on the host being activated.

## Install the complete plugin

Use Node.js 22.13.0 or newer on macOS arm64, Linux x64/arm64 (glibc), or Windows x64. The SDK and its native bindings are bundled; end users do not need to run npm install or compile the plugin.

Add this repository as a marketplace:

```bash
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref main
```

Then open the Plugins Directory in the desktop app, select the Atbash AI marketplace, and install Atbash Safety. If you already registered another marketplace named `atbash-ai`, choose the source that points to this repository. Configure credentials before enabling and trusting its hook. Review the Atbash hook through `/hooks` and start a new task after installation.

The inspected Codex CLI versions 0.154.0 and 0.155.0 report `plugin_hooks` as removed. Do not treat installing the plugin as hook activation. Use the user-level installer described below, then verify hook execution and enforcement on the actual host; 0.155.0 has not been tested for tool enforcement here.

## Plugin-hook support in the inspected Codex versions

Verified 2026-09-17 on Codex CLI 0.154.0: `codex features list` reports `plugin_hooks: removed`, the plugin manifest validator rejects a `hooks` field in `.codex-plugin/plugin.json`, and with this plugin installed and enabled a shell command ran with no hook activity at all. On that Codex, `plugins/atbash/hooks/hooks.json` enforces nothing, and that includes the copy of this plugin in OpenAI's curated marketplace. The file still ships for hosts that load plugin hooks; do not treat the plugin listing itself as enforcement.

Codex does run the very same hook when it is registered at the user level (`~/.codex/hooks.json`, or `[hooks]` in `~/.codex/config.toml`) or at the project level (`<project>/.codex/hooks.json`). The plugin ships an installer that writes that entry:

```bash
node plugins/atbash/runtime/install-hook.cjs
```

Run it with the node you want the hook to use, from a clone of this repository or from the directory Codex installed the plugin into. The command it registers is `"<absolute node>" "<absolute pre-tool-use.cjs>"`: the real path of the `runtime/pre-tool-use.cjs` next to the installer and the real path of the node that ran it (`process.execPath`), so the hook does not depend on the `PATH` of whatever launched Codex (a launcher or Dock icon whose `PATH` lacks an nvm node could not spawn a bare `node` hook, and a hook that cannot spawn returns no decision). Codex on Windows runs hook commands through PowerShell (verified on 0.154.0: the plain quoted form `"<node>" "<script>"` ran the tool with no hook activity at all, the call-operator form ran the hook), so on Windows both `command` and `commandWindows` (forward slashes) start with PowerShell's call operator: `& "<node>" "<script>"`. On macOS and Linux the command is `"<node>" "<script>"` for `sh` (assumed from Claude Code's documented hook contract; not verified on a POSIX Codex host). The entry has the same matcher, timeout and status message as `hooks/hooks.json`. The bundled `hooks/hooks.json` entry, by contrast, runs a bare `node` and a `$PLUGIN_ROOT` / `$env:PLUGIN_ROOT` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own, even on a host that still loads plugin hooks; the Windows placeholder uses PowerShell syntax. Both paths go into a shell string unescaped, so they are allowlisted (letters, digits, space, `_ . : / + @ ( ) -`, plus `\` on Windows); a plugin or node under any other path is refused with exit `1`, and after building the entry the installer parses both paths back out of the command and refuses unless they resolve to the same two files. It then runs that exact string through the host's shell (Windows PowerShell `-NoProfile -NonInteractive -Command` with `commandWindows` and again with `command` on Windows, `/bin/sh -c` with `command` elsewhere) with a synthetic `PreToolUse` payload, no PATH, no home and no configuration, and writes only if the hook exits 0 with one deny decision on standard output within 15 s; a string the shell cannot run would be a hook that never answers. (PowerShell runs a native program only when `PATHEXT` is set; with it unset it silently runs nothing and exits 0, so the probe supplies the system default rather than inherit an empty one.) Codex runs several `PreToolUse` hooks; verified on 0.154.0 on 2026-09-17: a hook that answers `permissionDecision: "allow"` registered ahead of the Atbash hook did not outrank the Atbash deny, and neither did one registered after it - a deny wins in either order, so the installer appending the Atbash entry last is not a gap. Earlier audit notes reported that a host timeout let a tool proceed. That observation requires a retained execution-marker probe on the actual host before it can establish current behavior; the shim keeps its own deadline below the registered 35 s as a precaution.

Ownership checks the command the host actually runs: `commandWindows` on Windows, and `command` on macOS/Linux. A Windows-only field does not establish ownership on a POSIX host.

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

Use the absolute path of your node (`node -p process.execPath`) rather than a bare `node`, for the `PATH` reason above. On Windows both fields need PowerShell's call operator and the same forward-slash path spelling: `"command": "& \"C:/path/to/node.exe\" \"C:/path/to/plugins/atbash/runtime/pre-tool-use.cjs\""` and `"commandWindows": "& \"C:/path/to/node.exe\" \"C:/path/to/plugins/atbash/runtime/pre-tool-use.cjs\""`. The backslash spelling terminated PowerShell before the hook answered on the elevated Windows runner. Without the `&` Codex evaluates the quoted path as a string and runs nothing. Then trust the hook in `/hooks` and restart Codex, exactly as above.

## Configure your agent locally

Invoke `$atbash-setup` after installing the plugin. The setup skill creates an empty config template when needed and opens it in a graphical editor: Notepad on Windows, TextEdit on macOS, or the desktop's default editor on Linux. It never reads or overwrites an existing config.

Enter the values locally in the opened file, then save and close it:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Protect the directory and file with permissions `700` and `600` on macOS/Linux. The organization is required and must match the organization where your agent is registered. Each user supplies their own credentials. Never upload the configuration or paste a private key into chat.

After you confirm that the editor is closed, the setup skill runs the local status check. If the agent is ready but hook registration is missing or degraded, complete the installer step above and run status again. You must still review and trust the exact Atbash hook definition through `/hooks`, restart Codex, and verify a harmless tool call; registration alone does not prove that the current session is enforcing.

The SDK uses the key locally for identity and signing. The hook calls `auditToolCall()` with the tool name, arguments, and limited execution context. The SDK handles redaction and communication with Atbash. Network access to Atbash and the configured chain services must be available in the hook's execution environment.

Try: “Run pwd, then list the files in this repository.” The setup skill can explain activation, status results, and key rotation. Disabling the plugin or its hook deactivates enforcement for later calls.

## Source and distribution

`main` is the public release source. Initial plugin code and runtime are based on source commit `5cdeb7d66def9a94e387f129a9f0744cbf818515` (production SDK 0.7.1). This repository starts with fresh Git history and contains no agent configuration or previous debugging history.

| Path                                       | Purpose                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`         | Catalog used by Git-based installation                                                                           |
| `plugins/atbash/.codex-plugin/plugin.json` | Plugin identity and presentation                                                                                 |
| `plugins/atbash/hooks/hooks.json`          | Catch-all `PreToolUse` registration (not loaded by the inspected Codex 0.154.0 and 0.155.0 binaries; see above)  |
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
