import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import {
  canonicalIntent,
  PAIRING_ORIGIN,
  signPairingIntent,
  verifyPairingIntent,
  type PairingIntent,
} from "../src/atbash/pairing-intent.js";

function fixture() {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const now = Date.now();
  const intent: PairingIntent = {
    version: 1,
    nonce: randomBytes(32).toString("hex"),
    origin: PAIRING_ORIGIN,
    publicKey: key.getPublicKey("hex", "compressed"),
    blockchainRid: "1".repeat(64),
    organization: "test-org",
    agentName: "test-agent",
    purpose: "Test enrollment",
    risk: "high",
    policyName: "test-policy",
    policyRevision: 1,
    policyVersion: "v1",
    compactHash: "2".repeat(64),
    extendedHash: "3".repeat(64),
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  return { intent, privateKey: key.getPrivateKey("hex"), now };
}

test("signs a domain-separated immutable intent using the local identity", () => {
  const { intent, privateKey, now } = fixture();
  const signed = signPairingIntent(intent, privateKey);
  assert.equal(verifyPairingIntent(signed, now), true);
  assert.equal(JSON.stringify(signed).includes(privateKey), false);
  intent.organization = "changed-after-signing";
  assert.equal(signed.intent.organization, "test-org");
  assert.equal(verifyPairingIntent(signed, now), true);
});

test("rejects substitution of every signed field", () => {
  const { intent, privateKey, now } = fixture();
  const signed = signPairingIntent(intent, privateKey);
  for (const field of Object.keys(intent) as (keyof PairingIntent)[]) {
    const value = intent[field];
    const changed = typeof value === "number" ? value + 1 : `${value}a`;
    assert.equal(
      verifyPairingIntent({ ...signed, intent: { ...intent, [field]: changed } }, now),
      false,
      field,
    );
  }
});

test("rejects expired, future, malformed and differently signed intents", () => {
  const { intent, privateKey, now } = fixture();
  const signed = signPairingIntent(intent, privateKey);
  assert.equal(verifyPairingIntent(signed, now - 1), false);
  assert.equal(verifyPairingIntent(signed, intent.expiresAt), false);
  assert.equal(verifyPairingIntent({ ...signed, signature: "0".repeat(128) }, now), false);
  assert.throws(() => signPairingIntent(intent, fixture().privateKey), /mismatch/);
  assert.throws(() => canonicalIntent({ ...intent, publicKey: `02${"f".repeat(64)}` }));
  assert.throws(() => canonicalIntent({ ...intent, policyRevision: 0 }));
  assert.throws(() => canonicalIntent({ ...intent, organization: "test\norg" }));
  assert.throws(() => canonicalIntent({ ...intent, expiresAt: now + 300_001 }));
  assert.equal(
    verifyPairingIntent({ ...signed, secret: "unexpected" } as typeof signed, now),
    false,
  );
  assert.equal(
    verifyPairingIntent(
      { ...signed, intent: { ...intent, unexpected: "field" } } as typeof signed,
      now,
    ),
    false,
  );
});
