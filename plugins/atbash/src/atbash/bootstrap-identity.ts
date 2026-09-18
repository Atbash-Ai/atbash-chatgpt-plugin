import { derivePublicKey, generateKeypair, loadAgentFromFile } from "@atbash/sdk";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { WindowsStorageSession } from "./windows-storage-session.js";

export interface CreatedLocalIdentity {
  state: "created";
  pubkey: string;
}

const STORE_NAMES = ["config.json", "guard-client-key", "atbash-client-key"] as const;
const FAILURE = "Local identity setup could not safely finish. Existing files were preserved.";

function refuse(): never {
  throw new Error(FAILURE);
}

function hasEnvironmentKey(): boolean {
  // Windows environment names are case-insensitive. Presence includes blank values.
  return Object.keys(process.env).some((name) => name.toUpperCase() === "ATBASH_AGENT_KEY");
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    refuse();
  }
  refuse();
}

function identity(value: BigIntStats, directory: boolean, links?: bigint): BigIntStats {
  if (
    value.isSymbolicLink() ||
    (directory ? !value.isDirectory() : !value.isFile()) ||
    value.ino <= 0n ||
    value.dev < 0n ||
    (links !== undefined && value.nlink !== links)
  )
    refuse();
  return value;
}

function sameObject(actual: BigIntStats, expected: BigIntStats): void {
  if (actual.ino !== expected.ino || actual.dev !== expected.dev) refuse();
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/**
 * Explicit, create-only local action. Importing this module performs no setup.
 * No alternative root, key, organization or test callback is accepted. Callers
 * must separately handle existing identities, enrollment and host activation.
 */
export async function bootstrapWindowsIdentity(): Promise<CreatedLocalIdentity> {
  let claim: FileHandle | undefined;
  let staging: FileHandle | undefined;
  let encoded: Buffer | undefined;
  let permissions: WindowsStorageSession | undefined;
  try {
    // Reject runtime arguments too, including empty/blank key overrides.
    if (arguments.length !== 0 || process.platform !== "win32" || hasEnvironmentKey()) refuse();
    const homeInput = process.env.HOME;
    const osHome = homedir();
    if (!isAbsolute(osHome) || (homeInput && !isAbsolute(homeInput))) refuse();
    const home = resolve(homeInput || osHome);
    if (!samePath(home, osHome)) refuse();
    const configParent = join(home, ".config");
    const directory = join(configParent, "atbash");
    const stores = STORE_NAMES.map((name) => join(directory, name));
    const destination = join(directory, "guard-client-key");
    const claimPath = join(directory, ".onboarding-bootstrap-claim");
    const stagingPath = join(directory, ".onboarding-bootstrap-staging");

    function inputsUnchanged(): void {
      if (process.env.HOME !== homeInput || homedir() !== osHome || hasEnvironmentKey()) refuse();
      permissions?.assertHealthy();
    }
    async function storesAbsent(): Promise<void> {
      for (const path of stores) await absent(path);
    }

    // Inspect every candidate before any filesystem mutation. Never parse an
    // existing config/key to decide it is disposable or safe to replace.
    await storesAbsent();
    const homeIdentity = identity(await lstat(home, { bigint: true }), true);
    if (!samePath(await realpath(home), home)) refuse();
    inputsUnchanged();
    permissions = new WindowsStorageSession();
    try {
      identity(await lstat(configParent, { bigint: true }), true);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        refuse();
      // Only this explicit immediate parent may be created; home already exists.
      await permissions.prepareDirectory(configParent);
    }
    const parentIdentity = identity(await lstat(configParent, { bigint: true }), true);
    if (!samePath(await realpath(configParent), configParent)) refuse();
    await permissions.prepareDirectory(directory);
    const directoryIdentity = identity(await lstat(directory, { bigint: true }), true);
    if (!samePath(await realpath(directory), directory)) refuse();
    await storesAbsent();
    inputsUnchanged();

    claim = await open(claimPath, "wx", 0o600);
    const claimIdentity = identity(await claim.stat({ bigint: true }), false, 1n);
    if (claimIdentity.size !== 0n) refuse();
    await permissions.verifyFile(claimPath);
    sameObject(identity(await lstat(claimPath, { bigint: true }), false, 1n), claimIdentity);
    staging = await open(stagingPath, "wx+", 0o600);
    const stagingIdentity = identity(await staging.stat({ bigint: true }), false, 1n);
    if (stagingIdentity.size !== 0n) refuse();

    async function verifyBoundary(links: bigint, published: boolean): Promise<void> {
      inputsUnchanged();
      sameObject(identity(await lstat(home, { bigint: true }), true), homeIdentity);
      sameObject(identity(await lstat(configParent, { bigint: true }), true), parentIdentity);
      sameObject(identity(await lstat(directory, { bigint: true }), true), directoryIdentity);
      if (!samePath(await realpath(directory), directory)) refuse();
      await permissions!.verifyStorage(
        directory,
        published ? [claimPath, stagingPath, destination] : [claimPath, stagingPath],
      );
      sameObject(identity(await claim!.stat({ bigint: true }), false, 1n), claimIdentity);
      const claimed = identity(await lstat(claimPath, { bigint: true }), false, 1n);
      sameObject(claimed, claimIdentity);
      if (claimed.size !== 0n) refuse();
      const staged = identity(await lstat(stagingPath, { bigint: true }), false, links);
      sameObject(staged, stagingIdentity);
      if (staging)
        sameObject(identity(await staging.stat({ bigint: true }), false, links), stagingIdentity);
      if (staged.size !== BigInt(encoded?.length ?? 0)) refuse();
      for (const name of STORE_NAMES) {
        const path = join(directory, name);
        if (published && name === "guard-client-key") {
          sameObject(identity(await lstat(path, { bigint: true }), false, links), stagingIdentity);
        } else await absent(path);
      }
      inputsUnchanged();
    }

    await verifyBoundary(1n, false);
    // Native generation is deliberately after verified private empty staging.
    const pair = generateKeypair();
    const pubkey = derivePublicKey(pair.priv_key);
    if (!/^(02|03)[0-9a-f]{64}$/.test(pubkey) || pubkey !== pair.pub_key) refuse();
    // Check open-handle/path identity again immediately before the secret write.
    await verifyBoundary(1n, false);
    encoded = Buffer.from(JSON.stringify({ privkey: pair.priv_key, pubkey }), "utf8");
    await staging.writeFile(encoded);
    await staging.sync();
    await staging.close();
    staging = undefined;
    await verifyBoundary(1n, false);
    await link(stagingPath, destination); // Atomic no-replace publication on verified NTFS.
    await verifyBoundary(2n, true);
    const loaded = loadAgentFromFile(destination);
    if (loaded.pubkey !== pubkey) refuse();
    await verifyBoundary(2n, true);
    await claim.close();
    claim = undefined;
    await permissions.finish();
    return { state: "created", pubkey };
  } catch {
    // SDK/native errors can contain paths or input values. Never attach a cause.
    throw new Error(FAILURE);
  } finally {
    encoded?.fill(0);
    await permissions?.dispose().catch(() => {});
    // Do not delete claims, staging files or published identities on any path.
    // These markers prevent a crash/retry from generating another identity.
    await staging?.close().catch(() => {});
    await claim?.close().catch(() => {});
  }
}
