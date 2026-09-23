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
Both the one-shot ACL check and the bootstrap session resolve Windows PowerShell
through the operating-system object namespace before spawning it. A caller's
`SystemRoot` or `PATH` cannot select the program that returns an ACL verdict;
the child receives the resolved Windows root. The Windows fixture places a real
executable under a poisoned `SystemRoot` and requires bootstrap to use the
trusted helper before generating an identity.

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

Focused cases cover import behavior, blank environment/override inputs, HOME
mismatch, empty/malformed existing stores, native creation, SDK restart readback,
concurrency, crashes, drift, substitution and error handling as detailed below.
Aggregate verification at the final commit across all required configurations
and final reviews remain necessary before integration. The initial
success/restart/retry test took about 30 seconds on a loaded Windows host; later
samples below reflect the helper optimization, not a live onboarding guarantee.

Each of the five bootstrap boundaries batches its directory and up to three
files into one helper request. The helper checks ancestors before and after each
file, and private directory permissions before and after the batch. The early
claim check and every Node identity, size, link-count, environment and store check
remain. No result is cached across generation, writing, publication or readback.

Batch requests require unique immediate children with exact ordinal parent
spelling. Unicode lookalike siblings, traversal, alternate streams, short-name
spellings and textual aliases are refused. Intentional publication hardlinks
remain valid; the bootstrap separately pins their identity and link count.
PowerShell reads strict UTF-8 so Unicode profile paths preserve their spelling.
The helper accepts only the bounded protocol and returns one all-or-nothing
result. Permission checks remain observations, not an atomic filesystem snapshot.

A single public-fixture comparison on the loaded development machine took
3.64 seconds for four separate helper launches versus 1.06 seconds for one batch.
This preliminary sample preceded ordinal path hardening and is not an onboarding
benchmark. Installed runtime, registration, approval and host enforcement timing
remain separate verification requirements.

Bootstrap fixtures also clear inherited Node preload options before child startup.
A harmless real preload is first proven executable, then required not to execute
through the isolated runner. Resolver redirection and generation counters cannot
establish isolation if unrelated preload code executes before them.

Authenticated organization and policy selection, local configuration association,
owner approval, independent chain readback and actual host trust/enforcement are
separate requirements. A stored key or successful pairing is not sufficient to
label an agent Protected. End-to-end timing must be measured on the real installed
and deployed flow, including an explicit breakdown of login and approval time.

## Per-attempt Windows helper under verification

The internal bootstrap now uses one owned PowerShell process for its permission
operations. It retains the optional parent preparation, private directory
preparation, early claim check and five distinct storage boundaries. Each request
runs the shared permission-check body again. Nothing is cached across boundaries;
native key generation, secret writes and SDK readback remain in Node.

The public-only protocol has a random 128-bit session identifier, sequences 1–8
and one request in flight. An exact canonical JSON grammar rejects duplicate and
unknown request fields before parsing. Input is strict UTF-8 and incrementally
bounded to 16 KiB per request and 128 KiB overall. Responses have one exact success
serialization, at most 256 bytes each and 2 KiB overall. Any stderr, extra reply,
wrong sequence, malformed data or process failure invalidates the attempt without
retrying or restarting the helper.

Requests expire after 20 seconds; helper lifetime is limited to 60 seconds without
refreshing the deadline. Responses arriving after either deadline are refused.
These limits do not cancel a blocked native SDK or filesystem call; expiration
prevents the next transition when control returns. Cleanup is limited to the
owned child and has a 2-second bound. Success requires a clean helper exit after
the final readback check. Claims, staging and published identities remain intact
on all failure paths.

The first real create/restart/refused-retry fixture completed in 5.67 seconds and
observed exactly one helper and all eight requests. This remains a local combined
fixture duration, not an installed onboarding benchmark. Protocol, exit-order,
timeout and interruption checks have passed; their aggregate final-commit
verification and final reviews are required before integration.

The helper invalidates the session on the process `exit` event, before waiting
for its pipes to close. Buffered replies cannot authorize another operation after
an observed exit. Termination is idempotent, signaling errors remain generic, and
finish/dispose share one cleanup deadline. The lifecycle regressions reproduce
acceptance of buffered replies and repeated cleanup budgets before these fixes.

Real-helper termination tests cover all five verification points: before
generation, before writing, before publication, after publication and after SDK
readback. Each refuses readiness, confirms helper closure and preserves any
staged/published identity without generating a replacement on retry. These tests
do not replace the separate parent-process crash, partial-write, filesystem
substitution and store/environment drift cases documented below.

One subsequent local sample measured 3.284 seconds for a cold bootstrap subprocess
(including Node/module startup), of which 1.231 seconds was inside the bootstrap
function including helper startup and shutdown. This sample is not live enrollment
or an installed-runtime benchmark and does not establish a latency guarantee.

Abrupt parent-process interruption is now tested separately from helper failure.
Ten isolated fixture processes exit with the exact checkpoint code after claim
creation, empty-stage creation, native generation, a real partial write, the full
write, fsync, close, publication, SDK readback, and immediately before publication.
The partial-write case verifies the bytes are a proper nonempty prefix before
exiting. Each case retains the real claim and any staging/published files; a fresh
process must refuse generation, writing and publication, preserving file identity,
link count, size and content hash. Published identities must still load through
the real SDK. Public-only markers establish checkpoint reachability; missing
markers, unexpected exits or unconfirmed helper disappearance fail the tests.
The helper PID probe observes process existence only and does not terminate it.

The ten crash cases and the existing native success/restart/refused-retry control
passed together (11 executed, zero failures or skips). This is focused evidence;
the separate I/O exceptions and substitution/drift cases do not establish
full-suite verification or live enrollment. No onboarding CLI, installed hook or
personal identity is changed by these tests.

Six injected error cases now cover an actual verified partial write followed by
an exception, an exception before fsync, an exception after a completed close,
an exception before publication, and either an exception or a different public
identity after actual SDK readback. Faults occur once at their named boundary.
Every case requires generic refusal, helper closure, retained file identities
and bytes, and a fresh retry with zero generation, writes or publication. After
publication, a separate uninjected SDK process must still load the original
identity. These six cases and the ordinary success control passed together.
Injected I/O exceptions prove application error handling, not physical disk
failure or crash durability. Full validation and live onboarding remain pending.

The drift matrix changes each of four inputs after stage creation, after stage
close, and after publication: a newly inserted config.json, a legacy identity
file, presence of an empty environment key, or HOME pointing to a fresh empty
fixture directory. All twelve cases refuse readiness at the expected generation,
write and publication counts. Injected public stores and existing identities stay
unchanged across a clean-environment retry; the alternate HOME receives no files.
Published identities remain readable through explicit-path SDK loading even when
the injected config is malformed. The twelve cases and a success control passed.
This verifies observed drift refusal, not atomic exclusion of all same-user races.

Replacement coverage uses real rename/copy operations for claim and stage files
before generation and before publication. Originals remain in private fixture
backup paths. A separate real directory replacement occurs after its identity is
observed but before claim creation; production checks refuse the changed state.
Because the replacement directory has inherited permissions, this case does not
independently isolate inode checking from ACL validation.

Two initially attempted later directory substitutions could not execute: this
Windows host returned EPERM while bootstrap handles were open. Their failed
diagnostic reports are retained. Two explicitly named OS-refusal controls instead
require that denial, an unchanged directory and no backup, then allow the real
bootstrap to succeed. They are not successful substitutions or a claim of
universal Windows protection. No production handle is closed to force a mutation.

Two real ACL changes pause immediately before the first or second storage check.
The fixture parent adds an actual Everyone grant to the empty stage, confirms the
stored descriptor changed, then lets the original PowerShell check run. Refusal
must occur with zero secret writes and preserve the descriptor through retry.
All nine replacement/OS/ACL cases and the success control passed together.
Replacing an entire store with a new secure empty directory by an arbitrary
same-user actor remains outside the cooperative claim's trust guarantee.

Four additional cases create real unexpected hard links to the claim or stage
before generation or before publication. They prove both paths reference the
same unchanged file with two links, then require refusal and preservation across
retry. The extra links stay in private fixture storage, including post-write
stage cases. The four cases and the ordinary successful two-link publication
control passed together. Extra links and backup files are retained, never removed.

Remaining delivery gates are aggregate exact-commit review, refreshed negative
proofs for production fixes, the full testing/development/production pipeline,
and actual CLI/dashboard/installed-hook integration and enrollment verification.
The internal bootstrap alone does not satisfy the live onboarding objective.

Strict-absence coverage includes a real dangling NTFS junction at each of the
three authoritative store paths: lstat observes the link while following stat
returns ENOENT. Bootstrap must preserve the entry and target and launch no helper.
Six precise metadata-error injections cover EACCES and EIO for each store, with
the same zero-helper/no-mutation requirement. Fresh uninjected retries preserve
the existing entries. These nine cases and a normal success control passed;
junction coverage is specific to that reparse form, and metadata exceptions are
injected error-handling checks rather than claims of actual disk failure.

### Diagnostic-only test runner evidence

The isolated bootstrap fixture reports fixed phase labels, child exit code/signal,
readiness-event count, stdout/stderr byte counts, parse completion and elapsed time
when a child fails. It never includes raw child output, exception details, key files
or environment values. A real child writes synthetic private-output sentinels and
exits unsuccessfully to check that diagnostic metadata survives while both sentinels
remain withheld. Timeouts, assertions, the concurrency barrier and production code
are unchanged. This improves failure diagnosis; it does not waive failed runs or
establish live activation.

The ACL fixture also reports only process-error presence, exit status, signal
presence and output byte counts. A real Windows startup failure emitted UTF-16
stderr containing NULs and invalidated the production JUnit report. Raw fixture
output is now withheld from assertion messages; successful startup, zero exit
status and valid descriptor output remain mandatory assertions. Original failed
reports are preserved, not repaired or counted as passing evidence.
