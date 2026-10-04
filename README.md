# Atbash Safety for Codex

Atbash Safety checks Codex tool calls through a `PreToolUse` hook. The plugin ships a prebuilt runtime with the Atbash SDK and its native bindings, so users do not install the SDK separately or enter chain settings.

## Environments

The plugin is built for one of two Atbash environments. Both branches share the same source; only the committed runtime in `plugins/atbash/runtime/` differs.

|                 | Production                         | Development                                                           |
| --------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Branch          | `main`                             | `dev`                                                                 |
| Who installs it | Users                              | The team, for testing                                                 |
| Bundled SDK     | `@atbash/sdk` (stable npm release) | `@atbash/sdk-dev` (npm alias of an `@atbash/sdk` dev build)           |
| Atbash service  | `https://atbash.ai`                | `https://chromia-verified-ai-dev-two.vercel.app`                      |
| Chains          | The SDK's production defaults      | Development chains pinned in `plugins/atbash/build-environments.json` |
| Build command   | `npm run build:marketplace`        | `npm run build:marketplace:dev`                                       |

Codex installs a snapshot of the plugin from the Git ref and runs the committed runtime as-is, so **the ref you install from decides the environment**. `plugins/atbash/runtime/manifest.json` records which one a runtime was built for (`"environment": "prod"` or `"dev"`).

## Install

Use Node.js 22.13.0 or newer on macOS arm64, Linux x64/arm64 (glibc), or Windows x64. Add this repository as a Codex marketplace, from `main` for production or `dev` for testing:

```bash
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref main   # production
codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref dev    # development
```

Open the Plugins Directory in Codex, choose the Atbash AI marketplace, and install **Atbash Safety**. The installed plugin includes the SDK runtime; no local build is needed. On macOS, if `codex` is not on your `PATH`, the ChatGPT app bundles the CLI at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.

Check which environment is installed:

```bash
grep '"environment"' ~/.codex/plugins/cache/atbash-ai/atbash/*/runtime/manifest.json
```

The installed plugin is a snapshot. After new commits land, run `codex plugin marketplace upgrade atbash-ai` and install the plugin again.

### Switching between production and development

An agent exists only in the environment it was created in: an agent onboarded on development is not registered on production, and the hook fails closed. When you switch:

1. In Codex, open `/hooks` and untrust the Atbash hook, so it cannot block the next setup.
2. Disconnect the current Codex profile. It stays saved under `~/.config/atbash/` and can be selected again later with `profile switch`:

   ```bash
   node ~/.codex/plugins/cache/atbash-ai/atbash/<version>/skills/atbash-setup/scripts/atbash-control.mjs profile disconnect --host codex
   ```

3. Reinstall from the other ref:

   ```bash
   codex plugin remove atbash@atbash-ai
   codex plugin marketplace remove atbash-ai
   codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref main  # production
   codex plugin marketplace add Atbash-Ai/atbash-chatgpt-plugin --ref dev   # or development
   codex plugin add atbash@atbash-ai
   ```

4. Restart Codex, run `$atbash-setup`, then trust the hook again.

`~/.config/atbash/` is shared with the Atbash Claude Code plugin. Disconnecting `--host codex` leaves the Claude profile untouched; a legacy `config.json`, `guard-client-key`, or `ATBASH_AGENT_KEY` applies to both plugins.

## Set up an agent

Invoke `$atbash-setup` in Codex. The skill starts a short-lived onboarding session and provides a Connect Atbash link. Sign in and verify your wallet in the browser, then review and approve the exact account, organization, plan, and agent changes. The helper finishes setup and saves the agent key locally under `~/.config/atbash/` with restricted permissions. For an existing agent, it opens a local form for the key; the key is not sent to the dashboard or chat.

Setup works with the hook trusted. Until an agent is configured, the hook allows only the Atbash setup steps — the helper's setup commands, with the plan passed inline, and plain reads of the setup skill's own files — and denies every other tool call. Once setup activates a profile, every tool call is judged again; `setup continue` reports the new agent's status itself, so no extra judged call is needed. An existing but invalid configuration stays fail closed.

The Connect Atbash URL must be on the service of the installed environment (see [Environments](#environments)). If it is not, the installed snapshot is not the one you expect.

Each new agent starts with a policy preset (Developer, DevOps, or Full baseline). Codex suggests one from the agent's purpose, and you can switch it or customize individual rules on the Connect Atbash review page before approving. It is created as the organization policy "<agent name> Policy" and can be fine-tuned later under Policies in the dashboard.

Use `$atbash-manage` for later changes. Each change requires a fresh browser authorization.

## Activate the Codex hook

On Codex 0.154 or newer, installing the plugin alone does not register its hook. Run the installer from the installed plugin directory, or from a checkout of this repository:

```bash
node plugins/atbash/runtime/install-hook.cjs
```

Restart Codex, open `/hooks`, and trust the Atbash `PreToolUse` hook. Then check status:

```bash
node plugins/atbash/runtime/status.cjs
```

The commands above assume you are in the repository checkout. From an installed plugin, use the corresponding `runtime/` paths. The status command checks both agent readiness and hook registration. Try a harmless tool call such as listing the current directory after it reports ready.

The guard allows only an SDK `ALLOW` decision with `allow: true`. `HOLD`, `BLOCK`, invalid configuration, and service errors deny the pending call. Enforcement covers tool calls exposed to the host's `PreToolUse` hook.

Register the hook with the installer above. The plugin's bundled `hooks/hooks.json` entry runs a bare `node` and a `$PLUGIN_ROOT` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own.
## What the hook sends

With each tool call the hook sends the tool name, its arguments (secrets redacted by the SDK) and a short context: `source=codex`, the model and the permission mode.

It also reads the end of the local Codex session transcript (the rollout file Codex names in `transcript_path`, at most 2 MiB) to compute one fact. When an instruction addressed to the agent appears in earlier tool output (a web page, file, email or command result), matches this call, and was never typed by the user, the context gains `call_origin=tool_output (the instruction for this call appeared in a tool output, not in the user request)`. That is a sign of prompt injection, and the judge treats the call more carefully. The fact is a fixed sentence, the same one the Claude Code plugin sends. The transcript is read only on your machine: only that fixed sentence leaves it, never any transcript text. Codex's own compaction summary is not counted as the user's words. Because the agent can write to its own rollout file, a call that names that file or Codex's sessions folder, now or earlier in the session, also gains the fact. Without a transcript, or when in doubt, nothing is added. The check is linear and capped, gives up after 1 second, and opens only an absolute, local, regular file.

Only what you typed counts as your words: your messages, your answers to the agent's questions, and your request under a comment on an earlier response. Codex's own context blocks, the agent's question, text quoted from an earlier response, and a task one agent relays to another (sub-agents) do not.

The judge context is recorded on a public chain, so it never includes the working directory or the workspace folder name: a folder name can identify a client, and it is text a cloned repository controls. The model is sent only when it looks like a model id (letters, digits and `. _ : / @ [ ] -`, at most 128 characters) and as `other` otherwise, with any 12-digit AWS account id inside a model ARN sent as `account`; a custom model or gateway name you chose is sent as it is, so do not put client names in it. The permission mode is one of Codex's fixed values.

Tool arguments are a different matter. File paths and commands usually carry the full working directory, including your user name and folder names. Arguments and commands are sent as they are, to the judge and to its model provider, and are recorded on chain in plain text unless your organization enables encryption. Secret redaction is best-effort: it matches known secret patterns and cannot catch everything. Records written by earlier plugin versions, which included `workspace=<folder name>` in the context, stay on chain.

## Build from source

```bash
npm ci
npm run verify                  # typecheck, lint, tests, build, formatting
npm run build:marketplace:dev   # regenerate runtime/ for dev
npm run build:marketplace       # regenerate runtime/ for main
```

`build:marketplace` regenerates the committed universal runtime from the exact npm SDK version of the selected environment and downloads its supported native packages. Commit the regenerated `plugins/atbash/runtime/` whenever source or SDK versions change: a development build on `dev`, a production build on `main`.

How the build picks an environment:

- `plugins/atbash/build-environments.json` is the single source of truth. `prod` uses the stable SDK with no overrides. `dev` uses the development SDK and pins its service endpoint and chains.
- `ATBASH_BUILD_ENV=dev` or `--env dev` selects development; anything unset defaults to `prod`. An unknown name stops the build. The variable is read only at build time; setting it on a user's machine does nothing.
- Only the selected SDK is bundled, so production installs never contain development code or settings.
- The setup helper pairs with the same service the bundled SDK uses, so no extra settings are needed in either environment. Do not set `ATBASH_CONTROL_ORIGIN` for normal use.

### Release: `dev` → `main`

`main` must always carry a production runtime. Merge through a short-lived release branch that rebuilds for production:

```bash
git switch dev && git pull
git switch -c release/<yyyy-mm-dd>
npm ci
npm run build:marketplace        # rebuild runtime/ for production
npm run verify
git add plugins/atbash/runtime
git commit -m "build: production runtime"
git push -u origin release/<yyyy-mm-dd>
```

Open the pull request into `main` only. Never merge the release branch back into `dev`.

If `main` is ever merged into `dev` (for example a hotfix), rebuild with `npm run build:marketplace:dev` on `dev` and commit `runtime/` again.

### Updating SDK versions

```bash
# Production SDK (main)
npm install --save-exact @atbash/sdk@<version> --workspace @atbash/codex-plugin

# Development SDK (dev)
npm install --save-exact --save-dev @atbash/sdk-dev@npm:@atbash/sdk@<dev-version> --workspace @atbash/codex-plugin
```

Then rebuild the runtime for the branch you are on and commit it. Keep the development SDK on the same version the Atbash dashboard's `development` branch uses. The development service endpoint and chain node pools live in `plugins/atbash/build-environments.json`.

### CI checks

- `.github/workflows/ci.yml` (every push and pull request): runs `npm run verify`, rebuilds `runtime/` for the environment recorded in `runtime/manifest.json`, fails if the committed runtime differs, and packages a submission candidate. Pushes to `main` and pull requests into `main` also fail unless the runtime is a production build.
- `.github/workflows/release.yml` (`v*` tags): requires a production runtime, verifies on macOS, Linux, and Windows, and packages the plugin.

`node plugins/atbash/runtime-environment.mjs` prints the environment of the committed runtime; add `--require prod` to fail on anything else.

See [SECURITY.md](SECURITY.md) for security information.
