# Cold first-use setup: work in progress

The goal is to remove manual key handling from first-use onboarding while keeping
the identity local and preserving every existing SDK identity. This checkout
contains an internal Windows permissions foundation only. It does not create a
key, change SDK configuration, enroll an agent or activate a hook, and is not
called by the pairing command or shipped runtime.

## Storage permissions

The helper supports fixed local NTFS volumes. It rejects reparse points, null
DACLs and ancestors that an untrusted principal can replace or change permissions
on. Its ancestor trust list is the current user, SYSTEM, Administrators and the
exact Windows TrustedInstaller SID; this is not a general service-account or
application-capability exception. A malicious process running as the same user,
or privileged operating-system code, is outside this boundary.

Private directories must be owned by the current user and have a protected DACL
granting that user FullControl with file and directory inheritance. Existing
directories are inspected, never repaired. New directories receive the DACL at
creation and are checked afterward, since the Windows creation API may return an
already-existing directory. Empty staging files must also have their actual
owner and ACL checked before the future bootstrap code generates a key.

The PowerShell helper accepts only public paths and an operation name. It never
receives a key. It runs without a shell association or visible window, with a
deadline and bounded output. Errors do not echo paths or exception details.
Unsupported platforms and unverifiable permissions fail closed.

Validation examines every raw DACL entry instead of relying on the high-level
rule projection, which can omit rule types or discard callback conditions. Only
ordinary unconditional allow/deny entries with supported flags and file rights
are understood; other entries refuse setup. Windows generic file rights are
mapped explicitly before access checks. A callback FullControl entry cannot
satisfy the required unconditional private grant.

Windows TEMP and application-managed folders may grant additional principals
replacement rights. Tests use fresh, uniquely named profile fixture directories
whose actual ancestors pass the same checks. They do not repair those ancestors
or access the user's SDK configuration. Successful fixture checks are not proof
that an arbitrary real configuration directory is safe.

## Remaining bootstrap and onboarding work

Before this helper is integrated, bootstrap still needs strict absence checks for
config.json, guard-client-key and atbash-client-key; environment/key-path conflict
handling; one exclusive setup claim; verified staging identity; durable complete
writes and publication without replacement; actual SDK readback; race/crash tests;
and recovery that never silently generates a replacement identity. Existing keys
and even empty or malformed configuration must remain untouched.

Authenticated organization and policy selection, local configuration association,
owner approval, independent chain readback and actual host trust/enforcement are
separate requirements. A stored key or successful pairing is not sufficient to
label an agent Protected. End-to-end timing must be measured on the real installed
and deployed flow, including an explicit breakdown of login and approval time.
