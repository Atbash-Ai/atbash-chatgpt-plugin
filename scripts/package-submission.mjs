import { spawnSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins/atbash");
const metadata = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(plugin, "runtime/manifest.json"), "utf8"));
if (runtime.sdkVersion !== metadata.dependencies["@atbash/sdk"]) {
  throw new Error("Runtime SDK differs from the pinned dependency. Rebuild before packaging.");
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
  const included = [".codex-plugin", "assets", "hooks", "runtime", "skills"];
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
    sdkVersion: runtime.sdkVersion,
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
