---
name: atbash-setup
description: Configure, activate, verify, troubleshoot, or rotate credentials for the Atbash Safety Codex plugin. Use when a user asks how to set up Atbash, enable or disable its hook, configure an organization or private key, check agent status, understand ALLOW/HOLD/BLOCK behavior, or fix configuration, registration, jailed-agent, endpoint, or service errors.
---

# Atbash Setup

Keep Atbash enforcement separate from this skill. The plugin's catch-all `PreToolUse` hook automatically judges supported tool calls whenever the plugin and hook are enabled and trusted; do not decide case by case whether to invoke Atbash.

## Protect credentials

- Never ask the user to paste, upload, or reveal an Atbash private key in chat.
- Never read, print, log, inspect, or transmit the user's Atbash config file.
- Never place a private key in a prompt, tool argument, command-line argument, shell history, manifest, repository file, or `.env` file.
- The bundled setup helper may create an empty config template and open it in a local graphical editor. It must never overwrite or inspect an existing config.
- Ask the user to enter credentials directly in the graphical editor. If a private key has appeared in chat, logs, or version control, advise the user to revoke or rotate it before continuing.
- Explain that the SDK uses the private key locally for agent identity and cryptographic signing and derives the public key locally. The configuration file remains on the user's machine; the plugin does not operate a credential-holding MCP server.

## Prepare the local configuration

Before trusting the hook, run the bundled `scripts/prepare-config.mjs` helper from this skill directory. Do this automatically when the user asks to set up Atbash; do not merely print setup commands.

The helper:

- creates `~/.config/atbash/` on macOS/Linux or `%USERPROFILE%\.config\atbash\` on Windows;
- creates `config.json` with empty `agentKey` and `orgName` values only when the file does not exist;
- tightens directory and file permissions on macOS/Linux;
- opens the file in Notepad on Windows, TextEdit on macOS, or the desktop's default text editor on Linux; and
- never reads, prints, replaces, or transmits an existing config.

If the graphical editor cannot be opened, report the config path and ask the user to open it in a local graphical editor. Do not fall back to displaying or editing the file in the terminal.

Tell the user to enter this shape in the opened file, save it, close the editor, and reply when finished:

```json
{
  "agentKey": "YOUR_PRIVATE_KEY",
  "orgName": "YOUR_EXACT_ORGANIZATION_NAME"
}
```

The organization name is required and must exactly match the organization where the agent's derived public key is onboarded. Never ask the user to show the saved file or its contents.

Environment variables `ATBASH_AGENT_KEY` and `ATBASH_ORG_NAME` are a session-only alternative. Prefer the config file for Codex desktop because environment changes do not reach an already-running desktop process.

If the already-trusted fail-closed hook prevents setup actions, tell the user to disable or untrust the Atbash hook, complete configuration manually outside Codex, restart Codex, and trust the hook again through `/hooks`.

## Activate or deactivate

Treat Atbash as active only when all of these are true:

1. The `atbash` plugin is installed and enabled.
2. Codex lifecycle hooks are enabled.
3. The Atbash `PreToolUse` command is trusted in `/hooks`.
4. Local Atbash credentials and organization configuration are valid.

To deactivate Atbash, tell the user to disable the plugin or untrust/disable its hook in Codex. Do not describe deactivation as bypassing an individual verdict; it disables enforcement for subsequent tool calls.

## Verify and troubleshoot

After the user confirms that the graphical editor was saved and closed, run the installed plugin's `runtime/status.cjs` without reading the config directly. If working from a source checkout, run:

```bash
npm run status --workspace @atbash/codex-plugin
```

When the status is `ready`, tell the user to review and trust the Atbash hook through `/hooks`, fully restart Codex if the hook definition changed, and start a new task. Hook trust is deliberately a manual Codex security review and must not be bypassed or edited directly in config files.

After configuration and activation, use a harmless tool call such as listing the current directory to verify that the hook allows an ordinary action. Do not use destructive or privileged commands as tests.

Interpret status results as follows:

- `ready`: configuration, registration, and service access are working.
- `configuration_error`: correct the local key, exact organization name, or optional endpoint settings.
- `agent_not_registered`: onboard the public key derived from this private key into the named organization.
- `agent_jailed`: resolve the agent state in Atbash before retrying.
- `service_error`: check connectivity, endpoint/chain settings, and Atbash service availability.

Never diagnose key mismatch by asking to inspect the private key. Ask the user to compare the locally derived public key with the public key registered in the Atbash dashboard.

## Explain verdicts

- `ALLOW` with `allow: true`: Codex continues the pending tool call.
- `HOLD`: Codex blocks this attempt pending operator review. After approval in Atbash, the user must explicitly retry the original request.
- `BLOCK`: Codex blocks the tool call.
- `ERROR`, timeout, malformed output, missing configuration, or inconsistent output: Codex blocks the tool call because the hook is fail closed.

Do not claim that the plugin covers plain text responses, hosted tools that opt out of hooks, or every possible Codex capability. It guards tool calls exposed to the `PreToolUse` lifecycle hook.

## Rotate a key

Ask the user to rotate or revoke the old key in Atbash, then run the bundled setup helper to open the existing config in the graphical editor without reading it. The user replaces `agentKey` locally, verifies the derived public key is onboarded to the exact organization, and starts a new Codex task. Never handle either key value in the conversation.
