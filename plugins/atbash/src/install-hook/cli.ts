import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  HooksFileRefusal,
  buildAtbashEntry,
  directoryWritableByOthers,
  fileIdentity,
  foreignContent,
  hasAtbashEntry,
  mergeAtbashEntry,
  parseHooksFile,
  probeRegisteredCommand,
  removeAtbashEntry,
  resolveHookScript,
  resolveInterpreter,
  resolveWriteTarget,
  serializeHooksFile,
  verifyEntryRoundTrip,
  writeHooksFileAtomically,
  type AtbashIdentity,
  type AtbashMatcherGroup,
  type HooksDocument,
} from "./hooks-file.js";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export type Scope = "user" | "project";

export interface InstallHookOptions {
  scope: Scope;
  dir?: string;
  dryRun: boolean;
  uninstall: boolean;
  help: boolean;
}

export type ParsedArgs = { ok: true; options: InstallHookOptions } | { ok: false; message: string };

export const USAGE = `Usage: node install-hook.cjs [--dry-run] [--uninstall] [--scope user|project] [--dir <path>]

Registers the Atbash PreToolUse hook in a Codex hooks file, because Codex 0.154+ does not run
hooks shipped inside a plugin. Nothing is written until the file is validated.

  --scope user      (default) write <codex home>/hooks.json; codex home is --dir, else
                    $CODEX_HOME, else ~/.codex
  --scope project   write <project>/.codex/hooks.json; the project is --dir, else the current
                    directory
  --dir <path>      the Codex home (user scope) or project directory (project scope)
  --dry-run         print the Atbash entry that would be written and write nothing
  --uninstall       remove only the Atbash entry
  -h, --help        show this help

Exit codes: 0 done (or nothing to do), 1 refused or failed (the file was left as it was), 2 usage.
`;

const OPTIONS_WITH_VALUE = new Set(["--scope", "--dir"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: InstallHookOptions = {
    scope: "user",
    dryRun: false,
    uninstall: false,
    help: false,
  };
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--uninstall") {
      options.uninstall = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!OPTIONS_WITH_VALUE.has(name)) {
      return { ok: false, message: `Unknown argument: ${argument}` };
    }
    let value: string | undefined;
    if (separator !== -1) {
      value = argument.slice(separator + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || value.startsWith("-")) {
      return { ok: false, message: `${name} needs a value.` };
    }
    if (values.has(name)) {
      return { ok: false, message: `${name} was given more than once.` };
    }
    values.set(name, value);
  }

  const scope = values.get("--scope");
  if (scope !== undefined) {
    if (scope !== "user" && scope !== "project") {
      return {
        ok: false,
        message: `--scope must be "user" or "project", not ${JSON.stringify(scope)}.`,
      };
    }
    options.scope = scope;
  }
  const dir = values.get("--dir");
  if (dir !== undefined) options.dir = dir;
  return { ok: true, options };
}

export interface PathContext {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** Where the hooks file lives for the chosen scope. Never reads the file system. */
export function resolveHooksPath(
  scope: Scope,
  dir: string | undefined,
  { cwd, env, home }: PathContext,
): string {
  if (scope === "project") {
    return resolve(cwd, dir ?? cwd, ".codex", "hooks.json");
  }
  const codexHome = env.CODEX_HOME;
  const base =
    dir !== undefined
      ? resolve(cwd, dir)
      : codexHome !== undefined && codexHome.trim() !== ""
        ? resolve(cwd, codexHome)
        : resolve(home, ".codex");
  return resolve(base, "hooks.json");
}

export type InstallAction = "installed" | "updated" | "unchanged" | "removed" | "not-installed";

export interface InstallResult {
  action: InstallAction;
  /** The path the user asked for. */
  hooksPath: string;
  /** The file actually replaced: the real file behind a symlinked hooksPath. */
  target: string;
  hookScript: string;
  /** The absolute node that the registered command runs: the node that ran the installer. */
  interpreter: string;
  /** The Atbash entry that was (or would be) written; absent for --uninstall. */
  entry?: AtbashMatcherGroup;
  /** The full resulting file. Never printed; tests and callers may inspect it. */
  text: string;
  written: boolean;
  /** What the file keeps that is not Atbash's. */
  kept: { foreignHooks: number; otherEvents: number };
  /** Facts the user should know; printed on stderr, never fatal. */
  notes: string[];
  warnings: string[];
}

export interface InstallContext extends PathContext {
  /** The directory holding pre-tool-use.cjs: the installer's own directory in the shipped runtime. */
  runtimeDir: string;
  platform: NodeJS.Platform;
  /** The node running the installer (process.execPath): it becomes the hook's interpreter. */
  nodePath: string;
  /** Test seam: runs between the temp-file write and the compare-and-swap. Never set by the CLI. */
  beforeSwap?: () => void;
}

/** The whole operation, minus printing. Throws HooksFileRefusal for a file that cannot be handled
 *  and lets file-system errors propagate; in both cases nothing has been written. */
export function installHook(options: InstallHookOptions, context: InstallContext): InstallResult {
  const hookScript = resolveHookScript(context.runtimeDir, context.platform);
  const interpreter = resolveInterpreter(context.nodePath, context.platform);
  const identity: AtbashIdentity = { hookScript, platform: context.platform };
  const hooksPath = resolveHooksPath(options.scope, options.dir, context);
  const target = resolveWriteTarget(hooksPath);
  const existingText = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  const existingIdentity = existingText === undefined ? undefined : fileIdentity(target);
  const existing: HooksDocument =
    existingText === undefined ? {} : parseHooksFile(existingText, hooksPath);
  const present = hasAtbashEntry(existing, identity);
  const foreign = foreignContent(existing, identity);
  const kept = {
    foreignHooks: foreign.foreignHooks.length,
    otherEvents: foreign.otherEvents.length,
  };
  const notes = foreign.lookalikes.map(
    () =>
      `${hooksPath} has a PreToolUse hook that looks like Atbash's (the Atbash status message, or a script called pre-tool-use.cjs) but does not run this plugin's hook script; it is not provably Atbash's and was left alone. If it is a stale entry from a plugin that moved, remove it by hand.`,
  );
  const warnings = directoryWritableByOthers(dirname(target), context.platform)
    ? [
        `${dirname(target)} is writable by other users; anyone who can write there can replace this hook. Consider chmod 700.`,
      ]
    : [];
  const base = { hooksPath, target, hookScript, interpreter, kept, notes, warnings };

  let next: HooksDocument;
  let action: InstallAction;
  let entry: AtbashMatcherGroup | undefined;
  if (options.uninstall) {
    if (!present) {
      return { ...base, action: "not-installed", text: existingText ?? "", written: false };
    }
    next = removeAtbashEntry(existing, identity);
    action = "removed";
  } else {
    entry = buildAtbashEntry(hookScript, context.platform, interpreter);
    verifyEntryRoundTrip(entry, hookScript, interpreter, context.platform);
    // The string parses back; now prove the host shell can run it and that it answers.
    probeRegisteredCommand(entry, context.platform);
    next = mergeAtbashEntry(existing, entry, identity);
    action = present ? "updated" : "installed";
  }

  const text = serializeHooksFile(next);
  const result = { ...base, ...(entry === undefined ? {} : { entry }), text };
  if (text === existingText) {
    return { ...result, action: "unchanged", written: false };
  }
  if (options.dryRun) {
    return { ...result, action, written: false };
  }
  writeHooksFileAtomically(target, text, {
    platform: context.platform,
    expectedExisting: existingText,
    expectedIdentity: existingIdentity,
    ...(context.beforeSwap === undefined ? {} : { beforeSwap: context.beforeSwap }),
  });
  return { ...result, action, written: true };
}

const REMAINING_STEPS = `Codex 0.154+ does not run hooks shipped inside a plugin (\`codex features list\` reports
\`plugin_hooks: removed\`), so this hooks file is what enforces Atbash. Two steps remain, and
both are yours:
  1. Restart Codex so it reads the hooks file.
  2. In Codex, run /hooks and trust the Atbash PreToolUse hook. Codex does not run an
     untrusted hook.
Configure ~/.config/atbash/config.json first if you have not (ask $atbash-setup); with no
configuration the hook denies every tool call.
`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The human summary. Only the Atbash entry is ever printed: a foreign hook's command line is
 *  the user's business (it may carry a token), so the rest of the file is counted, not shown. */
export function describeResult(result: InstallResult, options: InstallHookOptions): string {
  const lines: string[] = [];
  const where = `${result.hooksPath} (${options.scope} scope)`;
  const keptSummary = `${plural(result.kept.foreignHooks, "foreign PreToolUse hook")} and ${plural(result.kept.otherEvents, "other event")} kept.`;
  const wouldChange = result.action !== "unchanged" && result.action !== "not-installed";
  if (options.dryRun && wouldChange) {
    lines.push(`Dry run: nothing was written.`);
    if (result.entry !== undefined) {
      lines.push(`${where} would gain this PreToolUse entry:`);
      lines.push("");
      lines.push(JSON.stringify(result.entry, null, 2));
      lines.push("");
    }
  }
  switch (result.action) {
    case "installed":
      lines.push(
        `${options.dryRun ? "Would install" : "Installed"} the Atbash hook in ${where}. ${keptSummary}`,
      );
      break;
    case "updated":
      lines.push(
        `${options.dryRun ? "Would replace" : "Replaced"} the existing Atbash hook in ${where}. ${keptSummary}`,
      );
      break;
    case "unchanged":
      lines.push(
        `The Atbash hook is already ${options.uninstall ? "absent from" : "installed in"} ${where}; nothing to change.`,
      );
      break;
    case "removed":
      lines.push(
        `${options.dryRun ? "Would remove" : "Removed"} the Atbash hook from ${where}. ${keptSummary}`,
      );
      break;
    case "not-installed":
      lines.push(`No Atbash hook in ${where}; nothing to remove.`);
      break;
  }
  if (result.target !== result.hooksPath) {
    lines.push(
      `  (${result.hooksPath} is a link; the file behind it, ${result.target}, is the one updated)`,
    );
  }
  if (!options.uninstall) {
    // Printed only after installHook verified the command resolves back to the hook script.
    lines.push(`  hook command: ${result.entry?.hooks[0]?.command ?? ""}`);
    lines.push(
      `  interpreter:  ${result.interpreter} (the node that ran this installer; the hook does not depend on PATH)`,
    );
    lines.push(
      `  verified:     ${result.entry === undefined || !result.entry.hooks[0]?.command.startsWith("&") ? "sh" : "Windows PowerShell"} ran this exact command with no PATH and no configuration, and it answered with a deny`,
    );
    lines.push("");
    lines.push(REMAINING_STEPS.trimEnd());
  } else if (result.action === "removed") {
    lines.push("Restart Codex so it stops running the hook.");
  }
  return `${lines.join("\n")}\n`;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function runInstallHookCli(
  argv: readonly string[],
  context: InstallContext,
  io: CliIo,
): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.options.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  try {
    const result = installHook(parsed.options, context);
    for (const note of result.notes) io.stderr(`note: ${note}\n`);
    for (const warning of result.warnings) io.stderr(`warning: ${warning}\n`);
    io.stdout(describeResult(result, parsed.options));
    return EXIT_OK;
  } catch (error) {
    const refusal = error instanceof HooksFileRefusal;
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr(`${refusal ? "Refused" : "Failed"}: ${detail}\nNothing was written.\n`);
    return EXIT_REFUSED;
  }
}

export function defaultPathContext(): PathContext {
  return { cwd: process.cwd(), env: process.env, home: homedir() };
}
