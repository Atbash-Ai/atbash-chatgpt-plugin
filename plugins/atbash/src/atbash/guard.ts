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

/**
 * What the guard should run as.
 *
 * Setup writes a PROFILE (`hosts/`, `profiles/`, `credentials/`), which is not
 * a shape the SDK's own configuration resolution reads. Without this the guard
 * asks the SDK for a key it was never given, finds none, and reports
 * "configuration is missing or invalid" forever — so a completed setup would
 * never produce a working guard.
 *
 * Falls back to the SDK's own configuration when no profile is selected, which
 * keeps a pre-profile install working.
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
  const orgName = resolveOrgName();
  return { source: "legacy", ...(orgName === undefined ? {} : { orgName }) };
}

export function createAtbashGuard(host: ControlHost = "codex"): ToolCallGuard {
  const configuration = resolveGuardConfiguration(host);
  return Atbash.fromConfig({
    failClosed: true,
    ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
    ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
    timeoutMs: resolveTimeoutMs(),
  });
}
