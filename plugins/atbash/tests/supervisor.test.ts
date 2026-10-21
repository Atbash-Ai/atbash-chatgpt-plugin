/**
 * The supervisor: the process the host starts (dist/pre-tool-use.cjs, src/hook/supervisor.cjs).
 *
 * The shim's deadline timer runs on the shim's own event loop, so a synchronous stall in that
 * process - an antivirus scanner holding the native addon's load (measured on 2026-10-20: over
 * 25 s), a hang inside the addon - kept the timer from firing, and the host's 35 s timeout is a
 * permit on both hosts. The supervisor runs the shim in a child process and keeps its own clock,
 * so these tests stall or kill the CHILD and check that the host still gets a deny in time.
 * They spawn the BUILT entry point, as the host does.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

function runEntry(dir: string, env: NodeJS.ProcessEnv, input: unknown = makeHookInput()) {
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
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify(input));
    // Stands in for the host's timeout: a hook still running here has already been let through.
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

/** A copy of the built runtime with one file replaced. */
function runtimeWith(file: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "atbash-supervisor-"));
  cpSync("dist", dir, { recursive: true });
  writeFileSync(join(dir, file), source);
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
}

// A bundle that blocks its own event loop synchronously: what an antivirus-held native load looks
// like from inside the process. The shim's timer cannot run while this holds.
const STALLED_BUNDLE = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);\n";

test("a hook whose event loop is stalled (an antivirus-held native load) is denied at the supervisor's deadline", async () => {
  const dir = runtimeWith("pre-tool-use-main.cjs", STALLED_BUNDLE);
  try {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "3000" });
    assertSingleDeny(result, /did not finish/);
    // 3 s shim deadline + 1.5 s supervisor margin, with room for a loaded machine.
    assert.ok(result.wallMs < 9_000, `denied after ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("with the default deadline a stalled hook is still denied before the host's 35 s timeout", async () => {
  const dir = runtimeWith("pre-tool-use-main.cjs", STALLED_BUNDLE);
  try {
    const result = await runEntry(dir, {});
    assertSingleDeny(result, /did not finish/);
    assert.ok(result.wallMs < 34_000, `denied after ${result.wallMs} ms, past the host timeout`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a hook process that dies without running its exit handlers is denied, never a permit", async () => {
  // process.reallyExit skips every exit listener, the shim's exit backstop included: exit 1 with
  // an empty stdout, which both hosts read as a permit when the shim is the process they started.
  const dir = runtimeWith("pre-tool-use-main.cjs", "process.reallyExit(1);\n");
  try {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
    assertSingleDeny(result, /without a usable decision/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a missing shim is denied, never a permit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atbash-supervisor-"));
  cpSync("dist", dir, { recursive: true });
  rmSync(join(dir, "pre-tool-use-shim.cjs"));
  try {
    const result = await runEntry(dir, {});
    assertSingleDeny(result, /without a usable decision/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the bundle's permit reaches the host as silence with exit 0", async () => {
  const dir = runtimeWith("pre-tool-use-main.cjs", `${ANSWER}("");\n`);
  try {
    const result = await runEntry(dir, { ATBASH_HOOK_DEADLINE_MS: "6000" });
    assert.equal(result.killed, false);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the host's payload reaches the hook unchanged and the hook's deny reaches the host once", async () => {
  // The stand-in bundle echoes the tool name it read from stdin as its deny reason.
  const dir = runtimeWith(
    "pre-tool-use-main.cjs",
    `let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const reason = "saw " + JSON.parse(raw).tool_name;
  ${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
});
`,
  );
  try {
    const result = await runEntry(
      dir,
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      makeHookInput({ tool_name: "Bash", tool_input: { command: "echo supervised" } }),
    );
    assertSingleDeny(result, /^saw Bash$/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

for (const [label, output] of [
  [
    "two decisions",
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"a"}}\\n{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"b"}}\\n',
  ],
  [
    "an allow-shaped decision",
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\\n',
  ],
  ["a log line", "hello from a stray library\\n"],
] as const) {
  test(`a child that ends 0 with ${label} on stdout is denied, never forwarded`, async () => {
    // Replaces the shim itself: whatever the child prints, only a single well-formed deny or an
    // empty stdout is ever passed on.
    const dir = runtimeWith(
      "pre-tool-use-shim.cjs",
      `require("node:fs").writeSync(1, "${output}");\nprocess.exitCode = 0;\n`,
    );
    try {
      const result = await runEntry(dir, {});
      assertSingleDeny(result, /without a usable decision/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
}
