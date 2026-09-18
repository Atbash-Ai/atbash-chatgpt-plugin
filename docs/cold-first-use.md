# Cold first-use setup: work in progress

The goal is to remove manual key handling from first-use onboarding while keeping
the identity local and preserving every existing SDK identity. This checkout
contains an internal Windows permissions helper and a create-only identity
bootstrap function. Neither is called by the pairing command or shipped runtime.
Bootstrap is an explicit local action; importing its module does not create an
identity. It does not change organization configuration, enroll an agent or
activate a hook.

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

Permission fixtures replace their DACL with inheritance disabled. Otherwise
Windows can reapply the parent's FullControl grant and invalidate a negative
test's premise. Actual descriptor readback verifies the persisted state; refusal
checks retain the descriptor and public marker bytes. Junction tests also verify
that neither the junction nor its target is changed.

The Windows filesystem/.NET ACL path normalizes the tested unknown-mask and
audit-flag entries into an ordinary FullControl grant. Tests assert that actual
readback instead of claiming those malformed entries survived on disk. Separate
synthetic-descriptor tests run the production raw-rule classifier in PowerShell
and require rejection of the original unsupported forms, with a valid-rule
positive control. These synthetic cases do not substitute for the real NTFS
permission, inheritance, callback and junction tests. Process-boundary tests
additionally cover timeouts, spawn/output errors and nonzero exits without
starting PowerShell or touching storage.

CI runs the full verification and committed marketplace-runtime checks on both
Linux and Windows, using immutable action commit references. Submission packaging
and artifact upload remain Linux-only. Local Windows results do not establish that
the hosted Windows job has passed; its actual run is a separate delivery gate.

## Remaining bootstrap and onboarding work

The initial bootstrap checks strict absence of config.json, guard-client-key and
atbash-client-key before changing storage. It refuses runtime arguments, even
blank key/path overrides, an environment key even when blank, or disagreement
between HOME and the OS home. Only a missing immediate .config parent and the
private atbash directory can be created; arbitrary ancestors are not created.

An exclusive fixed claim coordinates bootstrap attempts. An exclusive empty
staging file receives real ACL verification before native SDK key generation.
Bigint device/inode values, regular-file types, link counts, resolver inputs and
store absence are rechecked at publication boundaries. The complete JSON write
is synced and closed before an NTFS hard link publishes guard-client-key without
replacement. Explicit-path SDK readback must derive the same public identity.
Only the public key and created state are returned; failures have a bounded
generic message without SDK exception causes.

Claims and staging files are retained on success and failure. Bootstrap never
breaks a stale claim or deletes a partial/published identity. Existing-identity
onboarding and recovery remain separate work. This cooperative claim cannot
atomically exclude older SDKs or other same-user processes writing another store;
observed drift refuses success and never deletes either identity.

The first focused cases cover import behavior, blank environment/override inputs,
HOME mismatch, empty/malformed existing stores, native creation, SDK restart
readback and replacement refusal. Concurrency, crash interruption, metadata/ACL
substitution and injected publication failures still need verification before
integration. The initial success/restart/retry test took about 30 seconds on a
loaded Windows host; this is a fixture duration, not an onboarding benchmark or
achievement of the speed goal. Permission-helper launch overhead still needs
measurement and reduction without removing boundary checks.

Bootstrap fixtures also clear inherited Node preload options before child startup.
A harmless real preload is first proven executable, then required not to execute
through the isolated runner. Resolver redirection and generation counters cannot
establish isolation if unrelated preload code executes before them.

Authenticated organization and policy selection, local configuration association,
owner approval, independent chain readback and actual host trust/enforcement are
separate requirements. A stored key or successful pairing is not sufficient to
label an agent Protected. End-to-end timing must be measured on the real installed
and deployed flow, including an explicit breakdown of login and approval time.
