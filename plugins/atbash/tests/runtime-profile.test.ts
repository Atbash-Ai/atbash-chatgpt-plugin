import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";
import { resolveGuardConfiguration } from "../src/atbash/guard.js";
import { loadSelectedRuntimeProfile } from "../src/control/runtime-profile.js";
import { ControlStore } from "../src/control/store.js";

test("selected host profile resolves a matching local credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-runtime-profile-"));
  const keypair = generateKeypair();
  const store = new ControlStore(root);
  await store.activate({
    credential: {
      schemaVersion: 1,
      credentialId: "credential-one",
      agentPrivateKey: keypair.priv_key,
      agentPubkey: keypair.pub_key,
      createdAt: "2099-01-01T00:00:00.000Z",
    },
    profile: {
      schemaVersion: 1,
      profileId: "codex-one",
      credentialId: "credential-one",
      host: "codex",
      organization: "Acme",
      network: "public",
      agentPubkey: keypair.pub_key,
      serviceOrigin: "https://atbash.ai",
      createdAt: "2099-01-01T00:00:00.000Z",
    },
  });

  const previousRoot = process.env.ATBASH_CONFIG_DIR;
  const previousKey = process.env.ATBASH_AGENT_KEY;
  const previousOrg = process.env.ATBASH_ORG_NAME;
  process.env.ATBASH_CONFIG_DIR = root;
  delete process.env.ATBASH_AGENT_KEY;
  delete process.env.ATBASH_ORG_NAME;
  try {
    const profile = loadSelectedRuntimeProfile("codex");
    assert.equal(profile?.profileId, "codex-one");
    assert.equal(profile?.agentPubkey, keypair.pub_key);
    assert.equal(profile?.orgName, "Acme");
    assert.equal(profile?.agentKey, keypair.priv_key);

    // The guard must actually USE that profile. Setup writes a profile, which
    // is not a shape the SDK's own configuration resolution reads — so without
    // this wiring a completed setup leaves the guard reporting "configuration
    // is missing or invalid" forever, and the plugin can never work.
    const configuration = resolveGuardConfiguration("codex");
    assert.equal(configuration.source, "profile");
    assert.equal(configuration.profileId, "codex-one");
    assert.equal(configuration.agentKey, keypair.priv_key);
    assert.equal(configuration.orgName, "Acme");

    process.env.ATBASH_ORG_NAME = "OtherOrg";
    assert.throws(() => loadSelectedRuntimeProfile("codex"), /conflicts/);
  } finally {
    if (previousRoot === undefined) delete process.env.ATBASH_CONFIG_DIR;
    else process.env.ATBASH_CONFIG_DIR = previousRoot;
    if (previousKey === undefined) delete process.env.ATBASH_AGENT_KEY;
    else process.env.ATBASH_AGENT_KEY = previousKey;
    if (previousOrg === undefined) delete process.env.ATBASH_ORG_NAME;
    else process.env.ATBASH_ORG_NAME = previousOrg;
  }
});
