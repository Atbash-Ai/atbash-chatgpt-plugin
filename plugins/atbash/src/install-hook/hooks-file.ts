/**
 * The user-level hooks file installer: what makes the Atbash gate exist on a Codex that no longer
 * loads hooks shipped inside a plugin (0.154+ reports `plugin_hooks: removed` and its manifest
 * validator rejects a `hooks` field). Codex still reads `~/.codex/hooks.json` (user scope) and
 * `<project>/.codex/hooks.json` (project scope), so the plugin's PreToolUse entry is written there,
 * pointing at the absolute path of the plugin's own `runtime/pre-tool-use.cjs`.
 *
 * The file is the user's, not ours: only a file that is valid JSON in the documented hook shape is
 * touched, other events and other PreToolUse entries are preserved verbatim, the Atbash entry is
 * recognised by an Atbash-specific signal (its status message, or a command naming this very
 * hook script) so a re-run replaces it and never duplicates it, and the file is replaced
 * atomically (temp file + rename onto the real file behind any symlink, 0600 on POSIX) only if it
 * still holds the bytes that were read.
 *
 * The command string is executed by a shell on every tool call, so the path that goes into it is
 * allowlisted, never escaped: a plugin under a path a shell could interpret is refused.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const HOOK_SCRIPT = "pre-tool-use.cjs";
export const HOOK_MATCHER = "*";
export const HOOK_TIMEOUT_SECONDS = 35;
export const HOOK_STATUS_MESSAGE = "Checking action with Atbash";

/** A refusal: the target cannot be handled safely, and nothing has been written. */
export class HooksFileRefusal extends Error {}

export interface AtbashCommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout: number;
  statusMessage: string;
}

export interface AtbashMatcherGroup {
  matcher: string;
  hooks: AtbashCommandHook[];
}

type JsonObject = Record<string, unknown>;

/** A validated hooks document: `hooks.PreToolUse` is an array of matcher groups (objects). */
export interface HooksDocument extends JsonObject {
  hooks?: JsonObject & { PreToolUse?: JsonObject[] };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Which shell runs the command is a fact about the host, not about this file:
//   - Windows: PowerShell. Verified on the real Codex CLI 0.154.0 (2026-09-17, inline hooks
//     override): `& "<node>" "<script>"` ran the hook and Codex reported the block, while
//     `"<node>" "<script>"` (a quoted leading token) ran the tool with NO hook activity - in
//     PowerShell that is a string expression, not a command. So on win32 both `command` and
//     `commandWindows` carry the call operator. PowerShell also resolves a native command only
//     when PATHEXT is set (with it unset it silently runs nothing and exits 0); the probe below
//     supplies the system default so that a missing PATHEXT cannot fake a pass.
//   - POSIX: sh, assumed from Claude Code's documented hook contract (Codex is assumed to share
//     it; not verified on a POSIX Codex host). sh executes a quoted leading token; `&` would be
//     a background operator there, so the call operator is never emitted on POSIX.
// The allowlist below excludes `&`, `;` and `|` from paths, so the operator can never be
// confused with path content. Whatever the shell, the installer does not take the parse on
// trust: before writing, probeRegisteredCommand runs the exact string through the host's shell
// and requires a decision back.
//
// The command is a shell string. Nothing in it is escaped; the path is allowlisted instead.
// Letters, digits, space, `_ . : / + @ ( ) -` are literal inside double quotes in sh, cmd and
// PowerShell (parentheses appear in ordinary Windows folder names such as "New folder (3)").
// Everything else - `$` and backticks (sh, PowerShell), `%` and `!` (cmd expands them even inside
// quotes), `^`, `~`, `'`, `;`, `&`, `|`, `<`, `>`, `*`, `?`, `"`, control characters - is refused.
// A backslash is a path separator on Windows only; on POSIX it is an escape character and a legal
// file-name character, and rewriting it would register a path that does not exist (fail open at
// the host), so on POSIX it is refused too.
const SAFE_PATH_POSIX = /^[A-Za-z0-9 _.:/+@()-]+$/;
const SAFE_PATH_WIN32 = /^[A-Za-z0-9 _.:/+@()\\-]+$/;

export function validateHookScriptPath(
  path: string,
  platform: NodeJS.Platform,
  what: "hook path" | "node interpreter path" = "hook path",
): void {
  const safe = platform === "win32" ? SAFE_PATH_WIN32 : SAFE_PATH_POSIX;
  if (!safe.test(path)) {
    const remedy =
      what === "hook path"
        ? "move the plugin to a plain path."
        : "run the installer with a node installed under a plain path.";
    throw new HooksFileRefusal(
      `The ${what} ${JSON.stringify(path)} contains a character a shell could interpret ` +
        `(allowed: letters, digits, space, _ . : / + @ ( ) -${platform === "win32" ? " and \\" : ""}); ` +
        remedy,
    );
  }
}

/** The node that runs the hook: the absolute path of the node that ran the installer, resolved
 *  through realpath. A bare `node` would be looked up on PATH at hook time, and a Codex started
 *  from a launcher whose PATH lacks the user's node (nvm, a Dock icon) could not spawn the hook
 *  at all - no decision, and the host proceeds. */
export function resolveInterpreter(nodePath: string, platform: NodeJS.Platform): string {
  if (!isAbsolute(nodePath) || !existsSync(nodePath)) {
    throw new HooksFileRefusal(
      `The node interpreter path ${JSON.stringify(nodePath)} is not an existing absolute path.`,
    );
  }
  const resolved = realpathSync(nodePath);
  validateHookScriptPath(resolved, platform, "node interpreter path");
  return resolved;
}

/** The hook script next to the installer, resolved through realpath so the registered command
 *  names the real file whatever path spelling (junction, symlink, drive-letter case) reached it. */
export function resolveHookScript(runtimeDir: string, platform: NodeJS.Platform): string {
  const candidate = join(runtimeDir, HOOK_SCRIPT);
  if (!existsSync(candidate)) {
    throw new HooksFileRefusal(
      `No ${HOOK_SCRIPT} next to this installer (looked at ${candidate}); run the installer that ships in the plugin's runtime directory.`,
    );
  }
  const resolved = realpathSync(candidate);
  validateHookScriptPath(resolved, platform);
  return resolved;
}

/** The PreToolUse entry Codex runs: the same shape as the plugin's hooks/hooks.json, with the
 *  `$PLUGIN_ROOT` placeholder replaced by the real absolute path and the bare `node` replaced by
 *  the absolute interpreter. On Windows `command` carries both paths with forward slashes (node
 *  accepts them) and `commandWindows` the backslash form; on POSIX the paths are used as they are. */
export function buildAtbashEntry(
  hookScript: string,
  platform: NodeJS.Platform,
  interpreter: string,
): AtbashMatcherGroup {
  validateHookScriptPath(hookScript, platform);
  validateHookScriptPath(interpreter, platform, "node interpreter path");
  const forward = (path: string) => (platform === "win32" ? path.replaceAll("\\", "/") : path);
  const backward = (path: string) => path.replaceAll("/", "\\");
  // PowerShell needs the call operator to run a quoted program path; sh must not get one.
  const call = platform === "win32" ? "& " : "";
  const hook: AtbashCommandHook = {
    type: "command",
    command: `${call}"${forward(interpreter)}" "${forward(hookScript)}"`,
    ...(platform === "win32"
      ? {
          commandWindows: `${call}"${backward(forward(interpreter))}" "${backward(forward(hookScript))}"`,
        }
      : {}),
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: HOOK_STATUS_MESSAGE,
  };
  return { matcher: HOOK_MATCHER, hooks: [hook] };
}

// `"<interpreter>" "<script>"` as the installer writes it (with the PowerShell call operator
// in front on Windows), or the bare `node "<script>"` of the plugin's hooks.json and of a
// hand-edited entry, optionally followed by arguments (`--verbose`).
const COMMAND_PATTERN = /^\s*(&\s+)?(?:node|"([^"]+)")\s+"([^"]+)"(?:\s+.*)?$/s;

export interface ParsedHookCommand {
  /** True when the command starts with PowerShell's call operator `&`. */
  callOperator: boolean;
  /** Absent for the bare `node` form. */
  interpreter: string | undefined;
  script: string;
}

/** The interpreter and script a hook command runs, exactly as a reader of the file would parse
 *  them, or undefined when the command has another shape. */
export function parseHookCommand(command: unknown): ParsedHookCommand | undefined {
  if (typeof command !== "string") return undefined;
  const match = COMMAND_PATTERN.exec(command);
  if (match === null || match[3] === undefined) return undefined;
  return { callOperator: match[1] !== undefined, interpreter: match[2], script: match[3] };
}

/** The script path a hook command runs, or undefined when the command has another shape. */
export function commandScriptPath(command: unknown): string | undefined {
  return parseHookCommand(command)?.script;
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
}

export interface AtbashIdentity {
  /** The realpath of this installer's own hook script. */
  hookScript: string;
  platform: NodeJS.Platform;
}

/** The one signal that proves an entry is this plugin's: a command whose script path is this
 *  very hook script. The status message is not proof (any vendor can copy a string), so an entry
 *  carrying it with another script is a look-alike, kept and reported, never replaced or removed. */
export function isAtbashHook(hook: unknown, identity: AtbashIdentity): boolean {
  if (!isPlainObject(hook)) return false;
  const own = comparablePath(identity.hookScript, identity.platform);
  return [hook.command, hook.commandWindows].some((command) => {
    const path = commandScriptPath(command);
    return path !== undefined && comparablePath(path, identity.platform) === own;
  });
}

/** A hook that looks like Atbash's without being provably so: it carries the Atbash status
 *  message, or runs some script called pre-tool-use.cjs, but not this plugin's hook script. Left
 *  alone, counted as foreign, and worth telling the user about (it may be a stale entry from a
 *  plugin that moved, or somebody else's hook wearing our name). */
export function isAtbashLookalike(hook: unknown, identity: AtbashIdentity): boolean {
  if (!isPlainObject(hook) || isAtbashHook(hook, identity)) return false;
  if (hook.statusMessage === HOOK_STATUS_MESSAGE) return true;
  return [hook.command, hook.commandWindows].some((command) => {
    const path = commandScriptPath(command);
    return path !== undefined && /[\\/]pre-tool-use\.cjs$/.test(path);
  });
}

/** Every command the entry carries must lead back to the hook script and the interpreter
 *  themselves: both paths are parsed out of the string exactly as a reader would, and must exist
 *  and resolve to the same files. */
export function verifyEntryRoundTrip(
  entry: AtbashMatcherGroup,
  hookScript: string,
  interpreter: string,
  platform: NodeJS.Platform,
): void {
  for (const hook of entry.hooks) {
    for (const command of [hook.command, hook.commandWindows]) {
      if (command === undefined) continue;
      const parsed = parseHookCommand(command);
      if (parsed === undefined) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)} does not parse back to a script path.`,
        );
      }
      if (!existsSync(parsed.script)) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)} names a file that does not exist.`,
        );
      }
      const resolvedScript = realpathSync(parsed.script);
      if (resolvedScript !== hookScript) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)} resolves to ${resolvedScript}, not to ${hookScript}.`,
        );
      }
      if (parsed.interpreter === undefined || !isAbsolute(parsed.interpreter)) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)} does not name an absolute interpreter.`,
        );
      }
      if (!existsSync(parsed.interpreter)) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)} names an interpreter that does not exist.`,
        );
      }
      const resolvedInterpreter = realpathSync(parsed.interpreter);
      if (resolvedInterpreter !== interpreter) {
        throw new HooksFileRefusal(
          `The hook command ${JSON.stringify(command)}: the interpreter resolves to ${resolvedInterpreter}, not to ${interpreter}.`,
        );
      }
      if (parsed.callOperator !== (platform === "win32")) {
        throw new HooksFileRefusal(
          platform === "win32"
            ? `The hook command ${JSON.stringify(command)} lacks the PowerShell call operator; Codex on Windows would evaluate it as a string and run nothing.`
            : `The hook command ${JSON.stringify(command)} carries a call operator that sh would read as a background job.`,
        );
      }
    }
  }
}

function hasAtbashHook(group: JsonObject, identity: AtbashIdentity): boolean {
  return Array.isArray(group.hooks) && group.hooks.some((hook) => isAtbashHook(hook, identity));
}

// The V8 message can quote the input ("<text>" is not valid JSON); only its position survives.
function describeJsonError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)?.[0];
  if (position !== undefined) return `syntax error ${position}`;
  if (/end of JSON input/i.test(message)) return "unexpected end of input";
  const token = /Unexpected token '(.)'/.exec(message)?.[1];
  return token === undefined ? "syntax error" : `syntax error near token '${token}'`;
}

/** Parse and validate; anything outside the documented shape is refused, never repaired. */
export function parseHooksFile(text: string, path: string): HooksDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HooksFileRefusal(
      `${path} is not valid JSON (${describeJsonError(error)}); fix or remove it first.`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new HooksFileRefusal(`${path} must contain a JSON object at the top level.`);
  }
  if (parsed.hooks !== undefined) {
    if (!isPlainObject(parsed.hooks)) {
      throw new HooksFileRefusal(`${path}: "hooks" must be an object keyed by event name.`);
    }
    const preToolUse = parsed.hooks.PreToolUse;
    if (preToolUse !== undefined) {
      if (!Array.isArray(preToolUse)) {
        throw new HooksFileRefusal(
          `${path}: "hooks.PreToolUse" must be an array of matcher groups.`,
        );
      }
      preToolUse.forEach((group, index) => {
        if (!isPlainObject(group)) {
          throw new HooksFileRefusal(`${path}: "hooks.PreToolUse[${index}]" must be an object.`);
        }
        if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
          throw new HooksFileRefusal(
            `${path}: "hooks.PreToolUse[${index}].hooks" must be an array of hooks.`,
          );
        }
      });
    }
  }
  return parsed as HooksDocument;
}

function preToolUseGroups(document: HooksDocument): JsonObject[] {
  return document.hooks?.PreToolUse ?? [];
}

function preToolUseHooks(document: HooksDocument): unknown[] {
  return preToolUseGroups(document).flatMap((group) =>
    Array.isArray(group.hooks) ? group.hooks : [],
  );
}

/** Every Atbash hook removed from every group; a group left empty is dropped, everything else is
 *  returned as it was. */
function withoutAtbash(groups: JsonObject[], identity: AtbashIdentity): JsonObject[] {
  return groups.flatMap((group) => {
    if (!hasAtbashHook(group, identity)) return [group];
    const remaining = (group.hooks as unknown[]).filter((hook) => !isAtbashHook(hook, identity));
    return remaining.length === 0 ? [] : [{ ...group, hooks: remaining }];
  });
}

function withPreToolUse(document: HooksDocument, groups: JsonObject[] | undefined): HooksDocument {
  const hooks: JsonObject = { ...(document.hooks ?? {}) };
  if (groups === undefined) {
    delete hooks.PreToolUse;
  } else {
    hooks.PreToolUse = groups;
  }
  return { ...document, hooks };
}

export function hasAtbashEntry(document: HooksDocument, identity: AtbashIdentity): boolean {
  return preToolUseGroups(document).some((group) => hasAtbashHook(group, identity));
}

/** What a document keeps that is not provably Atbash's: PreToolUse hooks of other origin
 *  (look-alikes included), and the hooks under other events. */
export function foreignContent(
  document: HooksDocument,
  identity: AtbashIdentity,
): { foreignHooks: unknown[]; otherEvents: string[]; lookalikes: unknown[] } {
  const foreignHooks = preToolUseHooks(document).filter((hook) => !isAtbashHook(hook, identity));
  return {
    foreignHooks,
    otherEvents: Object.keys(document.hooks ?? {}).filter((event) => event !== "PreToolUse"),
    lookalikes: foreignHooks.filter((hook) => isAtbashLookalike(hook, identity)),
  };
}

/** A synthetic PreToolUse payload for the execution probe. With no configuration reachable the
 *  hook must answer with a deny; that deny is the proof that the host shell can run the command. */
export const PROBE_PAYLOAD = {
  hook_event_name: "PreToolUse",
  tool_name: "probe",
  tool_input: {},
  cwd: ".",
  permission_mode: "default",
  session_id: "install-probe",
  model: "probe",
  tool_use_id: "probe",
  transcript_path: null,
  turn_id: "probe",
};

export const PROBE_TIMEOUT_MS = 15_000;

/** Windows PowerShell by its system path: the probe must not depend on PATH to find the shell. */
export function windowsPowerShellPath(env: Readonly<Record<string, string | undefined>>): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Run the registered command string exactly as the host would - Windows PowerShell
 *  (`-NoProfile -NonInteractive -Command`) with `commandWindows` and again with `command` on
 *  win32, `/bin/sh -c` with `command` elsewhere - with the synthetic payload on stdin and an
 *  environment that has no PATH, no home and no Atbash configuration. Anything but exit 0 and one
 *  deny decision on stdout is a refusal: a string the shell cannot execute would be a hook that
 *  never answers, and the host proceeds. */
export function probeRegisteredCommand(
  entry: AtbashMatcherGroup,
  platform: NodeJS.Platform,
  timeoutMs = PROBE_TIMEOUT_MS,
): void {
  const hook = entry.hooks[0];
  if (hook === undefined) {
    throw new HooksFileRefusal(
      "the registered command could not be executed by the host shell: the entry has no hook",
    );
  }
  const commands =
    platform === "win32" ? [hook.commandWindows ?? hook.command, hook.command] : [hook.command];
  for (const command of commands) runProbe(command, platform, timeoutMs);
}

function runProbe(command: string, platform: NodeJS.Platform, timeoutMs: number): void {
  const fail = (reason: string): never => {
    throw new HooksFileRefusal(
      `the registered command could not be executed by the host shell: ${reason} (command: ${command})`,
    );
  };
  // No PATH (the interpreter must be absolute), no home (no config file), an invalid SDK budget
  // (no network call): the hook has to deny from configuration alone. The shell and node still
  // need the system roots, and PowerShell needs PATHEXT to run any native program at all.
  const env: Record<string, string> = {
    PATH: "",
    HOME: "",
    USERPROFILE: "",
    ATBASH_CODEX_TIMEOUT_MS: "invalid",
    ATBASH_HOOK_DEADLINE_MS: "",
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (platform === "win32") env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const [shell, args] =
    platform === "win32"
      ? [windowsPowerShellPath(process.env), ["-NoProfile", "-NonInteractive", "-Command", command]]
      : ["/bin/sh", ["-c", command]];
  // A neutral working directory: with the home variables emptied a relative config lookup would
  // otherwise resolve against whatever directory the installer was started from.
  const result = spawnSync(shell, args, {
    input: JSON.stringify(PROBE_PAYLOAD),
    encoding: "utf8",
    env,
    cwd: tmpdir(),
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return fail(code === "ETIMEDOUT" ? `no decision within ${timeoutMs} ms` : result.error.message);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
    return fail(
      `exit ${result.status ?? `signal ${result.signal ?? "unknown"}`}${detail === "" ? "" : ` (${detail})`}`,
    );
  }
  let decision: unknown;
  try {
    decision = JSON.parse((result.stdout ?? "").trim());
  } catch {
    return fail("stdout is not one JSON object");
  }
  const permission = isPlainObject(decision)
    ? isPlainObject(decision.hookSpecificOutput)
      ? decision.hookSpecificOutput.permissionDecision
      : undefined
    : undefined;
  if (permission !== "deny") {
    return fail(
      `stdout is not a deny decision (permissionDecision: ${JSON.stringify(permission)})`,
    );
  }
}

/** Replace any existing Atbash entry with `entry` (appended as its own matcher group); foreign
 *  entries, other events and unknown top-level keys are kept in place. Idempotent. */
export function mergeAtbashEntry(
  document: HooksDocument,
  entry: AtbashMatcherGroup,
  identity: AtbashIdentity,
): HooksDocument {
  const groups = withoutAtbash(preToolUseGroups(document), identity);
  return withPreToolUse(document, [...groups, entry as unknown as JsonObject]);
}

/** Remove only the Atbash entry; an emptied PreToolUse key is dropped, nothing else changes. */
export function removeAtbashEntry(
  document: HooksDocument,
  identity: AtbashIdentity,
): HooksDocument {
  const groups = withoutAtbash(preToolUseGroups(document), identity);
  return withPreToolUse(document, groups.length === 0 ? undefined : groups);
}

export function serializeHooksFile(document: HooksDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The file that will actually be replaced: the real file behind a symlinked hooks.json (so a
 *  dotfiles link is updated through, never detached), or, for a file that does not exist yet, its
 *  name inside the real directory. A link to nothing is refused. */
export function resolveWriteTarget(path: string): string {
  let linkInfo;
  try {
    linkInfo = lstatSync(path);
  } catch {
    linkInfo = undefined;
  }
  if (linkInfo !== undefined) {
    try {
      return realpathSync(path);
    } catch {
      throw new HooksFileRefusal(
        `${path} is a link to a file that does not exist; fix the link first.`,
      );
    }
  }
  const directory = dirname(path);
  return existsSync(directory) ? join(realpathSync(directory), basename(path)) : path;
}

/** Windows permissions are ACLs, and stat reports mode bits that mean nothing there (every
 *  directory shows as writable), so no check is made on win32. */
export function directoryWritableByOthers(directory: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false;
  try {
    return (statSync(directory).mode & 0o022) !== 0;
  } catch {
    return false;
  }
}

/** dev + inode + change time of a file. A different file at the same path has another inode
 *  (POSIX) or file index (Windows) - except when the filesystem hands the freed number straight
 *  back to the next file, which ext4 does deterministically for an unlink-and-recreate, so the
 *  change time (new for a recreated file, and for any metadata change) is part of the identity
 *  too. A metadata change alone (a chmod between the read and the rename) therefore also refuses
 *  the swap, which fails closed. */
export interface FileIdentity {
  dev: number;
  ino: number;
  ctimeMs: number;
}

export function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const info = statSync(path);
    return { dev: info.dev, ino: info.ino, ctimeMs: info.ctimeMs };
  } catch {
    return undefined;
  }
}

export function sameIdentity(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.ctimeMs === b.ctimeMs
  );
}

export interface AtomicWriteOptions {
  platform: NodeJS.Platform;
  /** The bytes read at the start (undefined: the file did not exist). The swap happens only if
   *  the target still holds exactly these. */
  expectedExisting: string | undefined;
  /** The file's dev/inode/change time when it was read, if it existed: the swap also requires
   *  the same, unchanged file object to still be there, so an identical-content replacement is
   *  noticed too - by its new inode, or by its new change time where the inode was reused. */
  expectedIdentity?: FileIdentity | undefined;
  /** Runs between the temp-file write and the final check; exists so a test can reproduce a
   *  concurrent edit against the real file. Never set by the CLI. */
  beforeSwap?: () => void;
}

/** Temp file in the target's own directory, private mode, then rename over the target: a reader
 *  sees either the old file or the new one, never a partial write, and a file that changed since
 *  it was read is left as it is. The check is content plus dev/inode/change time, taken just
 *  before the rename;
 *  the remaining window (a swap between that check and the rename) needs write access to the
 *  Codex home, and whoever has that can rewrite hooks.json outright - the gate is already theirs. */
export function writeHooksFileAtomically(
  target: string,
  text: string,
  options: AtomicWriteOptions,
): void {
  const directory = dirname(target);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (options.platform !== "win32") chmodSync(temporary, 0o600);
    options.beforeSwap?.();
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const identityChanged =
      options.expectedIdentity !== undefined &&
      !sameIdentity(fileIdentity(target), options.expectedIdentity);
    if (current !== options.expectedExisting || identityChanged) {
      throw new HooksFileRefusal(
        `${target} changed while the installer was running; re-run it to work from the current contents.`,
      );
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
