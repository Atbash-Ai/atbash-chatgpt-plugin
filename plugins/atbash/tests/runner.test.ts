import assert from "node:assert/strict";
import test from "node:test";

import type { Decision, ToolCallInput } from "@atbash/sdk";

import type { ToolCallGuard } from "../src/atbash/guard.js";
import { NOT_SET_UP_REASON, type SetupBootstrap } from "../src/hook/bootstrap.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

/** Stubbed so these tests never depend on what is configured on the machine running them. */
function bootstrap(configured: boolean, setupCall = false): SetupBootstrap {
  return { hasConfiguration: () => configured, isSetupCall: () => setupCall };
}

const missingConfiguration = () => {
  throw new Error("missing configuration");
};

function guardReturning(decision: Decision, calls: ToolCallInput[] = []): ToolCallGuard {
  return {
    async auditToolCall(input) {
      calls.push(input);
      return decision;
    },
  };
}

test("allows only a canonical ALLOW decision", async () => {
  const calls: ToolCallInput[] = [];
  const outcome = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: true, verdict: "ALLOW", reason: "within policy" }, calls),
  );

  assert.deepEqual(outcome, { allow: true, source: "atbash" });
  assert.deepEqual(calls, [
    {
      toolName: "Bash",
      args: { command: "git status --short" },
      context: "source=codex; workspace=example; model=gpt-test; permission_mode=default",
    },
  ]);
});

test("denies HOLD and includes its reference", async () => {
  const outcome = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({
      allow: false,
      verdict: "HOLD",
      reason: "operator review required",
      toolCallId: "call-123",
    }),
  );

  assert.deepEqual(outcome, {
    allow: false,
    verdict: "HOLD",
    reason: "Atbash HOLD: operator review required Reference: call-123.",
  });
});

test("denies BLOCK and inconsistent decisions", async () => {
  const blocked = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: false, verdict: "BLOCK", reason: "policy red line" }),
  );
  const inconsistent = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: true, verdict: "ERROR", reason: "unexpected" }),
  );

  assert.equal(blocked.allow, false);
  assert.equal(blocked.allow ? undefined : blocked.verdict, "BLOCK");
  assert.equal(inconsistent.allow, false);
  assert.equal(inconsistent.allow ? undefined : inconsistent.verdict, "ERROR");
});

test("fails closed on configuration and runtime errors", async () => {
  const configurationError = await evaluatePreToolUse(
    makeHookInput(),
    () => {
      throw new Error("contains-sensitive-config");
    },
    bootstrap(true),
  );
  const runtimeError = await evaluatePreToolUse(makeHookInput(), () => ({
    async auditToolCall() {
      throw new Error("contains-sensitive-runtime-data");
    },
  }));

  assert.deepEqual(configurationError, {
    allow: false,
    verdict: "ERROR",
    // Still a denial, and still says why — but now also says what to do, because
    // a hook trusted before setup denies setup's own calls and this reason is
    // the only thing the operator sees.
    reason:
      "Atbash ERROR: configuration is missing or invalid. Run the atbash-setup skill to configure this host, " +
      "or its launcher from a terminal if setup's own tool calls are denied.",
  });
  assert.deepEqual(runtimeError, {
    allow: false,
    verdict: "ERROR",
    reason: "Atbash ERROR: the safety check failed before a decision was returned.",
  });
});

test("judges every Atbash-named tool and fails closed without configuration", async () => {
  for (const toolName of [
    "mcp__atbash__status",
    "mcp__atbash__exec",
    "mcp__atbash__",
    "mcp__atbash_fake__status",
  ]) {
    const calls: ToolCallInput[] = [];
    const input = makeHookInput({ tool_name: toolName });
    const blocked = await evaluatePreToolUse(input, () =>
      guardReturning({ allow: false, verdict: "BLOCK", reason: "policy denial" }, calls),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, toolName);
    assert.equal(blocked.allow, false);
    assert.equal(blocked.allow ? undefined : blocked.verdict, "BLOCK");

    const invalid = await evaluatePreToolUse(input, missingConfiguration, bootstrap(true));
    assert.equal(invalid.allow, false);
    assert.equal(invalid.allow ? undefined : invalid.verdict, "ERROR");

    const unconfigured = await evaluatePreToolUse(input, missingConfiguration, bootstrap(false));
    assert.equal(unconfigured.allow, false);
    assert.equal(unconfigured.allow ? undefined : unconfigured.verdict, "ERROR");
  }
});

test("without any configuration, allows only setup calls", async () => {
  const setup = await evaluatePreToolUse(
    makeHookInput(),
    missingConfiguration,
    bootstrap(false, true),
  );
  const other = await evaluatePreToolUse(
    makeHookInput(),
    missingConfiguration,
    bootstrap(false, false),
  );

  assert.deepEqual(setup, { allow: true, source: "setup-bootstrap" });
  assert.deepEqual(other, { allow: false, verdict: "ERROR", reason: NOT_SET_UP_REASON });
});

// The narrowest part of the design: setup mode is for a machine that has never
// been set up. A configuration that exists but cannot be used stays fail closed,
// so a deleted or corrupted config can never widen what the guard permits.
test("an existing invalid configuration keeps setup calls fail closed", async () => {
  const outcome = await evaluatePreToolUse(
    makeHookInput(),
    missingConfiguration,
    bootstrap(true, true),
  );

  assert.equal(outcome.allow, false);
  assert.equal(outcome.allow ? undefined : outcome.verdict, "ERROR");
  assert.match(
    outcome.allow ? "" : outcome.reason,
    /configuration is missing or invalid/,
    "an invalid configuration must not report itself as not set up",
  );
});

test("a working configuration judges setup calls like any other call", async () => {
  const calls: ToolCallInput[] = [];
  const outcome = await evaluatePreToolUse(
    makeHookInput(),
    () => guardReturning({ allow: false, verdict: "BLOCK", reason: "policy" }, calls),
    bootstrap(false, true),
  );

  assert.equal(calls.length, 1);
  assert.equal(outcome.allow ? undefined : outcome.verdict, "BLOCK");
});

test("routes shell, patch, MCP, and other local tools through the guard", async () => {
  for (const toolName of ["Bash", "apply_patch", "mcp__github__get_issue", "view_image"]) {
    const calls: ToolCallInput[] = [];
    const outcome = await evaluatePreToolUse(makeHookInput({ tool_name: toolName }), () =>
      guardReturning({ allow: true, verdict: "ALLOW" }, calls),
    );

    assert.deepEqual(outcome, { allow: true, source: "atbash" });
    assert.equal(calls[0]?.toolName, toolName);
  }
});
