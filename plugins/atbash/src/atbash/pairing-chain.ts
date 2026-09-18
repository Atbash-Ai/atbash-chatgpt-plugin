import { createHash } from "node:crypto";
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
type QueryName =
  | "get_org_account_id"
  | "get_org_policy"
  | "get_org_policies"
  | "get_org_agent_capacity"
  | "get_agent_by_pubkey"
  | "get_agent_governance_hashes"
  | "get_agent_tier_info";
export type PairingQuery = (name: QueryName, args: Args) => Promise<unknown>;

/** Only read-only, fixed-chain queries. HTTPS failures never fall back to HTTP. */
export function createPairingQuery(origin: string, signal?: AbortSignal): PairingQuery {
  const target = PAIRING_TARGETS[origin];
  if (!target) throw new Error("Unsupported pairing network.");
  return async (name, args) => {
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
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
// Rell booleans travel as GTV integer 0/1. Other truthy/falsy values are invalid.
const yes = (value: unknown) => value === true || value === 1;
const no = (value: unknown) => value === false || value === 0;

/** Early UX check only: the registration transaction is the final capacity gate. */
export async function hasPairingCapacity(
  organization: string,
  publicKey: string,
  query: PairingQuery,
): Promise<boolean> {
  const owner = Buffer.from(
    hex(await query("get_org_account_id", { org_name: organization })),
    "hex",
  );
  if (owner.length !== 32) throw new Error("Organization not found on the pinned chain.");
  const [capacityRaw, existing] = await Promise.all([
    query("get_org_agent_capacity", { org_name: organization, requester_pubkey: owner }),
    query("get_agent_by_pubkey", { pubkey: Buffer.from(publicKey, "hex") }),
  ]);
  const capacity = record(capacityRaw);
  for (const field of ["max_agents", "active_count", "total_count"])
    if (!Number.isSafeInteger(capacity[field]) || Number(capacity[field]) < 0)
      throw new Error("Malformed organization capacity.");
  if (existing !== null) {
    const agent = record(existing);
    if (hex(agent.pubkey) !== publicKey || agent.org_name !== organization)
      throw new Error("Identity does not belong to the selected organization.");
    return true;
  }
  return Number(capacity.active_count) < Number(capacity.max_agents);
}

export async function resolvePairingPolicy(
  organization: string,
  policyName: string,
  query: PairingQuery = pairingQuery,
) {
  const owner = await query("get_org_account_id", { org_name: organization });
  const ownerHex = hex(owner);
  if (ownerHex.length !== 64) throw new Error("Organization not found on the pinned chain.");
  const row = record(
    await query("get_org_policy", {
      org_name: organization,
      name: policyName,
      requester_pubkey: Buffer.from(ownerHex, "hex"),
    }),
  );
  if (
    row.name !== policyName ||
    !no(row.needs_reencryption) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.policy_text !== "string" ||
    !row.policy_text.trim() ||
    typeof row.extended_policy !== "string"
  ) {
    throw new Error("Selected policy is unavailable or needs repair.");
  }
  return {
    policyName,
    policyRevision: Number(row.revision),
    policyVersion: `${policyName}@rev${row.revision}`,
    compactHash: hash(row.policy_text),
    extendedHash: hash(row.extended_policy),
  };
}

export async function resolveDefaultPairingPolicy(
  organization: string,
  query: PairingQuery,
): Promise<string> {
  const owner = Buffer.from(
    hex(await query("get_org_account_id", { org_name: organization })),
    "hex",
  );
  if (owner.length !== 32) throw new Error("Organization not found on the pinned chain.");
  const row = record(
    await query("get_org_policies", { org_name: organization, requester_pubkey: owner }),
  );
  if (typeof row.default_policy_name !== "string" || !row.default_policy_name.trim())
    throw new Error("Choose an existing organization policy with --policy.");
  return row.default_policy_name;
}

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
