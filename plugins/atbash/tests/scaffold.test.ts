import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { buildAtbashEntry, parseHookCommand } from "../src/install-hook/hooks-file.js";

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
  interface?: {
    displayName?: unknown;
  };
}

interface MarketplaceManifest {
  name?: unknown;
  interface?: {
    displayName?: unknown;
  };
  plugins?: Array<{
    name?: unknown;
    source?: {
      path?: unknown;
    };
    policy?: {
      installation?: unknown;
      authentication?: unknown;
    };
  }>;
}

interface HookManifest {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: unknown;
      hooks?: Array<{
        type?: unknown;
        command?: unknown;
        commandWindows?: unknown;
        timeout?: unknown;
        statusMessage?: unknown;
      }>;
    }>;
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("Codex manifest matches the accepted plugin identity", async () => {
  const manifest = await readJson<PluginManifest>(
    join(process.cwd(), ".codex-plugin", "plugin.json"),
  );

  assert.equal(manifest.name, "atbash");
  assert.equal(manifest.interface?.displayName, "Atbash Safety");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
});

test("repo marketplace points to the local Atbash plugin", async () => {
  const marketplace = await readJson<MarketplaceManifest>(
    join(process.cwd(), "..", "..", ".agents", "plugins", "marketplace.json"),
  );
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "atbash");

  assert.equal(marketplace.name, "atbash-ai");
  assert.equal(marketplace.interface?.displayName, "Atbash AI");
  assert.ok(entry);
  assert.equal(entry.source?.path, "./plugins/atbash");
  assert.equal(entry.policy?.installation, "AVAILABLE");
  assert.equal(entry.policy?.authentication, "ON_INSTALL");
});

test("hook bundle declares catch-all PreToolUse enforcement", async () => {
  const hookManifest = await readJson<HookManifest>(join(process.cwd(), "hooks", "hooks.json"));
  const matcher = hookManifest.hooks?.PreToolUse?.[0];
  const handler = matcher?.hooks?.[0];

  assert.equal(matcher?.matcher, "*");
  assert.equal(handler?.type, "command");
  assert.equal(handler?.command, 'node "$PLUGIN_ROOT/runtime/pre-tool-use.cjs"');
  assert.equal(handler?.commandWindows, 'node "%PLUGIN_ROOT%\\runtime\\pre-tool-use.cjs"');
  assert.equal(handler?.timeout, 35);
});

test("the user-level installer writes the entry hooks.json declares, with the placeholder resolved", async () => {
  // Codex 0.154+ does not load hooks/hooks.json from a plugin; install-hook.cjs writes the same
  // entry into the user's own hooks file. The two must not drift: same matcher, type, timeout and
  // status message, and the same command with $PLUGIN_ROOT / %PLUGIN_ROOT% replaced by a real path.
  const hookManifest = await readJson<HookManifest>(join(process.cwd(), "hooks", "hooks.json"));
  const declared = hookManifest.hooks?.PreToolUse?.[0];
  const declaredHook = declared?.hooks?.[0];
  assert.ok(declaredHook);

  const installed = buildAtbashEntry(
    "C:\\plugins\\atbash\\runtime\\pre-tool-use.cjs",
    "win32",
    process.execPath,
  );
  const installedHook = installed.hooks[0];
  assert.ok(installedHook);
  assert.equal(installed.matcher, declared?.matcher);
  assert.equal(installedHook.type, declaredHook.type);
  assert.equal(installedHook.timeout, declaredHook.timeout);
  assert.equal(installedHook.statusMessage, declaredHook.statusMessage);
  // Everything but the interpreter token is the same: hooks.json keeps the bare `node` because
  // it is the plugin-bundled form; the installer embeds the absolute node so the hook does not
  // depend on the PATH of whatever launched Codex.
  const withoutInterpreter = (command: unknown) =>
    String(command).replace(/^(?:node|"[^"]+")\s+/, "");
  assert.equal(
    withoutInterpreter(installedHook.command),
    withoutInterpreter(declaredHook.command).replace("$PLUGIN_ROOT", "C:/plugins/atbash"),
  );
  assert.equal(
    withoutInterpreter(installedHook.commandWindows),
    withoutInterpreter(declaredHook.commandWindows).replace("%PLUGIN_ROOT%", "C:\\plugins\\atbash"),
  );
  assert.deepEqual(Object.keys(installedHook).sort(), Object.keys(declaredHook).sort());

  assert.equal(parseHookCommand(declaredHook.command)?.interpreter, undefined, "bare node");
  const interpreter = parseHookCommand(installedHook.command)?.interpreter;
  assert.ok(interpreter, "the installer names an interpreter");
  assert.equal(isAbsolute(interpreter), true);
  assert.equal(existsSync(interpreter), true);
  assert.equal(interpreter, process.execPath.replaceAll("\\", "/"));
  assert.equal(
    parseHookCommand(installedHook.commandWindows)?.interpreter,
    process.execPath.replaceAll("/", "\\"),
  );
});
