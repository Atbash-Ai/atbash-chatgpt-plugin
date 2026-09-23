import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginPairing } from "../src/atbash/pairing-session.js";
import { PAIRING_CHAIN } from "../src/atbash/pairing-chain.js";
import { PAIRING_ORIGIN } from "../src/atbash/pairing-intent.js";

test("pairing requires an authenticated owner handoff before state or chain access", async (t) => {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const stateRoot = join(tmpdir(), `atbash-owner-gate-${randomBytes(12).toString("hex")}`);
  let chainRequests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    chainRequests++;
    throw new Error("The test must never contact a chain without owner authorization.");
  });
  let session: Awaited<ReturnType<typeof beginPairing>> | undefined;
  try {
    session = await beginPairing(
      {
        pubkey: key.getPublicKey("hex", "compressed"),
        privkey: key.getPrivateKey("hex").padStart(64, "0"),
        orgName: "test-org",
        endpoint: PAIRING_ORIGIN,
        blockchainRid: PAIRING_CHAIN.rid,
      },
      { stateRoot },
    );
  } catch (error) {
    assert.match(String(error), /owner-authenticated policy handoff/i);
  } finally {
    await session?.close();
  }
  assert.equal(session, undefined, "pairing must remain unavailable without owner authorization");
  assert.equal(chainRequests, 0, "no public owner ID or policy query may run");
  assert.equal(
    existsSync(stateRoot),
    false,
    "no pairing state is created before owner authorization",
  );
});
