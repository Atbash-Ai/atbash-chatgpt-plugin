# OpenAI submission preparation

Public source: https://github.com/Atbash-Ai/atbash-chatgpt-plugin/tree/main

Candidate: `atbash` version `0.3.4`, using production `@atbash/sdk@0.9.2`. The plugin implements local `PreToolUse` enforcement plus a setup skill. No MCP server is included.

Run `npm run package:submission` after verification. Packaging checks all four public URLs in the plugin manifest using unauthenticated HTTPS GET requests before creating any ZIP. A missing URL, failed request, non-success HTTP response, or empty page stops packaging. Network access is required. The resulting `artifacts/submission-manifest.json` records the check time, HTTP statuses, final URLs, exact source commit, and SHA-256 hashes. A branch URL identifies a moving source; the recorded commit identifies the specific package submitted for review.

## Artifacts

- `atbash-plugin-0.3.4.zip`: complete plugin, including manifest, assets, local hook installer and runtime, native binaries, SDK license, and setup skill. Embedded hook registration is excluded for marketplace compatibility.
- `atbash-setup-0.3.4.zip`: setup skill only. This cannot independently enforce tool safety.
- `submission-manifest.json`: local release provenance; it is not the portal's `chatgpt-app-submission.json` import schema.

Upload each artifact only to a portal field that accepts that artifact type. Do not upload a ZIP into a JSON form-import field. Never include agent credentials in a distributable package.

## Remaining publication requirements

1. The public ZIP does not declare lifecycle hooks; OpenAI currently rejects embedded hook registration. Its runtime includes `install-hook.cjs` for explicit local registration. Reviewers must configure Atbash, run the installer, restart Codex, and trust the hook through `/hooks` before testing enforcement. A successful skill scan alone does not establish enforcement, and the setup-only ZIP is not the complete product.
2. Use an approved Atbash publisher identity and the public website, support, privacy, and terms URLs in `listing.md`. The full plugin ZIP includes these URLs in `.codex-plugin/plugin.json`; enter the same URLs in the portal draft. Reachability checks do not validate legal content or guarantee directory approval.
3. Review the listing in `listing.md` and the reproducible scenarios in `test-cases.md`. Provide dedicated demo-agent access only through an approved private reviewer channel if required.
4. Update the existing portal draft with the final artifacts and source commit. A GitHub push does not update that draft.
5. Complete publisher attestations and submit for review. Publish through the portal after approval.

Official references: [submission](https://developers.openai.com/plugins/deploy/submission) and [packaging](https://developers.openai.com/plugins/build/plugins).
