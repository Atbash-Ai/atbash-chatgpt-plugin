"use strict";
// The process the host starts (runtime/pre-tool-use.cjs). Plain CommonJS, no dependencies, never
// bundled, and it never loads the native SDK. It runs the real hook - the shim, which loads the
// bundle and the native addon - in a CHILD process, and keeps its own clock.
//
// Why a second process: the shim's deadline timer lives on the shim's event loop. A synchronous
// stall in that process - the native addon's load held by an antivirus scanner (measured on
// 2026-10-20: over 25 s for atbash.node under a PowerShell-started node), a hang inside the addon,
// a suspended process - keeps that timer from ever running, and the host's own timeout (35 s)
// is a permit on both hosts. The supervisor's loop is never blocked by the child, so its timer
// runs whatever the child does: past the deadline the child is killed and the call is denied.
//
// The answer the host sees is decided here, from what the child produced:
//   - exit 0 with an empty stdout: the shim's permit (its exit backstop turns every other silent
//     exit into a deny, so an empty 0 is the bundle's explicit allow) - nothing is written;
//   - exit 0 with exactly one PreToolUse deny: that deny, re-serialized here;
//   - anything else - another exit code, a signal, unparseable or extra output, a child that
//     could not start, a child still running at the deadline: a deny with exit 0.
// The child's stderr is the host transcript, as before.
//
// What this cannot close: a stall of THIS process before its timer is armed (node itself not
// starting) - only the host timeout ends that; this file loads nothing but node built-ins.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Taken once, before anything else in the process can run (the shim does the same).
const writeSync = fs.writeSync;

// The shim's own deadline bounds (src/hook/shim.cjs). The supervisor fires after the shim's
// deadline, so a live shim always answers first with its own reason, and still well under the
// host's 35 s: 30 s (the largest shim deadline) + 1.5 s = 31.5 s from the supervisor's start.
const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
const MAX_DEADLINE_MS = 30000;
const SUPERVISOR_MARGIN_MS = 1500;
// The largest deny written to the host, in serialized bytes - the shim's bound (see there).
const MAX_DENY_BYTES = 3584;
// The child's stdout is at most one bounded deny; anything far larger is not a decision.
const MAX_CHILD_STDOUT_BYTES = 16384;
const WRITE_RETRY_WAIT_MS = 25;
const WRITE_STALL_BUDGET_MS = 2000;

function shimDeadlineMs(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
    // The shim denies an invalid value at once; the supervisor only needs an upper bound.
    return MAX_DEADLINE_MS;
  }
  return parsed;
}

function serializeDeny(reason) {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

// The deny the child produced, or null. Exactly one PreToolUse deny object with a string reason;
// the reason is re-serialized so no sibling key the child wrote reaches the host.
function childDeny(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || trimmed.includes("\n")) return null;
  try {
    const out = JSON.parse(trimmed)?.hookSpecificOutput;
    if (
      typeof out === "object" &&
      out !== null &&
      out.hookEventName === "PreToolUse" &&
      out.permissionDecision === "deny" &&
      typeof out.permissionDecisionReason === "string"
    ) {
      const text = serializeDeny(out.permissionDecisionReason);
      // The shim already bounds its deny; a child that did not is not trusted with the host's pipe.
      return Buffer.byteLength(text, "utf8") <= MAX_DENY_BYTES ? text : null;
    }
  } catch {
    // not a decision
  }
  return null;
}

let decided = false;
let child = null;
let deadlineTimer = null;

function writeAllSync(text) {
  // Every byte or an error, retried on EAGAIN without outliving the host's timeout (the shim's
  // writeDecisionSync, without its in-process adversary handling: nothing else runs here).
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  let lastProgress = Date.now();
  while (offset < buffer.length) {
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (!Number.isInteger(written) || written < 0 || written > buffer.length - offset) {
        throw Object.assign(new Error("impossible byte count"), { code: "EIO" });
      }
      if (written > 0) {
        offset += written;
        lastProgress = Date.now();
        continue;
      }
    } catch (error) {
      if (!(error && error.code === "EAGAIN")) throw error;
    }
    if (Date.now() - lastProgress >= WRITE_STALL_BUDGET_MS) {
      throw Object.assign(new Error("the decision could not be written"), { code: "ETIMEDOUT" });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRY_WAIT_MS);
  }
}

function finish(text) {
  if (decided) return;
  decided = true;
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  if (text === "") {
    process.exit(0);
    return;
  }
  try {
    writeAllSync(text);
    process.exit(0);
  } catch {
    // stdout is gone: a blocking exit (Claude Code), never 0 with an empty, permit-shaped stdout.
    try {
      writeSync(2, "Atbash ERROR: the decision could not be delivered to the host.\n");
    } catch {
      // nothing left to report to
    }
    process.exit(2);
  }
}

function deny(reason) {
  finish(serializeDeny(reason));
}

// Last word: a supervisor that ends any other way still denies.
process.on("uncaughtException", () => deny("Atbash ERROR: the hook supervisor failed."));
process.on("exit", () => {
  if (decided) return;
  decided = true;
  try {
    writeAllSync(serializeDeny("Atbash ERROR: the hook ended without a decision."));
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  }
});

// Armed first, before the child exists: the clock counts from this process's start.
const budgetMs =
  shimDeadlineMs(process.env.ATBASH_HOOK_DEADLINE_MS) +
  SUPERVISOR_MARGIN_MS -
  Math.ceil(process.uptime() * 1000);
deadlineTimer = setTimeout(
  () => deny("Atbash ERROR: the safety check did not finish before the host's hook timeout."),
  Math.max(0, budgetMs),
);

try {
  child = spawn(process.execPath, [path.join(__dirname, "pre-tool-use-shim.cjs")], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
} catch {
  deny("Atbash ERROR: the hook runtime could not start.");
}

if (!decided) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  child.on("error", () => deny("Atbash ERROR: the hook runtime could not start."));
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_CHILD_STDOUT_BYTES) overflow = true;
    else chunks.push(chunk);
  });
  child.stdout.on("error", () => {});
  child.stdin.on("error", () => {});
  // The host's tool-call payload, passed through unchanged.
  process.stdin.on("error", () => child.stdin.end());
  process.stdin.pipe(child.stdin);
  child.on("close", (code, signal) => {
    if (decided) return;
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (code === 0 && signal === null && !overflow) {
      if (stdout === "") {
        finish("");
        return;
      }
      const forwarded = childDeny(stdout);
      if (forwarded !== null) {
        finish(forwarded);
        return;
      }
    }
    deny("Atbash ERROR: the hook ended without a usable decision.");
  });
}
