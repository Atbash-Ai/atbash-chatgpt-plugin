import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  HooksFileRefusal,
  buildAtbashEntry,
  hasAtbashEntry,
  mergeAtbashEntry,
  parseHooksFile,
  removeAtbashEntry,
  resolveHookScript,
  serializeHooksFile,
  writeHooksFileAtomically,
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
  --dry-run         print the resulting hooks file and write nothing
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
        : join(home, ".codex");
  return resolve(base, "hooks.json");
}

export type InstallAction = "installed" | "updated" | "unchanged" | "removed" | "not-installed";

export interface InstallResult {
  action: InstallAction;
  hooksPath: string;
  hookScript: string;
  text: string;
  written: boolean;
}

export interface InstallContext extends PathContext {
  /** The directory holding pre-tool-use.cjs: the installer's own directory in the shipped runtime. */
  runtimeDir: string;
  platform: NodeJS.Platform;
}

/** The whole operation, minus printing. Throws HooksFileRefusal for a file that cannot be handled
 *  and lets file-system errors propagate; in both cases nothing has been written. */
export function installHook(options: InstallHookOptions, context: InstallContext): InstallResult {
  const hookScript = resolveHookScript(context.runtimeDir);
  const hooksPath = resolveHooksPath(options.scope, options.dir, context);
  const existingText = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : undefined;
  const existing: HooksDocument =
    existingText === undefined ? {} : parseHooksFile(existingText, hooksPath);
  const present = hasAtbashEntry(existing);

  let next: HooksDocument;
  let action: InstallAction;
  if (options.uninstall) {
    if (!present) {
      const text = existingText ?? "";
      return { action: "not-installed", hooksPath, hookScript, text, written: false };
    }
    next = removeAtbashEntry(existing);
    action = "removed";
  } else {
    next = mergeAtbashEntry(existing, buildAtbashEntry(hookScript, context.platform));
    action = present ? "updated" : "installed";
  }

  const text = serializeHooksFile(next);
  if (text === existingText) {
    return { action: "unchanged", hooksPath, hookScript, text, written: false };
  }
  if (options.dryRun) {
    return { action, hooksPath, hookScript, text, written: false };
  }
  writeHooksFileAtomically(hooksPath, text, context.platform);
  return { action, hooksPath, hookScript, text, written: true };
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

export function describeResult(result: InstallResult, options: InstallHookOptions): string {
  const lines: string[] = [];
  const where = `${result.hooksPath} (${options.scope} scope)`;
  const wouldChange = result.action !== "unchanged" && result.action !== "not-installed";
  if (options.dryRun && wouldChange) {
    lines.push(`Dry run: nothing was written. ${where} would become:`);
    lines.push("");
    lines.push(result.text.trimEnd());
    lines.push("");
  }
  switch (result.action) {
    case "installed":
      lines.push(`${options.dryRun ? "Would install" : "Installed"} the Atbash hook in ${where}.`);
      break;
    case "updated":
      lines.push(
        `${options.dryRun ? "Would replace" : "Replaced"} the existing Atbash hook in ${where}.`,
      );
      break;
    case "unchanged":
      lines.push(
        `The Atbash hook is already ${options.uninstall ? "absent from" : "installed in"} ${where}; nothing to change.`,
      );
      break;
    case "removed":
      lines.push(
        `${options.dryRun ? "Would remove" : "Removed"} the Atbash hook from ${where}. Other hooks were kept.`,
      );
      break;
    case "not-installed":
      lines.push(`No Atbash hook in ${where}; nothing to remove.`);
      break;
  }
  if (!options.uninstall) {
    lines.push(`  hook command: node "${result.hookScript.replaceAll("\\", "/")}"`);
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
