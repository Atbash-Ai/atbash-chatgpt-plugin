# Atbash Safety for Codex

Atbash Safety checks Codex tool calls through a `PreToolUse` hook. The `dev` branch bundles `@atbash/sdk@0.10.10-dev.0` and its native bindings. The bundled SDK is configured for the Atbash development service; users do not need to install the SDK separately or enter chain settings.

## Install the development plugin

Use Node.js 22.13.0 or newer on macOS arm64, Linux x64/arm64 (glibc), or Windows x64. Add the **dev** branch as a Codex marketplace:

```bash
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref dev
```

Open the Plugins Directory in Codex, choose the Atbash AI marketplace, and install **Atbash Safety**. If you already added this marketplace from `main`, switch its source to `dev` before installing or updating the plugin. The installed plugin includes the SDK runtime; no local build is needed.

## Set up an agent

Invoke `$atbash-setup` in Codex. The skill starts a short-lived onboarding session and provides a Connect Atbash link. Sign in and verify your wallet in the browser, then review and approve the exact account, organization, plan, and agent changes. The helper finishes setup and saves the agent key locally under `~/.config/atbash/` with restricted permissions. For an existing agent, it opens a local form for the key; the key is not sent to the dashboard or chat.

Use `$atbash-manage` for later changes. Each change requires a fresh browser authorization.

## Activate the Codex hook

On Codex 0.154 or newer, installing the plugin alone does not register its hook. Run the installer from the installed plugin directory, or from a checkout of this repository:

```bash
node plugins/atbash/runtime/install-hook.cjs
```

Run `$atbash-setup` before trusting the hook, because an unconfigured hook denies tool calls. Restart Codex, open `/hooks`, and trust the Atbash `PreToolUse` hook. Then check status:

```bash
node plugins/atbash/runtime/status.cjs
```

The installer registers the absolute path of the node that ran it and of the hook script, so the hook does not depend on the `PATH` of whatever launched Codex. The plugin's bundled `hooks/hooks.json` entry, by contrast, runs a bare `node` and a `$PLUGIN_ROOT` / `$env:PLUGIN_ROOT` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own.

The commands above assume you are in the repository checkout. From an installed plugin, use the corresponding `runtime/` paths. The status command checks both agent readiness and hook registration. Try a harmless tool call such as listing the current directory after it reports ready.

The guard allows only an SDK `ALLOW` decision with `allow: true`. `HOLD`, `BLOCK`, invalid configuration, and service errors deny the pending call. Enforcement covers tool calls exposed to the host's `PreToolUse` hook.

## What the hook sends

With each tool call the hook sends the tool name, its arguments (secrets redacted by the SDK), and a short context: `source=codex`, the workspace folder name, the model and the permission mode.

It also reads the end of the local Codex session transcript (the rollout file Codex names in `transcript_path`, at most 2 MiB) to compute one fact. When an instruction addressed to the agent appears in earlier tool output (a web page, file, email or command result), matches this call, and was never typed by the user, the context gains `call_origin=tool_output (the instruction for this call appeared in a tool output, not in the user request)`. That is a sign of prompt injection, and the judge treats the call more carefully. The fact is a fixed sentence, the same one the Claude Code plugin sends. The transcript is read only on your machine: only that fixed sentence leaves it, never any transcript text. Codex's own compaction summary is not counted as the user's words. Because the agent could write to its own rollout file, a call that points into Codex's home folder (`.codex`, `$CODEX_HOME`) or names a rollout or sessions `.jsonl` file by path or pattern, in this call or in a call still within the last 2 MiB of the transcript, also gains the fact. That is a string check: a path the agent builds at run time escapes it. What stops the agent writing its own transcript is the Codex sandbox (the default workspace-write sandbox does not let it write the sessions folder), not this check. Without a transcript, or when in doubt, nothing is added. The check is linear and capped, gives up after 1 second, and opens only an absolute, local, regular file.

Only what you typed counts as your words: your messages, your answers to the agent's questions, and your request under a comment on an earlier response. Codex's own context blocks, the agent's question, text quoted from an earlier response, and a task one agent relays to another (sub-agents) do not.

## Build from source

```bash
npm ci
npm run verify
npm run build:marketplace
```

`build:marketplace` regenerates the committed runtime from the pinned SDK version. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for development and security information.
