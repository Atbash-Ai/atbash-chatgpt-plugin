# Atbash Safety for ChatGPT and Codex

Atbash Safety evaluates supported Codex tool calls against your Atbash agent's policy before execution. This repository distributes the complete local plugin: a `PreToolUse` hook, the production npm SDK `@atbash/sdk@0.7.1`, native binaries, and an `atbash-setup` skill. It has no MCP server.

Only `allow: true` with verdict `ALLOW` permits the pending call. `HOLD`, `BLOCK`, invalid configuration, timeout, and service errors deny that attempt. Coverage is limited to tools exposed to the host's `PreToolUse` hook; plain text responses and tools outside that lifecycle are not covered.

### The host boundary

A `PreToolUse` host lets a tool call proceed when the hook times out or exits without a decision. This is Claude Code's documented hook contract (exit 0 with a decision, exit 2 blocking, any other exit or a timeout non-blocking); Codex is assumed to share it, and that assumption has not been verified against a real Codex host. Two failures that would silently remove the gate are therefore handled by the entry point itself (`plugins/atbash/runtime/pre-tool-use.cjs`, a small un-bundled shim that loads the bundled hook `runtime/pre-tool-use-main.cjs`):

- **Hard deadline.** The SDK budget (`ATBASH_CODEX_TIMEOUT_MS`, default 30,000 ms) applies per request, and one judgment is several requests, so a slow but alive judge could outlive the 35 s hook timeout in `hooks/hooks.json`. The shim denies the call at `ATBASH_HOOK_DEADLINE_MS` (default 28,000 ms; accepted range 1,000-30,000, so that node start-up and the bundle load always fit under the host timeout) unless the bundled hook has already written its decision. An invalid value denies every call rather than running without a deadline.
- **Runtime failure.** A bundled hook that cannot load, throws asynchronously, or leaves a promise rejected exits with a deny (exit code 0) instead of exit code 1 and no output. The deny text is fixed; nothing from the failure is echoed to the host.
- **Only the decision reaches standard output.** The bundled hook hands its decision to the shim over a private in-process channel (`Symbol.for("atbash.hook.answer")`, installed by the shim before the bundle loads), never over standard output; the shim diverts everything the bundle or its library loggers (`console.log` sinks) write to standard output to standard error (the host transcript), so a stray log line can neither corrupt the decision nor count as one, however well shaped. The channel payload is checked (one JSON object with a `hookSpecificOutput.permissionDecision` string; a permit is the empty string) and a malformed answer is a deny. Library diagnostics therefore appear in the transcript rather than on the decision channel; a closed standard error drops them. A bundle that wrote its decision but is still alive is ended once those bytes have drained.
- **What the shim cannot close.** The deny is written synchronously, and if standard output cannot be written at all the shim exits with code 2 (a blocking error for the host) rather than 0 with an empty, permit-shaped output. A synchronous hang inside the bundle or the native SDK addon keeps the event loop from running the deadline timer at all; only the host timeout ends that, and that case is fail open at the host. A write straight to file descriptor 1 (not through `process.stdout`) is not intercepted; the JavaScript bundle has none, and the native SDK addon is assumed not to print to it. On POSIX a momentarily full pipe can make the synchronous deny write fail with `EAGAIN`; it is retried for about a second and then takes the exit-2 path: still a blocking error, delivered on standard error instead of as JSON.

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

Run it from a clone of this repository, or from the directory Codex installed the plugin into; the command it registers is the absolute path of the `runtime/pre-tool-use.cjs` next to it (resolved through the real path, with forward slashes; on Windows a `commandWindows` variant with backslashes is added, matching `hooks/hooks.json`). Options: `--dry-run` prints the exact resulting file and writes nothing; `--scope project` writes `<project>/.codex/hooks.json` instead of the user file; `--dir <path>` names the Codex home (user scope; the default is `$CODEX_HOME`, then `~/.codex`) or the project directory; `--uninstall` removes only the Atbash entry. An existing file is touched only if it is valid JSON in the documented hook shape, and then other hooks, other events, and unknown keys are preserved verbatim; an existing Atbash entry (recognised by its `pre-tool-use.cjs` command) is replaced rather than duplicated; the file is replaced atomically (temp file and rename) with mode `0600` on macOS/Linux. Exit codes: `0` done or nothing to do, `1` refused or failed with the file left as it was, `2` usage.

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
            "command": "node \"/absolute/path/to/plugins/atbash/runtime/pre-tool-use.cjs\"",
            "timeout": 35,
            "statusMessage": "Checking action with Atbash"
          }
        ]
      }
    ]
  }
}
```

On Windows add `"commandWindows": "node \"C:\\path\\to\\plugins\\atbash\\runtime\\pre-tool-use.cjs\""` beside `command`. Then trust the hook in `/hooks` and restart Codex, exactly as above.

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

Automated tests use synthetic fixtures and need no credentials. CI verifies the source, native checksums, generated runtime, and submission archives.

## OpenAI directory submission

This public repository is an installation and review source. Creating it does not publish the plugin in OpenAI's directory or automatically update an existing portal draft.

OpenAI documents Skills-only and remote MCP submission paths. Its packaging guidance supports lifecycle hooks in local execution environments, but installing on the web does not deploy hook scripts. Confirm that the approved distribution path delivers and executes the full hook package before advertising automatic enforcement in a public directory listing. See [submission preparation](submission/README.md), [OpenAI submission guidance](https://developers.openai.com/plugins/deploy/submission), and [hook packaging guidance](https://developers.openai.com/plugins/build/plugins).

## Licensing

The bundled SDK retains its own [license](plugins/atbash/runtime/licenses/atbash-sdk.LICENSE). This repository does not change the licensing of SDK or other bundled dependencies.
