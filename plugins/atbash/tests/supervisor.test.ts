/**
 * The supervisor: the process the host starts (dist/pre-tool-use.cjs, src/hook/supervisor.cjs).
 *
 * The shim's deadline timer runs on the shim's own event loop, so a synchronous stall in that
 * process - an antivirus scanner holding the native addon's load (measured on 2026-10-20: over
 * 25 s), a hang inside the addon - kept the timer from firing, and the host's 35 s timeout is a
 * permit on both hosts. The supervisor runs the shim in a child process and keeps its own clock,
 * so these tests stall, kill or impersonate the CHILD and check what the host gets. They spawn the
 * BUILT entry point, as the host does. host-boundary.test.ts pins the shim's own guarantees by
 * running the shim directly.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { makeHookInput } from "./fixtures.js";

const DENY_SHAPE = /"permissionDecision":"deny"/;
const ANSWER = 'globalThis[Symbol.for("atbash.hook.answer")]';
// The host's hook timeout (hooks.json) is 35 s; an answer must be on stdout before it.
const HOST_TIMEOUT_MS = 35_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  killed: boolean;
}

interface RunOptions {
  input?: unknown;
  /** Destroy the read end of the hook's stdout at once: the host went away. */
  closeStdout?: boolean;
}

function runEntry(dir: string, env: NodeJS.ProcessEnv, options: RunOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "atbash-supervisor-home-"));
  const started = process.hrtime.bigint();
  return new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [join(dir, "pre-tool-use.cjs")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        HOME: home,
        USERPROFILE: home,
        HONEYCOMB_API_KEY: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    if (options.closeStdout === true) child.stdout.destroy();
    else child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify(options.input ?? makeHookInput()));
    // Stands in for the host's timeout, and resolves on 'close' - after EVERY holder of the hook's
    // stdout and stderr let go - as a host that reads to end-of-file does.
    const guard = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, HOST_TIMEOUT_MS + 5_000);
    child.on("close", (code) => {
      clearTimeout(guard);
      rmSync(home, { force: true, recursive: true });
      resolve({
        code,
        stdout,
        stderr,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        killed,
      });
    });
  });
}

/** A copy of the built runtime with some files replaced or added. */
function runtimeWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "atbash-supervisor-"));
  cpSync("dist", dir, { recursive: true });
  for (const [file, source] of Object.entries(files)) writeFileSync(join(dir, file), source);
  return dir;
}

/** One parseable deny and nothing else, with exit 0: the only answer both hosts block on. */
function assertSingleDeny(result: RunResult, reason: RegExp) {
  assert.equal(result.killed, false, `the hook outlived the host timeout: ${result.wallMs} ms`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { permissionDecisionReason: string };
  };
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, reason);
  return parsed;
}

function denyLiteral(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** A stand-in for the shim: writes `output` to stdout and ends with `code`. */
function fakeShim(output: string, code = 0): string {
  return `require("node:fs").writeSync(1, ${JSON.stringify(output)});\nprocess.exitCode = ${code};\n`;
}

// A bundle that blocks its own event loop synchronously: what an antivirus-held native load looks
// like from inside the process. The shim's timer cannot run while this holds.
const STALLED_BUNDLE = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);\n";

async function withRuntime(files: Record<string, string>, body: (dir: string) => Promise<void>) {
  const dir = runtimeWith(files);
  try {
    await body(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// --- the stall the supervisor exists for -------------------------------------------------------

test("a hook whose event loop is stalled (an antivirus-held native load) is denied at the supervisor's deadline", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": STALLED_BUNDLE }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "3000" });
    assertSingleDeny(result, /did not finish/);
    // 3 s shim deadline + 1.5 s supervisor margin, with room for a loaded machine.
    assert.ok(result.wallMs < 9_000, `denied after ${result.wallMs} ms`);
  });
});

test("with the default deadline a stalled hook is still denied before the host's 35 s timeout", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": STALLED_BUNDLE }, async (dir) => {
    const result = await runEntry(dir, {});
    assertSingleDeny(result, /did not finish/);
    assert.ok(result.wallMs < 34_000, `denied after ${result.wallMs} ms, past the host timeout`);
  });
});

test("with the largest accepted deadline a stalled hook is still denied before the host's 35 s timeout", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": STALLED_BUNDLE }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "30000" });
    assertSingleDeny(result, /did not finish/);
    assert.ok(result.wallMs < 34_000, `denied after ${result.wallMs} ms, past the host timeout`);
  });
});

test("a killed hook that cannot die yet does not hold the host's output open", async () => {
  // A process whose teardown the OS defers (a scanner holding it in a kernel wait) keeps every
  // handle it has. A detached grandchild that inherited the hook's stderr stands in for it: with
  // the host's stderr handed straight to the hook, the host waits for that handle to close long
  // after the deny - past its own timeout, a permit. The supervisor relays stderr through a pipe
  // of its own, so the host's handles close when the supervisor exits.
  const pidFile = join(tmpdir(), `atbash-supervisor-grandchild-${process.pid}-${Date.now()}.pid`);
  const shim = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: require("node:os").tmpdir(), detached: true, stdio: ["ignore", "ignore", "inherit"] });',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    "g.unref();",
    STALLED_BUNDLE,
  ].join("\n");
  const stopGrandchild = () => {
    if (!existsSync(pidFile)) return;
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")));
    } catch {
      // already gone
    }
    rmSync(pidFile, { force: true });
  };
  await withRuntime({ "pre-tool-use-shim.cjs": shim }, async (dir) => {
    try {
      const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "3000" });
      assertSingleDeny(result, /did not finish/);
      assert.ok(result.wallMs < 9_000, `the host got its answer after ${result.wallMs} ms`);
    } finally {
      // Before the runtime directory is removed: the grandchild was started from it.
      stopGrandchild();
    }
  });
});

// --- silence is a permit only with the shim's sign ---------------------------------------------

test("a hook process that dies without running its exit handlers is denied, never a permit", async () => {
  // process.reallyExit skips every exit listener, the shim's exit backstop included: exit 1 with
  // an empty stdout, which both hosts read as a permit when the shim is the process they started.
  await withRuntime({ "pre-tool-use-main.cjs": "process.reallyExit(1);\n" }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
    assertSingleDeny(result, /without a usable decision/);
  });
});

test("a hook that exits 0 without running its exit handlers is denied, never a permit", async () => {
  // The same skip with exit 0 (a native exit(0) from the addon looks like this): an empty stdout
  // and code 0, but no permit sign - the sign is written from the shim's exit listener only.
  await withRuntime({ "pre-tool-use-main.cjs": "process.reallyExit(0);\n" }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
    assertSingleDeny(result, /without a usable decision/);
  });
});

test("a child that ends 0 with an empty stdout but no permit sign is denied", async () => {
  await withRuntime({ "pre-tool-use-shim.cjs": fakeShim("") }, async (dir) => {
    assertSingleDeny(await runEntry(dir, {}), /without a usable decision/);
  });
});

test("a missing shim is denied, never a permit", async () => {
  const dir = runtimeWith({});
  rmSync(join(dir, "pre-tool-use-shim.cjs"));
  try {
    assertSingleDeny(await runEntry(dir, {}), /without a usable decision/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the bundle's permit reaches the host as silence with exit 0", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": `${ANSWER}("");\n` }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
    assert.equal(result.killed, false);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  });
});

// --- what is forwarded --------------------------------------------------------------------------

test("the host's payload reaches the hook unchanged and the hook's deny reaches the host once", async () => {
  // The stand-in bundle echoes the command it read from stdin as its deny reason.
  const bundle = `let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const reason = "saw " + JSON.parse(raw).tool_input.command;
  ${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
});
`;
  await withRuntime({ "pre-tool-use-main.cjs": bundle }, async (dir) => {
    const result = await runEntry(
      dir,
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      {
        input: makeHookInput({
          tool_name: "Bash",
          tool_input: { command: "echo supervised-7f3a" },
        }),
      },
    );
    assertSingleDeny(result, /^saw echo supervised-7f3a$/);
  });
});

test("a sibling key next to the child's deny never reaches the host", async () => {
  const output =
    JSON.stringify({
      decision: "approve",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "kept",
        approve: true,
      },
    }) + "\n";
  await withRuntime({ "pre-tool-use-shim.cjs": fakeShim(output) }, async (dir) => {
    const result = await runEntry(dir, {});
    assertSingleDeny(result, /^kept$/);
    assert.doesNotMatch(result.stdout, /approve/);
  });
});

for (const [label, output, code] of [
  ["two decisions", `${denyLiteral("a")}\n${denyLiteral("b")}\n`, 0],
  ["two decisions on one line", `${denyLiteral("a")}${denyLiteral("b")}\n`, 0],
  [
    "an allow-shaped decision",
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
    0,
  ],
  ["a log line", "hello from a stray library\n", 0],
  ["a deny over the byte bound", `${denyLiteral("x".repeat(5_000))}\n`, 0],
  ["a deny behind 20 KB of padding", `${" ".repeat(20_000)}${denyLiteral("padded")}\n`, 0],
  ["a valid deny but exit 1", `${denyLiteral("exit one")}\n`, 1],
  ["a valid deny but exit 2", `${denyLiteral("exit two")}\n`, 2],
] as const) {
  test(`a child that ends with ${label} is denied with the supervisor's own reason, never forwarded`, async () => {
    // Replaces the shim itself: only a single well-formed, bounded deny with exit 0 is passed on.
    await withRuntime({ "pre-tool-use-shim.cjs": fakeShim(output, code) }, async (dir) => {
      assertSingleDeny(await runEntry(dir, {}), /without a usable decision/);
    });
  });
}

test("an invalid ATBASH_HOOK_DEADLINE_MS is denied at once through the supervisor", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": STALLED_BUNDLE }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "34000" });
    assertSingleDeny(result, /ATBASH_HOOK_DEADLINE_MS must be an integer/);
    assert.ok(result.wallMs < 5_000, `denied after ${result.wallMs} ms`);
  });
});

// --- the supervisor's own writes ----------------------------------------------------------------

test("the child's log lines reach the host's stderr, bounded", async () => {
  await withRuntime(
    { "pre-tool-use-main.cjs": `process.stderr.write("L".repeat(10_000));\n${ANSWER}("");\n` },
    async (dir) => {
      const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
      assert.equal(result.code, 0, result.stderr.slice(0, 200));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^L{2048}/);
      assert.match(result.stderr, /further hook log lines were dropped/);
      assert.ok(result.stderr.length < 2_200, `${result.stderr.length} bytes relayed`);
    },
  );
});

test("when the host's stdout is gone the supervisor exits 2, never 0 with an empty output", async () => {
  await withRuntime({ "pre-tool-use-main.cjs": STALLED_BUNDLE }, async (dir) => {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "1000" }, { closeStdout: true });
    assert.equal(result.killed, false);
    assert.equal(result.code, 2, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stderr, /could not be delivered/);
  });
});

test("a host pipe that takes one byte per stall never holds the supervisor past the host's timeout", async () => {
  // The decoy is loaded into the supervisor only (it checks the script name): fd 1 refuses with
  // EAGAIN twice, then takes one byte. Each accepted byte is progress, so only the absolute
  // give-up (1.5 s past the supervisor's deadline: 6 s + 1.5 s + 1.5 s = 9 s of uptime) ends it.
  const reason = "x".repeat(800);
  const decoy = [
    'const path = require("node:path");',
    'if (path.basename(process.argv[1] ?? "") === "pre-tool-use.cjs") {',
    '  const fs = require("node:fs");',
    "  const original = fs.writeSync;",
    "  let calls = 0;",
    "  fs.writeSync = function (fd, buffer, offset, length) {",
    "    if (fd !== 1) return original.apply(this, arguments);",
    "    calls += 1;",
    "    if (calls % 3 !== 0) {",
    '      const error = new Error("EAGAIN: resource temporarily unavailable, write");',
    '      error.code = "EAGAIN";',
    "      throw error;",
    "    }",
    "    return original.call(this, fd, buffer, offset, 1);",
    "  };",
    "}",
  ].join("\n");
  await withRuntime(
    {
      "decoy.cjs": decoy + "\n",
      "pre-tool-use-main.cjs": `${ANSWER}(${JSON.stringify(denyLiteral(reason))});\n`,
    },
    async (dir) => {
      const result = await runEntry(dir, {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      });
      assert.equal(result.killed, false, `held for ${result.wallMs} ms`);
      assert.equal(result.code, 2, `exit ${result.code}`);
      assert.match(result.stderr, /could not be delivered/);
      assert.throws(() => JSON.parse(result.stdout), "the prefix on stdout parsed as a decision");
      assert.ok(result.wallMs < 20_000, `ended after ${result.wallMs} ms`);
    },
  );
});

// --- with the real bundle and a judge ---------------------------------------------------------

async function startJudge(verdict: "ALLOW" | "BLOCK") {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(url.pathname);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/ai/exists") {
        res.end(
          JSON.stringify({
            registered: true,
            pubkey: url.searchParams.get("pubkey"),
            org_encryption_pubkey: null,
          }),
        );
      } else if (url.pathname === "/api/risk-engine") {
        res.end(
          JSON.stringify({
            policy: "",
            is_custom: false,
            default_policy: "default",
            is_jailed: false,
          }),
        );
      } else if (url.pathname === "/api/v1/judge") {
        res.end(
          JSON.stringify(
            verdict === "BLOCK"
              ? {
                  verdict: "BLOCK",
                  action_type: "block",
                  allow: false,
                  reason: "denied by the test judge",
                  tool_call_id: "tc-1",
                }
              : {
                  verdict: "ALLOW",
                  action_type: "allow",
                  allow: true,
                  reason: "routine",
                  tool_call_id: "tc-1",
                },
          ),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

for (const verdict of ["ALLOW", "BLOCK"] as const) {
  test(`a judge ${verdict} reaches the host through the supervisor and the real bundle`, async () => {
    const judge = await startJudge(verdict);
    try {
      const result = await runEntry(resolve("dist"), {
        ATBASH_ENDPOINT: judge.endpoint,
        ATBASH_AGENT_KEY: generateKeypair().priv_key,
      });
      assert.equal(result.killed, false);
      assert.ok(
        judge.hits.includes("/api/v1/judge"),
        `judge not consulted: ${judge.hits.join()} stdout ${result.stdout} stderr ${result.stderr.slice(0, 400)}`,
      );
      if (verdict === "ALLOW") {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "", `expected a permit, got ${JSON.stringify(result.stdout)}`);
        assert.ok(result.wallMs < 8_000, `a permit took ${result.wallMs} ms`);
      } else {
        assertSingleDeny(result, /denied by the test judge/);
      }
    } finally {
      await judge.close();
    }
  });
}

// --- the supervisor and the shim agree ----------------------------------------------------------

test("the supervisor's copies of the shim's constants match the shim", () => {
  const supervisor = readFileSync("src/hook/supervisor.cjs", "utf8");
  const shim = readFileSync("src/hook/shim.cjs", "utf8");
  for (const name of [
    "DEFAULT_DEADLINE_MS",
    "MIN_DEADLINE_MS",
    "MAX_DEADLINE_MS",
    "MAX_DENY_BYTES",
    "PERMIT_SIGN",
  ]) {
    const pattern = new RegExp(`^const ${name} = (.+);$`, "m");
    const inSupervisor = pattern.exec(supervisor)?.[1];
    assert.ok(inSupervisor !== undefined, `${name} missing from the supervisor`);
    assert.equal(inSupervisor, pattern.exec(shim)?.[1], name);
  }
});
