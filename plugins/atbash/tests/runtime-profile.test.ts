import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";
import {
  createAtbashGuard,
  resolveGuardConfiguration,
  type FromConfig,
} from "../src/atbash/guard.js";
import { createStatusClient } from "../src/atbash/status.js";
import { loadSelectedRuntimeProfile } from "../src/control/runtime-profile.js";
import { ControlStore } from "../src/control/store.js";

type Keypair = ReturnType<typeof generateKeypair>;

/** Runs `body` with a codex profile for org "Acme" selected under a throwaway config root. */
async function withSelectedProfile(
  body: (keypair: Keypair) => void | Promise<void>,
): Promise<void> {
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
    await body(keypair);
  } finally {
    if (previousRoot === undefined) delete process.env.ATBASH_CONFIG_DIR;
    else process.env.ATBASH_CONFIG_DIR = previousRoot;
    if (previousKey === undefined) delete process.env.ATBASH_AGENT_KEY;
    else process.env.ATBASH_AGENT_KEY = previousKey;
    if (previousOrg === undefined) delete process.env.ATBASH_ORG_NAME;
    else process.env.ATBASH_ORG_NAME = previousOrg;
  }
}

test("selected host profile resolves a matching local credential", () =>
  withSelectedProfile((keypair) => {
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
    // Status, which setup continue reports as agentStatus, runs as the same agent.
    assert.equal(createStatusClient().pubkey, keypair.pub_key);

    process.env.ATBASH_ORG_NAME = "OtherOrg";
    assert.throws(() => loadSelectedRuntimeProfile("codex"), /conflicts/);
  }));

test("a guard built from the selected profile requires a checked judge decision", () =>
  withSelectedProfile((keypair) => {
    // Every user who finished setup runs on this path; an audit-tier answer must never permit here either.
    const seen: Parameters<FromConfig>[0][] = [];
    const fromConfig = ((options: Parameters<FromConfig>[0]) => {
      seen.push(options);
      return {} as ReturnType<FromConfig>;
    }) as FromConfig;
    createAtbashGuard("codex", fromConfig);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.requireEnforcement, true);
    assert.equal(seen[0]?.failClosed, true);
    assert.equal(seen[0]?.agentKey, keypair.priv_key);
    assert.equal(seen[0]?.orgName, "Acme");
  }));
