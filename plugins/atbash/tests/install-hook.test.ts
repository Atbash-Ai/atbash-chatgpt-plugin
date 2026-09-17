/**
 * The user-level hook installer, driven against real files in os.tmpdir() through node's fs API
 * (never a shell: the workspace guard refuses shell writes to any file named hooks.json, and the
 * installer is the product under test, not a shell). No mocks: the library is exercised on real
 * temporary directories, and the BUILT installer (dist and the committed runtime) is spawned as
 * a user would run it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
  buildAtbashEntry,
  isAtbashHook,
} from "../src/install-hook/hooks-file.js";

// dist-tests/tests -> plugins/atbash/runtime: the committed runtime, where the installer ships.
const RUNTIME_DIR = resolve(process.cwd(), "runtime");
const REAL_HOOK_SCRIPT = realpathSync(join(RUNTIME_DIR, "pre-tool-use.cjs"));
const REAL_HOOK_POSIX = REAL_HOOK_SCRIPT.replaceAll("\\", "/");

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
    ...overrides,
  };
}

function readDocument(path: string): DocumentShape {
  return JSON.parse(readFileSync(path, "utf8")) as DocumentShape;
}

function atbashGroups(document: DocumentShape): GroupShape[] {
  return (document.hooks?.PreToolUse ?? []).filter((group) =>
    (group.hooks ?? []).some((hook) => isAtbashHook(hook)),
  );
}

function assertAtbashHook(hook: HookShape | undefined): void {
  assert.ok(hook, "no Atbash hook");
  assert.equal(hook.type, "command");
  assert.equal(hook.command, `node "${REAL_HOOK_POSIX}"`);
  assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
  assert.equal(hook.statusMessage, HOOK_STATUS_MESSAGE);
  if (process.platform === "win32") {
    assert.equal(hook.commandWindows, `node "${REAL_HOOK_POSIX.replaceAll("/", "\\")}"`);
  } else {
    assert.equal(hook.commandWindows, undefined, "commandWindows is a Windows-only key");
  }
}

test("install-hook: the entry names the plugin's real absolute hook path, forward slashes, Windows variant on win32", () => {
  assert.ok(resolve(REAL_HOOK_SCRIPT) === REAL_HOOK_SCRIPT, "realpath must be absolute");
  assert.match(REAL_HOOK_POSIX, /\/runtime\/pre-tool-use\.cjs$/);
  assert.doesNotMatch(REAL_HOOK_POSIX, /\\/);

  const posix = buildAtbashEntry("/home/dev/atbash/runtime/pre-tool-use.cjs", "linux");
  assert.deepEqual(posix, {
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: 'node "/home/dev/atbash/runtime/pre-tool-use.cjs"',
        timeout: HOOK_TIMEOUT_SECONDS,
        statusMessage: HOOK_STATUS_MESSAGE,
      },
    ],
  });

  const windows = buildAtbashEntry(
    "C:\\Users\\dev\\New folder\\runtime\\pre-tool-use.cjs",
    "win32",
  );
  assert.deepEqual(windows.hooks[0], {
    type: "command",
    command: 'node "C:/Users/dev/New folder/runtime/pre-tool-use.cjs"',
    commandWindows: 'node "C:\\Users\\dev\\New folder\\runtime\\pre-tool-use.cjs"',
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: HOOK_STATUS_MESSAGE,
  });

  // The marker: either spelling of the command, and nothing that merely mentions the plugin.
  assert.equal(isAtbashHook(windows.hooks[0]), true);
  assert.equal(isAtbashHook(posix.hooks[0]), true);
  assert.equal(isAtbashHook({ command: 'node "$PLUGIN_ROOT/runtime/pre-tool-use.cjs"' }), true);
  assert.equal(
    isAtbashHook({ commandWindows: 'node "%PLUGIN_ROOT%\\runtime\\pre-tool-use.cjs"' }),
    true,
  );
  assert.equal(isAtbashHook(FOREIGN_GROUP.hooks?.[0]), false);
  assert.equal(isAtbashHook({ command: "echo atbash pre-tool-use.cjs is great" }), false);
  assert.equal(isAtbashHook("node pre-tool-use.cjs"), false);
  assert.equal(isAtbashHook(null), false);
});

test("install-hook: fresh install writes a documented-shape file, then a re-run is idempotent", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    assert.equal(existsSync(hooksPath), false);

    const first = installHook(options(), context(home));
    assert.equal(first.action, "installed");
    assert.equal(first.written, true);
    assert.equal(first.hooksPath, hooksPath);
    assert.equal(first.hookScript, REAL_HOOK_SCRIPT);

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
    assertAtbashHook(groups[0]?.hooks?.[0]);
    if (process.platform !== "win32") {
      assert.equal(statSync(hooksPath).mode & 0o777, 0o600, "private mode on POSIX");
    }
    // The temp file was renamed away, not left behind.
    assert.deepEqual(readdirSync(join(home, ".codex")), ["hooks.json"]);

    const again = installHook(options(), context(home));
    assert.equal(again.action, "unchanged");
    assert.equal(again.written, false);
    assert.equal(readFileSync(hooksPath, "utf8"), text);
    assert.equal(atbashGroups(readDocument(hooksPath)).length, 1, "never duplicated");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: merges beside a foreign entry and other events, replacing a stale Atbash entry", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const stale = {
      matcher: "*",
      hooks: [
        { type: "command", command: 'node "/old/place/runtime/pre-tool-use.cjs"', timeout: 35 },
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
        { type: "command", command: 'node "/old/place/runtime/pre-tool-use.cjs"' },
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

test("install-hook: a malformed file, a non-object root, and a PreToolUse that is not an array are refused untouched", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const cases: Array<[string, RegExp]> = [
      ['{"hooks": {"PreToolUse": [', /not valid JSON/],
      ["", /not valid JSON/],
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
      const stderr: string[] = [];
      const code = runInstallHookCli([], context(home), {
        stdout: () => {},
        stderr: (text) => stderr.push(text),
      });
      assert.equal(code, EXIT_REFUSED, content);
      assert.match(stderr.join(""), /^Refused: /, content);
      assert.match(stderr.join(""), expected, content);
      assert.match(stderr.join(""), /Nothing was written/, content);
      assert.equal(readFileSync(hooksPath, "utf8"), content, `file changed for ${content}`);
      assert.deepEqual(readdirSync(join(home, ".codex")), ["hooks.json"], "no temp file left");

      // --uninstall is held to the same standard: a file it cannot read is not a file it edits.
      const uninstall = runInstallHookCli(["--uninstall"], context(home), {
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal(uninstall, EXIT_REFUSED, content);
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

test("install-hook: --dry-run prints the exact resulting JSON and writes nothing", () => {
  const home = tempHome();
  try {
    const hooksPath = join(home, ".codex", "hooks.json");
    const stdout: string[] = [];
    const code = runInstallHookCli(["--dry-run"], context(home), {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    assert.equal(code, EXIT_OK);
    assert.equal(existsSync(hooksPath), false);
    assert.equal(existsSync(join(home, ".codex")), false, "not even the directory is created");
    const output = stdout.join("");
    assert.match(output, /Dry run: nothing was written/);
    const printed = installHook(options({ dryRun: true }), context(home)).text;
    assert.ok(output.includes(printed.trimEnd()), "the exact resulting file is printed");
    const parsed = JSON.parse(printed) as DocumentShape;
    assertAtbashHook(parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]);
    assert.match(output, /\/hooks/, "the trust step is named");
    assert.match(output, /Restart Codex/);

    // Dry-run against a file that would change: still untouched.
    mkdirSync(join(home, ".codex"), { recursive: true });
    const before = JSON.stringify({ hooks: { PreToolUse: [FOREIGN_GROUP] } });
    writeFileSync(hooksPath, before);
    assert.equal(installHook(options({ dryRun: true }), context(home)).action, "installed");
    assert.equal(readFileSync(hooksPath, "utf8"), before);
    assert.equal(
      installHook(options({ dryRun: true, uninstall: true }), context(home)).action,
      "not-installed",
    );
    assert.equal(readFileSync(hooksPath, "utf8"), before);
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
    const stderr: string[] = [];
    const code = runInstallHookCli(argv, context(tmpdir()), {
      stdout: () => {},
      stderr: (text) => stderr.push(text),
    });
    assert.equal(code, EXIT_USAGE, argv.join(" "));
    assert.match(stderr.join(""), /Usage: node install-hook\.cjs/);
  }
  const stdout: string[] = [];
  assert.equal(
    runInstallHookCli(["--help"], context(tmpdir()), {
      stdout: (t) => stdout.push(t),
      stderr: () => {},
    }),
    EXIT_OK,
  );
  assert.match(stdout.join(""), /--uninstall/);

  const home = tempHome();
  try {
    const stderr: string[] = [];
    const code = runInstallHookCli([], context(home, { runtimeDir: home }), {
      stdout: () => {},
      stderr: (text) => stderr.push(text),
    });
    assert.equal(code, EXIT_REFUSED);
    assert.match(stderr.join(""), /No pre-tool-use\.cjs next to this installer/);
    assert.equal(existsSync(join(home, ".codex")), false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("install-hook: the built installer (dist and the committed runtime) registers its own sibling hook", () => {
  for (const entry of ["dist/install-hook.cjs", "runtime/install-hook.cjs"]) {
    const home = tempHome();
    try {
      const sibling = realpathSync(join(resolve(entry, ".."), "pre-tool-use.cjs")).replaceAll(
        "\\",
        "/",
      );
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
      const hooksPath = join(home, "hooks.json");
      const document = readDocument(hooksPath);
      const hook = document.hooks?.PreToolUse?.[0]?.hooks?.[0];
      assert.ok(hook);
      assert.equal(hook.command, `node "${sibling}"`, entry);
      assert.equal(hook.timeout, HOOK_TIMEOUT_SECONDS);
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

      writeFileSync(hooksPath, "{not json");
      const refused = run(["--dir", home]);
      assert.equal(refused.status, EXIT_REFUSED);
      assert.match(refused.stderr, /^Refused: .*not valid JSON/);
      assert.equal(readFileSync(hooksPath, "utf8"), "{not json");
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }
});
