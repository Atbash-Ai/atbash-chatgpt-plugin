import assert from "node:assert/strict";
import { lstat, mkdir, open, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createFixture,
  addFixtureGrant,
  setFixtureDescriptor,
  readFixtureDescriptor,
  type DescriptorCase,
} from "./windows-acl-fixture.js";
import {
  preparePrivateWindowsDirectory,
  verifyPrivateWindowsDirectory,
  verifyPrivateWindowsFile,
} from "../src/atbash/windows-storage-security.js";

const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
if (process.platform === "win32") {
  test("Windows bootstrap ACL: directory verification never creates or repairs storage", async () => {
    const fixture = await createFixture();
    const missing = join(fixture, "absent");
    assert.throws(() => verifyPrivateWindowsDirectory(missing), /cannot be verified/);
    await assert.rejects(stat(missing), { code: "ENOENT" });
    const existing = join(fixture, "inherited");
    await mkdir(existing);
    const before = readFixtureDescriptor(existing);
    assert.throws(() => verifyPrivateWindowsDirectory(existing), /cannot be verified/);
    assert.equal(readFixtureDescriptor(existing), before);
  });
  const refusedDescriptors: DescriptorCase[] = [
    "object",
    "null",
    "empty",
    "read",
    "inherit-only",
    "generic-read",
    "generic-write",
    "generic-execute",
  ];
  for (const descriptor of refusedDescriptors) {
    test(`Windows bootstrap ACL: ${descriptor} descriptor cannot establish private storage`, async () => {
      const fixture = await createFixture();
      const directory = join(fixture, "private");
      preparePrivateWindowsDirectory(directory);
      const file = join(directory, "marker");
      const handle = await open(file, "wx+");
      try {
        await handle.writeFile("public fixture");
        const before = setFixtureDescriptor(file, descriptor);
        assert.throws(() => verifyPrivateWindowsFile(file), /cannot be verified/);
        assert.equal(
          readFixtureDescriptor(file),
          before,
          "Refusal must preserve the actual descriptor",
        );
        const contents = Buffer.alloc(14);
        assert.equal(
          (await handle.read(contents, 0, contents.length, 0)).bytesRead,
          contents.length,
        );
        assert.equal(contents.toString(), "public fixture");
      } finally {
        await handle.close();
      }
    });
  }

  for (const descriptor of ["unknown-mask", "audit-flags"] as const) {
    test(`Windows bootstrap ACL: filesystem normalizes ${descriptor} before readback`, async () => {
      const fixture = await createFixture();
      const directory = join(fixture, "private");
      preparePrivateWindowsDirectory(directory);
      const file = join(directory, "marker");
      await writeFile(file, "public fixture");
      const before = setFixtureDescriptor(file, descriptor);
      const bytes = Buffer.from(before, "base64");
      const dacl = bytes.readUInt32LE(16);
      assert.ok(dacl > 0);
      assert.equal(bytes.readUInt16LE(dacl + 4), 1, "Persisted DACL has one normalized ACE");
      assert.equal(bytes[dacl + 8], 0, "Persisted ACE is an ordinary allow");
      assert.equal(bytes[dacl + 9], 0, "Unsupported flags did not survive persistence");
      assert.equal(
        bytes.readUInt32LE(dacl + 12),
        2032127,
        "Unsupported mask bits did not survive persistence",
      );
      verifyPrivateWindowsFile(file);
      assert.equal(readFixtureDescriptor(file), before);
      assert.equal(await readFile(file, "utf8"), "public fixture");
    });
  }

  test("Windows bootstrap ACL: leaf and ancestor junctions refuse without changing their targets", async () => {
    const fixture = await createFixture();
    const target = join(fixture, "target");
    preparePrivateWindowsDirectory(target);
    const marker = join(target, "marker");
    await writeFile(marker, "public fixture");
    const before = readFixtureDescriptor(target);
    const junction = join(fixture, "junction");
    await symlink(target, junction, "junction");
    assert.throws(() => preparePrivateWindowsDirectory(junction), /cannot be verified/);
    assert.throws(() => verifyPrivateWindowsFile(join(junction, "marker")), /cannot be verified/);
    assert.throws(
      () => preparePrivateWindowsDirectory(join(junction, "child")),
      /cannot be verified/,
    );
    assert.equal((await lstat(junction)).isSymbolicLink(), true);
    assert.equal(readFixtureDescriptor(target), before);
    assert.equal(await readFile(marker, "utf8"), "public fixture");
    await assert.rejects(stat(join(target, "child")), { code: "ENOENT" });
  });

  test("Windows bootstrap ACL: untrusted generic ALL ancestor grant refuses without mutation", async () => {
    const fixture = await createFixture();
    const parent = join(fixture, "parent");
    preparePrivateWindowsDirectory(parent);
    const before = setFixtureDescriptor(parent, "generic-all-other");
    const child = join(parent, "must-not-exist");
    assert.throws(() => preparePrivateWindowsDirectory(child), /cannot be verified/);
    await assert.rejects(stat(child), { code: "ENOENT" });
    assert.equal(readFixtureDescriptor(parent), before);
  });

  test("Windows bootstrap ACL: callback FullControl is not an unconditional private grant", async () => {
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    preparePrivateWindowsDirectory(directory);
    const file = join(directory, "empty");
    const handle = await open(file, "wx");
    await handle.close();
    addFixtureGrant(file, "callback-self");
    assert.throws(() => verifyPrivateWindowsFile(file), /cannot be verified/);
  });

  test("Windows bootstrap ACL: newly created directory protects an empty staging file", async () => {
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    preparePrivateWindowsDirectory(directory);
    preparePrivateWindowsDirectory(directory);
    const path = join(directory, "empty-staging");
    const handle = await open(path, "wx", 0o600);
    try {
      verifyPrivateWindowsFile(path);
      assert.equal((await handle.stat()).size, 0);
    } finally {
      await handle.close();
    }
  });

  test("Windows bootstrap ACL: existing inherited directory is refused without repair", async () => {
    const fixture = await createFixture();
    const directory = join(fixture, "inherited");
    await mkdir(directory);
    const marker = join(directory, "marker.txt");
    await writeFile(marker, "preserve");
    const before = await stat(directory);
    assert.throws(() => preparePrivateWindowsDirectory(directory), /cannot be verified/);
    assert.equal(await readFile(marker, "utf8"), "preserve");
    assert.equal((await stat(directory)).ino, before.ino);
  });

  test("Windows bootstrap ACL: inherited ordinary file and missing file are refused", async () => {
    const fixture = await createFixture();
    const file = join(fixture, "ordinary");
    await writeFile(file, "public fixture");
    assert.throws(() => verifyPrivateWindowsFile(file), /cannot be verified/);
    assert.throws(() => verifyPrivateWindowsFile(join(fixture, "absent")), /cannot be verified/);
    assert.equal(await readFile(file, "utf8"), "public fixture");
  });

  test("Windows bootstrap ACL: exact TrustedInstaller grant is accepted only on an ancestor", async () => {
    const fixture = await createFixture();
    const parent = join(fixture, "parent");
    preparePrivateWindowsDirectory(parent);
    addFixtureGrant(parent, TRUSTED_INSTALLER);
    const child = join(parent, "private");
    preparePrivateWindowsDirectory(child);
    assert.throws(() => preparePrivateWindowsDirectory(parent), /cannot be verified/);
    const file = join(child, "empty");
    const handle = await open(file, "wx");
    await handle.close();
    verifyPrivateWindowsFile(file);
    addFixtureGrant(file, TRUSTED_INSTALLER);
    assert.throws(() => verifyPrivateWindowsFile(file), /cannot be verified/);
    assert.equal((await stat(file)).size, 0);
  });

  for (const sid of [TRUSTED_INSTALLER.slice(0, -1) + "5", "S-1-5-80-1-2-3-4-5", "S-1-1-0"]) {
    test(`Windows bootstrap ACL: untrusted ancestor grant ${sid} is refused`, async () => {
      const fixture = await createFixture();
      const parent = join(fixture, "parent");
      preparePrivateWindowsDirectory(parent);
      addFixtureGrant(parent, sid);
      const child = join(parent, "must-not-exist");
      assert.throws(() => preparePrivateWindowsDirectory(child), /cannot be verified/);
      await assert.rejects(stat(child), { code: "ENOENT" });
    });
  }
} else {
  test("Windows bootstrap ACL refuses unsupported platforms", () => {
    assert.throws(() => preparePrivateWindowsDirectory("/tmp/unused"), /unsupported/);
  });
}
