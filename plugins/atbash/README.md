# Atbash Safety for Codex

This package is the plugin payload for the Git-backed Atbash Codex marketplace. It contains the plugin manifest, catch-all `PreToolUse` hook, `$atbash-setup` skill, compiled SDK adapter, and a committed universal runtime with every native platform binding published for `@atbash/sdk@0.7.1`. It does not require an MCP server or upload user credentials to one.

Codex 0.154 and newer do not load the hook bundled in a plugin (`plugin_hooks: removed`); `runtime/install-hook.cjs` registers the same hook in the user's or project's own hooks file (`node runtime/install-hook.cjs [--dry-run] [--uninstall] [--scope user|project] [--dir <path>]`), after which the user trusts it in `/hooks` and restarts Codex.

Use the repository root for installation, configuration, testing, and security guidance.
