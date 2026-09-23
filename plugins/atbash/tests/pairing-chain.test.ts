import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import test from "node:test";
import { gtv, Buffer as PcBuffer } from "postchain-client";
import {
  PAIRING_CHAIN,
  createPairingQuery,
  pairingQuery,
  verifyPairingChain,
  type PairingQuery,
} from "../src/atbash/pairing-chain.js";
import { PAIRING_ORIGIN, type PairingIntent } from "../src/atbash/pairing-intent.js";

function fixture() {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const publicKey = key.getPublicKey("hex", "compressed");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const intent: PairingIntent = {
    version: 1,
    nonce: "1".repeat(64),
    origin: PAIRING_ORIGIN,
    publicKey,
    blockchainRid: PAIRING_CHAIN.rid,
    organization: "test-org",
    agentName: "test-agent",
    purpose: "Test enrollment",
    risk: "high",
    policyName: "safety",
    policyRevision: 2,
    policyVersion: "safety@rev2",
    compactHash: hash("stored-policy"),
    extendedHash: hash("stored-extended"),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const rows: Record<string, Record<string, unknown>> = {
    get_agent_by_pubkey: {
      pubkey: Buffer.from(publicKey, "hex"),
      org_name: intent.organization,
      name: intent.agentName,
      purpose: intent.purpose,
      risk: intent.risk,
      is_jailed: false,
      policy_name: "safety",
      follows_org_default: false,
      policy_source_name: "safety",
      policy_source_revision: 2,
      policy_version: "safety@rev2",
    },
    get_agent_governance_hashes: {
      policy_hash: Buffer.from(intent.compactHash, "hex"),
      extended_policy_hash: Buffer.from(intent.extendedHash, "hex"),
      policy_version: "safety@rev2",
      is_custom_policy: true,
    },
    get_agent_tier_info: {
      agent_pubkey: Buffer.from(publicKey, "hex"),
      org_name: intent.organization,
      active: true,
      shadow_mode_active: false,
      verdict_enabled: true,
      enforcement_enabled: true,
      enforcement_mode: "enforce",
    },
  };
  const query: PairingQuery = async (name) => rows[name];
  return { intent, rows, query };
}

test("encodes query bytes and decodes HTTP response bytes through the actual GTV codec", async (t) => {
  const key = Buffer.alloc(33, 2);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, `${PAIRING_CHAIN.nodes[0]}/query_gtv/${PAIRING_CHAIN.rid}`);
    assert.equal(init.redirect, "error");
    const decoded = gtv.decode(PcBuffer.from(init.body as Uint8Array)) as unknown[];
    assert.equal(decoded[0], "get_agent_by_pubkey");
    assert.equal(PcBuffer.isBuffer((decoded[1] as Record<string, unknown>).pubkey), true);
    return new Response(new Uint8Array(gtv.encode(null)), { status: 200 });
  });
  assert.equal(await pairingQuery("get_agent_by_pubkey", { pubkey: key }), null);
});

test("pairing query transport refuses owner-scoped names before network access", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Unexpected chain request.");
  });
  const query = createPairingQuery(PAIRING_ORIGIN);
  for (const name of [
    "get_org_account_id",
    "get_org_policy",
    "get_org_policies",
    "get_org_agent_capacity",
  ]) {
    await assert.rejects(
      query(name as Parameters<PairingQuery>[0], {}),
      /Unsupported pairing query/,
    );
  }
  assert.equal(calls, 0);
});

test("accepts exact chain readback including GTV-decoded byte fields", async () => {
  const { intent, rows } = fixture();
  const query: PairingQuery = async (name) => {
    const wire = Object.fromEntries(
      Object.entries(rows[name]!).map(([field, value]) => [
        field,
        Buffer.isBuffer(value) ? PcBuffer.from(value) : value,
      ]),
    );
    return gtv.decode(gtv.encode(wire as never));
  };
  assert.equal(await verifyPairingChain(intent, query), true);
});

test("rejects substitution or absence of every required chain field", async () => {
  const baseline = fixture();
  for (const [name, row] of Object.entries(baseline.rows)) {
    for (const [field, value] of Object.entries(row)) {
      const original = row[field];
      row[field] =
        typeof value === "boolean"
          ? !value
          : typeof value === "number"
            ? value + 1
            : Buffer.isBuffer(value)
              ? Buffer.alloc(value.length)
              : "substituted";
      assert.equal(
        await verifyPairingChain(baseline.intent, baseline.query),
        false,
        `${name}.${field}`,
      );
      delete row[field];
      assert.equal(
        await verifyPairingChain(baseline.intent, baseline.query).catch(() => false),
        false,
        `missing ${name}.${field}`,
      );
      row[field] = original;
    }
  }
});

test("refuses wrong chain and expired enrollment before querying", async () => {
  const { intent } = fixture();
  let calls = 0;
  const query: PairingQuery = async () => {
    calls++;
    throw new Error("unreachable");
  };
  assert.equal(
    await verifyPairingChain({ ...intent, blockchainRid: "0".repeat(64) }, query),
    false,
  );
  assert.equal(await verifyPairingChain({ ...intent, expiresAt: Date.now() - 1 }, query), false);
  assert.equal(calls, 0);
  await assert.rejects(verifyPairingChain(intent, query));
});
