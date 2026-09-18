import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gtv, Buffer as PcBuffer } from "postchain-client";
import { beginPairing } from "../src/atbash/pairing-session.js";
import { PAIRING_CHAIN } from "../src/atbash/pairing-chain.js";
import {
  PAIRING_ORIGIN,
  verifyPairingIntent,
  type SignedPairingIntent,
} from "../src/atbash/pairing-intent.js";

async function fixture(t: TestContext) {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const identity = {
    pubkey: key.getPublicKey("hex", "compressed"),
    privkey: key.getPrivateKey("hex").padStart(64, "0"),
    orgName: "test-org",
    endpoint: PAIRING_ORIGIN,
    blockchainRid: PAIRING_CHAIN.rid,
  };
  const stateRoot = await mkdtemp(join(tmpdir(), "atbash-pairing-session-"));
  const policy = {
    name: "safety",
    revision: 2,
    needs_reencryption: 0,
    policy_text: "stored-policy",
    extended_policy: "stored-extended",
  };
  const remote: { rows: Record<string, unknown>; unavailable: boolean; stall?: () => void } = {
    rows: {},
    unavailable: false,
  };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    assert.ok(PAIRING_CHAIN.nodes.some((node) => url === `${node}/query_gtv/${PAIRING_CHAIN.rid}`));
    if (remote.unavailable) throw new Error("Transport unavailable");
    if (remote.stall) {
      remote.stall();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(new Error("Aborted"));
        else signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    }
    const [name] = gtv.decode(PcBuffer.from(init!.body as Uint8Array)) as [string];
    const result =
      name === "get_org_account_id"
        ? PcBuffer.alloc(32, 7)
        : name === "get_org_policies"
          ? { default_policy_name: "safety" }
          : name === "get_org_agent_capacity"
            ? { max_agents: 1, active_count: 0, total_count: 0 }
            : name === "get_org_policy"
              ? policy
              : (remote.rows[name] ?? null);
    return new Response(new Uint8Array(gtv.encode(result as never)));
  });
  const start = async () => {
    const session = await beginPairing(identity, { stateRoot });
    t.after(() => session.close());
    const fragment = new URLSearchParams(new URL(session.browserUrl).hash.slice(1));
    const token = fragment.get("token")!;
    const post = (path: string) =>
      realFetch(`http://127.0.0.1:${fragment.get("port")}${path}`, {
        method: "POST",
        headers: {
          Origin: PAIRING_ORIGIN,
          "Content-Type": "application/json",
          "X-Atbash-Pairing": token,
        },
        body: "{}",
      });
    const response = await post("/intent");
    assert.equal(response.status, 200);
    const signed = (await response.json()) as SignedPairingIntent;
    assert.equal(verifyPairingIntent(signed), true);
    return { session, post, signed, token };
  };
  const register = (signed: SignedPairingIntent) => {
    const i = signed.intent;
    remote.rows = {
      get_agent_by_pubkey: {
        pubkey: PcBuffer.from(i.publicKey, "hex"),
        org_name: i.organization,
        name: i.agentName,
        purpose: i.purpose,
        risk: i.risk,
        is_jailed: 0,
        policy_name: i.policyName,
        follows_org_default: 0,
        policy_source_name: i.policyName,
        policy_source_revision: i.policyRevision,
        policy_version: i.policyVersion,
      },
      get_agent_governance_hashes: {
        policy_hash: PcBuffer.from(i.compactHash, "hex"),
        extended_policy_hash: PcBuffer.from(i.extendedHash, "hex"),
        policy_version: i.policyVersion,
        is_custom_policy: 1,
      },
      get_agent_tier_info: {
        agent_pubkey: PcBuffer.from(i.publicKey, "hex"),
        org_name: i.organization,
        active: 1,
        shadow_mode_active: 0,
        verdict_enabled: 1,
        enforcement_enabled: 1,
        enforcement_mode: "enforce",
      },
    };
  };
  const stateFile = join(
    stateRoot,
    createHash("sha256").update(identity.pubkey).digest("hex"),
    "state.json",
  );
  const stored = () => readFile(stateFile, "utf8");
  return { identity, stateRoot, stateFile, policy, remote, start, register, stored };
}

test("real pairing orchestration requires chain evidence before persisting success and rechecks on resume", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  assert.equal((await first.post("/verify")).status, 503);
  assert.equal(await first.session.verified(), false);
  await assert.rejects(beginPairing(f.identity, { stateRoot: f.stateRoot }));
  f.register(first.signed);
  assert.equal((await first.post("/verify")).status, 200);
  assert.equal(await first.session.verified(), true);
  const persisted = await f.stored();
  assert.equal(persisted.includes(f.identity.privkey), false);
  assert.equal(persisted.includes(first.token), false);
  await first.session.close();
  const resumed = await f.start();
  assert.equal(resumed.signed.intent.publicKey, first.signed.intent.publicKey);
  assert.notEqual(resumed.signed.intent.nonce, first.signed.intent.nonce);
  assert.equal(await resumed.session.verified(), false);
  assert.equal((await resumed.post("/verify")).status, 200);
  assert.equal(await resumed.session.verified(), true);
});

test("policy drift on resume cannot replace the saved enrollment expectations", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await first.session.close();
  const before = await f.stored();
  f.policy.revision++;
  await assert.rejects(
    beginPairing(f.identity, { stateRoot: f.stateRoot }),
    /expectations changed/,
  );
  assert.equal(await f.stored(), before);
});

test("tampering with the unsigned progress phase cannot claim verified enrollment", async (t) => {
  const f = await fixture(t);
  const attempt = await f.start();
  const state = JSON.parse(await f.stored());
  state.phase = "verified";
  await writeFile(f.stateFile, JSON.stringify(state), "utf8");
  assert.equal(await attempt.session.verified(), false);
});

test("wrong identity, wrong policy, paused enforcement and unreachable chain never persist verified", async (t) => {
  const f = await fixture(t);
  const attempt = await f.start();
  for (const [query, field, value] of [
    ["get_agent_by_pubkey", "pubkey", PcBuffer.alloc(33, 2)],
    ["get_agent_by_pubkey", "policy_source_revision", 99],
    ["get_agent_tier_info", "active", 0],
  ] as const) {
    f.register(attempt.signed);
    (f.remote.rows[query] as Record<string, unknown>)[field] = value;
    assert.equal((await attempt.post("/verify")).status, 409);
    assert.equal(await attempt.session.verified(), false);
    assert.notEqual(JSON.parse(await f.stored()).phase, "verified");
  }
  f.register(attempt.signed);
  f.remote.unavailable = true;
  assert.equal((await attempt.post("/verify")).status, 503);
  assert.notEqual(JSON.parse(await f.stored()).phase, "verified");
  assert.ok((await readdir(f.stateRoot)).length > 0);
});

test("expired enrollment cannot persist verified even with matching chain evidence", async (t) => {
  const f = await fixture(t);
  const attempt = await f.start();
  f.register(attempt.signed);
  t.mock.method(Date, "now", () => attempt.signed.intent.expiresAt + 1);
  assert.equal((await attempt.post("/verify")).status, 410);
  assert.notEqual(JSON.parse(await f.stored()).phase, "verified");
});

test("closing during remote verification aborts readback and never persists success", async (t) => {
  const f = await fixture(t);
  const attempt = await f.start();
  f.register(attempt.signed);
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.remote.stall = observed;
  const response = attempt.post("/verify").catch(() => null);
  await started;
  await attempt.session.close();
  await response;
  assert.notEqual(JSON.parse(await f.stored()).phase, "verified");
});

test("abort during verified-state persistence never establishes session confirmation", async (t) => {
  const f = await fixture(t);
  const attempt = await f.start();
  f.register(attempt.signed);
  const realRename = fsPromises.rename;
  let release!: () => void;
  let observed!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const mock = t.mock.method(
    fsPromises,
    "rename",
    async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (JSON.parse(await f.stored()).phase === "verified") {
        observed();
        await delayed;
      }
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    release();
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  const response = attempt.post("/verify");
  await written;
  // Exercise the real server's bounded verification timeout while the durable
  // write has completed but its asynchronous completion is still pending.
  assert.equal((await response).status, 503);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await attempt.session.verified(), false);
});
