import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createECDH, randomBytes } from "node:crypto";
import { signPairingIntent } from "../src/atbash/pairing-intent.js";
import { startPairingServer } from "../src/atbash/pairing-server.js";

const origin = "https://chromia-verified-ai-dev-two.vercel.app";
type Helper = Awaited<ReturnType<typeof startPairingServer>>;
function call(
  helper: Helper,
  overrides: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        helper.endpoint + (overrides.path ?? "/intent"),
        {
          method: overrides.method ?? "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Atbash-Pairing": helper.capability,
            ...overrides.headers,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.end(overrides.body ?? "{}");
    },
  );
}
function signedFixture() {
  const key = createECDH("secp256k1");
  key.generateKeys();
  return signPairingIntent(
    {
      version: 1,
      nonce: randomBytes(32).toString("hex"),
      origin,
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
      expiresAt: Date.now() + 30_000,
    },
    key.getPrivateKey("hex"),
  );
}
async function fixture(verify: (signal: AbortSignal) => Promise<boolean> = async () => false) {
  const publicIntent = signedFixture();
  return startPairingServer({
    origin,
    publicIntent,
    expiresAt: publicIntent.intent.expiresAt,
    verify,
  });
}

test("serves one immutable public intent over a real loopback connection", async (t) => {
  const helper = await fixture();
  t.after(helper.close);
  assert.match(helper.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await call(helper);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).intent.agentName, "test-agent");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes(helper.capability), false);
});

test("rejects hostile origins, rebinding hosts, capabilities and simple form requests", async (t) => {
  const helper = await fixture();
  t.after(helper.close);
  for (const headers of [
    { Origin: "https://evil.invalid" },
    { Origin: "null" },
    { Origin: "" },
    { Host: "localhost" },
    { Host: "evil.invalid" },
    { "X-Atbash-Pairing": "" },
    { "X-Atbash-Pairing": "0".repeat(64) },
    { "Content-Type": "text/plain" },
  ])
    assert.equal((await call(helper, { headers })).status, 403);
  assert.equal((await call(helper, { method: "GET" })).status, 403);
  assert.equal((await call(helper, { path: `/intent?token=${helper.capability}` })).status, 404);
});

test("preflight does not authorize POST or call verification", async (t) => {
  let calls = 0;
  const helper = await fixture(async () => {
    calls++;
    return true;
  });
  t.after(helper.close);
  const preflight = {
    method: "OPTIONS",
    headers: {
      "X-Atbash-Pairing": "",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-atbash-pairing, content-type",
    },
  };
  const allowed = await call(helper, preflight);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], origin);
  assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
  assert.equal(
    (
      await call(helper, {
        ...preflight,
        headers: { ...preflight.headers, "Access-Control-Request-Headers": "authorization" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(helper, { path: "/verify", headers: { "X-Atbash-Pairing": "" } })).status,
    403,
  );
  assert.equal(calls, 0);
});

test("browser completion cannot assert success or submit a different tuple", async (t) => {
  const helper = await fixture();
  t.after(helper.close);
  assert.equal((await call(helper, { path: "/verify", body: '{"verified":true}' })).status, 413);
  const response = await call(helper, { path: "/verify" });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { verified: false });
  assert.equal((await call(helper)).status, 200);
});

test("serializes verification and consumes the capability only after independent success", async (t) => {
  let release!: (value: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const helper = await fixture(() => {
    entered();
    return new Promise<boolean>((resolve) => {
      release = resolve;
    });
  });
  t.after(helper.close);
  const first = call(helper, { path: "/verify" });
  await started;
  assert.equal((await call(helper, { path: "/verify" })).status, 409);
  release(true);
  assert.equal((await first).status, 200);
  assert.equal((await call(helper, { path: "/verify" })).status, 200);
  assert.equal((await call(helper)).status, 410);
});

test("readback errors are sanitized and do not consume the pairing", async (t) => {
  const helper = await fixture(async () => {
    throw new Error("secret diagnostic");
  });
  t.after(helper.close);
  const response = await call(helper, { path: "/verify" });
  assert.equal(response.status, 503);
  assert.equal(response.body.includes("secret"), false);
  assert.equal((await call(helper)).status, 200);
});

test("slow readback survives the upload timeout and success can be retrieved without repeating verification", async (t) => {
  let calls = 0;
  const helper = await fixture(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    return true;
  });
  t.after(helper.close);
  assert.equal((await call(helper, { path: "/verify" })).status, 200);
  assert.deepEqual(JSON.parse((await call(helper, { path: "/verify" })).body), { verified: true });
  assert.equal(calls, 1);
});

test("closing the helper aborts in-flight verification", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  const helper = await fixture((value) => {
    signal = value;
    entered();
    return new Promise<boolean>((_, reject) =>
      value.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
  });
  const pending = assert.rejects(call(helper, { path: "/verify" }));
  await started;
  helper.close();
  await pending;
  assert.equal(signal?.aborted, true);
});

test("rejects extra private fields, invalid signatures and mismatched signed expiry before listening", async () => {
  const signed = signedFixture();
  for (const publicIntent of [
    { ...signed, privateKey: "must-never-be-returned" },
    { ...signed, intent: { ...signed.intent, privateKey: "must-never-be-returned" } },
    { ...signed, signature: "0".repeat(128) },
  ])
    await assert.rejects(
      startPairingServer({
        origin,
        publicIntent,
        expiresAt: signed.intent.expiresAt,
        verify: async () => true,
      }),
    );
  await assert.rejects(
    startPairingServer({
      origin,
      publicIntent: signed,
      expiresAt: signed.intent.expiresAt + 1,
      verify: async () => true,
    }),
  );
});

test("rejects untrusted destinations and invalid lifetimes before binding", async () => {
  for (const options of [
    { origin: "https://evil.invalid", expiresAt: Date.now() + 1000 },
    { origin, expiresAt: Date.now() - 1 },
    { origin, expiresAt: Date.now() + 600_000 },
  ])
    await assert.rejects(
      startPairingServer({ ...options, publicIntent: signedFixture(), verify: async () => true }),
    );
});
