import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPairingState } from "../src/atbash/pairing-state.js";
import { PAIRING_ORIGIN, signPairingIntent } from "../src/atbash/pairing-intent.js";

function signedFixture() {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const secret = key.getPrivateKey("hex").padStart(64, "0");
  const signed = signPairingIntent(
    {
      version: 1,
      nonce: randomBytes(32).toString("hex"),
      origin: PAIRING_ORIGIN,
      publicKey: key.getPublicKey("hex", "compressed"),
      blockchainRid: "1".repeat(64),
      organization: "test-org",
      agentName: "test-agent",
      purpose: "Test enrollment",
      risk: "high",
      policyName: "safety",
      policyRevision: 1,
      policyVersion: "safety@rev1",
      compactHash: "2".repeat(64),
      extendedHash: "3".repeat(64),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    secret,
  );
  return { signed, secret };
}

test("keeps identity-scoped exclusive state and resumes interrupted verification without changing identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atbash-pairing-state-"));
  const { signed, secret } = signedFixture();
  const first = await openPairingState(root, signed.intent.publicKey);
  t.after(() => first.close());
  assert.equal(await first.read(), null);
  await first.save({ phase: "prepared", signed });
  await assert.rejects(openPairingState(root, signed.intent.publicKey));
  await first.save({ phase: "verifying", signed });
  await first.close();
  const resumed = await openPairingState(root, signed.intent.publicKey);
  t.after(() => resumed.close());
  assert.deepEqual(await resumed.read(), { phase: "verifying", signed });
  await resumed.save({ phase: "verified", signed });
  assert.equal((await resumed.read())?.phase, "verified");
  const stateDir = (await readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name))!;
  assert.equal(
    (await readFile(join(root, stateDir, "state.json"), "utf8")).includes(secret),
    false,
  );
});

test("does not write a substituted identity or extra private response fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atbash-pairing-state-"));
  const { signed } = signedFixture();
  const state = await openPairingState(root, signed.intent.publicKey);
  t.after(() => state.close());
  await assert.rejects(state.save({ phase: "prepared", signed: signedFixture().signed }));
  await state.save({ phase: "prepared", signed });
  await state.close();
  await assert.rejects(state.save({ phase: "verified", signed }));
  assert.equal(state.signal.aborted, true);
});
