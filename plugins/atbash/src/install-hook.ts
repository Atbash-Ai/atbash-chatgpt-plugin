#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { defaultPathContext, runInstallHookCli } from "./install-hook/cli.js";

// The hook registered is the pre-tool-use.cjs next to this script, whatever path spelling started
// it: argv[1] is resolved through realpath (a junctioned or symlinked checkout, a drive-letter case)
// so the command written into hooks.json names the real file.
function main(): void {
  const script = process.argv[1];
  if (script === undefined) {
    process.stderr.write("install-hook must be started as a script (node install-hook.cjs).\n");
    process.exitCode = 1;
    return;
  }
  process.exitCode = runInstallHookCli(
    process.argv.slice(2),
    {
      ...defaultPathContext(),
      runtimeDir: dirname(realpathSync(script)),
      platform: process.platform,
      nodePath: process.execPath,
    },
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  );
}

main();
