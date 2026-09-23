import { createHash, randomBytes } from "node:crypto";
import { mkdir, lstat, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import {
  serializePublicIntent,
  verifyPairingIntent,
  type SignedPairingIntent,
} from "./pairing-intent.js";

export interface PairingState {
  phase: "prepared" | "verifying" | "verified";
  signed: SignedPairingIntent;
}
export interface PairingStateStore {
  signal: AbortSignal;
  read(): Promise<PairingState | null>;
  save(state: PairingState): Promise<void>;
  close(): Promise<void>;
}

/** Public expectations only. Credentials/capabilities never enter this store.
 * One OS-visible lease per identity prevents simultaneous local enrollment.
 * The lease is recoverable after a crashed process stops its heartbeat.
 */
export async function openPairingState(
  root: string,
  publicKey: string,
): Promise<PairingStateStore> {
  if (!/^0[23][a-f0-9]{64}$/.test(publicKey)) throw new Error("Invalid pairing identity.");
  const directory = join(root, createHash("sha256").update(publicKey).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Invalid pairing state directory.");
  const cancelled = new AbortController();
  const release = await lock(directory, {
    stale: 10_000,
    update: 2_000,
    retries: 0,
    realpath: true,
    onCompromised: () => cancelled.abort(),
  });
  const path = join(directory, "state.json");
  let closed = false;
  const assertOpen = () => {
    if (closed || cancelled.signal.aborted) throw new Error("Pairing state lease is unavailable.");
  };
  return {
    signal: cancelled.signal,
    async read(): Promise<PairingState | null> {
      assertOpen();
      let source: string;
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.size > 32_768) throw new Error("Invalid pairing state.");
        source = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        // Public diagnostics intentionally omit filesystem details and causes.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Pairing state could not be read safely.");
      }
      const state = JSON.parse(source) as PairingState;
      if (
        Object.keys(state).sort().join(",") !== "phase,signed" ||
        !["prepared", "verifying", "verified"].includes(state.phase) ||
        state.signed?.intent?.publicKey !== publicKey ||
        !verifyPairingIntent(state.signed, state.signed.intent.issuedAt)
      )
        throw new Error("Invalid pairing state.");
      return state;
    },
    async save(state: PairingState) {
      assertOpen();
      if (
        !["prepared", "verifying", "verified"].includes(state.phase) ||
        state.signed.intent.publicKey !== publicKey ||
        !verifyPairingIntent(state.signed)
      )
        throw new Error("Invalid pairing state.");
      const temporary = join(directory, `state-${randomBytes(16).toString("hex")}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            phase: state.phase,
            signed: JSON.parse(serializePublicIntent(state.signed)),
          }),
          "utf8",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      assertOpen();
      await rename(temporary, path);
    },
    async close() {
      if (closed) return;
      closed = true;
      cancelled.abort();
      await release();
    },
  };
}
