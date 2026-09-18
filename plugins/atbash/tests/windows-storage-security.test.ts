import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import {
  preparePrivateWindowsDirectory,
  verifyPrivateWindowsFile,
} from "../src/atbash/windows-storage-security.js";

const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const fixtureRoots = new Set<string>();

async function createFixture() {
  // TEMP and this host's workspace have additional replacement-capable ACEs.
  // Fresh profile fixtures exercise the same checks without changing those ACLs.
  // This is never the actual SDK configuration directory.
  const root = await mkdtemp(join(homedir(), ".atbash-bootstrap-fixture-"));
  fixtureRoots.add(resolve(root));
  return root;
}

function addFixtureGrant(path: string, sid: string): void {
  const target = resolve(path);
  assert.ok(
    [...fixtureRoots].some((root) => target.startsWith(root + sep)),
    "ACL mutation stays inside a newly owned fixture",
  );
  assert.ok(sid === "callback-self" || /^S-[0-9-]+$/.test(sid));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$directory = [bool]([IO.File]::GetAttributes($request.path) -band [IO.FileAttributes]::Directory)
$acl = if ($directory) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
if ($request.sid -eq 'callback-self') {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $raw.DiscretionaryAcl = [Security.AccessControl.RawAcl]::new(2, 2)
  $raw.DiscretionaryAcl.InsertAce(0, [Security.AccessControl.CommonAce]::new('None', 'AccessAllowed', [int][Security.AccessControl.FileSystemRights]::Read, $sid, $false, $null))
  $raw.DiscretionaryAcl.InsertAce(1, [Security.AccessControl.CommonAce]::new('None', 'AccessAllowed', [int][Security.AccessControl.FileSystemRights]::FullControl, $sid, $true, [byte[]]@()))
  $bytes = New-Object byte[] $raw.BinaryLength
  $raw.GetBinaryForm($bytes, 0)
  $acl.SetSecurityDescriptorBinaryForm($bytes, [Security.AccessControl.AccessControlSections]::Access)
} else {
  $sid = [Security.Principal.SecurityIdentifier]::new([string]$request.sid)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
if ($directory) { [IO.Directory]::SetAccessControl($request.path, $acl) } else { [IO.File]::SetAccessControl($request.path, $acl) }
`;
  const result = spawnSync(
    join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: target, sid }),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4096,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `Fixture ACL grant must execute successfully: ${result.stderr}`);
}

if (process.platform === "win32") {
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
