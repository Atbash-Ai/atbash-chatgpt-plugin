#!/usr/bin/env node

import { describeControlError, runControl } from "./control/cli.js";

async function main(): Promise<void> {
  try {
    const result = await runControl();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: describeControlError(error) })}\n`);
    process.exitCode = 1;
  }
}

void main();
