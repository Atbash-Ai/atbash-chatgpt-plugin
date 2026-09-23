import { gtv, Buffer as PcBuffer } from "postchain-client";
import type { PairingIntent } from "./pairing-intent.js";

// Pinned to Dashboard hosted-targets.ts at a16cc1c. Never accept RPC URLs from
// the browser. Additional networks require an explicit reviewed target.
export const PAIRING_CHAIN = {
  rid: "02668c5218871f69a93cc0f7032dcffe06ef0d35ef2f0b07a92a3d83a3f23a7d",
  nodes: ["https://node0.testnet.chromia.com:7740", "https://node1.testnet.chromia.com:7740"],
} as const;
export const PAIRING_TARGETS: Readonly<Record<string, { rid: string; nodes: readonly string[] }>> =
  {
    "https://chromia-verified-ai-dev-two.vercel.app": PAIRING_CHAIN,
    "https://atbash.ai": {
      rid: "0163241d9af137638e63e48efcde15510f38c2426f7ad5dc726af60351bf4dfe",
      nodes: ["https://node0.testnet.chromia.com", "https://node1.testnet.chromia.com"],
    },
  };
type Args = Record<string, string | Buffer>;
type QueryName = "get_agent_by_pubkey" | "get_agent_governance_hashes" | "get_agent_tier_info";
export type PairingQuery = (name: QueryName, args: Args) => Promise<unknown>;
const READBACK_QUERIES = new Set<string>([
  "get_agent_by_pubkey",
  "get_agent_governance_hashes",
  "get_agent_tier_info",
]);

/** Only read-only, fixed-chain queries. HTTPS failures never fall back to HTTP. */
export function createPairingQuery(origin: string, signal?: AbortSignal): PairingQuery {
  const target = PAIRING_TARGETS[origin];
  if (!target) throw new Error("Unsupported pairing network.");
  return async (name, args) => {
    if (!READBACK_QUERIES.has(name)) throw new Error("Unsupported pairing query.");
    signal?.throwIfAborted();
    const wireArgs = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? PcBuffer.from(value) : value,
      ]),
    );
    const encoded = new Uint8Array(gtv.encode([name, wireArgs]));
    for (const node of target.nodes) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(`${node}/query_gtv/${target.rid}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: encoded,
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
            : AbortSignal.timeout(8_000),
        });
        if (!response.ok || !response.body) throw new Error("Query failed.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 1_048_576) throw new Error("Query response too large.");
          chunks.push(chunk);
        }
        return gtv.decode(PcBuffer.from(Buffer.concat(chunks)));
      } catch {
        /* Try the other pinned node, then fail closed. */
      }
    }
    throw new Error("Enrollment chain verification unavailable.");
  };
}
export const pairingQuery = createPairingQuery("https://chromia-verified-ai-dev-two.vercel.app");

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value))
    throw new Error("Missing enrollment chain evidence.");
  return value as Record<string, unknown>;
}
function hex(value: unknown): string {
  if (!Buffer.isBuffer(value) && !PcBuffer.isBuffer(value))
    throw new Error("Malformed chain bytes.");
  return Buffer.from(value as Uint8Array).toString("hex");
}
// Rell booleans travel as GTV integer 0/1. Other truthy/falsy values are invalid.
const yes = (value: unknown) => value === true || value === 1;
const no = (value: unknown) => value === false || value === 0;

/** Readback is a snapshot, not proof that an owner can never change policy.
 * The caller must recheck immediately before the first protected action.
 */
export async function verifyPairingChain(
  intent: PairingIntent,
  query: PairingQuery = createPairingQuery(intent.origin),
): Promise<boolean> {
  if (
    intent.blockchainRid !== PAIRING_TARGETS[intent.origin]?.rid ||
    Date.now() >= intent.expiresAt
  )
    return false;
  const key = Buffer.from(intent.publicKey, "hex");
  const [agentRaw, hashesRaw, tierRaw] = await Promise.all([
    query("get_agent_by_pubkey", { pubkey: key }),
    query("get_agent_governance_hashes", { agent_pubkey: key }),
    query("get_agent_tier_info", { agent_pubkey: key }),
  ]);
  const agent = record(agentRaw),
    hashes = record(hashesRaw),
    tier = record(tierRaw);
  return (
    Date.now() < intent.expiresAt &&
    hex(agent.pubkey) === intent.publicKey &&
    agent.org_name === intent.organization &&
    agent.name === intent.agentName &&
    agent.purpose === intent.purpose &&
    agent.risk === intent.risk &&
    no(agent.is_jailed) &&
    agent.policy_name === intent.policyName &&
    no(agent.follows_org_default) &&
    agent.policy_source_name === intent.policyName &&
    agent.policy_source_revision === intent.policyRevision &&
    agent.policy_version === intent.policyVersion &&
    hashes.policy_version === intent.policyVersion &&
    yes(hashes.is_custom_policy) &&
    hex(hashes.policy_hash) === intent.compactHash &&
    hex(hashes.extended_policy_hash) === intent.extendedHash &&
    hex(tier.agent_pubkey) === intent.publicKey &&
    tier.org_name === intent.organization &&
    yes(tier.active) &&
    no(tier.shadow_mode_active) &&
    yes(tier.verdict_enabled) &&
    yes(tier.enforcement_enabled) &&
    tier.enforcement_mode === "enforce"
  );
}
