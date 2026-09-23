import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createECDH } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

interface Trace {
  configReads: number;
  blockedAccess: number;
  browser: number;
  server: number;
  network: number;
  queries: Array<{
    name: string;
    organization: string | null;
    publicKey: string | null;
    url: string;
  }>;
}

function invokePairing(fileOrg?: string, envOrg?: string) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "atbash-cli-organization-"));
  const configDir = join(fixtureRoot, ".config", "atbash");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "config.json");
  const config = JSON.stringify(fileOrg === undefined ? {} : { orgName: fileOrg });
  writeFileSync(configPath, config, { mode: 0o600 });
  const identity = createECDH("secp256k1");
  identity.generateKeys();
  const fixtureKey = identity.getPrivateKey("hex").padStart(64, "0");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("ATBASH_")),
  );
  Object.assign(env, {
    NODE_OPTIONS: "",
    PAIR_TEST_ROOT: fixtureRoot,
    ATBASH_AGENT_KEY: fixtureKey,
    ATBASH_ENDPOINT: "https://atbash.ai",
    ATBASH_BLOCKCHAIN_RID: "0163241d9af137638e63e48efcde15510f38c2426f7ad5dc726af60351bf4dfe",
    ATBASH_DEBUG: "0",
    ...(envOrg === undefined ? {} : { ATBASH_ORG_NAME: envOrg }),
  });
  const result = spawnSync(
    process.execPath,
    ["--require", resolve("tests/pairing-cli-preload.cjs"), "dist/pair.cjs"],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  // Never place the generated fixture key in assertion diagnostics.
  assert.equal(
    result.stdout.includes(fixtureKey) || result.stderr.includes(fixtureKey),
    false,
    "No fixture credential output",
  );
  assert.equal(result.error, undefined, "CLI must finish without a spawn error or timeout");
  assert.equal(result.status, 1, "Missing owner handoff must exit 1");
  assert.equal(readFileSync(configPath, "utf8"), config, "Existing configuration is preserved");
  const trace = JSON.parse(readFileSync(join(fixtureRoot, "trace.json"), "utf8")) as Trace;
  assert.equal(trace.blockedAccess, 0, "No real Atbash storage access");
  assert.equal(trace.network, 0, "No unmatched or actual network access");
  assert.equal(trace.browser, 0, "No browser invocation");
  assert.equal(trace.server, 0, "No callback server before owner authorization");
  return { result, trace, fixtureRoot, publicKey: identity.getPublicKey("hex", "compressed") };
}

for (const scenario of [
  {
    name: "configured organization cannot bypass the owner gate",
    file: "  file-org  ",
    env: undefined,
  },
  {
    name: "environment organization cannot bypass the owner gate",
    file: "file-org",
    env: "  env-org  ",
  },
]) {
  test(`packaged pairing CLI: ${scenario.name}`, () => {
    const { result, trace, fixtureRoot } = invokePairing(scenario.file, scenario.env);
    assert.match(result.stderr, /Owner-authenticated policy handoff is not available/);
    assert.deepEqual(trace.queries, []);
    assert.equal(existsSync(join(fixtureRoot, ".config", "atbash", "pairing")), false);
    if (scenario.env === undefined)
      assert.ok(trace.configReads > 0, "Real SDK config resolution was exercised");
  });
}

for (const scenario of [
  { name: "missing organization", file: undefined, env: undefined },
  { name: "blank configured organization", file: "   ", env: undefined },
  { name: "blank environment override", file: "file-org", env: "   " },
]) {
  test(`packaged pairing CLI refuses ${scenario.name} before queries`, () => {
    const { result, trace, fixtureRoot } = invokePairing(scenario.file, scenario.env);
    assert.match(result.stderr, /Owner-authenticated policy handoff is not available/);
    assert.deepEqual(trace.queries, []);
    assert.equal(existsSync(join(fixtureRoot, ".config", "atbash", "pairing")), false);
  });
}
