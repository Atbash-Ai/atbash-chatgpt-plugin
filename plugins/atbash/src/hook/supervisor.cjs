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
//   - exit 0, an empty stdout AND the shim's permit sign on the private fd 3 pipe: the bundle's
//     explicit permit - nothing is written. The sign is written from the shim's exit listener, so
//     a child that ends 0 without running its listeners (process.reallyExit(0), a native exit(0))
//     has no sign and is denied: silence alone is never a permit;
//   - exit 0 with exactly one PreToolUse deny: that deny, re-serialized here;
//   - anything else - another exit code, a signal, unparseable or extra output, a child that
//     could not start, a child still running at the deadline: a deny with exit 0.
// The child's stderr is relayed to the host's stderr (the transcript), bounded, so the host's
// output handles are held by this process alone: a killed child whose teardown the OS defers (a
// scanner holding it in a kernel wait) cannot keep the host waiting for end-of-file.
//
// What this cannot close: a stall of THIS process before its timer is armed (node itself not
// starting) or while it starts the child (process creation held by a scanner in this process's
// context) - only the host timeout ends those; this file loads nothing but node built-ins.
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
// The child's log lines relayed to the host's stderr, in total. Written synchronously and kept,
// with the supervisor's own short reason lines, under the smallest pipe buffer a host hands a hook
// (4 KiB), so a host that never reads stderr cannot block this process's event loop - and with it
// the deadline. Lines past the bound are dropped with one note.
const MAX_STDERR_RELAY_BYTES = 2048;
// The shim's permit sign (src/hook/shim.cjs PERMIT_SIGN), on the private fd 3 pipe.
const PERMIT_SIGN = "atbash-permit\n";
const WRITE_RETRY_WAIT_MS = 25;
const WRITE_STALL_BUDGET_MS = 2000;
// The write to the host is bounded in wall-clock time as well as by the stall budget: a transport
// that keeps taking one byte between refusals is never "stalled", and a 900-byte deny through it
// took over 45 s in the shim before the shim got the same bound. No retry starts after this many
// ms of uptime - 1.5 s past the supervisor's latest possible deadline, 1.5 s under the host's 35 s.
const WRITE_CEILING_MS = MAX_DEADLINE_MS + SUPERVISOR_MARGIN_MS + 1500;

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

// The supervisor's deadline, in ms of this process's uptime.
const DEADLINE_AT_MS = shimDeadlineMs(process.env.ATBASH_HOOK_DEADLINE_MS) + SUPERVISOR_MARGIN_MS;

let decided = false;
let child = null;
let deadlineTimer = null;

function uptimeMs() {
  return Math.ceil(process.uptime() * 1000);
}

function writeAllSync(text) {
  // Every byte or an error, retried on EAGAIN without outliving the host's timeout (the shim's
  // writeDecisionSync, without its in-process adversary handling: nothing else runs here). The
  // first attempt always happens; retries stop at the stall budget or at the give-up: 1.5 s past
  // this run's deadline, or one stall budget after the first attempt if that is later, and never
  // past WRITE_CEILING_MS.
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  let attempts = 0;
  const firstAttempt = uptimeMs();
  const giveUp = Math.min(
    WRITE_CEILING_MS,
    Math.max(DEADLINE_AT_MS + 1500, firstAttempt + WRITE_STALL_BUDGET_MS),
  );
  let lastProgress = firstAttempt;
  while (offset < buffer.length) {
    if (attempts > 0) {
      const now = uptimeMs();
      if (now >= giveUp || now - lastProgress >= WRITE_STALL_BUDGET_MS) {
        throw Object.assign(new Error("the decision could not be written"), { code: "ETIMEDOUT" });
      }
    }
    attempts += 1;
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (!Number.isInteger(written) || written < 0 || written > buffer.length - offset) {
        throw Object.assign(new Error("impossible byte count"), { code: "EIO" });
      }
      if (written > 0) {
        offset += written;
        lastProgress = uptimeMs();
        continue;
      }
    } catch (error) {
      if (!(error && error.code === "EAGAIN")) throw error;
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
deadlineTimer = setTimeout(
  () => deny("Atbash ERROR: the safety check did not finish before the host's hook timeout."),
  Math.max(0, DEADLINE_AT_MS - uptimeMs()),
);

try {
  child = spawn(process.execPath, [path.join(__dirname, "pre-tool-use-shim.cjs")], {
    env: { ...process.env, ATBASH_HOOK_PERMIT_FD: "3" },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
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
  let sign = "";
  child.stdio[3].on("data", (chunk) => {
    if (sign.length <= PERMIT_SIGN.length) sign += chunk.toString("utf8");
  });
  child.stdio[3].on("error", () => {});
  let relayed = 0;
  child.stderr.on("data", (chunk) => {
    if (relayed >= MAX_STDERR_RELAY_BYTES) return;
    const room = MAX_STDERR_RELAY_BYTES - relayed;
    relayed += Math.min(chunk.length, room);
    try {
      writeSync(2, chunk.subarray(0, room));
      if (relayed >= MAX_STDERR_RELAY_BYTES) {
        writeSync(2, "\n[Atbash: further hook log lines were dropped]\n");
      }
    } catch {
      // the transcript is optional; the decision is on stdout
    }
  });
  child.stderr.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stdin.on("error", () => {});
  // The host's tool-call payload, passed through unchanged.
  process.stdin.on("error", () => child.stdin.end());
  process.stdin.pipe(child.stdin);
  child.on("close", (code, signal) => {
    if (decided) return;
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (code === 0 && signal === null && !overflow) {
      if (stdout === "" && sign === PERMIT_SIGN) {
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
