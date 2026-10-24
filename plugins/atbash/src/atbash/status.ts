import { Atbash, type AgentPolicy } from "@atbash/sdk";

import { resolveGuardConfiguration, resolveTimeoutMs, type FromConfig } from "./guard.js";

export type AtbashStatus =
  | {
      ready: true;
      state: "ready";
      pubkey: string;
      policy: AgentPolicy;
    }
  | {
      ready: false;
      state: "configuration_error" | "agent_not_registered" | "agent_jailed" | "service_error";
      message: string;
      pubkey?: string;
      policy?: AgentPolicy;
    };

export interface StatusClient {
  readonly pubkey: string;
  checkAgentExists(): Promise<boolean>;
  getAgentPolicy(pubkey: string): Promise<AgentPolicy>;
}

export type StatusClientFactory = () => StatusClient;

/**
 * The status client runs as the same configuration the hook's guard does: the
 * profile setup selected, or the plugin's resolution of the SDK configuration
 * when none is. Reading only the SDK's configuration reported "configuration is
 * missing or invalid" right after a successful setup.
 */
export function createStatusClient(
  fromConfig: FromConfig = (options) => Atbash.fromConfig(options),
): StatusClient {
  const configuration = resolveGuardConfiguration("codex");
  return fromConfig({
    failClosed: true,
    ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
    ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
    timeoutMs: resolveTimeoutMs(),
  });
}

export async function getAtbashStatus(
  createClient: StatusClientFactory = () => createStatusClient(),
): Promise<AtbashStatus> {
  let client: StatusClient;
  try {
    client = createClient();
  } catch {
    return {
      ready: false,
      state: "configuration_error",
      message: "Atbash configuration is missing or invalid.",
    };
  }

  try {
    if (!(await client.checkAgentExists())) {
      return {
        ready: false,
        state: "agent_not_registered",
        message: "The configured Atbash agent is not registered.",
        pubkey: client.pubkey,
      };
    }

    const policy = await client.getAgentPolicy(client.pubkey);
    if (policy.isJailed) {
      return {
        ready: false,
        state: "agent_jailed",
        message: "The configured Atbash agent is jailed.",
        pubkey: client.pubkey,
        policy,
      };
    }

    return {
      ready: true,
      state: "ready",
      pubkey: client.pubkey,
      policy,
    };
  } catch {
    return {
      ready: false,
      state: "service_error",
      message: "Atbash status could not be retrieved.",
      pubkey: client.pubkey,
    };
  }
}
