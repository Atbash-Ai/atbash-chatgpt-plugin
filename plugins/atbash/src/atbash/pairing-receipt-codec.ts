import { ECDH } from "node:crypto";
import { gtv, gtx, calculateTransactionRid, Buffer as PcBuffer } from "postchain-client";

export interface EnrollmentTransactionExpectation {
  blockchainRid: string;
  transactionRid: string;
  ownerAccountId: string;
  descriptorId: string;
  sessionSigner: string;
  agentPublicKey: string;
  organization: string;
  agentName: string;
  purpose: string;
  risk: "low" | "medium" | "high" | "critical";
  policyName: string;
  merkleVersion: 1 | 2;
}

export type EnrollmentTransactionResult =
  Readonly<{ valid: false }> | Readonly<{ valid: true; transactionRid: string }>;

const invalid = Object.freeze({ valid: false as const });
const fields = [
  "blockchainRid",
  "transactionRid",
  "ownerAccountId",
  "descriptorId",
  "sessionSigner",
  "agentPublicKey",
  "organization",
  "agentName",
  "purpose",
  "risk",
  "policyName",
  "merkleVersion",
] as const;
const hex32 = /^[a-f0-9]{64}$/;

function point(value: unknown): value is string {
  if (typeof value !== "string" || !/^0[23][a-f0-9]{64}$/.test(value)) return false;
  ECDH.convertKey(Buffer.from(value, "hex"), "secp256k1");
  return true;
}

function label(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

function snapshot(value: unknown): EnrollmentTransactionExpectation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k as (typeof fields)[number]))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) return null;
    result[field] = descriptor.value;
  }
  for (const field of ["blockchainRid", "transactionRid", "ownerAccountId", "descriptorId"]) {
    if (typeof result[field] !== "string" || !hex32.test(result[field])) return null;
  }
  if (
    !point(result.sessionSigner) ||
    !point(result.agentPublicKey) ||
    !label(result.organization, 100) ||
    !label(result.agentName, 100) ||
    !label(result.purpose, 300) ||
    !label(result.policyName, 100) ||
    !["low", "medium", "high", "critical"].includes(result.risk as string) ||
    (result.merkleVersion !== 1 && result.merkleVersion !== 2)
  )
    return null;
  return Object.freeze(result) as unknown as EnrollmentTransactionExpectation;
}

/** Iterative resource/canonical-length guard BEFORE the recursive GTV decoder.
 * Primitive contents are opaque. Limit 24 enclosing constructed nodes and
 * 256 total TLVs; a supported enrollment needs substantially fewer of each.
 */
export function hasBoundedEnrollmentDer(bytes: Buffer): boolean {
  if (bytes.length < 1 || bytes.length > 65_536) return false;
  const ends = [bytes.length];
  let offset = 0;
  let nodes = 0;
  let roots = 0;
  while (ends.length) {
    const end = ends[ends.length - 1]!;
    if (offset === end) {
      ends.pop();
      continue;
    }
    if (offset > end || offset + 2 > end || ++nodes > 256) return false;
    if (ends.length === 1 && ++roots > 1) return false;
    const tag = bytes[offset++]!;
    if (tag === 0 || (tag & 31) === 31) return false;
    let length = bytes[offset++]!;
    if (length & 128) {
      const count = length & 127;
      if (!count || count > 3 || offset + count > end || bytes[offset] === 0) return false;
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]!;
      if (length < 128) return false;
    }
    const next = offset + length;
    if (next > end) return false;
    if (tag & 32) {
      if (ends.length > 24) return false;
      ends.push(next);
    } else offset = next;
  }
  return roots === 1 && offset === bytes.length;
}

function binary(value: unknown, size: number): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === size;
}

function sameBytes(value: unknown, expectedHex: string): boolean {
  return (
    binary(value, expectedHex.length / 2) && Buffer.from(value).toString("hex") === expectedHex
  );
}

function operation(value: unknown, name: string, expected: readonly unknown[]): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== name ||
    !Array.isArray(value[1]) ||
    value[1].length !== expected.length
  )
    return false;
  return value[1].every((arg: unknown, index: number) => {
    const wanted = expected[index];
    return Buffer.isBuffer(wanted)
      ? binary(arg, wanted.length) && Buffer.from(arg).equals(wanted)
      : arg === wanted;
  });
}

/** Checks only bytes, signature and the exact standard FT-login enrollment
 * template against SUPPLIED expectations. No network/config/key access.
 * Success proves neither owner authority, inclusion, current policy nor safety
 * readiness. Callers must derive and verify expectations independently.
 */
export function verifyEnrollmentTransaction(
  input: unknown,
  expectation: unknown,
): EnrollmentTransactionResult {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength < 1 ||
      input.byteLength > 65_536 ||
      input.buffer instanceof SharedArrayBuffer
    )
      return invalid;
    const bytes = Buffer.from(input);
    const expected = snapshot(expectation);
    if (!expected || !hasBoundedEnrollmentDer(bytes)) return invalid;
    const raw: unknown = gtv.decode(PcBuffer.from(bytes));
    if (!Array.isArray(raw) || raw.length !== 2 || !Array.isArray(raw[0]) || raw[0].length !== 3)
      return invalid;
    const [body, signatures] = raw;
    const [rid, operations, signers] = body;
    if (
      !sameBytes(rid, expected.blockchainRid) ||
      !Array.isArray(operations) ||
      operations.length !== 5 ||
      !Array.isArray(signers) ||
      signers.length !== 1 ||
      !sameBytes(signers[0], expected.sessionSigner) ||
      !Array.isArray(signatures) ||
      signatures.length !== 1 ||
      !binary(signatures[0], 64)
    )
      return invalid;
    const owner = Buffer.from(expected.ownerAccountId, "hex");
    const descriptor = Buffer.from(expected.descriptorId, "hex");
    const agent = Buffer.from(expected.agentPublicKey, "hex");
    if (
      !operation(operations[0], "ft4.ft_auth", [owner, descriptor]) ||
      !operation(operations[1], "org_register_agent", [
        agent,
        expected.organization,
        expected.agentName,
        expected.purpose,
        expected.risk,
      ]) ||
      !operation(operations[2], "ft4.ft_auth", [owner, descriptor]) ||
      !operation(operations[3], "org_assign_agent_policy", [agent, expected.policyName])
    )
      return invalid;
    const nop = operations[4];
    if (
      !Array.isArray(nop) ||
      nop.length !== 2 ||
      nop[0] !== "nop" ||
      !Array.isArray(nop[1]) ||
      nop[1].length !== 1 ||
      !binary(nop[1][0], 32)
    )
      return invalid;
    if (!Buffer.from(gtv.encode(raw)).equals(bytes)) return invalid;
    const transaction = gtx.deserialize(PcBuffer.from(bytes));
    const transactionRid = calculateTransactionRid(
      gtx.gtxToRawGtxBody(transaction),
      expected.merkleVersion,
    );
    if (
      transactionRid.toString("hex") !== expected.transactionRid ||
      !gtx.checkGTXSignatures(transactionRid, transaction)
    )
      return invalid;
    return Object.freeze({ valid: true, transactionRid: expected.transactionRid });
  } catch {
    return invalid;
  }
}
