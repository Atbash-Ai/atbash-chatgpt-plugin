# Directory listing

## Public metadata

- Plugin name: `Atbash Safety`
- Package name: `atbash`
- Version: `0.3.3`
- Developer: `Atbash AI`
- Category: `Security`
- Short description: `Guard tool calls with Atbash`
- Website: `https://www.atbash.ai/`
- Support: pending approved public URL
- Privacy policy: pending approved public URL
- Terms: pending approved public URL
- Logo: `plugins/atbash/assets/atbash-icon.png`

## Long description

Atbash Safety evaluates supported Codex tool calls before execution using policies configured in Atbash. While the plugin's trusted `PreToolUse` hook is active, the Atbash SDK submits the tool name, SDK-redacted arguments, and minimal execution context for a safety judgment. `ALLOW` continues the call; `HOLD`, `BLOCK`, errors, timeouts, malformed decisions, or invalid configuration stop that attempt.

A bundled setup skill guides users through local credential configuration, activation, status checks, troubleshooting, and key rotation without asking them to upload or reveal their private key. The private key remains in the user's local Atbash SDK configuration and is used locally for agent identity and cryptographic signing.

Coverage is limited to tool calls Codex exposes to the `PreToolUse` lifecycle hook. Atbash Safety does not inspect plain model text or hosted tools outside hook coverage, and it is not a complete host security boundary.

## Capabilities

- Safety policy enforcement
- Local credential setup

## Starter prompts

1. `Set up Atbash locally without sharing my private key.`
2. `Verify that Atbash safety is active for this task.`
3. `Explain why Atbash blocked or held the last tool call.`

All three prompts are one line, unique, contain no app mention, and are under the 128-character directory limit.

## Availability

Country and region selection is intentionally unset. The publisher must select only locations covered by its approved terms, privacy policy, product availability, and support process.
