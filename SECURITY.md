# Security

Report suspected vulnerabilities privately to the Atbash team through your established support contact. Do not include private keys, real tool payloads, or transcripts in public issues.

Security fixes target the current public release source on `main`. Store agent configuration outside this repository. Keep the SDK pinned and review generated runtime and native checksums when upgrading it. Hook enforcement covers only supported `PreToolUse` events and depends on the host enabling and trusting the hook.
