import { randomBytes } from "node:crypto";
import {
  createPairingQuery,
  hasPairingCapacity,
  PAIRING_TARGETS,
  resolveDefaultPairingPolicy,
  resolvePairingPolicy,
  verifyPairingChain,
} from "./pairing-chain.js";
import { signPairingIntent, type PairingIntent } from "./pairing-intent.js";
import { startPairingServer } from "./pairing-server.js";
import { openPairingState } from "./pairing-state.js";

export class PairingCapacityError extends Error {
  constructor() {
    super(
      "This organization has no available active-agent slot. Select an organization with capacity before restarting pairing.",
    );
  }
}

export interface PairingIdentity {
  readonly pubkey: string;
  readonly privkey: string;
  readonly orgName?: string;
  readonly endpoint: string;
  readonly blockchainRid: string;
}

/** Receives the SDK object, not an exported credential file. No local config or
 * hook trust is changed. Network and organization must match the actual runtime.
 */
export async function beginPairing(
  client: PairingIdentity,
  options: {
    stateRoot: string;
    policyName?: string;
    agentName?: string;
    purpose?: string;
  },
) {
  const origin = client.endpoint;
  const target = PAIRING_TARGETS[origin];
  if (!target || client.blockchainRid.toLowerCase() !== target.rid)
    throw new Error("The installed runtime does not match a supported Dashboard network.");
  const organization = client.orgName;
  if (!organization?.trim()) throw new Error("Configure your organization locally before pairing.");
  const store = await openPairingState(options.stateRoot, client.pubkey);
  try {
    const previous = await store.read();
    if (
      previous &&
      (previous.signed.intent.organization !== organization ||
        previous.signed.intent.origin !== origin)
    )
      throw new Error(
        "This identity has enrollment state for another organization or network. Review that state before proceeding.",
      );
    const query = createPairingQuery(origin, store.signal);
    if (!(await hasPairingCapacity(organization, client.pubkey, query)))
      throw new PairingCapacityError();
    const policyName =
      options.policyName ??
      previous?.signed.intent.policyName ??
      (await resolveDefaultPairingPolicy(organization, query));
    const policy = await resolvePairingPolicy(organization, policyName, query);
    if (previous) {
      const pinned = previous.signed.intent;
      if (
        policyName !== pinned.policyName ||
        policy.policyRevision !== pinned.policyRevision ||
        policy.policyVersion !== pinned.policyVersion ||
        policy.compactHash !== pinned.compactHash ||
        policy.extendedHash !== pinned.extendedHash ||
        (options.agentName !== undefined && options.agentName !== pinned.agentName) ||
        (options.purpose !== undefined && options.purpose !== pinned.purpose)
      )
        throw new Error(
          "The saved enrollment expectations changed. Review the policy and local enrollment state before starting a new attempt.",
        );
    }
    const profile = {
      agentName:
        options.agentName ??
        previous?.signed.intent.agentName ??
        `codex-${client.pubkey.slice(-12)}`,
      purpose:
        options.purpose ??
        previous?.signed.intent.purpose ??
        "Codex development assistant governed by the selected organization policy.",
      risk: "high" as const,
    };
    const now = Date.now();
    const intent: PairingIntent = {
      version: 1,
      nonce: randomBytes(32).toString("hex"),
      origin,
      publicKey: client.pubkey,
      blockchainRid: target.rid,
      organization,
      ...profile,
      ...policy,
      issuedAt: now,
      expiresAt: now + 300_000,
    };
    // Resume preserves policy/profile expectations; only the nonce and lifetime
    // are renewed. Every completion still requires fresh independent readback.
    const signed = signPairingIntent(intent, client.privkey);
    await store.save({ phase: "prepared", signed });
    let verifiedLocally = false;
    const server = await startPairingServer({
      origin,
      publicIntent: signed,
      expiresAt: intent.expiresAt,
      verify: async (requestSignal) => {
        const signal = AbortSignal.any([store.signal, requestSignal]);
        signal.throwIfAborted();
        await store.save({ phase: "verifying", signed });
        const verified = await verifyPairingChain(intent, createPairingQuery(origin, signal));
        signal.throwIfAborted();
        await store.save({ phase: verified ? "verified" : "prepared", signed });
        signal.throwIfAborted();
        if (Date.now() >= intent.expiresAt) throw new Error("Pairing expired.");
        verifiedLocally = verified;
        return verified;
      },
    });
    const port = new URL(server.endpoint).port;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      server.close();
      await store.close();
    };
    store.signal.addEventListener("abort", () => server.close(), { once: true });
    return {
      // Pass directly to the browser launcher. Never print, log or copy this URL.
      browserUrl: `${origin}/pair-agent#port=${port}&token=${server.capability}`,
      expiresAt: intent.expiresAt,
      organization,
      policyName,
      async verified() {
        if (!verifiedLocally || store.signal.aborted || Date.now() >= intent.expiresAt)
          return false;
        const state = await store.read();
        return (
          state?.phase === "verified" &&
          state.signed.intent.nonce === intent.nonce &&
          state.signed.signature === signed.signature
        );
      },
      close,
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
