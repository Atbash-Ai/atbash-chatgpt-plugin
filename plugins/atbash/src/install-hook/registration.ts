/**
 * What the status command reports about a user-level registration: the interpreter is pinned to
 * the node that ran the installer and the script to the plugin's location, and neither is
 * re-validated at hook time. If either disappears (an nvm uninstall, a node upgrade that moves
 * the path, a plugin moved or deleted) the host cannot spawn the hook and proceeds, so the two
 * paths are checked here, on demand, and a missing one is a warning worth acting on.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  HooksFileRefusal,
  isAtbashHook,
  isAtbashLookalike,
  parseHookCommand,
  parseHooksFile,
  type AtbashIdentity,
} from "./hooks-file.js";

export interface RegistrationReport {
  hooksPath: string;
  /** Own entries found (commands naming this plugin's hook script). */
  registered: number;
  /** Warnings: a missing interpreter or script on an own or look-alike entry, or an unreadable file. */
  warnings: string[];
  /** Notes: no user-level entry for this plugin's runtime. */
  notes: string[];
}

export function inspectRegistration(
  hooksPath: string,
  identity: AtbashIdentity,
): RegistrationReport {
  const report: RegistrationReport = { hooksPath, registered: 0, warnings: [], notes: [] };
  if (!existsSync(hooksPath)) {
    report.notes.push(
      `no user-level hooks file at ${hooksPath}; on Codex 0.154+ nothing enforces Atbash until install-hook.cjs has been run.`,
    );
    return report;
  }
  let document;
  try {
    document = parseHooksFile(readFileSync(hooksPath, "utf8"), hooksPath);
  } catch (error) {
    const detail = error instanceof HooksFileRefusal ? error.message : String(error);
    report.warnings.push(`the hooks file could not be read: ${detail}`);
    return report;
  }
  for (const group of document.hooks?.PreToolUse ?? []) {
    for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
      const own = isAtbashHook(hook, identity);
      if (!own && !isAtbashLookalike(hook, identity)) continue;
      if (own) report.registered += 1;
      const label = own ? "the registered Atbash hook" : "a hook that looks like Atbash's";
      const command = hook as { command?: unknown; commandWindows?: unknown };
      const spelled =
        identity.platform === "win32"
          ? (command.commandWindows ?? command.command)
          : command.command;
      const parsed = parseHookCommand(spelled);
      if (parsed === undefined) {
        report.warnings.push(`${label} has a command this plugin cannot parse: ${String(spelled)}`);
        continue;
      }
      if (parsed.interpreter === undefined || !isAbsolute(parsed.interpreter)) {
        report.warnings.push(
          `${label} runs a bare "node" resolved from PATH at hook time; re-run install-hook.cjs to pin the interpreter.`,
        );
      } else if (!existsSync(parsed.interpreter)) {
        report.warnings.push(
          `${label} names an interpreter that no longer exists (${parsed.interpreter}); the host cannot spawn it. Re-run install-hook.cjs with the node you use now.`,
        );
      }
      if (!existsSync(parsed.script)) {
        report.warnings.push(
          `${label} names a hook script that no longer exists (${parsed.script}); re-run install-hook.cjs from the plugin's current location.`,
        );
      }
    }
  }
  if (report.registered === 0) {
    report.notes.push(
      `${hooksPath} has no PreToolUse entry for this plugin's hook script; on Codex 0.154+ nothing enforces Atbash until install-hook.cjs has been run.`,
    );
  }
  return report;
}
