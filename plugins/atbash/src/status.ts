#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getAtbashStatus } from "./atbash/status.js";
import { HOOK_SCRIPT } from "./install-hook/hooks-file.js";
import { inspectRegistration } from "./install-hook/registration.js";

// The user-level registration written by install-hook.cjs is checked alongside the agent status:
// a pinned interpreter or hook script that no longer exists is a hook the host cannot spawn.
// Written to stderr so stdout stays the status JSON.
function reportRegistration(): void {
  const script = process.argv[1];
  if (script === undefined) return;
  const codexHome = process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
  const hookScript = join(dirname(realpathSync(script)), HOOK_SCRIPT);
  const report = inspectRegistration(resolve(codexHome, "hooks.json"), {
    hookScript: realpathSync(hookScript),
    platform: process.platform,
  });
  for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const note of report.notes) process.stderr.write(`note: ${note}\n`);
}

async function main(): Promise<void> {
  try {
    reportRegistration();
  } catch {
    process.stderr.write("warning: the user-level hook registration could not be inspected.\n");
  }
  const status = await getAtbashStatus();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = status.ready ? 0 : 1;
}

void main();
