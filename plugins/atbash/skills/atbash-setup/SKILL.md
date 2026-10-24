---
name: atbash-setup
description: Set up, connect, verify, troubleshoot, or switch the Atbash Safety profile for Codex. Use when the user wants to sign up for Atbash, connect an existing Atbash agent, create a new agent, check setup progress, or repair local plugin configuration.
---

# Atbash Setup

Use the bundled control helper for onboarding. Keep private keys outside the conversation and outside tool arguments.

## Carry out setup

Treat a request to sign up, set up, or connect Atbash as a request to perform the workflow. Run the bundled commands yourself with the available execution tool; command examples below are for you to execute, not instructions to hand back to the user. Resolve `<skill-directory>` to the directory containing this SKILL.md, and use that installed copy's launcher throughout the job.

Handle session creation, progress checks, discovery, plan-file creation and submission, and local activation yourself. Ask only for missing user choices and actions requiring the user's identity or consent: wallet sign-in, review and signature of the exact proposal, local entry of an existing agent key, and enabling or trusting the host hook. Do not send the user to manually create an account, organization, or agent when the control API supports that step.

After a user completes verification or approval, inspect the same job and perform the next available step. Keep the job ID in the conversation so setup can resume without asking the user to run commands. Do not claim completion until the helper and status checks confirm it.

## Start or resume setup

The helper needs network access to reach Atbash and write access to the Atbash configuration directory: the absolute path of `~/.config/atbash`, or `$ATBASH_CONFIG_DIR` when it is set. How to get that access depends on the tools this session has:

- If a `request_permissions` tool is available, request both in one call before the first helper command, with `network.enabled` set to `true` and that directory as the only `file_system.write` path, and ask the user to allow it for the session. If they allow it only for this turn, make the same request again at the start of each later turn, before the first helper command.
- Otherwise, run the helper command as usual. If the sandbox blocks it, run the same command again with `sandbox_permissions` set to `"with_additional_permissions"` and `additional_permissions` holding the same network and directory access, when the shell tool offers that option; if it does not, set `sandbox_permissions` to `"require_escalated"`. Give a one-sentence `justification` saying the Atbash setup helper needs to reach Atbash and save its configuration, so the user can approve it.

Do not stop setup because `request_permissions` is not available. A helper error that says Atbash "could not be reached" or "could not write" means this access is missing, not that the service is down: get the access as above, then run the same command again once.

Run the helper through this skill's `scripts/atbash-control.mjs` launcher, using the absolute skill directory:

```text
node "<skill-directory>/scripts/atbash-control.mjs" setup start --host codex
```

Until setup activates a profile, the hook allows only these setup steps, the access request above, and questions to the user, and denies everything else with "Atbash is not set up yet". Run each helper command as one plain command in exactly this form: no `cd`, `&&`, `;`, pipes, redirection, environment-variable prefixes, or command substitution, and no `--service` option. Commands in any other form are denied.

The result contains a public `verificationUri`, verification code, opaque job ID, and `planPath`. Show the URL and code to the user and ask them to complete wallet verification in **Connect Atbash**, then come back to the conversation. Never expose files under `~/.config/atbash/pending`, `credentials`, `profiles`, or `hosts`.

Inspect progress with `setup inspect <job-id>` through the same launcher. Follow `nextAction`:

- `OPEN_BROWSER`: the user completes sign-in and wallet verification in the provided page.
- `PREPARE_PLAN`: use discovery to determine what exists. Ask for any missing names or choices, then build a non-secret plan JSON containing only `actions` yourself and pass it to the launcher inline, as one single-quoted argument: `setup plan <job-id> --json '{"actions":[...]}'`. Do not write it to a file first — writing a file means running a shell command, which setup mode does not allow. Do not ask the user to write JSON or run the command.
- If the organization has no active subscription, run `setup checkout <job-id> --organization <name>`. Show the returned `checkoutUrl` and ask the user to choose a plan in the dashboard's existing checkout flow. Resume inspection after the dashboard returns to `returnUrl`; never select paid plans or handle payment details yourself.
- `REVIEW_IN_BROWSER`: the user reviews and signs the exact proposal in Connect Atbash. Do not approve it for them.
- `WAIT`: inspect again after the returned poll interval, or after two seconds if none is present. Keep the user informed during longer waits; stop on expiry or a terminal failure.
- `ACTIVATE`: run `setup continue <job-id>` to decrypt the delivered key locally and activate the profile.
- `RECOVER`: report completed and failed steps. Any replacement mutation requires a new management session and approval.
- `DONE`: `setup continue` already reports the new agent's `agentStatus`. Report setup as finished only when `nextAction` is `DONE` and `agentStatus.state` is `ready`. A session `status` of `completed` alone does not mean the profile is active. Do not run another command to check status: from this point every tool call is judged under the new agent's policy, and a blocked call can jail the agent. To confirm enforcement, make one harmless call that fits the agent's stated purpose.

Registering the hook is the user's step. If their `/hooks` list does not show the Atbash `PreToolUse` hook, ask them to run `node <skill-directory>/../../runtime/install-hook.cjs` from their own terminal, restart Codex, and trust the hook. Do not run the installer yourself: where the plugin's own hook already runs it registers a second copy, and once setup activates a profile it is judged like any other action. The plugin's bundled `hooks/hooks.json` entry runs a bare `node` and a `PLUGIN_ROOT` placeholder: it depends on `node` being on the host's PATH and on `PLUGIN_ROOT` being exported by the host, so it is not a gate on its own.

For a new setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, organization descriptions, purposes, risks, or agent names; ask for any that are missing before building the plan.

### Plan format

A plan is `{"actions": [...]}` with the actions in the order below. There are no other top-level fields. Every action carries its own `"network"` (`"public"` or `"private"`), and all actions in one plan use the same network. Use a network listed in discovery's `availableNetworks`, which names the networks this Atbash deployment serves: when it lists only one, use it without asking; when it is absent, ask the user. Use exactly these fields:

| Action                | Include when                               | Fields                                                                                                                                                                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_account`      | discovery shows no account on that network | `type`, `network`                                                                                                                                                                        |
| `create_organization` | the organization does not exist yet        | `type`, `network`, `name` (2–64 letters, digits, `.`, `_`, or `-`), `description` (1–280 characters)                                                                                     |
| `activate_free_plan`  | the organization has no subscription       | `type`, `network`, `organization` (the organization's name)                                                                                                                              |
| `create_agent`        | always, for a new agent                    | `type`, `network`, `organization`, `name` (up to 80 characters), `purpose` (up to 280), `risk` (`low`, `medium`, `high`, or `critical`), `keySource` (`"generate_in_browser"`), `policy` |

For example, a new user on a deployment that serves only the private network:

```json
{
  "actions": [
    { "type": "create_account", "network": "private" },
    {
      "type": "create_organization",
      "network": "private",
      "name": "acme_ai",
      "description": "Acme agents"
    },
    { "type": "activate_free_plan", "network": "private", "organization": "acme_ai" },
    {
      "type": "create_agent",
      "network": "private",
      "organization": "acme_ai",
      "name": "codex dev",
      "purpose": "Coding assistant for the Acme repository",
      "risk": "medium",
      "keySource": "generate_in_browser",
      "policy": { "preset": "developer", "version": 1 }
    }
  ]
}
```

Activate the Free plan on the same network as the rest of the plan. If the dashboard answers that the Free plan is available only on the public network, that deployment keeps Free on public: a private organization there needs a paid plan first, so offer `setup checkout` for an existing organization or suggest the public network. Because the plan is passed in single quotes, write any single quote inside a value as `\u0027` (for example `"Nati\u0027s agent"`). If the helper rejects the plan, its error names the action number and the field to fix; correct that field and submit the whole plan again.

Give every new agent a starting policy by adding `"policy": { "preset": "<preset>", "version": 1 }` to its `create_agent` action. Choose the preset from the agent's purpose: `developer` for coding work (the usual choice for Codex), `devops` for infrastructure, deployment, or operations work, and `full_baseline` when the user asks for the strictest protection. Tell the user which preset you suggested and that they can switch it or customize individual rules on the Connect Atbash review page before approving; the policy they approve is created as the organization policy "<agent name> Policy" and can be fine-tuned later under Policies in the dashboard. If the user wants a different preset before review, resubmit the plan with it.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher. Show the returned loopback `localUri` to the user. If the user abandons the connection, or the local page expires before a key is entered, cancel the job as described under **Cancel setup**. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Cancel setup

`setup cancel <job-id>`, run through the same launcher, ends a setup job: it cancels the session in Connect Atbash, so its link stops working, and deletes the job's local files, including its session secret. Setup mode allows it, and it needs the same network and configuration-directory access as the other helper commands.

- Run it when the user asks to stop, cancel, or start over, or abandons setup, while `nextAction` is `OPEN_BROWSER`, `PREPARE_PLAN`, or `REVIEW_IN_BROWSER`. Tell the user setup was cancelled. To start over, run `setup start` for a new job.
- Run it at `RECOVER` when the session was cancelled, rejected, or expired, and for an expired job you will not resume, so its secrets do not stay on disk. If the helper reports that the session had already ended on Atbash, the cleanup still succeeded.
- Do not cancel after the user approved the proposal: approved steps run in the browser and cancelling does not undo them. Let the job finish and report what was created. At `ACTIVATE` the new agent's key is waiting to be activated and the helper refuses to cancel; run `setup continue <job-id>` instead.

## Profiles and legacy compatibility

List profiles with `profile list --host codex`, select one with `profile switch --host codex --profile <id>`, or disconnect the host mapping with `profile disconnect --host codex`. Disconnecting retains the credential; it does not delete or revoke the on-chain agent.

If there is no selected profile, the hook keeps the legacy SDK configuration behavior. If `ATBASH_AGENT_KEY` or `ATBASH_ORG_NAME` conflicts with a selected profile, report the conflict and ask the user to remove or correct the override locally. Never inspect the conflicting key.

Setup runs with the hook trusted; do not ask the user to disable the plugin, which also removes this skill. While no configuration exists at all, the hook allows the setup steps above and denies everything else.

If the hook denies a setup step because a configuration already exists (invalid, jailed, or not registered), setup mode does not apply — report the exact denial and tell the user they can disconnect the current profile from their own terminal with `node "<skill-directory>/scripts/atbash-control.mjs" profile disconnect --host codex`, then start setup again. Do not describe this as bypassing an individual verdict.

If the API fails, report the failing step and the returned error. A backend error is not a reason to hand the same command to the user or ask them to supply backend credentials. Do not repeatedly create sessions or claim that a manual command will fix a server failure.
