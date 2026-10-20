import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface BuildHelpers {
  resolveNpmCli: (
    env: Record<string, string | undefined>,
    exists: (p: string) => boolean,
  ) => string;
  containedNativePath: (extractDir: string, reported: string) => string;
  assertRegularFile: (path: string, lstat?: (p: string) => { isFile(): boolean }) => string;
  isEntryPoint: (argv1: string | undefined, moduleUrl?: string) => boolean;
  assertInsidePackage: (extractDir: string, target: string) => string;
  assertLockedIntegrity: (
    lock: unknown,
    packageName: string,
    version: string,
    integrity: unknown,
    sdkPackage?: string,
  ) => void;
}

// dist-tests/tests/ -> plugins/atbash/: the build script itself, not a copy.
const buildScriptUrl = new URL("../../build-marketplace.mjs", import.meta.url);
const buildScriptPath = fileURLToPath(buildScriptUrl);
const helpers = (await import(buildScriptUrl.href)) as BuildHelpers;

test("build: an npm_execpath that is not npm-cli.js is refused, and the invoking npm takes precedence", () => {
  const seen: string[] = [];
  const exists = (p: string) => {
    seen.push(p);
    return false;
  };
  assert.throws(
    () => helpers.resolveNpmCli({ npm_execpath: "C:/evil/payload.js" }, exists),
    /Could not locate npm-cli\.js/,
  );
  assert.ok(
    seen.every((p) => basename(p) === "npm-cli.js"),
    `a candidate that is not npm-cli.js was consulted: ${seen.join(", ")}`,
  );
  assert.ok(!seen.some((p) => p.includes("payload")), "the foreign script must never be probed");

  const legit = "/opt/tools/npm/bin/npm-cli.js";
  const order: string[] = [];
  const found = helpers.resolveNpmCli({ npm_execpath: legit }, (p) => {
    order.push(p);
    return true;
  });
  assert.equal(basename(found), "npm-cli.js");
  assert.deepEqual(order, [legit], "the invoking npm must take precedence over bundled npm");
});

test("build: a native file path that escapes the extraction directory is refused", () => {
  const extractDir = process.platform === "win32" ? "C:/tmp/extract" : "/tmp/extract";
  assert.throws(
    () => helpers.containedNativePath(extractDir, "../../secret.node"),
    /leaves the package/,
  );
  assert.throws(
    () => helpers.containedNativePath(extractDir, "/etc/passwd.node"),
    /leaves the package/,
  );
  assert.throws(() => helpers.containedNativePath(extractDir, ""), /leaves the package/);
  const ok = helpers.containedNativePath(extractDir, "atbash.win32-x64-msvc.node");
  assert.ok(ok.endsWith("atbash.win32-x64-msvc.node"));
  assert.ok(ok.includes("package"));
});

test("build: a native file that is not a regular file is refused (a path check is not a file check)", () => {
  // A directory reached through a junction: contained by path, but not a file - and neither is a
  // symlink, which copyFile would otherwise follow out of the package.
  const dir = mkdtempSync(join(tmpdir(), "atbash-build-link-"));
  try {
    const link = join(dir, "atbash.node");
    symlinkSync(dir, link, "junction");
    assert.throws(() => helpers.assertRegularFile(link), /not a regular file/);
    assert.throws(() => helpers.assertRegularFile(dir), /not a regular file/);
    assert.throws(
      () => helpers.assertRegularFile("anything.node", () => ({ isFile: () => false })),
      /not a regular file/,
    );
    assert.equal(helpers.assertRegularFile(buildScriptPath), buildScriptPath);
    unlinkSync(link);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("build: the entry-point guard matches the script through a junction and never a different file", () => {
  // The build must run when node was started with this file, whatever path spelling reached it
  // (a junctioned checkout is how this workspace is reached), and must never run from an import.
  assert.equal(helpers.isEntryPoint(buildScriptPath), true);
  assert.equal(helpers.isEntryPoint(fileURLToPath(import.meta.url)), false, "another file");
  assert.equal(helpers.isEntryPoint(undefined), false, "no argv[1]");
  assert.equal(helpers.isEntryPoint(join(tmpdir(), "does-not-exist.mjs")), false, "missing file");
  const dir = mkdtempSync(join(tmpdir(), "atbash-build-junction-"));
  try {
    const link = join(dir, "plugin");
    symlinkSync(resolve(buildScriptPath, ".."), link, "junction");
    assert.equal(helpers.isEntryPoint(join(link, "build-marketplace.mjs")), true, "junction path");
    // The junction points at the live source tree: unlink it before the recursive removal.
    unlinkSync(link);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// Security review 2026-10-04 (LOW): the path check compares strings and the file check looks only
// at the last component, so a package holding `package/bin -> <outside>` and reporting
// `bin/x.node` passed both and copyFile read a file from outside the package into the runtime.
test("build: a native file reached through a linked folder that leaves the package is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "atbash-build-escape-"));
  const link = join(dir, "extract", "package", "bin");
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "x.node"), "not the package's file");
    mkdirSync(join(dir, "extract", "package", "lib"), { recursive: true });
    writeFileSync(join(dir, "extract", "package", "lib", "ok.node"), "the package's file");
    symlinkSync(outside, link, "junction");
    const extractDir = join(dir, "extract");
    const escaped = helpers.containedNativePath(extractDir, "bin/x.node");
    assert.equal(helpers.assertRegularFile(escaped), escaped, "both earlier checks pass");
    assert.throws(() => helpers.assertInsidePackage(extractDir, escaped), /leaves the package/);
    const inside = helpers.containedNativePath(extractDir, "lib/ok.node");
    assert.equal(helpers.assertInsidePackage(extractDir, inside), inside);
  } finally {
    // The junction points outside the package: unlink it before the recursive removal.
    try {
      unlinkSync(link);
    } catch {
      // already gone
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

// Security review 2026-10-04 (LOW): the native packages were packed by name and version and never
// compared with the lockfile, so a republished or substituted tarball would have been committed.
test("build: a packed native package must match the lockfile's integrity for that exact version", () => {
  const name = "@atbash/sdk-linux-x64-gnu";
  const integrity = "sha512-AAAA";
  const lock = {
    packages: { [`node_modules/${name}`]: { version: "1.2.3", integrity } },
  };
  helpers.assertLockedIntegrity(lock, name, "1.2.3", integrity);
  assert.throws(
    () => helpers.assertLockedIntegrity(lock, name, "1.2.3", "sha512-BBBB"),
    /does not match the lockfile/,
  );
  assert.throws(
    () => helpers.assertLockedIntegrity(lock, name, "1.2.4", integrity),
    /does not match the lockfile/,
  );
  assert.throws(() => helpers.assertLockedIntegrity(lock, name, "1.2.3", undefined), /integrity/);
  assert.throws(
    () => helpers.assertLockedIntegrity({ packages: {} }, name, "1.2.3", integrity),
    /not in the lockfile/,
  );
  assert.throws(() => helpers.assertLockedIntegrity(null, name, "1.2.3", integrity), /lockfile/);
});

// Security review 2026-10-19 (MEDIUM): the lookup assumed every SDK sits at the repository root,
// but npm installs the production SDK (and its natives) under plugins/atbash/node_modules, so the
// default prod build refused every native package. This runs the check against the repository's
// real lockfile for every environment, with the integrity npm recorded for each native package.
test("build: every native package of every environment resolves to its real lockfile entry", () => {
  const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
  const lock = JSON.parse(readFileSync(join(pluginRoot, "..", "..", "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const environments = JSON.parse(
    readFileSync(join(pluginRoot, "build-environments.json"), "utf8"),
  ) as Record<string, { sdkPackage: string }>;
  const dependencies = (
    JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  );
  const natives = [
    "@atbash/sdk-darwin-arm64",
    "@atbash/sdk-linux-arm64-gnu",
    "@atbash/sdk-linux-x64-gnu",
    "@atbash/sdk-win32-x64-msvc",
  ];
  for (const [name, { sdkPackage }] of Object.entries(environments)) {
    const spec =
      dependencies.dependencies?.[sdkPackage] ?? dependencies.devDependencies?.[sdkPackage];
    assert.ok(spec, `${name}: ${sdkPackage} is not a dependency of the plugin`);
    const version = spec.replace(/^npm:@atbash\/sdk@/, "");
    for (const native of natives) {
      const recorded = Object.entries(lock.packages).find(
        ([key, entry]) => key.endsWith(`node_modules/${native}`) && entry.version === version,
      );
      assert.ok(recorded, `${name}: the lockfile records no ${native}@${version}`);
      assert.doesNotThrow(
        () => helpers.assertLockedIntegrity(lock, native, version, recorded[1].integrity, sdkPackage),
        `${name}: ${native}@${version}`,
      );
    }
  }
});

// The dev build packs the natives of an aliased SDK (@atbash/sdk-dev), which npm nests under the
// alias's folder. That nested entry is the one checked, and a top-level copy of another version
// cannot vouch for it.
test("build: an aliased SDK's native package is checked against its own nested lockfile entry", () => {
  const name = "@atbash/sdk-linux-x64-gnu";
  const sdk = "@atbash/sdk-dev";
  const nested = "sha512-NEST";
  const top = "sha512-TOP";
  const lock = {
    packages: {
      [`node_modules/${sdk}`]: { version: "2.0.0-dev.0" },
      [`node_modules/${sdk}/node_modules/${name}`]: { version: "2.0.0-dev.0", integrity: nested },
      [`node_modules/${name}`]: { version: "1.2.3", integrity: top },
    },
  };
  helpers.assertLockedIntegrity(lock, name, "2.0.0-dev.0", nested, sdk);
  // No SDK is locked at 1.2.3, so nothing vouches for a 1.2.3 native packed for it.
  assert.throws(
    () => helpers.assertLockedIntegrity(lock, name, "1.2.3", top, sdk),
    /not in the lockfile/,
  );
  // The nested entry is the one Node would load for this SDK: a top-level copy cannot stand in
  // for it, and a nested entry at another version is refused rather than skipped.
  const stale = {
    packages: {
      [`node_modules/${sdk}`]: { version: "2.0.0-dev.0" },
      [`node_modules/${sdk}/node_modules/${name}`]: { version: "1.9.0", integrity: nested },
      [`node_modules/${name}`]: { version: "2.0.0-dev.0", integrity: top },
    },
  };
  assert.throws(
    () => helpers.assertLockedIntegrity(stale, name, "2.0.0-dev.0", top, sdk),
    /does not match the lockfile/,
  );
  assert.throws(
    () => helpers.assertLockedIntegrity(lock, name, "2.0.0-dev.0", "sha512-BBBB", sdk),
    /does not match the lockfile/,
  );
  assert.throws(
    () =>
      helpers.assertLockedIntegrity({ packages: {} }, name, "2.0.0-dev.0", nested, sdk),
    /not in the lockfile/,
  );
});
