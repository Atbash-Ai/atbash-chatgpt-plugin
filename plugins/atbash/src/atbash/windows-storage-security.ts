import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

// This helper handles paths and ACLs only. Private key material must never enter
// its input, argv, output or errors. Bootstrap integration is deliberately absent.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$request.path
  if ($path -notmatch '^[A-Za-z]:\\' -or $path.Substring(2).Contains(':')) { throw 'path' }
  $path = [IO.Path]::GetFullPath($path).TrimEnd('\')
  $volume = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($path))
  if ($volume.DriveType -ne [IO.DriveType]::Fixed -or $volume.DriveFormat -ne 'NTFS') { throw 'volume' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  # Exact privileged Windows servicing SID, ancestors only; never a service-SID wildcard.
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $danger = [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  function CheckAncestors([string]$candidate) {
    $parent = [IO.Directory]::GetParent($candidate)
    if ($null -eq $parent) { throw 'parent' }
    while ($null -ne $parent) {
      $attributes = [IO.File]::GetAttributes($parent.FullName)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
      $acl = [IO.Directory]::GetAccessControl($parent.FullName)
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
      if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'ancestor-owner' }
      foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($ace.AccessControlType -eq 'Allow' -and $trusted -notcontains $ace.IdentityReference.Value -and
            ($ace.FileSystemRights -band $danger) -ne 0) { throw 'ancestor-rights' }
      }
      $parent = $parent.Parent
    }
  }
  function CheckPrivate([string]$candidate, [bool]$directory) {
    $attributes = [IO.File]::GetAttributes($candidate)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    if ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $directory) { throw 'kind' }
    $acl = if ($directory) { [IO.Directory]::GetAccessControl($candidate) } else { [IO.File]::GetAccessControl($candidate) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
    if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'inheritance' }
    $full = $false
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($ace.IdentityReference.Value -ne $sid.Value -or $ace.AccessControlType -ne 'Allow') { throw 'principal' }
      if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { throw 'inherit-only' }
      if (($ace.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
        if (-not $directory -or ($ace.InheritanceFlags -eq ([Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit) -and $ace.PropagationFlags -eq 'None')) { $full = $true }
      }
    }
    if (-not $full) { throw 'rights' }
  }
  CheckAncestors $path
  switch ([string]$request.operation) {
    'prepare-directory' {
      if (-not [IO.Directory]::Exists($path)) {
        if ([IO.File]::Exists($path)) { throw 'exists' }
        $security = New-Object Security.AccessControl.DirectorySecurity
        $security.SetOwner($sid)
        $security.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule ($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $security.AddAccessRule($rule)
        [IO.Directory]::CreateDirectory($path, $security) | Out-Null
      }
      CheckPrivate $path $true
    }
    'verify-file' { CheckPrivate $path $false }
    default { throw 'operation' }
  }
  CheckAncestors $path
  [Console]::Out.Write('{"ok":true}')
} catch {
  $code = 'internal'
  if ($_.Exception.Message -cin @('path','volume','parent','reparse','ancestor-owner','ancestor-rights','kind','owner','null-dacl','inheritance','principal','inherit-only','rights','exists','operation')) { $code = $_.Exception.Message }
  [Console]::Out.Write('{"ok":false,"code":"' + $code + '"}')
  exit 1
}
`;

function check(operation: "prepare-directory" | "verify-file", path: string): void {
  if (process.platform !== "win32") throw new Error("Windows private storage is unsupported here.");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot) || !isAbsolute(path))
    throw new Error("Windows private storage cannot be verified.");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ operation, path }),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4096,
    },
  );
  if (result.error || result.status !== 0 || result.stdout !== '{"ok":true}' || result.stderr)
    throw new Error("Windows private storage cannot be verified.");
}

export function preparePrivateWindowsDirectory(path: string): void {
  check("prepare-directory", path);
}

export function verifyPrivateWindowsFile(path: string): void {
  check("verify-file", path);
}
