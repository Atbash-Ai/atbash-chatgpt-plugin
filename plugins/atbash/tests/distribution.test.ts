import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { makeHookInput } from "./fixtures.js";

/** The bundles that carry the hook's context builder. */
const BUNDLES = ["runtime/pre-tool-use-main.cjs", "runtime/index.cjs"];

/**
 * The model reaches the context only through the checked-model function: the push names a function
 * whose body tests the model-id shape, masks an AWS account id and falls back to "other".
 */
function assertCheckedModel(source: string, bundle: string): void {
  const call = /`model=\$\{([\w$]+)\([\w$]+\.model\)\}`/.exec(source);
  assert.ok(call, `${bundle}: the model is not sent through a checking function`);
  const name = call[1]!.replace(/\$/g, "\\$");
  assert.match(
    source,
    new RegExp(
      `function ${name}\\(([\\w$]+)\\)\\{return [\\w$]+\\.test\\(\\1\\)\\?\\1\\.replace\\([\\w$]+,":account:"\\):"other"\\}`,
    ),
    bundle,
  );
}

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
  assert.equal(existsSync("runtime/control.cjs"), true);

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
    "runtime/pre-tool-use.cjs": "100644",
    "runtime/pre-tool-use-main.cjs": "100755",
    "runtime/status.cjs": "100755",
    "runtime/control.cjs": "100755",
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
    "runtime/pre-tool-use-main.cjs",
    "runtime/status.cjs",
  ]) {
    assert.match(readFileSync(path, "utf8"), /^#!\/usr\/bin\/env node\n/, path);
  }
  assert.doesNotMatch(readFileSync("runtime/pre-tool-use.cjs", "utf8"), /^#!/);
});

test("marketplace package includes the setup and management skills", () => {
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
  assert.match(
    readFileSync("skills/atbash-manage/SKILL.md", "utf8"),
    /^---\r?\nname: atbash-manage\r?\n/,
  );
  assert.match(
    readFileSync("skills/atbash-setup/scripts/atbash-control.mjs", "utf8"),
    /runtime\/control\.cjs/,
  );
});

test("setup helper delegates to the bundled control runtime", () => {
  const launcher = readFileSync("skills/atbash-setup/scripts/atbash-control.mjs", "utf8");
  assert.match(launcher, /spawn\(process\.execPath/);
  assert.match(launcher, /runtime\/control\.cjs/);
});

test("shipped runtime sends only fixed, checked facts in the judge context", () => {
  // Codex runs the committed runtime, not src, and the judge context is recorded on a public
  // chain. The builder is pinned, so the check is not vacuous: source, the checked model (any AWS
  // account id masked) and the closed-set permission mode, and no workspace fact.
  for (const bundle of BUNDLES) {
    const source = readFileSync(bundle, "utf8");
    assert.match(
      source,
      /\["source=codex",`model=\$\{[\w$]+\([\w$]+\.model\)\}`,`permission_mode=\$\{[\w$]+\.permission_mode\}`\]/,
      bundle,
    );
    assertCheckedModel(source, bundle);
    assert.doesNotMatch(source, /workspace=/, bundle);
  }
});
