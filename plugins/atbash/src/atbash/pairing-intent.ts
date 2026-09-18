import { createECDH, createPrivateKey, createPublicKey, ECDH, sign, verify } from "node:crypto";

export const PAIRING_ORIGIN = "https://chromia-verified-ai-dev-two.vercel.app";
export const PAIRING_ORIGINS = [PAIRING_ORIGIN, "https://atbash.ai"] as const;
export const PAIRING_DOMAIN = "atbash:local-enrollment:v1\n";
export interface PairingIntent {
  version: 1;
  nonce: string;
  origin: string;
  publicKey: string;
  blockchainRid: string;
  organization: string;
  agentName: string;
  purpose: string;
  risk: "low" | "medium" | "high" | "critical";
  policyName: string;
  policyRevision: number;
  policyVersion: string;
  compactHash: string;
  extendedHash: string;
  issuedAt: number;
  expiresAt: number;
}
export interface SignedPairingIntent {
  intent: PairingIntent;
  signature: string;
}
const fields = [
  "version",
  "nonce",
  "origin",
  "publicKey",
  "blockchainRid",
  "organization",
  "agentName",
  "purpose",
  "risk",
  "policyName",
  "policyRevision",
  "policyVersion",
  "compactHash",
  "extendedHash",
  "issuedAt",
  "expiresAt",
] as const;
const hex32 = /^[a-f0-9]{64}$/;

/** Fixed field order and domain; do not sign arbitrary browser-supplied objects. */
export function canonicalIntent(intent: PairingIntent): Buffer {
  if (
    !intent ||
    typeof intent !== "object" ||
    Object.keys(intent).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(intent, field)) ||
    intent.version !== 1 ||
    !PAIRING_ORIGINS.some((origin) => origin === intent.origin)
  ) {
    throw new Error("Invalid pairing intent.");
  }
  for (const field of ["nonce", "blockchainRid", "compactHash", "extendedHash"] as const) {
    if (typeof intent[field] !== "string" || !hex32.test(intent[field]))
      throw new Error("Invalid pairing digest.");
  }
  if (typeof intent.publicKey !== "string" || !/^0[23][a-f0-9]{64}$/.test(intent.publicKey))
    throw new Error("Invalid public identity.");
  try {
    ECDH.convertKey(Buffer.from(intent.publicKey, "hex"), "secp256k1");
  } catch {
    throw new Error("Invalid public identity.");
  }
  for (const field of [
    "organization",
    "agentName",
    "purpose",
    "policyName",
    "policyVersion",
  ] as const) {
    const value = intent[field];
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      !value ||
      value.length > 512 ||
      [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error("Invalid pairing label.");
  }
  if (
    intent.agentName.length > 100 ||
    intent.purpose.length > 300 ||
    !["low", "medium", "high", "critical"].includes(intent.risk)
  )
    throw new Error("Invalid enrollment profile.");
  if (
    !Number.isSafeInteger(intent.policyRevision) ||
    intent.policyRevision < 1 ||
    !Number.isSafeInteger(intent.issuedAt) ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.issuedAt < 0 ||
    intent.expiresAt <= intent.issuedAt ||
    intent.expiresAt - intent.issuedAt > 300_000
  )
    throw new Error("Invalid pairing lifetime or revision.");
  return Buffer.from(PAIRING_DOMAIN + JSON.stringify(fields.map((field) => intent[field])), "utf8");
}

function publicJwk(publicKey: string) {
  const point = Buffer.from(
    ECDH.convertKey(
      Buffer.from(publicKey, "hex"),
      "secp256k1",
      undefined,
      undefined,
      "uncompressed",
    ),
  );
  return {
    kty: "EC",
    crv: "secp256k1",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33).toString("base64url"),
  };
}

/** The key is used only in local process memory. Never log either input. */
export function signPairingIntent(intent: PairingIntent, privateKey: string): SignedPairingIntent {
  const bytes = canonicalIntent(intent);
  if (!hex32.test(privateKey)) throw new Error("Invalid signing identity.");
  const keyBytes = Buffer.from(privateKey, "hex");
  try {
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(keyBytes);
    if (ecdh.getPublicKey("hex", "compressed") !== intent.publicKey)
      throw new Error("Signing identity mismatch.");
    const key = createPrivateKey({
      key: { ...publicJwk(intent.publicKey), d: keyBytes.toString("base64url") },
      format: "jwk",
    });
    return {
      intent: Object.freeze({ ...intent }),
      signature: sign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }).toString("hex"),
    };
  } finally {
    keyBytes.fill(0);
  }
}

export function verifyPairingIntent(signed: SignedPairingIntent, now = Date.now()): boolean {
  try {
    if (
      Object.keys(signed).length !== 2 ||
      !Object.hasOwn(signed, "intent") ||
      !Object.hasOwn(signed, "signature") ||
      typeof signed.signature !== "string" ||
      !/^[a-f0-9]{128}$/.test(signed.signature)
    )
      return false;
    const bytes = canonicalIntent(signed.intent);
    if (now < signed.intent.issuedAt || now >= signed.intent.expiresAt) return false;
    return verify(
      "sha256",
      bytes,
      {
        key: createPublicKey({ key: publicJwk(signed.intent.publicKey), format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signed.signature, "hex"),
    );
  } catch {
    return false;
  }
}

/** Build the response from validated primitives, never an object's toJSON hook. */
export function serializePublicIntent(signed: SignedPairingIntent): string {
  const values = JSON.parse(
    canonicalIntent(signed.intent).toString("utf8").slice(PAIRING_DOMAIN.length),
  ) as unknown[];
  const snapshot = {
    intent: Object.fromEntries(
      fields.map((field, index) => [field, values[index]]),
    ) as unknown as PairingIntent,
    signature: signed.signature,
  };
  if (!verifyPairingIntent(snapshot)) throw new Error("Invalid signed pairing intent.");
  return JSON.stringify(snapshot);
}
