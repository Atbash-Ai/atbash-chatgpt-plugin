# Secure local onboarding (implementation in progress)

The intended flow keeps the installed agent identity on the user's machine,
opens the Dashboard for owner approval, and reuses an existing organization
policy. It must never require pasting a private key into the browser.

The packaged preview command is `node plugins/atbash/runtime/pair.cjs` from the
repository, or `node runtime/pair.cjs` from the installed plugin directory.
Development builds also provide `dist/pair.cjs`. It uses the existing SDK configuration and opens Chrome
directly. An existing local identity, organization and organization policy are
required; cold account/configuration setup is not automated yet. Optional
`--policy`, `--name` and `--purpose` arguments contain public metadata only.
The helper resolves the organization with the same SDK configuration precedence
as the status command: `ATBASH_ORG_NAME` overrides the local configuration.
Surrounding whitespace is trimmed; a missing or blank organization is rejected
before chain queries, callback-server startup or browser launch. SDK 0.7.1
requires the resolved organization to be passed explicitly to `fromConfig`.
The command is implemented locally, **not released or activated**:

- `pairing-intent.ts` signs a fixed, domain-separated tuple with the local
  secp256k1 identity. Organization, chain, profile, named policy revision,
  hashes of stored policy bytes, and expiry are all included.
- `pairing-server.ts` exposes only the already signed public intent and a
  verification trigger. It binds literal IPv4 loopback, checks exact Host and
  Origin, and requires a random capability on POST. Preflight alone grants no
  operation. Requests cannot provide signing payloads or completion verdicts.
- `pairing-chain.ts` uses pinned development or production nodes and BRID for read-only
  queries. Readback must match the entire expected identity, policy binding,
  revision, stored-byte hashes, and active enforcement. Registration alone is
  insufficient. Node failures and missing evidence fail closed.
  Before opening the browser, capacity preflight rejects a new identity when
  the organization has no available active-agent slot. An existing matching
  identity can resume, but still needs full readback. The transaction is the
  final capacity authority; the preflight does not reserve a slot.
- `pairing-state.ts` keeps public signed expectations under an identity-scoped
  exclusive filesystem lease. It stores neither the private key nor the browser
  capability. Recovery renews the nonce and requires fresh readback; policy or
  profile drift rejects the attempt instead of replacing the saved expectations.
- `pairing-session.ts` connects signing, the actual HTTP helper, independent
  chain verification and durable completion. A browser response cannot mark the
  state verified. Host trust remains a separate requirement.

Verification is a snapshot, not a guarantee that an owner can never change
policy. Existing owner authority and the ordinary fail-closed action path remain
required. The contract does not enforce this helper's nonce. A conflicting
registration must never cause automatic organization adoption or key replacement.

## Remaining integration gates

The command, durable state, Dashboard pairing page, owner transaction and runtime
network checks are implemented in the isolated worktrees. The integrated plugin
includes the hook watchdog, private decision channel, hook installer and their
complete regression suite from `39be3f9c460b`; pairing adds a separate executable.
Marketplace packaging is built locally. Production browser verification,
final delivery gates, live registration and
the first protected action remain outstanding. No live registration has been
made. Private-chain targets are unsupported. A signed-in development Dashboard
does not activate an identity whose installed runtime targets production.

The dedicated browser page must remove the capability fragment before application
scripts initialize, disable analytics, use no-referrer/no-store/frame protection,
and allow loopback only on that page's CSP. Browser local-network permission may
require a first-run prompt; denial must remain actionable without weakening
browser security. It is different from a Windows file-association dialog.

## Verification

Run `npm test` from the repository. Pairing tests use real loopback HTTP and
Node cryptographic signatures. Chain tests exercise real GTV encoding/decoding
with controlled query results. Composition tests use the real helper, state,
signatures and GTV codec, mocking only remote transport, and cover recovery,
policy drift, wrong identity, paused enforcement and unavailable nodes. They do
not prove live enrollment. A separate
read-only live query verified transport and the configured identity's absence.
Final full environment runs, browser tests, negative proofs, independent reviews
and a generated pipeline handoff remain necessary.

`postchain-client@2.1.2` brings six low-severity production dependency
advisories with no fix reported by npm audit. Pairing-intent signing uses
`node:crypto`, but enrollment-receipt verification calls Postchain's
`gtx.checkGTXSignatures`, which reaches the transitive Elliptic verifier on
untrusted receipt signatures. Exploitability remains unproven; the advisory
cannot be dismissed as unreachable. Keep production enrollment blocked until
the dependency or a protocol-equivalent verifier is reviewed and tested.

On Windows, installer probes reject document-shaped interpreters before starting
a shell. Node must use an absolute native .exe path. The invalid-interpreter
fixture also uses .exe, preventing Windows application-association dialogs while
retaining real host-shell execution checks. The refusal regression observes the
launch boundary without invoking a document handler.

Inherited installer regression verification includes a deterministic reused-inode
case alongside real filesystem tests, so Windows inode allocation cannot conceal
a missing change-time comparison. Review evidence distinguishes explicit guard
mutations from historical shipped defects.

## Host enforcement prerequisite

Status inspects supported synchronous catch-all registration syntax and local paths; it does not prove host trust, actual execution or fail-closed behavior. Restricted matchers, unsupported types, asynchronous entries and trailing/invalid shell syntax cannot establish its registration signal.

Host enforcement is unverified. The earlier claim that Codex consumed an exit-2 denial and permitted the tool could not be substantiated from retained markers and is withdrawn. Current official documentation supports exit-2 blocking. A fresh diagnostic was rejected by automatic approval review before hook/tool execution, so it is inconclusive. Local error-exit tests prove process behavior only. Live protection still requires a successful allow control and hook/tool markers proving refusal of denied or failed decisions on the actual host. Do not label pairing completion or local green suites as Protected.

Registration status accepts only regular script/interpreter files and the canonical
Node interpreter currently running status, with the installer's exact timeout.
An existing registration pinned to another Node is conservatively unverified;
run status with the pinned Node or reinstall with the intended Node. Status never
executes a project-supplied interpreter to test it.
