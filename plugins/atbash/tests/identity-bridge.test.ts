/**
 * The plugin must keep signing as the key SDK 0.9.2 chose: a non-empty ATBASH_AGENT_KEY, else
 * config.json's agentKey, else the SDK key file. Newer SDKs dropped config.json from that order, so
 * without the plugin passing the key explicitly, config.json-only installs would be denied on every
 * tool call and their status would read configuration_error.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair, type Atbash } from "@atbash/sdk";

import {
  createAtbashGuard,
  resolveAgentKey,
  type FromConfig,
  type ToolCallGuard,
} from "../src/atbash/guard.js";
import { createStatusClient } from "../src/atbash/status.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

type FromConfigOptions = Parameters<FromConfig>[0];

/** Runs `body` with a throwaway home, optional config.json agentKey and optional env key. */
function withIdentity(
  setup: { configKey?: string; envKey?: string },
  body: () => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "atbash-identity-"));
    const names = [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "HONEYCOMB_API_KEY",
      ...Object.keys(process.env).filter((name) => name.startsWith("ATBASH_")),
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.HONEYCOMB_API_KEY = "";
      const configDir = join(home, ".config", "atbash");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "telemetry.json"), '{"enabled":false}');
      if (setup.configKey !== undefined)
        writeFileSync(
          join(configDir, "config.json"),
          JSON.stringify({ agentKey: setup.configKey }),
        );
      if (setup.envKey !== undefined) process.env.ATBASH_AGENT_KEY = setup.envKey;
      await body();
    } finally {
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function capture(): { calls: FromConfigOptions[]; fromConfig: FromConfig } {
  const calls: FromConfigOptions[] = [];
  const fromConfig = ((options: FromConfigOptions) => {
    calls.push(options);
    return { pubkey: "stub", async auditToolCall() {} } as unknown as Atbash;
  }) as FromConfig;
  return { calls, fromConfig };
}

const pubkeyOf = (client: ToolCallGuard | { pubkey: string }) =>
  String((client as { pubkey: string }).pubkey).toLowerCase();

test("resolveAgentKey trims and treats empty or whitespace as absent", () => {
  assert.equal(resolveAgentKey(""), undefined);
  assert.equal(resolveAgentKey("   "), undefined);
  assert.equal(resolveAgentKey(" abc "), "abc");
});

test(
  "the guard always requires a checked decision and fails closed",
  withIdentity({}, () => {
    const { calls, fromConfig } = capture();
    createAtbashGuard("codex", fromConfig);
    assert.equal(calls.length, 1);
    // Read through a widened type: SDK 0.9.2's options type has no requireEnforcement field.
    const options = calls[0] as Record<string, unknown> | undefined;
    assert.equal(options?.requireEnforcement, true);
    assert.equal(calls[0]?.failClosed, true);
    assert.equal("agentKey" in (calls[0] ?? {}), false, "no key configured, none passed");
  }),
);

for (const [label, setup, expected] of [
  ["config.json only", { configKey: "cfg-key" }, "cfg-key"],
  ["env over config.json", { configKey: "cfg-key", envKey: "env-key" }, "env-key"],
  ["empty env falls back to config.json", { configKey: "cfg-key", envKey: "" }, "cfg-key"],
  ["whitespace config.json is absent", { configKey: "   " }, undefined],
] as const) {
  test(
    `guard and status pass the 0.9.2 key: ${label}`,
    withIdentity(setup, () => {
      const guard = capture();
      const status = capture();
      createAtbashGuard("codex", guard.fromConfig);
      createStatusClient(status.fromConfig);
      for (const options of [guard.calls[0], status.calls[0]]) {
        assert.equal(options?.agentKey, expected);
        assert.equal(options?.failClosed, true);
      }
    }),
  );
}

{
  const configured = generateKeypair();
  const environment = generateKeypair();

  test(
    "real SDK: a config.json-only install signs as its config.json key",
    withIdentity({ configKey: configured.priv_key }, () => {
      assert.equal(pubkeyOf(createAtbashGuard()), configured.pub_key.toLowerCase());
      assert.equal(pubkeyOf(createStatusClient()), configured.pub_key.toLowerCase());
    }),
  );

  test(
    "real SDK: ATBASH_AGENT_KEY still wins over config.json",
    withIdentity({ configKey: configured.priv_key, envKey: environment.priv_key }, () => {
      assert.equal(pubkeyOf(createAtbashGuard()), environment.pub_key.toLowerCase());
      assert.equal(pubkeyOf(createStatusClient()), environment.pub_key.toLowerCase());
    }),
  );

  test(
    "real SDK: an empty ATBASH_AGENT_KEY falls back to config.json",
    withIdentity({ configKey: configured.priv_key, envKey: "" }, () => {
      assert.equal(pubkeyOf(createAtbashGuard()), configured.pub_key.toLowerCase());
      assert.equal(pubkeyOf(createStatusClient()), configured.pub_key.toLowerCase());
    }),
  );

  test(
    "real SDK: no key anywhere fails closed with the generic configuration denial",
    withIdentity({}, async () => {
      assert.throws(() => createAtbashGuard());
      assert.throws(() => createStatusClient());
      assert.deepEqual(await evaluatePreToolUse(makeHookInput()), {
        allow: false,
        verdict: "ERROR",
        reason: "Atbash ERROR: configuration is missing or invalid.",
      });
    }),
  );
}
