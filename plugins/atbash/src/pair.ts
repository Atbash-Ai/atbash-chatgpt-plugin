#!/usr/bin/env node
import { Atbash } from "@atbash/sdk";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { beginPairing } from "./atbash/pairing-session.js";

async function openDashboard(url: string) {
  // Launch a concrete browser executable, never a shell/file association handler
  // (which can produce Windows "Pick an app" dialogs). The token is not logged.
  let executable = "google-chrome";
  let args = [url];
  if (process.platform === "win32") {
    const candidates = [
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
    executable = "";
    for (const candidate of candidates) {
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {
        /* Try next conventional install. */
      }
    }
    if (!executable) throw new Error("Google Chrome is required for this pairing preview.");
  } else if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    args = ["-a", "Google Chrome", url];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not open the Dashboard browser.")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      policy: { type: "string" },
      name: { type: "string" },
      purpose: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      "Atbash local pairing\nUsage: node pair.cjs [--policy <existing policy>] [--name <agent name>] [--purpose <purpose>]\nUses your configured identity, organization and runtime network. Private keys stay local.\n",
    );
    return;
  }
  // Credential resolution and signing stay inside this local process. Never
  // print client/config objects or accept a key in command-line arguments.
  const client = Atbash.fromConfig({ failClosed: true });
  const pairing = await beginPairing(client, {
    stateRoot: join(homedir(), ".config", "atbash", "pairing"),
    ...(values.policy ? { policyName: values.policy } : {}),
    ...(values.name ? { agentName: values.name } : {}),
    ...(values.purpose ? { purpose: values.purpose } : {}),
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await openDashboard(pairing.browserUrl);
    process.stdout.write(
      "Review enrollment in the Dashboard. Keep this helper running; your key stays local.\n",
    );
    while (!stopping && Date.now() < pairing.expiresAt) {
      if (await pairing.verified()) {
        // Re-read after the browser callback: the durable result records chain
        // verification, not a browser success assertion or a hook trust grant.
        process.stdout.write(
          "Enrollment verified. Host hook trust and a protected action still need verification before Atbash can be called active.\n",
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.exitCode = 1;
    process.stderr.write(
      "Pairing ended without verified enrollment. Run the same command to resume safely.\n",
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await pairing.close();
  }
}

void main().catch(() => {
  // SDK errors may contain configuration details. Keep diagnostics bounded.
  process.stderr.write(
    "Atbash pairing could not start or finish. Check local configuration, the installed runtime network, organization policy, and whether another pairing process is running.\n",
  );
  process.exitCode = 1;
});
