# Security

Report suspected vulnerabilities privately to the Atbash team through your established support contact. Do not include private keys, real tool payloads, or transcripts in public issues.

Security fixes target the testing branch `dev` for review. Store agent configuration outside this repository. Keep the SDK pinned and review generated runtime and native checksums when upgrading it. Hook enforcement covers only supported `PreToolUse` events and depends on the host enabling and trusting the hook.

## Host-protocol residuals

The shim's best blocking answer is one complete deny JSON decision on stdout with exit 0. It writes that decision synchronously before exiting, keeps bundle logs off stdout, and bounds its deadline below the host's configured timeout. These measures do not make the hook an independent enforcement boundary: the host decides whether to run the tool.

The source records Codex 0.154.0 behavior, measured on 2026-09-17: only a deny JSON decision with exit 0 blocked the tool. A timeout, exit 1, exit 2 (even with deny JSON), or exit 0 with empty stdout was a permit. This is a dated measurement, not a claim about every Codex version. Claude Code's documented hook contract also blocks on exit 2. The tests here characterize the shim, not either live host.

The remaining paths are:

- **A closed or unwritable stdout:** the shim cannot deliver a deny over a dead channel. It keeps exit 2 because Claude Code still blocks on that code; the measured Codex behavior treats exit 2 as a permit. Switching to exit 0 with empty stdout would be a permit on both hosts. A write that stops after a partial JSON prefix also ends with exit 2 rather than claiming the decision was delivered. Stderr is diagnostic, not a replacement decision channel.
- **A synchronous native hang:** a synchronous stall inside the bundle or native addon blocks the event loop, so the deadline timer cannot run. Only the host can terminate that process; the measured host timeout behavior is a permit.
- **Unchecked direct fd-1 writes:** writes straight to file descriptor 1 bypass the shim's `process.stdout` interception. They can corrupt an otherwise valid deny into unparseable stdout, which the measured Codex behavior treats as a permit. The JavaScript bundle has no such writes; the native addon is assumed not to print to fd 1. Code already controlling this process can also patch the shim, so the shim is not a sandbox for its own dependencies.
- **A too-small pipe:** the deny is capped at 3584 serialized bytes, below the smallest known host pipe buffer (4 KiB). A pipe smaller than the actual deny, with a host that does not read, can still block the synchronous write. The event loop cannot interrupt that syscall, and a host timeout is a permit under the recorded contract. The byte cap protects known pipe sizes, not arbitrary transports.

These paths require a host-protocol change, not an in-hook fix. A host should support fail-closed treatment of timeout, failed or incomplete decision delivery, and hook process errors. This documentation and characterization does not close the Codex residual or claim an end-to-end negative-test proof.

See `plugins/atbash/src/hook/shim.cjs` for the implementation and measurement notes. Existing `plugins/atbash/tests/host-boundary.test.ts` cases pin the current choice:

- `a runtime that throws while loading still denies with exit 0` asserts deny JSON on writable stdout and exit 0.
- `when stdout cannot be written the shim exits 2, never 0 with an empty output` closes the real stdout pipe and asserts exit 2.
- `a bundle deny that arrives after the host closed stdout is a blocking exit, never a permit` also asserts exit 2 after delivery fails; its name describes the plugin's blocking intent, not a guarantee that Codex honors that code.
