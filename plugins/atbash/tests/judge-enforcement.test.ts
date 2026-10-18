/**
 * A judge answer the SDK did not check must never permit a tool call.
 *
 * The audit tier answers `{"status":"logged"}`: the call was recorded, not judged. SDKs without
 * H6 (atbash-sdk 509f1db) turned that into allow:true / verdict "ALLOW", so the hook let an
 * unchecked tool run. Both builds are covered: the prod SDK (`@atbash/sdk`) and the dev alias
 * (`@atbash/sdk-dev`) the dev marketplace build bundles instead.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import * as prodSdk from "@atbash/sdk";

import { createAtbashGuard, type ToolCallGuard } from "../src/atbash/guard.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

type Sdk = typeof prodSdk;
const devSdk = createRequire(import.meta.url)("@atbash/sdk-dev") as Sdk;

const sdks: ReadonlyArray<{ label: string; sdk: Sdk }> = [
  { label: "prod SDK", sdk: prodSdk },
  { label: "dev SDK", sdk: devSdk },
];

const scenarios = [
  {
    name: "allows an explicit ALLOW verdict",
    body: { verdict: "ALLOW", action_type: "allow", reason: "checked control" },
    allow: true,
  },
  {
    name: "fails closed on a response without a verdict",
    body: {},
    allow: false,
  },
  {
    name: "fails closed on an audit-tier response without a verdict",
    body: { status: "logged" },
    allow: false,
  },
] as const;

type Scenario = (typeof scenarios)[number];

const UNCHECKED = /logged this action but did not check it.*requires a checked decision/;

async function withLoopbackJudge(
  body: unknown,
  run: (endpoint: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "atbash-judge-enforcement-"));
  const names = [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "HONEYCOMB_API_KEY",
    ...Object.keys(process.env).filter((name) => name.startsWith("ATBASH_")),
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.method !== "POST" || request.url !== "/api/v1/judge") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  try {
    for (const name of names) delete process.env[name];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.HONEYCOMB_API_KEY = "";
    // Throwaway local configuration only; SDK telemetry must not contact an exporter.
    mkdirSync(join(home, ".config", "atbash"), { recursive: true });
    writeFileSync(join(home, ".config", "atbash", "telemetry.json"), '{"enabled":false}');
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// Only the chain log is stubbed. SDK signing, HTTP parsing, the decision and the plugin checks are real.
function stubChainLog(t: TestContext, client: object): void {
  t.mock.method(client as { logToolCall: () => Promise<unknown> }, "logToolCall", async () => ({
    success: true,
    toolCallId: "enforcement-test-call",
    signedHex: "00",
  }));
}

function assertOutcome(
  scenario: Scenario,
  outcome: Awaited<ReturnType<typeof evaluatePreToolUse>>,
  requests: string[],
): void {
  assert.deepEqual(requests, ["POST /api/v1/judge"], "only the loopback judge was called");
  assert.equal(outcome.allow, scenario.allow);
  if (outcome.allow) {
    assert.deepEqual(outcome, { allow: true, source: "atbash" });
    return;
  }
  assert.equal(outcome.verdict, "ERROR");
  if ("status" in scenario.body) assert.match(outcome.reason, UNCHECKED);
}

for (const { label, sdk } of sdks) {
  for (const scenario of scenarios) {
    test(`${label}: judge ${scenario.name}`, async (t) => {
      await withLoopbackJudge(scenario.body, async (endpoint, requests) => {
        const client = sdk.Atbash.fromConfig({
          agentKey: sdk.generateKeypair().priv_key,
          judge: { endpoint },
          failClosed: true,
          timeoutMs: 30_000,
        });
        stubChainLog(t, client);
        const outcome = await evaluatePreToolUse(makeHookInput(), () => client);
        assertOutcome(scenario, outcome, requests);
      });
    });
  }
}

for (const scenario of scenarios) {
  test(`plugin guard: judge ${scenario.name}`, async (t) => {
    await withLoopbackJudge(scenario.body, async (endpoint, requests) => {
      process.env.ATBASH_ENDPOINT = endpoint;
      process.env.ATBASH_AGENT_KEY = prodSdk.generateKeypair().priv_key;
      const guard: ToolCallGuard = createAtbashGuard();
      stubChainLog(t, guard);
      const outcome = await evaluatePreToolUse(makeHookInput(), () => guard);
      assertOutcome(scenario, outcome, requests);
    });
  });
}
