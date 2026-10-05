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

Run the helper through this skill's `scripts/atbash-control.mjs` launcher, using the absolute skill directory:

```text
node "<skill-directory>/scripts/atbash-control.mjs" setup start --host codex
```

Until setup activates a profile, the hook allows only these setup steps and denies everything else with "Atbash is not set up yet". Run each helper command as one plain command in exactly this form: no `cd`, `&&`, `;`, pipes, redirection, environment-variable prefixes, or command substitution, and no `--service` option. Commands in any other form are denied.

The result contains a public `verificationUri`, verification code, opaque job ID, and `planPath`. Show the URL and code to the user and ask them to complete wallet verification in **Connect Atbash**, then come back to the conversation. Never expose files under `~/.config/atbash/pending`, `credentials`, `profiles`, or `hosts`.

Inspect progress with `setup inspect <job-id>` through the same launcher. Follow `nextAction`:

- `OPEN_BROWSER`: the user completes sign-in and wallet verification in the provided page.
- `PREPARE_PLAN`: use discovery to determine what exists. Ask for any missing names or choices, then build a non-secret plan JSON containing only `actions` yourself and pass it to the launcher inline, as one single-quoted argument: `setup plan <job-id> --json '{"actions":[...]}'`. Do not write it to a file first — writing a file means running a shell command, which setup mode does not allow. Do not ask the user to write JSON or run the command.
- `REVIEW_IN_BROWSER`: the user reviews and signs the exact proposal in Connect Atbash. Do not approve it for them.
- `WAIT`: inspect again after the returned poll interval, or after two seconds if none is present. Keep the user informed during longer waits; stop on expiry or a terminal failure.
- `ACTIVATE`: run `setup continue <job-id>` to decrypt the delivered key locally and activate the profile.
- `RECOVER`: report completed and failed steps. Any replacement mutation requires a new management session and approval.
- `DONE`: `setup continue` already reports the new agent's `agentStatus`. Report setup as finished only when `nextAction` is `DONE` and `agentStatus.state` is `ready`. A session `status` of `completed` alone does not mean the profile is active. Do not run another command to check status: from this point every tool call is judged under the new agent's policy, and a blocked call can jail the agent. To confirm enforcement, make one harmless call that fits the agent's stated purpose.

For a new public setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, purposes, risks, or agent names.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher. Show the returned loopback `localUri` to the user. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Profiles and legacy compatibility

List profiles with `profile list --host codex`, select one with `profile switch --host codex --profile <id>`, or disconnect the host mapping with `profile disconnect --host codex`. Disconnecting retains the credential; it does not delete or revoke the on-chain agent.

If there is no selected profile, the hook keeps the legacy SDK configuration behavior. If `ATBASH_AGENT_KEY` or `ATBASH_ORG_NAME` conflicts with a selected profile, report the conflict and ask the user to remove or correct the override locally. Never inspect the conflicting key.

Setup runs with the hook trusted; do not ask the user to disable the plugin, which also removes this skill. While no configuration exists at all, the hook allows the setup steps above and denies everything else.

If the hook denies a setup step because a configuration already exists (invalid, jailed, or not registered), setup mode does not apply — report the exact denial and tell the user they can disconnect the current profile from their own terminal with `node "<skill-directory>/scripts/atbash-control.mjs" profile disconnect --host codex`, then start setup again. Do not describe this as bypassing an individual verdict.

If the API fails, report the failing step and the returned error. A backend error is not a reason to hand the same command to the user or ask them to supply backend credentials. Do not repeatedly create sessions or claim that a manual command will fix a server failure.
