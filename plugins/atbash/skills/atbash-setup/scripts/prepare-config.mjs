#!/usr/bin/env node

import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const template = `${JSON.stringify({ agentKey: "", orgName: "" }, null, 2)}\n`;

function parseArguments(args) {
  let configDir = join(homedir(), ".config", "atbash");
  let openEditor = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      openEditor = false;
      continue;
    }
    if (argument === "--config-dir" && args[index + 1]) {
      configDir = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }

  return { configDir, openEditor };
}

async function ensureConfig(configDir) {
  const configPath = join(configDir, "config.json");
  await mkdir(configDir, { mode: 0o700, recursive: true });

  let created = false;
  try {
    await writeFile(configPath, template, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const configStats = await lstat(configPath);
  if (!configStats.isFile() || configStats.isSymbolicLink()) {
    throw new Error(`Refusing to use a non-regular config file: ${configPath}`);
  }

  if (process.platform !== "win32") {
    await chmod(configDir, 0o700);
    await chmod(configPath, 0o600);
  }

  return { configPath, created };
}

async function openGraphicalEditor(configPath) {
  const editor =
    process.platform === "win32"
      ? { command: "notepad.exe", args: [configPath] }
      : process.platform === "darwin"
        ? { command: "open", args: ["-a", "TextEdit", configPath] }
        : { command: "xdg-open", args: [configPath] };

  const child = spawn(editor.command, editor.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  await new Promise((resolveLaunch, rejectLaunch) => {
    child.once("spawn", resolveLaunch);
    child.once("error", rejectLaunch);
  });
  child.unref();
}

async function main() {
  const { configDir, openEditor } = parseArguments(process.argv.slice(2));
  const { configPath, created } = await ensureConfig(configDir);

  if (openEditor) {
    await openGraphicalEditor(configPath);
  }

  const action = created ? "Created" : "Kept existing";
  const editorStatus = openEditor ? " and opened it in a graphical editor" : "";
  process.stdout.write(`${action} Atbash config at ${configPath}${editorStatus}.\n`);
}

main().catch((error) => {
  process.stderr.write(`Atbash config setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
