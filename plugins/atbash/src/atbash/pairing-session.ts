/**
 * Pairing stays unavailable until the Dashboard can hand the local agent
 * policy metadata authenticated by its owner and collect the agent's consent
 * signature. A public owner account ID is never an authorization credential.
 * The signed-intent, loopback, state, and readback modules remain available for
 * review, but this entry point must not create state or make chain requests.
 */
export class PairingUnavailableError extends Error {
  constructor() {
    super("Owner-authenticated policy handoff is not available. Pairing remains disabled.");
    this.name = "PairingUnavailableError";
  }
}

export interface PairingIdentity {
  readonly pubkey: string;
  readonly privkey: string;
  readonly orgName?: string;
  readonly endpoint: string;
  readonly blockchainRid: string;
}

export interface PairingSession {
  readonly browserUrl: string;
  readonly expiresAt: number;
  readonly organization: string;
  readonly policyName: string;
  verified(): Promise<boolean>;
  close(): Promise<void>;
}

export async function beginPairing(
  _client: PairingIdentity,
  _options: {
    stateRoot: string;
    policyName?: string;
    agentName?: string;
    purpose?: string;
  },
): Promise<PairingSession> {
  void _client;
  void _options;
  throw new PairingUnavailableError();
}
