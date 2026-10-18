import { Atbash, resolve, type Decision, type ToolCallInput } from "@atbash/sdk";

export const DEFAULT_ATBASH_TIMEOUT_MS = 30_000;
export const MIN_ATBASH_TIMEOUT_MS = 1_000;
export const MAX_ATBASH_TIMEOUT_MS = 30_000;

export interface ToolCallGuard {
  auditToolCall(input: ToolCallInput): Promise<Decision>;
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

export function createAtbashGuard(fromConfig: FromConfig = sdkFromConfig): ToolCallGuard {
  const orgName = resolveOrgName();
  return fromConfig({
    failClosed: true,
    ...(orgName === undefined ? {} : { orgName }),
    timeoutMs: resolveTimeoutMs(),
  });
}
