import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const workflow = (name) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

test("pull-request CI cannot upload a plugin submission artifact", () => {
  const ci = workflow("ci.yml");
  assert.match(ci, /^\s*pull_request:\s*$/m, "the workflow must still test pull requests");
  assert.equal(
    /^\s*uses:\s*actions\/upload-artifact@/m.test(ci),
    false,
    "pull-request CI must not upload untrusted code as a submission artifact",
  );
});

test("release workflow actions are pinned to commit digests", () => {
  const release = workflow("release.yml");
  const actions = [...release.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm)];
  assert.ok(actions.length >= 3, "the checkout, setup, and artifact actions must be covered");
  for (const [, name, revision] of actions) {
    assert.match(revision, /^[0-9a-f]{40}$/, `${name} must use an immutable commit digest`);
  }
});

test("unprotected release tags cannot upload an unsigned plugin package", () => {
  const release = workflow("release.yml");
  assert.equal(
    /^\s*uses:\s*actions\/upload-artifact@/m.test(release),
    false,
    "release packaging must remain local until reviewed tag protection and provenance exist",
  );
});
