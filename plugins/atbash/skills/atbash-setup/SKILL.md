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

Run the helper through this skill's `scripts/atbash-control.mjs` launcher:

```text
node <skill-directory>/scripts/atbash-control.mjs setup start --host codex
```

The result contains a public `verificationUri`, verification code, and opaque job ID. Show the URL and code to the user and ask them to complete wallet verification in **Connect Atbash**. Never expose files under `~/.config/atbash/pending`, `credentials`, `profiles`, or `hosts`.

Inspect progress with `setup inspect <job-id>` through the same launcher. Follow `nextAction`:

- `OPEN_BROWSER`: the user completes sign-in and wallet verification in the provided page.
- `PREPARE_PLAN`: use discovery to determine what exists. Ask for any missing names or choices, create the non-secret plan JSON file containing only `actions` yourself, then run `setup plan <job-id> --input <path>`. Do not ask the user to write JSON or run the command.
- `REVIEW_IN_BROWSER`: the user reviews and signs the exact proposal in Connect Atbash. Do not approve it for them.
- `WAIT`: inspect again after the returned poll interval, or after two seconds if none is present. Keep the user informed during longer waits; stop on expiry or a terminal failure.
- `ACTIVATE`: run `setup continue <job-id>` to decrypt the delivered key locally and activate the profile.
- `RECOVER`: report completed and failed steps. Any replacement mutation requires a new management session and approval.
- `DONE`: run `node <skill-directory>/../../runtime/status.cjs`, then verify one harmless host tool call after the user enables and trusts the hook.

For a new public setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, purposes, risks, or agent names.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher. Show the returned loopback `localUri` to the user. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Profiles and legacy compatibility

List profiles with `profile list --host codex`, select one with `profile switch --host codex --profile <id>`, or disconnect the host mapping with `profile disconnect --host codex`. Disconnecting retains the credential; it does not delete or revoke the on-chain agent.

If there is no selected profile, the hook keeps the legacy SDK configuration behavior. If `ATBASH_AGENT_KEY` or `ATBASH_ORG_NAME` conflicts with a selected profile, report the conflict and ask the user to remove or correct the override locally. Never inspect the conflicting key.

The hook remains fail closed throughout setup. If an already-trusted unconfigured hook blocks the helper, explain the actual block and the minimum user action needed to unblock setup; do not disable or bypass the hook yourself. Offer running the launcher outside the guarded task only when this block has actually occurred, then resume the job yourself.

If the API fails, report the failing step and the returned error. A backend error is not a reason to hand the same command to the user or ask them to supply backend credentials. Do not repeatedly create sessions or claim that a manual command will fix a server failure.
