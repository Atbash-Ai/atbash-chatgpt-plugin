// The marketplace build (build-marketplace.mjs) on a copy of the plugin, never on this checkout.
//
// This build runs npm as `node <npm-cli.js>` (a shell-less spawn of npm.cmd is refused on current
// Node), builds in a staging directory that replaces runtime/ only when the whole build succeeded,
// and refuses a native package that differs from the lockfile or a native file that leaves its
// package. Its own helper tests are in build.test.ts; this test (the same as atbash_chatgpt_plugin's,
// ported 2026-10-04) runs the whole build, so deleting any of those calls from it goes red.
//
// The build runs as a child process in a temporary copy of the plugin, with its dependencies linked,
// and a stand-in npm-cli.js that answers `npm pack` offline. Nothing is mocked inside the build.
//
// Out of scope: the stand-in tarballs are not the published packages, so these tests do not check a
// downloaded package's registry integrity (npm verifies that itself). They check that the manifest
// records the sha256 of the binary actually written, and that a bad package never replaces runtime/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// dist-tests/tests/ -> plugins/atbash/ and the repository root.
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = join(pluginRoot, "..", "..");
const NATIVE_PACKAGES = {
  "darwin-arm64": "@atbash/sdk-darwin-arm64",
  "linux-arm64": "@atbash/sdk-linux-arm64-gnu",
  "linux-x64": "@atbash/sdk-linux-x64-gnu",
  "win32-x64": "@atbash/sdk-win32-x64-msvc",
};
const PLATFORMS = Object.keys(NATIVE_PACKAGES);

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A minimal ustar archive holding one file, gzipped: what `npm pack` writes. */
const FAKE_NPM = String.raw`"use strict";
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { gzipSync } = require("node:zlib");
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_FAIL === "1") {
  process.stderr.write("npm pack failed (stand-in)\n");
  process.exit(1);
}
if (args[0] !== "pack") process.exit(3);
const spec = args[1];
const dest = args[args.indexOf("--pack-destination") + 1];
const name = spec.slice(0, spec.lastIndexOf("@")).replace(/^@/, "").replace(/\//g, "-");
const file = name + (process.env.FAKE_NPM_NO_BINARY === "1" ? ".txt" : ".node");
const body = Buffer.from("stand-in native binary for " + spec + "\n");
/** One ustar entry: "0" a file, "5" a folder, "2" a symbolic link to its link target. */
const entry = (path, type, data, link) => {
  const header = Buffer.alloc(512, 0);
  const put = (text, offset) => header.write(text, offset, "latin1");
  put(path, 0);
  put(type === "0" ? "0000644\0" : "0000755\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  if (link) put(link, 157);
  put("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
};
// FAKE_NPM_LINKED_BIN: the package's bin folder is a link out of the package, to a folder beside the
// extraction directory that holds a file the build must never copy into the runtime.
const linked = process.env.FAKE_NPM_LINKED_BIN === "1";
const reported = linked ? "bin/" + file : file;
if (linked) {
  const { mkdirSync } = require("node:fs");
  mkdirSync(join(dest, "escape"), { recursive: true });
  writeFileSync(join(dest, "escape", file), "NOT THE PACKAGE'S FILE\n");
}
const entries = linked
  ? [entry("package/", "5", Buffer.alloc(0)), entry("package/bin", "2", Buffer.alloc(0), "../../escape")]
  : [entry("package/" + file, "0", body)];
const filename = name + "-0.0.0.tgz";
const tgz = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));
writeFileSync(join(dest, filename), tgz);
const integrity =
  process.env.FAKE_NPM_BAD_INTEGRITY === "1"
    ? "sha512-substituted"
    : "sha512-" + require("node:crypto").createHash("sha512").update(tgz).digest("base64");
process.stdout.write(JSON.stringify([{ filename, integrity, files: [{ path: reported }] }]));
`;

/** A copy of the plugin with its dependencies linked, plus a stand-in npm on npm_execpath and PATH. */
function withPluginCopy(
  fn: (copy: string, env: NodeJS.ProcessEnv) => void,
  packEnv: NodeJS.ProcessEnv = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "atbash-marketplace-build-"));
  const copy = join(dir, "plugins", "atbash");
  const links: string[] = [];
  try {
    mkdirSync(copy, { recursive: true });
    for (const entry of [
      "build-marketplace.mjs",
      "build-lib.mjs",
      "package.json",
      "tsconfig.json",
    ]) {
      cpSync(join(pluginRoot, entry), join(copy, entry));
    }
    for (const entry of ["src", "runtime"]) {
      cpSync(join(pluginRoot, entry), join(copy, entry), { recursive: true });
    }
    cpSync(join(repoRoot, "tsconfig.base.json"), join(dir, "tsconfig.base.json"));
    const link = join(dir, "node_modules");
    symlinkSync(join(repoRoot, "node_modules"), link, "junction");
    links.push(link);

    const tools = join(dir, "tools");
    mkdirSync(tools);
    const npmCli = join(tools, "npm-cli.js");
    writeFileSync(npmCli, FAKE_NPM);
    // An `npm` on PATH that only fails, on every platform (`npm` for POSIX, `npm.cmd` for Windows): a
    // build that ignores npm_execpath and spawns whatever npm is on PATH fails here and never
    // reaches the network from a test.
    writeFileSync(join(tools, "npm"), "#!/bin/sh\necho 'npm from PATH (stand-in)' >&2\nexit 1\n", {
      mode: 0o755,
    });
    writeFileSync(join(tools, "npm.cmd"), "@echo npm from PATH (stand-in) 1>&2\r\n@exit /b 1\r\n");
    // packEnv shapes what the stand-in packs; the copy's lockfile records those same tarballs.
    const env: NodeJS.ProcessEnv = { ...process.env, ...packEnv, npm_execpath: npmCli };
    // Windows spells it Path: prepend to the key the environment already has, so the child sees
    // one PATH with the stand-in first.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${tools}${delimiter}${env[pathKey] ?? ""}`;

    // The copy's lockfile records each native package at the installed SDK version with the
    // integrity the stand-in reports for it, as a real lockfile records the published tarball's.
    const sdkVersion = (
      JSON.parse(
        readFileSync(join(repoRoot, "node_modules", "@atbash", "sdk", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    const packed = join(dir, "packed");
    mkdirSync(packed);
    const packages: Record<string, { version: string; integrity: string }> = {};
    for (const name of Object.values(NATIVE_PACKAGES)) {
      const out = spawnSync(
        process.execPath,
        [npmCli, "pack", `${name}@${sdkVersion}`, "--pack-destination", packed, "--json"],
        { encoding: "utf8", env },
      );
      const integrity = (JSON.parse(out.stdout) as { integrity: string }[])[0]?.integrity;
      assert.ok(integrity, `the stand-in npm reported no integrity for ${name}: ${out.stderr}`);
      packages[`node_modules/${name}`] = { version: sdkVersion, integrity };
    }
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    fn(copy, env);
  } finally {
    // The junction points at the live node_modules: unlink it before the recursive removal.
    for (const link of links) {
      try {
        unlinkSync(link);
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBuild(copy: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["build-marketplace.mjs"], {
    cwd: copy,
    env,
    encoding: "utf8",
    timeout: 300_000,
  });
}

test("build-marketplace: a failed build leaves the committed runtime and its native binaries in place", () => {
  withPluginCopy((copy, env) => {
    const before = new Map(
      [...PLATFORMS.map((p) => join("native", p, "atbash.node")), "index.cjs", "manifest.json"].map(
        (file) => [file, sha256(join(copy, "runtime", file))],
      ),
    );
    const result = runBuild(copy, { ...env, FAKE_NPM_FAIL: "1" });
    assert.notEqual(result.status, 0, `the build must fail: ${result.stdout}`);
    for (const [file, digest] of before) {
      const path = join(copy, "runtime", file);
      assert.ok(existsSync(path), `runtime/${file} was deleted by a failed build`);
      assert.equal(sha256(path), digest, `runtime/${file} was changed by a failed build`);
    }
    assert.equal(existsSync(join(copy, "runtime.build")), false, "staging left behind");
    assert.equal(existsSync(join(copy, "runtime.old")), false, "previous runtime left aside");
  });
});

test("build-marketplace: a package without a native binary fails the build and leaves runtime in place", () => {
  withPluginCopy((copy, env) => {
    const before = new Map(
      [...PLATFORMS.map((p) => join("native", p, "atbash.node")), "index.cjs", "manifest.json"].map(
        (file) => [file, sha256(join(copy, "runtime", file))],
      ),
    );
    const result = runBuild(copy, { ...env, FAKE_NPM_NO_BINARY: "1" });
    assert.notEqual(result.status, 0, `the build must fail: ${result.stdout}`);
    assert.match(result.stderr, /did not contain a native \.node file/);
    for (const [file, digest] of before) {
      const path = join(copy, "runtime", file);
      assert.ok(existsSync(path), `runtime/${file} was deleted by a failed build`);
      assert.equal(sha256(path), digest, `runtime/${file} was changed by a failed build`);
    }
    assert.equal(existsSync(join(copy, "runtime.build")), false, "staging left behind");
    assert.equal(existsSync(join(copy, "runtime.old")), false, "previous runtime left aside");
  });
});

// Security review 2026-10-04 (LOW): a packed native package must match the lockfile.
test("build-marketplace: a package that does not match the lockfile fails the build and leaves runtime in place", () => {
  withPluginCopy((copy, env) => {
    const before = new Map(
      [...PLATFORMS.map((p) => join("native", p, "atbash.node")), "index.cjs", "manifest.json"].map(
        (file) => [file, sha256(join(copy, "runtime", file))],
      ),
    );
    const result = runBuild(copy, { ...env, FAKE_NPM_BAD_INTEGRITY: "1" });
    assert.notEqual(result.status, 0, `the build must fail: ${result.stdout}`);
    assert.match(result.stderr, /does not match the lockfile/);
    for (const [file, digest] of before) {
      const path = join(copy, "runtime", file);
      assert.ok(existsSync(path), `runtime/${file} was deleted by a failed build`);
      assert.equal(sha256(path), digest, `runtime/${file} was changed by a failed build`);
    }
    assert.equal(existsSync(join(copy, "runtime.build")), false, "staging left behind");
  });
});

// Security review 2026-10-04 (LOW): a package whose bin folder links out of the package reported
// bin/<name>.node; the path and regular-file checks both passed and copyFile read the outside file
// into the runtime (on Windows too: copyFile follows the link tar writes). The build must refuse it
// and leave runtime/ as it was.
test("build-marketplace: a package whose folder links out of it fails the build and leaves runtime in place", () => {
  withPluginCopy(
    (copy, env) => {
      const before = new Map(
        [
          ...PLATFORMS.map((p) => join("native", p, "atbash.node")),
          "index.cjs",
          "manifest.json",
        ].map((file) => [file, sha256(join(copy, "runtime", file))]),
      );
      const result = runBuild(copy, env);
      assert.notEqual(result.status, 0, `the build must fail: ${result.stdout}`);
      assert.match(result.stderr, /leaves the package/);
      for (const [file, digest] of before) {
        const path = join(copy, "runtime", file);
        assert.ok(existsSync(path), `runtime/${file} was deleted by a failed build`);
        assert.equal(sha256(path), digest, `runtime/${file} was changed by a failed build`);
      }
      assert.equal(existsSync(join(copy, "runtime.build")), false, "staging left behind");
    },
    { FAKE_NPM_LINKED_BIN: "1" },
  );
});

test("build-marketplace: npm runs as node with npm's own script, never npm.cmd or npm from PATH", () => {
  withPluginCopy((copy, env) => {
    const result = runBuild(copy, env);
    assert.equal(
      result.status,
      0,
      `the build must succeed through npm_execpath:\n${result.stderr}\n${result.stdout}`,
    );
    const manifest = JSON.parse(readFileSync(join(copy, "runtime", "manifest.json"), "utf8")) as {
      platforms: Record<string, { package: string; sha256: string }>;
    };
    for (const platform of PLATFORMS) {
      const binary = join(copy, "runtime", "native", platform, "atbash.node");
      assert.match(readFileSync(binary, "utf8"), /^stand-in native binary for /);
      assert.equal(manifest.platforms[platform]?.sha256, sha256(binary));
    }
    assert.ok(existsSync(join(copy, "runtime", "index.cjs")), "the bundle was not written");
    assert.equal(existsSync(join(copy, "runtime.build")), false, "staging left behind");
  });
});
