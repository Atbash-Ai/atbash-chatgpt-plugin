import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const roots = new Set<string>();
export async function createFixture() {
  // The real host TEMP/workspace ancestors have extra replacement-capable ACEs.
  // Never repair them or use the personal SDK directory as a fixture.
  const root = await mkdtemp(join(homedir(), ".atbash-bootstrap-fixture-"));
  roots.add(resolve(root));
  return root;
}

export type DescriptorCase =
  | "callback"
  | "object"
  | "unknown-mask"
  | "audit-flags"
  | "null"
  | "empty"
  | "read"
  | "inherit-only"
  | "generic-read"
  | "generic-write"
  | "generic-execute"
  | "generic-all-other";

function access(path: string, mode: "inspect" | "grant" | "replace", value = ""): string {
  const target = resolve(path);
  assert.ok(
    [...roots].some((root) => target.startsWith(root + sep)),
    "Fixture ACL access is confined to newly owned descendants",
  );
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$directory = [bool]([IO.File]::GetAttributes($request.path) -band [IO.FileAttributes]::Directory)
$acl = if ($directory) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
if ($request.mode -eq 'grant') {
  $sid = [Security.Principal.SecurityIdentifier]::new([string]$request.value)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
} elseif ($request.mode -eq 'replace') {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  # Prevent the parent from silently restoring inherited FullControl after replacement.
  $raw.SetFlags([Security.AccessControl.ControlFlags]([int]$raw.ControlFlags -bor 4096))
  $raw.DiscretionaryAcl = [Security.AccessControl.RawAcl]::new(4, 2)
  $mask = [int][Security.AccessControl.FileSystemRights]::FullControl
  $flags = [Security.AccessControl.AceFlags]::None
  $callback = $false
  switch ([string]$request.value) {
    'callback' { $callback = $true }
    'object' { }
    'unknown-mask' { $mask = $mask -bor 33554432 }
    'audit-flags' { $flags = [Security.AccessControl.AceFlags]::SuccessfulAccess }
    'null' { $raw.DiscretionaryAcl = $null }
    'empty' { }
    'read' { $mask = [int][Security.AccessControl.FileSystemRights]::Read }
    'inherit-only' { $flags = [Security.AccessControl.AceFlags]9 }
    'generic-read' { $mask = [int]::MinValue }
    'generic-write' { $mask = 1073741824 }
    'generic-execute' { $mask = 536870912 }
    'generic-all-other' { $mask = 268435456; $sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0') }
    default { throw 'Unexpected descriptor fixture' }
  }
  if ($request.value -notin @('null', 'empty')) {
    if ($request.value -in @('callback', 'object', 'unknown-mask', 'audit-flags', 'inherit-only', 'generic-all-other')) {
      $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $raw.DiscretionaryAcl.InsertAce(0, [Security.AccessControl.CommonAce]::new('None', 'AccessAllowed', [int][Security.AccessControl.FileSystemRights]::Read, $owner, $false, $null))
    }
    $entry = if ($request.value -eq 'object') {
      [Security.AccessControl.ObjectAce]::new($flags, 'AccessAllowed', $mask, $sid, 'None', [guid]::Empty, [guid]::Empty, $false, $null)
    } else {
      [Security.AccessControl.CommonAce]::new($flags, 'AccessAllowed', $mask, $sid, $callback, [byte[]]@())
    }
    $raw.DiscretionaryAcl.InsertAce($raw.DiscretionaryAcl.Count, $entry)
  }
  $bytes = New-Object byte[] $raw.BinaryLength
  $raw.GetBinaryForm($bytes, 0)
  $acl.SetSecurityDescriptorBinaryForm($bytes, [Security.AccessControl.AccessControlSections]::Access)
} elseif ($request.mode -ne 'inspect') { throw 'Unexpected fixture operation' }
if ($request.mode -ne 'inspect') {
  if ($directory) { [IO.Directory]::SetAccessControl($request.path, $acl) } else { [IO.File]::SetAccessControl($request.path, $acl) }
}
$actual = if ($directory) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
[Console]::Out.Write([Convert]::ToBase64String($actual.GetSecurityDescriptorBinaryForm()))
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
      input: JSON.stringify({ path: target, mode, value }),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4096,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `Fixture ACL operation must succeed: ${result.stderr}`);
  assert.match(result.stdout, /^[A-Za-z0-9+/]+=*$/);
  return result.stdout;
}

export function addFixtureGrant(path: string, sid: string): void {
  if (sid === "callback-self") {
    access(path, "replace", "callback");
    return;
  }
  assert.match(sid, /^S-[0-9-]+$/);
  access(path, "grant", sid);
}
export const setFixtureDescriptor = (path: string, descriptor: DescriptorCase) =>
  access(path, "replace", descriptor);
export const readFixtureDescriptor = (path: string) => access(path, "inspect");
