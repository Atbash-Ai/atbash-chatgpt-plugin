import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  preparePrivateWindowsDirectory,
  verifyPrivateWindowsStorage,
} from "../src/atbash/windows-storage-security.js";
import { createFixture } from "./windows-acl-fixture.js";

if (process.platform === "win32") {
  test("Windows bootstrap batch helper enforces the real bounded request protocol", async (t) => {
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    preparePrivateWindowsDirectory(directory);
    const file = join(directory, "marker");
    await writeFile(file, "public fixture");
    const originalSpawn = childProcess.spawnSync;
    let captured: string[] = [];
    const stub = t.mock.method(childProcess, "spawnSync", (_executable: string, args: string[]) => {
      captured = args;
      return { status: 0, stdout: '{"ok":true}', stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      verifyPrivateWindowsStorage(directory, [file]);
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(captured.length, 5);
    const valid = { operation: "verify-storage", path: directory, files: [file] };
    const run = (request: unknown) =>
      originalSpawn(
        join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        captured,
        {
          input: JSON.stringify(request),
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: 20_000,
          maxBuffer: 4096,
        },
      );
    const positive = run(valid);
    assert.equal(positive.status, 0);
    assert.equal(positive.stdout, '{"ok":true}');
    for (const request of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, operation: ["verify-storage"] },
      { ...valid, operation: "VERIFY-STORAGE" },
      { ...valid, operation: `verify-${String.fromCharCode(0xad)}storage` },
      { operation: valid.operation, Path: directory, files: [file] },
      {
        operation: valid.operation,
        [`pa${String.fromCharCode(0xad)}th`]: directory,
        files: [file],
      },
    ]) {
      const result = run(request);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^\{"ok":false,"code":"(?:path|operation|internal)"\}$/);
    }
  });
  test("Windows bootstrap helper rejects every unsuccessful process response", (t) => {
    const success = {
      pid: 1,
      output: [],
      status: 0,
      signal: null,
      stdout: '{"ok":true}',
      stderr: "",
    };
    let response: object = success;
    let script = "";
    const stub = t.mock.method(
      childProcess,
      "spawnSync",
      (executable: string, args: string[], options: object) => {
        assert.equal(
          executable,
          join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        );
        assert.deepEqual(args.slice(0, 4), [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
        ]);
        assert.ok(typeof args[4] === "string");
        script = Buffer.from(args[4], "base64").toString("utf16le");
        assert.deepEqual(options, {
          input: JSON.stringify({ operation: "prepare-directory", path: "C:\\public-fixture" }),
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: 20_000,
          maxBuffer: 4096,
        });
        return response;
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      stub.mock.restore();
      syncBuiltinESMExports();
    });
    preparePrivateWindowsDirectory("C:\\public-fixture");
    assert.ok(script.includes("ReadRawRules"));
    for (const change of [
      { error: Object.assign(new Error("fixture"), { code: "ETIMEDOUT" }) },
      { error: Object.assign(new Error("fixture"), { code: "ENOENT" }) },
      { error: Object.assign(new Error("fixture"), { code: "ENOBUFS" }) },
      { status: 1 },
      { status: null, signal: "SIGTERM" },
      { stdout: "" },
      { stdout: "not-json" },
      { stdout: '{"ok":false}' },
      { stdout: '{"ok":true}\nextra' },
      { stdout: '{"ok":true,"extra":1}' },
      { stderr: "warning" },
    ]) {
      response = { ...success, ...change };
      assert.throws(() => preparePrivateWindowsDirectory("C:\\public-fixture"), {
        message: "Windows private storage cannot be verified.",
      });
    }
    assert.equal(stub.mock.callCount(), 12);
  });

  test("Windows bootstrap raw classifier refuses unsupported masks and flags before filesystem normalization", (t) => {
    // Capture the actual helper source without launching it, then run its unchanged
    // classifier against synthetic descriptors. NTFS/.NET normalizes these two
    // malformed forms on disk; the separate real filesystem tests assert that fact.
    let source = "";
    const originalSpawn = childProcess.spawnSync;
    const stub = t.mock.method(childProcess, "spawnSync", (_executable: string, args: string[]) => {
      assert.ok(typeof args[4] === "string");
      source = Buffer.from(args[4], "base64").toString("utf16le");
      return { pid: 1, output: [], status: 0, signal: null, stdout: '{"ok":true}', stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      preparePrivateWindowsDirectory("C:\\public-fixture");
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
    const start = source.indexOf("  function ReadRawRules($acl) {");
    const end = source.indexOf("  function CheckAncestors", start);
    assert.ok(start >= 0 && end > start);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${source.slice(start, end)}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$results = @()
foreach ($kind in @('mask', 'flags', 'valid')) {
  $mask = 2032127
  $flags = [Security.AccessControl.AceFlags]::None
  if ($kind -eq 'mask') { $mask = $mask -bor 33554432 }
  if ($kind -eq 'flags') { $flags = [Security.AccessControl.AceFlags]::SuccessfulAccess }
  $dacl = [Security.AccessControl.RawAcl]::new(2, 1)
  $dacl.InsertAce(0, [Security.AccessControl.CommonAce]::new($flags, 'AccessAllowed', $mask, $sid, $false, $null))
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new('DiscretionaryAclPresent', $sid, $sid, $null, $dacl)
  $bytes = New-Object byte[] $raw.BinaryLength
  $raw.GetBinaryForm($bytes, 0)
  $inputAcl = [pscustomobject]@{ Bytes=$bytes }
  $inputAcl | Add-Member ScriptMethod GetSecurityDescriptorBinaryForm { return ,$this.Bytes }
  try { $rules = @(ReadRawRules $inputAcl); $results += @{kind=$kind; outcome='accepted'; count=$rules.Count} }
  catch { $results += @{kind=$kind; outcome=$_.Exception.Message} }
}
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))
`;
    const result = originalSpawn(
      join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 20_000, maxBuffer: 4096 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), [
      { kind: "mask", outcome: "ace-mask" },
      { kind: "flags", outcome: "ace-flags" },
      { kind: "valid", outcome: "accepted", count: 1 },
    ]);
  });
}
