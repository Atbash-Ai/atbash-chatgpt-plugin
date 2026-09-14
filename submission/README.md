# OpenAI submission preparation

Public source: https://github.com/Atbash-Ai/atbash-chatgpt-plugin/tree/main

Candidate: `atbash` version `0.3.3`, using production `@atbash/sdk@0.7.1`. The plugin implements local `PreToolUse` enforcement plus a setup skill. No MCP server is included.

Run `npm run package:submission` after verification. The resulting `artifacts/submission-manifest.json` records the exact source commit and SHA-256 hashes. A branch URL identifies a moving source; the recorded commit identifies the specific package submitted for review.

## Artifacts

- `atbash-plugin-0.3.3.zip`: complete plugin, including manifest, assets, hook, runtime, native binaries, SDK license, and setup skill.
- `atbash-setup-0.3.3.zip`: setup skill only. This cannot independently enforce tool safety.
- `submission-manifest.json`: local release provenance; it is not the portal's `chatgpt-app-submission.json` import schema.

Upload each artifact only to a portal field that accepts that artifact type. Do not upload a ZIP into a JSON form-import field. Never include agent credentials in a distributable package.

## Remaining publication requirements

1. Confirm with OpenAI how the public distribution preserves and executes the local hook and runtime. A successful skill scan alone does not establish this. Do not represent a skill-only publication as the complete enforcement product.
2. Use an approved Atbash publisher identity and public support, privacy, and terms pages. The listing records these as pending until verified by the publisher.
3. Review the listing in `listing.md` and the reproducible scenarios in `test-cases.md`. Provide dedicated demo-agent access only through an approved private reviewer channel if required.
4. Update the existing portal draft with the final artifacts and source commit. A GitHub push does not update that draft.
5. Complete publisher attestations and submit for review. Publish through the portal after approval.

Official references: [submission](https://developers.openai.com/plugins/deploy/submission) and [packaging](https://developers.openai.com/plugins/build/plugins).
