#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getAtbashStatus } from "./atbash/status.js";
import { HOOK_SCRIPT } from "./install-hook/hooks-file.js";
import {
  inspectRegistration,
  summarizeRegistrations,
  type RegistrationSummary,
} from "./install-hook/registration.js";

// The registrations written by install-hook.cjs (user scope in the Codex home, project scope in
// the current directory) are checked alongside the agent status: a pinned interpreter or hook
// script that no longer exists is a hook the host cannot spawn, and no entry at all means nothing
// enforces Atbash on Codex 0.154+. The summary is part of the JSON and of the exit code, so a
// wrapper that reads either cannot take "agent ready" for "gate in place"; the details also go to
// stderr for a human.
function reportRegistration(): RegistrationSummary | undefined {
  const script = process.argv[1];
  if (script === undefined) return undefined;
  const codexHome = process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
  const identity = {
    hookScript: realpathSync(join(dirname(realpathSync(script)), HOOK_SCRIPT)),
    platform: process.platform,
  };
  const summary = summarizeRegistrations([
    inspectRegistration(resolve(codexHome, "hooks.json"), identity),
    inspectRegistration(resolve(process.cwd(), ".codex", "hooks.json"), identity),
  ]);
  for (const warning of summary.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const note of summary.notes) process.stderr.write(`note: ${note}\n`);
  return summary;
}

async function main(): Promise<void> {
  let registration: RegistrationSummary | undefined;
  try {
    registration = reportRegistration();
  } catch {
    process.stderr.write("warning: the hook registration could not be inspected.\n");
  }
  const status = await getAtbashStatus();
  const hookRegistration =
    registration === undefined
      ? { inspected: false as const, enforcing: false as const }
      : { inspected: true as const, ...registration };
  process.stdout.write(`${JSON.stringify({ ...status, hookRegistration }, null, 2)}\n`);
  // Exit 0 only when the agent is ready AND a hook is registered somewhere the host reads AND no
  // registered entry is a dead or narrowed one: a healthy user-level entry does not vouch for a
  // project-level entry the host may prefer, and the warning above names which one to fix.
  process.exitCode =
    status.ready && hookRegistration.enforcing && (hookRegistration.degraded ?? 0) === 0 ? 0 : 1;
}

void main();
