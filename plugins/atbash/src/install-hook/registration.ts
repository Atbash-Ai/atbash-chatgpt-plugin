/**
 * What the status command reports about a user-level registration: the interpreter is pinned to
 * the node that ran the installer and the script to the plugin's location, and neither is
 * re-validated at hook time. If either disappears (an nvm uninstall, a node upgrade that moves
 * the path, a plugin moved or deleted) the host cannot spawn the hook and proceeds, so the two
 * paths are checked here, on demand, and a missing one is a warning worth acting on.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  HooksFileRefusal,
  buildAtbashEntry,
  isAtbashHook,
  isAtbashLookalike,
  parseHookCommand,
  platformCommand,
  parseHooksFile,
  type AtbashIdentity,
} from "./hooks-file.js";

export interface RegistrationReport {
  hooksPath: string;
  /** Own entries found (commands naming this plugin's hook script). */
  registered: number;
  /** Own entries the host can actually spawn: an absolute interpreter that exists and a script
   *  that exists. An own entry whose pinned node is gone is registered but enforces nothing. */
  spawnable: number;
  /** Warnings: a missing interpreter or script on an own or look-alike entry, or an unreadable file. */
  warnings: string[];
  /** Notes: no user-level entry for this plugin's runtime. */
  notes: string[];
}

export function inspectRegistration(
  hooksPath: string,
  identity: AtbashIdentity,
): RegistrationReport {
  const report: RegistrationReport = {
    hooksPath,
    registered: 0,
    spawnable: 0,
    warnings: [],
    notes: [],
  };
  if (!existsSync(hooksPath)) {
    report.notes.push(
      `no hooks file at ${hooksPath}; on Codex 0.154+ nothing enforces Atbash until install-hook.cjs has been run.`,
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
      const spelled = platformCommand(hook, identity.platform);
      const parsed = parseHookCommand(spelled);
      if (parsed === undefined) {
        // The command text comes from a file the user (or, at project scope, a checked-out
        // repository) controls: it is reported, but bounded.
        report.warnings.push(
          `${label} has a command this plugin cannot parse: ${String(spelled).slice(0, 200)}`,
        );
        continue;
      }
      let spawnable = own;
      if (parsed.interpreter === undefined || !isAbsolute(parsed.interpreter)) {
        spawnable = false;
        report.warnings.push(
          `${label} runs a bare "node" resolved from PATH at hook time; re-run install-hook.cjs to pin the interpreter.`,
        );
      } else if (!existsSync(parsed.interpreter)) {
        spawnable = false;
        report.warnings.push(
          `${label} names an interpreter that no longer exists (${parsed.interpreter}); the host cannot spawn it. Re-run install-hook.cjs with the node you use now.`,
        );
      }
      if (!existsSync(parsed.script)) {
        spawnable = false;
        report.warnings.push(
          `${label} names a hook script that no longer exists (${parsed.script}); re-run install-hook.cjs from the plugin's current location.`,
        );
      }
      if (spawnable) {
        let supported = false;
        try {
          const expected = buildAtbashEntry(parsed.script, identity.platform, parsed.interpreter!)
            .hooks[0];
          supported =
            group.matcher === "*" &&
            hook.type === "command" &&
            (hook.async === undefined || hook.async === false) &&
            hook.timeout === expected?.timeout &&
            statSync(parsed.script).isFile() &&
            statSync(parsed.interpreter!).isFile() &&
            realpathSync(parsed.interpreter!) === realpathSync(process.execPath) &&
            (identity.platform !== "win32" || /\.exe$/i.test(parsed.interpreter!)) &&
            (spelled === expected?.command || spelled === expected?.commandWindows);
        } catch {
          // Unsupported shell syntax cannot establish an applicable registration.
        }
        if (!supported) {
          spawnable = false;
          report.warnings.push(
            `${label} is not a supported synchronous command covering all tools; re-run install-hook.cjs.`,
          );
        }
      }
      if (spawnable) report.spawnable += 1;
    }
  }
  if (report.registered === 0) {
    report.notes.push(
      `${hooksPath} has no PreToolUse entry for this plugin's hook script; on Codex 0.154+ nothing enforces Atbash until install-hook.cjs has been run.`,
    );
  }
  return report;
}

export interface RegistrationScope {
  hooksPath: string;
  registered: number;
  spawnable: number;
}

export interface RegistrationSummary {
  /** Each inspected hooks file with what it holds, so a reader can tell a machine-wide user-level
   *  entry from a project-level one that covers only the directory Codex is started in. */
  scopes: RegistrationScope[];
  /** Atbash entries found across every inspected hooks file. */
  registered: number;
  /** Of those, the entries whose interpreter and script exist, so the host can spawn them. */
  spawnable: number;
  /** True only when at least one Atbash entry exists AND the host can spawn it: with none,
   *  nothing enforces Atbash on Codex 0.154+, whatever the agent status says - and a registered
   *  entry whose pinned node is gone is exactly a hook the host cannot run. */
  enforcing: boolean;
  warnings: string[];
  notes: string[];
}

/** One answer over the user-level and project-level files: a status that says "ready" while no
 *  hook is registered would be a permissive answer about whether the gate exists at all. */
export function summarizeRegistrations(
  reports: readonly RegistrationReport[],
): RegistrationSummary {
  const registered = reports.reduce((sum, report) => sum + report.registered, 0);
  const spawnable = reports.reduce((sum, report) => sum + report.spawnable, 0);
  return {
    scopes: reports.map((report) => ({
      hooksPath: report.hooksPath,
      registered: report.registered,
      spawnable: report.spawnable,
    })),
    registered,
    spawnable,
    enforcing: spawnable > 0,
    warnings: reports.flatMap((report) => report.warnings),
    // A scope with no entry is worth a note only when no scope has one: an absent project file
    // next to a healthy user-level registration is the normal state, not a finding.
    notes: registered > 0 ? [] : reports.flatMap((report) => report.notes),
  };
}
