import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createFixture } from "./windows-acl-fixture.js";
import {
  preparePrivateWindowsDirectory,
  verifyPrivateWindowsDirectory,
} from "../src/atbash/windows-storage-security.js";
import { trustedWindowsPowerShell } from "../src/atbash/windows-system-powershell.js";

if (process.platform === "win32") {
  test("pinned PowerShell modules and real ACL helper start within the deadline", async () => {
    const { executable, env } = trustedWindowsPowerShell();
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [string]::Equals($env:PSModulePath, ($PSHOME + '\Modules\.'), [StringComparison]::OrdinalIgnoreCase)) { exit 2 }
[Console]::Out.Write((('{"value":1}' | ConvertFrom-Json).value))
`;
    const started = performance.now();
    const result = spawnSync(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env, encoding: "utf8", windowsHide: true, shell: false, timeout: 20_000, maxBuffer: 4096 },
    );
    const diagnostics = JSON.stringify({
      status: result.status,
      signal: result.signal,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
      stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
      stderrBytes: Buffer.byteLength(result.stderr ?? ""),
      elapsedMs: Math.round(performance.now() - started),
    });
    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.status, 0, diagnostics);
    assert.equal(result.stdout === "1", true, diagnostics);
    assert.equal(result.stderr === "", true, diagnostics);

    const fixture = await createFixture();
    const directory = join(fixture, "private");
    preparePrivateWindowsDirectory(directory);
    verifyPrivateWindowsDirectory(directory);
  });
}
