#!/usr/bin/env node
import { Atbash } from "@atbash/sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { beginPairing, PairingCapacityError } from "./atbash/pairing-session.js";
import { resolveOrgName } from "./atbash/guard.js";
import { openDashboardBrowser } from "./atbash/dashboard-browser.js";

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
  const orgName = resolveOrgName();
  const client = Atbash.fromConfig({
    failClosed: true,
    ...(orgName === undefined ? {} : { orgName }),
  });
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
    await openDashboardBrowser(pairing.browserUrl);
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

void main().catch((error: unknown) => {
  // SDK errors may contain configuration details. Keep diagnostics bounded.
  process.stderr.write(
    error instanceof PairingCapacityError
      ? `${error.message}\n`
      : "Atbash pairing could not start or finish. Check local configuration, the installed runtime network, organization policy, and whether another pairing process is running.\n",
  );
  process.exitCode = 1;
});
