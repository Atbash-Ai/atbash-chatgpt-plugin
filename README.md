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

The commands above assume you are in the repository checkout. From an installed plugin, use the corresponding `runtime/` paths. The status command checks both agent readiness and hook registration. Try a harmless tool call such as listing the current directory after it reports ready.

The guard allows only an SDK `ALLOW` decision with `allow: true`. `HOLD`, `BLOCK`, invalid configuration, and service errors deny the pending call. Enforcement covers tool calls exposed to the host's `PreToolUse` hook.

## Build from source

```bash
npm ci
npm run verify
npm run build:marketplace
```

`build:marketplace` regenerates the committed runtime from the pinned SDK version. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for development and security information.
