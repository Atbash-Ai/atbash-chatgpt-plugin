# Atbash Safety for ChatGPT and Codex

Atbash Safety evaluates supported Codex tool calls against your Atbash agent's policy before execution. This repository distributes the complete local plugin: a `PreToolUse` hook, the production npm SDK `@atbash/sdk@0.7.1`, native binaries, and an `atbash-setup` skill. It has no MCP server.

Only `allow: true` with verdict `ALLOW` permits the pending call. `HOLD`, `BLOCK`, invalid configuration, timeout, and service errors deny that attempt. Coverage is limited to tools exposed to the host's `PreToolUse` hook; plain text responses and tools outside that lifecycle are not covered.

## Install the complete plugin

Use Node.js 22.13.0 or newer on macOS arm64, Linux x64/arm64 (glibc), or Windows x64. The SDK and its native bindings are bundled; end users do not need to run npm install or compile the plugin.

Add this repository as a marketplace:

```bash
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref main
```

Then open the Plugins Directory in the desktop app, select the Atbash AI marketplace, and install Atbash Safety. If you already registered another marketplace named `atbash-ai`, choose the source that points to this repository. Configure credentials before enabling and trusting its hook. Review the Atbash hook through `/hooks` and start a new task after installation.

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

| Path                                       | Purpose                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`         | Catalog used by Git-based installation                                        |
| `plugins/atbash/.codex-plugin/plugin.json` | Plugin identity and presentation                                              |
| `plugins/atbash/hooks/hooks.json`          | Catch-all `PreToolUse` registration                                           |
| `plugins/atbash/src/`                      | SDK adapter and hook protocol implementation                                  |
| `plugins/atbash/runtime/`                  | Committed JavaScript bundles, native SDK bindings, checksums, and SDK license |
| `plugins/atbash/skills/atbash-setup/`      | Local setup and troubleshooting instructions                                  |
| `submission/`                              | Listing and reviewer preparation                                              |

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
