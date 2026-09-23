# Atbash Safety for Codex

This package is the plugin payload for the Git-backed Atbash Codex marketplace. It contains the plugin manifest, catch-all `PreToolUse` hook, `$atbash-setup` skill, compiled SDK adapter, and a committed universal runtime with every native platform binding published for `@atbash/sdk@0.7.1`. It does not require an MCP server or upload user credentials to one.

The inspected Codex 0.154.0 and 0.155.0 binaries report bundled plugin hooks as removed (`plugin_hooks: removed`); check the actual target host rather than assuming this for every later release. `runtime/install-hook.cjs` registers the same hook, run by the absolute node that ran the installer, in the user's or project's own hooks file (`node runtime/install-hook.cjs [--dry-run] [--uninstall] [--scope user|project] [--dir <path>]`), after which the user trusts it in `/hooks` and restarts Codex.

Use the repository root for installation, configuration, testing, and security guidance.
