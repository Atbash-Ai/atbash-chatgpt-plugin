import { spawnSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPublicLinks } from "./check-public-links.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins/atbash");
const metadata = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(plugin, "runtime/manifest.json"), "utf8"));
const environments = JSON.parse(await readFile(join(plugin, "build-environments.json"), "utf8"));
// The runtime is checked against the SDK pinned for the environment it was built for.
const sdkPackage = environments[runtime.environment]?.sdkPackage;
const pinned = metadata.dependencies?.[sdkPackage] ?? metadata.devDependencies?.[sdkPackage] ?? "";
if (sdkPackage === undefined || runtime.sdkVersion !== pinned.replace(/^npm:@atbash\/sdk@/, "")) {
  throw new Error("Runtime SDK differs from the pinned dependency. Rebuild before packaging.");
}
const pluginManifest = JSON.parse(
  await readFile(join(plugin, ".codex-plugin/plugin.json"), "utf8"),
);
console.log("Checking public website, support, privacy policy, and terms links...");
const publicLinkChecks = await checkPublicLinks(pluginManifest.interface);
for (const check of publicLinkChecks.results) {
  console.log(`${check.field}: HTTP ${check.status} ${check.finalUrl}`);
}
const output = join(root, "artifacts");
const staging = await mkdtemp(join(tmpdir(), "atbash-submission-"));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
};
try {
  await mkdir(output, { recursive: true });
  const full = join(staging, "plugin");
  await mkdir(full);
  // The public archive excludes bundled hook registration. The Git marketplace
  // keeps hooks/hooks.json; archive users register the local installer explicitly.
  const included = [".codex-plugin", "assets", "runtime", "skills"];
  for (const entry of included)
    await cp(join(plugin, entry), join(full, entry), { recursive: true });
  const archives = [
    { name: `atbash-plugin-${metadata.version}.zip`, cwd: full, entries: included },
    {
      name: `atbash-setup-${metadata.version}.zip`,
      cwd: join(full, "skills"),
      entries: ["atbash-setup"],
    },
  ];
  const files = [];
  for (const archive of archives) {
    const fresh = join(staging, archive.name);
    run("zip", ["-q", "-r", fresh, ...archive.entries], archive.cwd);
    run("unzip", ["-tq", fresh], root);
    await copyFile(fresh, join(output, archive.name));
    const bytes = await readFile(fresh);
    files.push({
      file: archive.name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const manifest = {
    repository: "https://github.com/Atbash-Ai/atbash-chatgpt-plugin",
    sourceCommit: head.status === 0 ? head.stdout.trim() : null,
    workingTreeDirty: dirty.status !== 0 || dirty.stdout.trim() !== "",
    pluginVersion: metadata.version,
    environment: runtime.environment,
    sdkVersion: runtime.sdkVersion,
    publicLinkChecks,
    files,
  };
  await writeFile(
    join(output, "submission-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`Artifacts: ${(await readdir(output)).join(", ")}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
