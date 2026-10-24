import { Atbash, resolve, type Decision, type ToolCallInput } from "@atbash/sdk";
import type { ControlHost } from "../control/protocol.js";
import { loadSelectedRuntimeProfile } from "../control/runtime-profile.js";

export const DEFAULT_ATBASH_TIMEOUT_MS = 30_000;
export const MIN_ATBASH_TIMEOUT_MS = 1_000;
export const MAX_ATBASH_TIMEOUT_MS = 30_000;

export interface ToolCallGuard {
  auditToolCall(input: ToolCallInput): Promise<Decision>;
}

export interface GuardConfiguration {
  source: "profile" | "legacy";
  agentKey?: string;
  orgName?: string;
  profileId?: string;
  agentPubkey?: string;
  network?: "public" | "private";
}

export function resolveOrgName(rawValue = resolve("orgName")): string | undefined {
  const orgName = rawValue.trim();
  return orgName === "" ? undefined : orgName;
}

/**
 * The signing key exactly as SDK 0.9.2 chose it: a non-empty ATBASH_AGENT_KEY, else config.json's
 * agentKey. Newer SDKs no longer read config.json for the identity, so the plugin passes this value
 * explicitly; otherwise installs configured through config.json would sign as nobody and every tool
 * call would be denied. When empty, the SDK's own key-file lookup runs, as it did before.
 */
export function resolveAgentKey(rawValue = resolve("agentKey")): string | undefined {
  const agentKey = rawValue.trim();
  return agentKey === "" ? undefined : agentKey;
}

export function resolveTimeoutMs(rawValue = process.env.ATBASH_CODEX_TIMEOUT_MS): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_ATBASH_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_ATBASH_TIMEOUT_MS ||
    parsed > MAX_ATBASH_TIMEOUT_MS
  ) {
    throw new Error(
      `ATBASH_CODEX_TIMEOUT_MS must be an integer between ${MIN_ATBASH_TIMEOUT_MS} and ${MAX_ATBASH_TIMEOUT_MS}.`,
    );
  }

  return parsed;
}

export type FromConfig = typeof Atbash.fromConfig;

const sdkFromConfig: FromConfig = (options) => Atbash.fromConfig(options);

/**
 * What the guard should run as.
 *
 * Setup writes a PROFILE (`hosts/`, `profiles/`, `credentials/`), which is not
 * a shape the SDK's own configuration resolution reads. Without this the guard
 * asks the SDK for a key it was never given, finds none, and reports
 * "configuration is missing or invalid" forever — so a completed setup would
 * never produce a working guard.
 *
 * Falls back to the plugin's own resolution of the SDK configuration when no
 * profile is selected, which keeps a pre-profile install working: the identity
 * is passed explicitly (resolveAgentKey), because newer SDKs no longer read
 * config.json's agentKey themselves.
 */
export function resolveGuardConfiguration(host: ControlHost = "codex"): GuardConfiguration {
  const profile = loadSelectedRuntimeProfile(host);
  if (profile) {
    return {
      source: "profile",
      agentKey: profile.agentKey,
      orgName: profile.orgName,
      profileId: profile.profileId,
      agentPubkey: profile.agentPubkey,
      network: profile.network,
    };
  }
  const agentKey = resolveAgentKey();
  const orgName = resolveOrgName();
  return {
    source: "legacy",
    ...(agentKey === undefined ? {} : { agentKey }),
    ...(orgName === undefined ? {} : { orgName }),
  };
}

export function createAtbashGuard(
  host: ControlHost = "codex",
  fromConfig: FromConfig = sdkFromConfig,
): ToolCallGuard {
  const configuration = resolveGuardConfiguration(host);
  return fromConfig({
    failClosed: true,
    // Explicit, not left to the SDK default: an unchecked audit-tier answer must never permit.
    requireEnforcement: true,
    ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
    ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
    timeoutMs: resolveTimeoutMs(),
  });
}
