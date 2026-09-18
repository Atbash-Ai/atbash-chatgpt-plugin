import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

// This helper handles paths and ACLs only. Private key material must never enter
// its input, argv, output or errors. Each call independently verifies current ACLs.
export const WINDOWS_STORAGE_CHECKS = String.raw`
  $ordinal = [StringComparison]::Ordinal
  if ($request.operation -isnot [string] -or
      @(@('prepare-directory','verify-directory','verify-file','verify-storage') | Where-Object {
        [string]::Equals($_, $request.operation, $ordinal)
      }).Count -ne 1) { throw 'operation' }
  if ([string]::Equals($request.operation, 'verify-storage', $ordinal)) {
    $names = @($request.PSObject.Properties.Name)
    if ($names.Count -ne 3 -or @($names | Where-Object {
          -not ([string]::Equals($_, 'operation', $ordinal) -or
                [string]::Equals($_, 'path', $ordinal) -or
                [string]::Equals($_, 'files', $ordinal))
        }).Count -ne 0 -or
        $request.path -isnot [string] -or $request.files -isnot [array] -or
        $request.files.Count -lt 1 -or $request.files.Count -gt 3) { throw 'path' }
    function CheckCanonical([string]$candidate) {
      if ($candidate -notmatch '^[A-Za-z]:\\' -or $candidate.Substring(2).Contains(':') -or
          $candidate -match '[/~]' -or $candidate -match '[. ](\\|$)' -or
          -not [string]::Equals($candidate, [IO.Path]::GetFullPath($candidate).TrimEnd('\'), $ordinal)) { throw 'path' }
    }
    CheckCanonical $request.path
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $request.files) {
      if ($file -isnot [string]) { throw 'path' }
      CheckCanonical $file
      # Exact parent spelling also works in case-sensitive NTFS directories.
      if (-not [string]::Equals([IO.Path]::GetDirectoryName($file), $request.path, $ordinal) -or
          -not $seen.Add($file)) { throw 'path' }
    }
  }
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
  function ReadRawRules($acl) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      # GetAccessRules can omit ACE classes and erase callback conditions.
      if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
          $ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed, [Security.AccessControl.AceType]::AccessDenied)) { throw 'ace-type' }
      if (([int]$ace.AceFlags -band 224) -ne 0) { throw 'ace-flags' }
      $mask = [long]$ace.AccessMask -band 4294967295
      if (($mask -band (4294967295 -bxor (4026531840 -bor 2032127))) -ne 0) { throw 'ace-mask' }
      # Windows file generic mappings: READ_CONTROL + SYNCHRONIZE plus file rights.
      # https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights
      $rights = $mask -band 268435455
      if (($mask -band 2147483648) -ne 0) { $rights = $rights -bor 1179785 }
      if (($mask -band 1073741824) -ne 0) { $rights = $rights -bor 1179926 }
      if (($mask -band 536870912) -ne 0) { $rights = $rights -bor 1179808 }
      if (($mask -band 268435456) -ne 0) { $rights = $rights -bor 2032127 }
      [pscustomobject]@{ Sid=$ace.SecurityIdentifier.Value; Flags=[int]$ace.AceFlags; Allow=($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed); Rights=$rights }
    }
  }
  function CheckAncestors([string]$candidate) {
    $parent = [IO.Directory]::GetParent($candidate)
    if ($null -eq $parent) { throw 'parent' }
    while ($null -ne $parent) {
      $attributes = [IO.File]::GetAttributes($parent.FullName)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
      $acl = [IO.Directory]::GetAccessControl($parent.FullName)
      if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'ancestor-owner' }
      foreach ($ace in @(ReadRawRules $acl)) {
        if (($ace.Flags -band 8) -ne 0) { continue }
        if ($ace.Allow -and $trusted -notcontains $ace.Sid -and
            ($ace.Rights -band $danger) -ne 0) { throw 'ancestor-rights' }
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
    if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'inheritance' }
    $full = $false
    foreach ($ace in @(ReadRawRules $acl)) {
      if ($ace.Sid -ne $sid.Value -or -not $ace.Allow) { throw 'principal' }
      if (($ace.Flags -band 8) -ne 0) { throw 'inherit-only' }
      if (($ace.Rights -band 2032127) -eq 2032127) {
        if (-not $directory -or ($ace.Flags -band 15) -eq 3) { $full = $true }
      }
    }
    if (-not $full) { throw 'rights' }
  }
  CheckAncestors $path
  switch -CaseSensitive ([string]$request.operation) {
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
    'verify-directory' { CheckPrivate $path $true }
    'verify-storage' {
      CheckPrivate $path $true
      foreach ($file in $request.files) {
        CheckAncestors $file
        CheckPrivate $file $false
        CheckAncestors $file
      }
      CheckPrivate $path $true
    }
    default { throw 'operation' }
  }
  CheckAncestors $path
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
${WINDOWS_STORAGE_CHECKS}
  [Console]::Out.Write('{"ok":true}')
} catch {
  $code = 'internal'
  if ($_.Exception.Message -cin @('path','volume','parent','reparse','ancestor-owner','ancestor-rights','kind','owner','null-dacl','inheritance','principal','inherit-only','rights','exists','operation','ace-type','ace-flags','ace-mask')) { $code = $_.Exception.Message }
  [Console]::Out.Write('{"ok":false,"code":"' + $code + '"}')
  exit 1
}
`;

function check(
  operation: "prepare-directory" | "verify-directory" | "verify-file" | "verify-storage",
  path: string,
  files?: readonly string[],
): void {
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
      input: JSON.stringify({ operation, path, ...(files === undefined ? {} : { files }) }),
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

export function verifyPrivateWindowsDirectory(path: string): void {
  check("verify-directory", path);
}

/** Verify one boundary in one process; never cache across key generation or I/O. */
export function verifyPrivateWindowsStorage(path: string, files: readonly string[]): void {
  check("verify-storage", path, files);
}
