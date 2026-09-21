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
3. The Atbash `PreToolUse` command is registered where this Codex loads hooks (see the next section: on Codex 0.154 or newer that is the user's or project's own hooks file, never the plugin's).
4. The Atbash `PreToolUse` command is trusted in `/hooks`.
5. Local Atbash credentials and organization configuration are valid.

To deactivate Atbash, tell the user to disable the plugin or untrust/disable its hook in Codex (and, for a user-level registration, run the installer with `--uninstall`). Do not describe deactivation as bypassing an individual verdict; it disables enforcement for subsequent tool calls.

## Codex 0.154+: plugin hooks are not loaded

Verified 2026-09-17 on Codex CLI 0.154.0: `codex features list` reports `plugin_hooks: removed`, the manifest validator rejects a `hooks` field in `.codex-plugin/plugin.json`, and with the plugin installed and enabled a shell command ran with no hook activity. On such a Codex the plugin's bundled `hooks/hooks.json` enforces nothing, including for the copy in OpenAI's curated marketplace. Never tell the user that installing the plugin alone activates enforcement there.

Codex does run the same hook from a user-level (`~/.codex/hooks.json`, or `[hooks]` in `~/.codex/config.toml`) or project-level (`<project>/.codex/hooks.json`) registration. Tell the user to run the plugin's installer themselves, from a clone of the repository or from the directory Codex installed the plugin into:

```bash
node plugins/atbash/runtime/install-hook.cjs
```

The user should run it with the node they want the hook to use: the installer registers `"<absolute node>" "<absolute pre-tool-use.cjs>"` (the node that ran it and the hook script next to it, both real paths), so the hook does not depend on the `PATH` of whatever launched Codex, and before writing it runs that exact command through the host's shell (Windows PowerShell on Windows, where the command carries the call operator `&` because Codex evaluates a plain quoted path as a string and runs nothing - verified on 0.154.0; `sh` elsewhere) with no PATH and no configuration and requires a deny decision back. The plugin's bundled `hooks/hooks.json` entry, on a host that still loads plugin hooks, runs a bare `node` and a `PLUGIN_ROOT` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own. Useful flags: `--dry-run` (print the Atbash entry that would be written and a count of what is kept, write nothing), `--scope project`, `--dir <codex home or project dir>`, `--uninstall` (remove only the Atbash entry). The installer keeps every other hook in the file, replaces an existing Atbash entry (recognised only by a command naming this hook script; the status message is not proof of ownership, so a look-alike carrying it is kept and reported) instead of duplicating it, leaves another vendor's `pre-tool-use.cjs` alone, refuses a file that is not valid JSON in the documented hook shape (exit 1, file untouched), refuses a plugin or node path containing characters a shell could interpret (exit 1; the user moves the plugin to a plain path), updates a symlinked file through the link, and writes atomically with mode `0600` on macOS/Linux only if the file is unchanged since it was read. Its output names the hook command and the interpreter it registered; a `warning:` line on standard error means the hooks directory is writable by other users.

Tell the user what the registration covers: user scope (the default) subjects every Codex session and every project on the machine to Atbash judgment, and without configuration every tool call is denied; suggest `--scope project` first to bound it to one project - and say that "project" means the directory Codex is started in, not the repository root: a session opened in a subdirectory does not read the root's `.codex/hooks.json` (measured on Codex 0.154.0), so the file must sit where Codex is started, and `status` (which inspects the current directory's file) is the check. The interpreter is pinned to the node that ran the installer, so the user must re-run the installer after changing node versions or moving the plugin; the status command warns when the registered interpreter or hook script no longer exists. Recovery: untrust the hook in `/hooks`, or run the installer with `--uninstall` from a shell outside Codex, then restart Codex.

Then two steps remain that only the user can do: restart Codex so it reads the hooks file, and trust the Atbash `PreToolUse` hook in `/hooks`. Codex does not run an untrusted hook; never suggest bypassing hook trust.

Manual fallback (`~/.codex/hooks.json`, absolute path of the user's copy of the plugin):

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

The node path is the output of `node -p process.execPath`, not a bare `node`. On Windows both fields need PowerShell's call operator: `"command": "& \"C:/path/to/node.exe\" \"C:/path/to/plugins/atbash/runtime/pre-tool-use.cjs\""` and `"commandWindows": "& \"C:\\path\\to\\node.exe\" \"C:\\path\\to\\plugins\\atbash\\runtime\\pre-tool-use.cjs\""`; without the `&` nothing runs.

## Verify and troubleshoot

After the user confirms that the graphical editor was saved and closed, run the installed plugin's `runtime/status.cjs` without reading the config directly. If working from a source checkout, run:

```bash
npm run status --workspace @atbash/codex-plugin
```

When the agent state is `ready`, also inspect `hookRegistration`. If registration is missing, uninspected, or degraded, complete the installer step above and run status again; do not report setup complete. Once status exits 0 with healthy registration, tell the user to review and trust the Atbash hook through `/hooks`, restart Codex, and start a new task. Hook trust is deliberately a manual Codex security review and must not be bypassed or edited directly in config files.

After configuration and activation, use a harmless tool call such as listing the current directory to verify that the hook allows an ordinary action. Do not use destructive or privileged commands as tests.

Interpret status results as follows:

- `ready`: configuration, registration, and service access are working for the agent. The process exits 0 only when, in addition, `hookRegistration.enforcing` is `true` AND `hookRegistration.degraded` is `0` in the JSON. `enforcing` means an Atbash `PreToolUse` entry exists in the user-level (`$CODEX_HOME`/`~/.codex/hooks.json`) or the project-level (`<cwd>/.codex/hooks.json`) hooks file as the installer writes it - `type` `command`, matcher `*`, a timeout of at least the shim's worst case (33 s), and a pinned interpreter and hook script that both exist. `registered` counts the Atbash entries found, `spawnable` those the host would run as written, and `degraded` is the difference: an Atbash entry the host would skip, run without the catch-all matcher, or time out on before the shim's own deadline - a gate that looks installed and is not. `"state": "ready"` with exit 1 and `"enforcing": false` means the agent is fine but nothing gates tool calls; with `"enforcing": true` and `"degraded"` above `0`, one scope enforces and another carries a broken entry. In both cases run `install-hook.cjs` (or re-run it after a node change); `warnings` say which entry and what is wrong.
- `configuration_error`: correct the local key, exact organization name, or optional endpoint settings.
- `agent_not_registered`: onboard the public key derived from this private key into the named organization.
- `agent_jailed`: resolve the agent state in Atbash before retrying.
- `service_error`: check connectivity, endpoint/chain settings, and Atbash service availability.
- a `warning:` line on standard error (also in `hookRegistration.warnings`): the pinned interpreter or hook script of a registration no longer exists, or an entry runs a bare `node`; the user re-runs `install-hook.cjs` with the node they use now. A `note:` line means no hooks file or no Atbash entry exists in either scope, so nothing enforces Atbash on Codex 0.154+ until the installer has been run.

Never diagnose key mismatch by asking to inspect the private key. Ask the user to compare the locally derived public key with the public key registered in the Atbash dashboard.

## Explain verdicts

- `ALLOW` with `allow: true`: Codex continues the pending tool call.
- `HOLD`: Codex blocks this attempt pending operator review. After approval in Atbash, the user must explicitly retry the original request.
- `BLOCK`: Codex blocks the tool call.
- `ERROR`, timeout, malformed output, missing configuration, or inconsistent output: Codex blocks the tool call because the hook is fail closed.
- Judge still pending at the hard deadline (`ATBASH_HOOK_DEADLINE_MS`, default 28,000 ms), or the hook runtime cannot load or crashes: the entry-point shim writes the deny itself, so the host never sees a timed-out or crashed hook.

Do not claim that the plugin covers plain text responses, hosted tools that opt out of hooks, or every possible Codex capability. It guards tool calls exposed to the `PreToolUse` lifecycle hook.

## Rotate a key

Ask the user to rotate or revoke the old key in Atbash, then run the bundled setup helper to open the existing config in the graphical editor without reading it. The user replaces `agentKey` locally, verifies the derived public key is onboarded to the exact organization, and starts a new Codex task. Never handle either key value in the conversation.
