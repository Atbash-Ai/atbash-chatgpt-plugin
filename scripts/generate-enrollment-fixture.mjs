// Offline regeneration only. Usage: node scripts/generate-enrollment-fixture.mjs
// <dependency-project-root> <new-output-file>. Requires FT4 2.1.0/Postchain 2.1.2.
// The dependency root is explicit; tests never require it or import FT4.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createECDH } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
let secret;
(async () => {
  const [root, output] = process.argv.slice(2);
  if (!root || !output || process.argv.length !== 4) throw new Error("Arguments required");
  const dependencyRoot = path.resolve(root);
  const load = createRequire(path.join(dependencyRoot, "package.json"));
  for (const [name, version] of [
    ["@chromia/ft4", "2.1.0"],
    ["postchain-client", "2.1.2"],
  ]) {
    if (
      JSON.parse(
        fs.readFileSync(path.join(dependencyRoot, "node_modules", name, "package.json"), "utf8"),
      ).version !== version
    )
      throw new Error("Version mismatch");
  }
  const ft = load("@chromia/ft4");
  const pc = load("postchain-client");
  const key = createECDH("secp256k1");
  key.generateKeys();
  secret = Buffer.from(key.getPrivateKey("hex").padStart(64, "0"), "hex");
  const pubKey = key.getPublicKey(undefined, "compressed");
  const store = ft.createInMemoryFtKeyStore({ privKey: secret, pubKey });
  const registration = ft.createSingleSigAuthDescriptorRegistration(["A", "T"], pubKey);
  const descriptor = { ...registration, id: ft.deriveAuthDescriptorId(registration, 2) };
  const accountId = Buffer.alloc(32, 17);
  const blockchainRid = "22".repeat(32);
  const handler = ft.createFtKeyHandler(descriptor, store);
  const authenticator = {
    accountId,
    getKeyHandlerForOperation: async () => handler,
    authDataService: new Proxy(
      {},
      {
        get() {
          throw new Error("Network forbidden");
        },
      },
    ),
  };
  const client = new Proxy(
    { config: { blockchainRid, merkleHashVersion: 2 } },
    {
      get(target, name) {
        if (name === "config") return target.config;
        throw new Error("Network forbidden");
      },
    },
  );
  const agent = createECDH("secp256k1");
  agent.generateKeys();
  const agentPublicKey = agent.getPublicKey(undefined, "compressed");
  const bytes = await ft
    .transactionBuilder(authenticator, client)
    .add({
      name: "org_register_agent",
      args: [agentPublicKey, "fixture-org", "fixture-agent", "Offline codec fixture", "low"],
    })
    .add({ name: "org_assign_agent_policy", args: [agentPublicKey, "fixture-policy"] })
    .add(ft.nop())
    .build();
  const tx = pc.gtx.deserialize(bytes);
  const rid = ft.getTransactionRid(tx, 2);
  if (!pc.gtx.checkGTXSignatures(rid, tx)) throw new Error("Signature verification failed");
  const fixture = {
    provenance: {
      generator: "scripts/generate-enrollment-fixture.mjs",
      ft4: "2.1.0",
      postchain: "2.1.2",
      synthetic: true,
      scope:
        "Actual FT4 builder output; synthetic account/descriptor/authenticator. No network, owner authority or inclusion claim.",
    },
    transactionHex: Buffer.from(bytes).toString("hex"),
    expected: {
      blockchainRid,
      transactionRid: rid.toString("hex"),
      ownerAccountId: accountId.toString("hex"),
      descriptorId: descriptor.id.toString("hex"),
      sessionSigner: pubKey.toString("hex"),
      agentPublicKey: agentPublicKey.toString("hex"),
      organization: "fixture-org",
      agentName: "fixture-agent",
      purpose: "Offline codec fixture",
      risk: "low",
      policyName: "fixture-policy",
      merkleVersion: 2,
    },
  };
  fs.writeFileSync(path.resolve(output), JSON.stringify(fixture, null, 2) + "\n", { flag: "wx" });
  console.log("Public synthetic FT4 fixture created; no private key persisted.");
})()
  .catch(() => {
    console.error("Fixture generation failed; raw diagnostics withheld.");
    process.exitCode = 1;
  })
  .finally(() => secret?.fill(0));
