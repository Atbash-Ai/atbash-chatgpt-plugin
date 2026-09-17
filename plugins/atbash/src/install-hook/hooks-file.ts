/**
 * The user-level hooks file installer: what makes the Atbash gate exist on a Codex that no longer
 * loads hooks shipped inside a plugin (0.154+ reports `plugin_hooks: removed` and its manifest
 * validator rejects a `hooks` field). Codex still reads `~/.codex/hooks.json` (user scope) and
 * `<project>/.codex/hooks.json` (project scope), so the plugin's PreToolUse entry is written there,
 * pointing at the absolute path of the plugin's own `runtime/pre-tool-use.cjs`.
 *
 * The file is the user's, not ours: only a file that is valid JSON in the documented hook shape is
 * touched, other events and other PreToolUse entries are preserved verbatim, the Atbash entry is
 * recognised by its command (a `pre-tool-use.cjs` script) so a re-run replaces it and never
 * duplicates it, and the file is replaced atomically (temp file + rename, 0600 on POSIX).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

/** The hook script next to the installer, resolved through realpath so the registered command
 *  names the real file whatever path spelling (junction, symlink, drive-letter case) reached it. */
export function resolveHookScript(runtimeDir: string): string {
  const candidate = join(runtimeDir, HOOK_SCRIPT);
  if (!existsSync(candidate)) {
    throw new HooksFileRefusal(
      `No ${HOOK_SCRIPT} next to this installer (looked at ${candidate}); run the installer that ships in the plugin's runtime directory.`,
    );
  }
  const resolved = realpathSync(candidate);
  if (/["\r\n]/.test(resolved)) {
    throw new HooksFileRefusal(
      `The hook path ${JSON.stringify(resolved)} contains a quote or line break and cannot be placed in a hook command; move the plugin.`,
    );
  }
  return resolved;
}

/** The PreToolUse entry Codex runs: the same shape as the plugin's hooks/hooks.json, with the
 *  `$PLUGIN_ROOT` placeholder replaced by the real absolute path. `command` uses forward slashes
 *  (node accepts them on every platform); on Windows `commandWindows` carries the backslash form. */
export function buildAtbashEntry(
  hookScript: string,
  platform: NodeJS.Platform,
): AtbashMatcherGroup {
  const posixPath = hookScript.replaceAll("\\", "/");
  const hook: AtbashCommandHook = {
    type: "command",
    command: `node "${posixPath}"`,
    ...(platform === "win32"
      ? { commandWindows: `node "${posixPath.replaceAll("/", "\\")}"` }
      : {}),
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: HOOK_STATUS_MESSAGE,
  };
  return { matcher: HOOK_MATCHER, hooks: [hook] };
}

const ATBASH_COMMAND = /[\\/]pre-tool-use\.cjs"?\s*$/;

/** The stable marker: a hook whose command (either spelling) runs a `pre-tool-use.cjs` script. */
export function isAtbashHook(hook: unknown): boolean {
  if (!isPlainObject(hook)) return false;
  return [hook.command, hook.commandWindows].some(
    (command) => typeof command === "string" && ATBASH_COMMAND.test(command),
  );
}

function hasAtbashHook(group: JsonObject): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(isAtbashHook);
}

/** Parse and validate; anything outside the documented shape is refused, never repaired. */
export function parseHooksFile(text: string, path: string): HooksDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HooksFileRefusal(`${path} is not valid JSON (${detail}); fix or remove it first.`);
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

/** Every Atbash hook removed from every group; a group left empty is dropped, everything else is
 *  returned as it was. */
function withoutAtbash(groups: JsonObject[]): JsonObject[] {
  return groups.flatMap((group) => {
    if (!hasAtbashHook(group)) return [group];
    const remaining = (group.hooks as unknown[]).filter((hook) => !isAtbashHook(hook));
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

export function hasAtbashEntry(document: HooksDocument): boolean {
  return preToolUseGroups(document).some(hasAtbashHook);
}

/** Replace any existing Atbash entry with `entry` (appended as its own matcher group); foreign
 *  entries, other events and unknown top-level keys are kept in place. Idempotent. */
export function mergeAtbashEntry(
  document: HooksDocument,
  entry: AtbashMatcherGroup,
): HooksDocument {
  const groups = withoutAtbash(preToolUseGroups(document));
  return withPreToolUse(document, [...groups, entry as unknown as JsonObject]);
}

/** Remove only the Atbash entry; an emptied PreToolUse key is dropped, nothing else changes. */
export function removeAtbashEntry(document: HooksDocument): HooksDocument {
  const groups = withoutAtbash(preToolUseGroups(document));
  return withPreToolUse(document, groups.length === 0 ? undefined : groups);
}

export function serializeHooksFile(document: HooksDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Temp file in the same directory, private mode, then rename over the target: a reader sees
 *  either the old file or the new one, never a partial write. */
export function writeHooksFileAtomically(
  path: string,
  text: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const directory = dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
