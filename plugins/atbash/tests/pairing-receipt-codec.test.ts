import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  gtv,
  gtx,
  calculateTransactionRid,
  newSignatureProvider,
  Buffer as PcBuffer,
} from "postchain-client";
import {
  verifyEnrollmentTransaction,
  hasBoundedEnrollmentDer,
} from "../src/atbash/pairing-receipt-codec.js";

// Tests use committed public data, not FT4 or another checkout's dependencies.
const fixture = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/enrollment-ft4-2.1.0.json", import.meta.url), "utf8"),
);
const original = Buffer.from(fixture.transactionHex, "hex");
const expected = fixture.expected;
type Transaction = ReturnType<typeof gtx.deserialize>;
const wire = (raw: unknown) => Buffer.from(gtv.encode(raw as Parameters<typeof gtv.encode>[0]));
const decode = () => gtx.deserialize(PcBuffer.from(original));
const refuses = (bytes: unknown, wanted: unknown = expected) => {
  const result = verifyEnrollmentTransaction(bytes, wanted);
  assert.deepEqual(result, { valid: false });
  assert.equal(Object.isFrozen(result), true);
};

async function resigned(change: (tx: Transaction) => void) {
  const key = createECDH("secp256k1");
  key.generateKeys();
  const secret = Buffer.from(key.getPrivateKey("hex").padStart(64, "0"), "hex");
  const pubKey = key.getPublicKey(undefined, "compressed");
  const tx = decode();
  tx.signers = [PcBuffer.from(pubKey)];
  change(tx);
  const body = gtx.gtxToRawGtxBody(tx);
  try {
    tx.signatures = [
      await newSignatureProvider({
        privKey: PcBuffer.from(secret),
        pubKey: PcBuffer.from(pubKey),
      }).sign(body, 2),
    ];
    const rid = calculateTransactionRid(body, 2);
    assert.equal(
      gtx.checkGTXSignatures(rid, tx),
      true,
      "Negative template case must have a genuine valid signature",
    );
    return {
      bytes: Buffer.from(gtx.serialize(tx)),
      wanted: {
        ...expected,
        sessionSigner: pubKey.toString("hex"),
        transactionRid: rid.toString("hex"),
      },
    };
  } finally {
    secret.fill(0);
  }
}

test("receipt codec accepts the committed real FT4 builder fixture without mutating inputs", () => {
  const before = Buffer.from(original);
  const result = verifyEnrollmentTransaction(original, expected);
  assert.deepEqual(result, { valid: true, transactionRid: expected.transactionRid });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(original, before);
  assert.equal(fixture.provenance.ft4, "2.1.0");
  assert.equal(fixture.provenance.postchain, "2.1.2");
});

const mutations: Record<string, (tx: Transaction) => void> = {
  organization: (tx) => {
    tx.operations[1]!.args[1] = "wrong-org";
  },
  policy: (tx) => {
    tx.operations[3]!.args[1] = "wrong-policy";
  },
  agent: (tx) => {
    tx.operations[1]!.args[0] = PcBuffer.from(expected.sessionSigner, "hex");
  },
  "assigned agent": (tx) => {
    tx.operations[3]!.args[0] = PcBuffer.from(expected.sessionSigner, "hex");
  },
  name: (tx) => {
    tx.operations[1]!.args[2] = "wrong-name";
  },
  purpose: (tx) => {
    tx.operations[1]!.args[3] = "wrong-purpose";
  },
  risk: (tx) => {
    tx.operations[1]!.args[4] = "critical";
  },
  owner: (tx) => {
    tx.operations[0]!.args[0] = PcBuffer.alloc(32, 9);
    tx.operations[2]!.args[0] = PcBuffer.alloc(32, 9);
  },
  descriptor: (tx) => {
    tx.operations[0]!.args[1] = PcBuffer.alloc(32, 9);
    tx.operations[2]!.args[1] = PcBuffer.alloc(32, 9);
  },
  "second auth": (tx) => {
    tx.operations[2]!.args[1] = PcBuffer.alloc(32, 9);
  },
  BRID: (tx) => {
    tx.blockchainRid = PcBuffer.alloc(32, 9);
  },
  order: (tx) => {
    [tx.operations[1], tx.operations[3]] = [tx.operations[3]!, tx.operations[1]!];
  },
  "missing auth": (tx) => {
    tx.operations.splice(0, 1);
  },
  "extra FT4 operation": (tx) => {
    tx.operations.push({ opName: "ft4.delete_auth_descriptor", args: [PcBuffer.alloc(32)] });
  },
  "extra product operation": (tx) => {
    tx.operations.push({
      opName: "org_remove_agent",
      args: [PcBuffer.from(expected.agentPublicKey, "hex")],
    });
  },
  "extra ICCF": (tx) => {
    tx.operations.push({ opName: "iccf_proof", args: [] });
  },
  "extra nop": (tx) => {
    tx.operations.push(tx.operations[4]!);
  },
  "extra argument": (tx) => {
    tx.operations[1]!.args.push("extra");
  },
  "missing argument": (tx) => {
    tx.operations[1]!.args.pop();
  },
  "wrong argument type": (tx) => {
    tx.operations[1]!.args[1] = 1;
  },
  "nop short": (tx) => {
    tx.operations[4]!.args[0] = PcBuffer.alloc(31);
  },
  "nop string": (tx) => {
    tx.operations[4]!.args[0] = "0".repeat(64);
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`receipt codec rejects genuinely signed wrong template: ${name}`, async () => {
    const { bytes, wanted } = await resigned(mutate);
    refuses(bytes, wanted);
  });
}

test("receipt codec allows a fresh 32-byte nop when supplied RID matches the newly signed body", async () => {
  const { bytes, wanted } = await resigned((tx) => {
    tx.operations[4]!.args[0] = PcBuffer.alloc(32, 7);
  });
  assert.equal(verifyEnrollmentTransaction(bytes, wanted).valid, true);
  refuses(bytes, { ...wanted, transactionRid: expected.transactionRid });
});

test("receipt codec refuses invalid signatures and signer/signature cardinality", () => {
  const tx = decode();
  tx.signatures![0]![0] = tx.signatures![0]![0]! ^ 1;
  refuses(Buffer.from(gtx.serialize(tx)));
  for (const [signers, signatures] of [
    [[], []],
    [[], decode().signatures],
    [decode().signers, []],
    [[...decode().signers, ...decode().signers], decode().signatures],
    [decode().signers, [...decode().signatures!, ...decode().signatures!]],
    [decode().signers, [PcBuffer.alloc(63)]],
  ]) {
    const raw = gtv.decode(PcBuffer.from(original)) as unknown[];
    (raw[0] as unknown[])[2] = signers;
    raw[1] = signatures;
    refuses(wire(raw));
  }
});

test("receipt codec strictly validates supplied expectations and refuses accessors without invoking them", () => {
  for (const field of Object.keys(expected)) {
    const missing = { ...expected };
    delete missing[field];
    refuses(original, missing);
    refuses(original, { ...expected, [field]: null });
  }
  for (const update of [
    { extra: true },
    { merkleVersion: undefined },
    { merkleVersion: 0 },
    { merkleVersion: 3 },
    { merkleVersion: "2" },
    { merkleVersion: NaN },
    { merkleVersion: 1.5 },
    { transactionRid: "00".repeat(32) },
    { blockchainRid: "aa".repeat(32) },
    { sessionSigner: "02" + "ff".repeat(32) },
    { agentPublicKey: "02" + "ff".repeat(32) },
    { organization: " fixture-org" },
    { policyName: "fixture-policy\n" },
    { agentName: "a".repeat(101) },
    { purpose: "a".repeat(301) },
    { risk: "unknown" },
  ])
    refuses(original, { ...expected, ...update });
  const accessors = { ...expected };
  let invoked = false;
  Object.defineProperty(accessors, "organization", {
    get() {
      invoked = true;
      return expected.organization;
    },
  });
  refuses(original, accessors);
  assert.equal(invoked, false);
  refuses(original, { ...expected, [Symbol("extra")]: true });
});

test("receipt codec refuses malformed raw GTX without projection dropping extra values", () => {
  const raw = gtv.decode(PcBuffer.from(original)) as unknown[];
  refuses(wire([...raw, 0]));
  refuses(wire([[...(raw[0] as unknown[]), 0], raw[1]]));
  refuses(wire([raw[0]]));
  refuses(wire({ body: raw[0], signatures: raw[1] }));
  const changed = gtv.decode(PcBuffer.from(original)) as unknown[];
  const operations = (changed[0] as unknown[])[1] as unknown[][];
  operations[1]!.push(0);
  refuses(wire(changed));
});

test("receipt codec refuses truncated, trailing, non-minimal, indefinite, oversized and deep DER", () => {
  for (const end of [0, 1, 2, original.length - 1]) refuses(original.subarray(0, end));
  refuses(Buffer.concat([original, Buffer.from([0])]));
  refuses(Buffer.alloc(65_537));
  refuses(Buffer.from([0xa5, 0x80, 0, 0]));
  refuses(Buffer.from([0xa5, 0x81, 0]));
  refuses(Buffer.from([0xa5, 0x82, 0, 0x80]));
  refuses(Buffer.from([0xa5, 0xff, 0]));
  let deep: unknown = 1;
  for (let i = 0; i < 60; i++) deep = [deep];
  refuses(wire(deep));
  refuses(wire(Array.from({ length: 257 }, () => 1)));
  refuses(new Uint8Array(new SharedArrayBuffer(20)));
  refuses({ byteLength: original.length, buffer: original });
});

test("receipt codec's explicit hash versions pass the independent upstream known-answer control", () => {
  const known = [
    "67bb8d38054db41a4b401f5971ff7560e48a730693e46371191ecea9d7bd1e32",
    "082e13545dd8a1d4003143d17f781c9346bc500800592cd9b2d5d39dedf05415",
  ];
  const decoded = gtv.decode(gtv.encode([[1]]));
  assert.deepEqual(
    [1, 2].map((v) => gtv.gtvHash(decoded, v).toString("hex")),
    known,
  );
  // This standard enrollment shape has equal hashes in v1/v2. Do not assert otherwise.
  assert.equal(
    verifyEnrollmentTransaction(original, { ...expected, merkleVersion: 1 }).valid,
    true,
  );
});

test("receipt codec returns only fixed public failures, never raw input or decode errors", () => {
  const marker = "private-output-sentinel";
  const result = verifyEnrollmentTransaction(Buffer.from(marker), {
    ...expected,
    organization: marker,
  });
  assert.equal(JSON.stringify(result), '{"valid":false}');
});

function tlv(tag: number, contents: Buffer): Buffer {
  const size = contents.length;
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), contents]);
}

test("receipt DER guard enforces exact depth and node boundaries before decoding", () => {
  let nested: Buffer = Buffer.from([5, 0]);
  for (let i = 0; i < 24; i++) nested = tlv(0x30, nested);
  assert.equal(hasBoundedEnrollmentDer(nested), true);
  assert.equal(hasBoundedEnrollmentDer(tlv(0x30, nested)), false);
  assert.equal(
    hasBoundedEnrollmentDer(
      tlv(0x30, Buffer.concat(Array.from({ length: 255 }, () => Buffer.from([5, 0])))),
    ),
    true,
  );
  assert.equal(
    hasBoundedEnrollmentDer(
      tlv(0x30, Buffer.concat(Array.from({ length: 256 }, () => Buffer.from([5, 0])))),
    ),
    false,
  );
  // Primitive payload bytes are opaque, even when they resemble nested TLVs.
  assert.equal(hasBoundedEnrollmentDer(tlv(4, Buffer.alloc(65_532, 0x30))), true);
  assert.equal(hasBoundedEnrollmentDer(tlv(4, Buffer.alloc(65_533, 0x30))), false);
  assert.equal(
    hasBoundedEnrollmentDer(Buffer.concat([Buffer.from([5, 0]), Buffer.from([5, 0])])),
    false,
  );
});
