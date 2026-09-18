import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { makeHookInput } from "./fixtures.js";

test("built hook is self-contained and fails closed", () => {
  assert.equal(existsSync(`dist/native/${process.platform}-${process.arch}/atbash.node`), true);

  const result = spawnSync(process.execPath, ["dist/pre-tool-use.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ATBASH_CODEX_TIMEOUT_MS: "invalid",
      ATBASH_HOOK_DEADLINE_MS: "",
    },
    input: JSON.stringify(makeHookInput()),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Atbash ERROR: configuration is missing or invalid.",
    },
  });
});

test("marketplace runtime includes every supported native target", () => {
  const platforms = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"] as const;
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const manifest = JSON.parse(readFileSync("runtime/manifest.json", "utf8")) as {
    sdkVersion?: string;
    platforms?: Record<string, { package?: string; sha256?: string }>;
  };

  assert.equal(manifest.sdkVersion, packageJson.dependencies?.["@atbash/sdk"]);
  assert.equal(existsSync("runtime/licenses/atbash-sdk.LICENSE"), true);

  for (const platform of platforms) {
    const nativePath = `runtime/native/${platform}/atbash.node`;
    assert.equal(existsSync(nativePath), true, platform);
    assert.match(manifest.platforms?.[platform]?.package ?? "", /^@atbash\/sdk-/);
    assert.equal(
      createHash("sha256").update(readFileSync(nativePath)).digest("hex"),
      manifest.platforms?.[platform]?.sha256,
      platform,
    );
  }

  const result = spawnSync(process.execPath, ["runtime/pre-tool-use.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ATBASH_CODEX_TIMEOUT_MS: "invalid",
      ATBASH_HOOK_DEADLINE_MS: "",
    },
    input: JSON.stringify(makeHookInput()),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Atbash ERROR: configuration is missing or invalid.",
    },
  });
});

test("marketplace runtime ships every entry point with the mode the build sets", () => {
  // CI rebuilds the runtime on Linux and diffs it against the committed tree, modes included; on
  // Windows the working tree cannot show a mode, so the index is what is checked. The hashbang
  // bundles are executable, the shim and the library are not, and the installer is a bundle.
  const expected: Record<string, string> = {
    "runtime/atbash-native.cjs": "100644",
    "runtime/index.cjs": "100644",
    "runtime/install-hook.cjs": "100755",
    "runtime/pair.cjs": "100755",
    "runtime/pre-tool-use.cjs": "100644",
    "runtime/pre-tool-use-main.cjs": "100755",
    "runtime/status.cjs": "100755",
  };
  const listing = spawnSync("git", ["ls-files", "--stage", "--", "runtime/*.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  const recorded = Object.fromEntries(
    listing.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => {
        const [meta, path] = line.split("\t");
        return [path, meta?.split(" ")[0]];
      }),
  );
  assert.deepEqual(recorded, expected);
  for (const path of Object.keys(expected)) {
    assert.equal(existsSync(path), true, path);
  }
  // Each bundled entry point starts with the hashbang the build preserves; the shim does not.
  for (const path of [
    "runtime/install-hook.cjs",
    "runtime/pair.cjs",
    "runtime/pre-tool-use-main.cjs",
    "runtime/status.cjs",
  ]) {
    assert.match(readFileSync(path, "utf8"), /^#!\/usr\/bin\/env node\n/, path);
  }
  assert.doesNotMatch(readFileSync("runtime/pre-tool-use.cjs", "utf8"), /^#!/);
});

test("marketplace pairing command can explain usage without reading local credentials", () => {
  const result = spawnSync(process.execPath, ["runtime/pair.cjs", "--help"], {
    encoding: "utf8",
    env: { ...process.env, ATBASH_PRIVATE_KEY: "invalid", ATBASH_ORG_NAME: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Atbash local pairing/);
  assert.match(result.stdout, /Private keys stay local/);
});

test("marketplace package includes the setup skill", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    files?: string[];
  };
  const manifest = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8")) as {
    skills?: string;
  };
  const skill = readFileSync("skills/atbash-setup/SKILL.md", "utf8");
  const skillInterface = readFileSync("skills/atbash-setup/agents/openai.yaml", "utf8");

  assert.equal(packageJson.files?.includes("skills"), true);
  assert.equal(manifest.skills, "./skills/");
  assert.match(skill, /^---\r?\nname: atbash-setup\r?\n/);
  assert.doesNotMatch(skill, /\[TODO:/);
  assert.match(skillInterface, /\$atbash-setup/);
});
