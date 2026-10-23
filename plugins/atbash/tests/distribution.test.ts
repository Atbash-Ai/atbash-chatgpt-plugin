import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { notSetUpReason } from "../src/hook/bootstrap.js";
import type { PreToolUseInput } from "../src/hook/protocol.js";
import { makeHookInput } from "./fixtures.js";

// Run built hooks against an empty home so the developer's own Atbash setup
// cannot leak in and decide which branch of the guard these tests exercise.
function runHook(script: string, input: PreToolUseInput = makeHookInput()) {
  const home = mkdtempSync(join(tmpdir(), "atbash-dist-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ATBASH_CONFIG_DIR: join(home, ".config", "atbash"),
    ATBASH_CODEX_TIMEOUT_MS: "invalid",
    ATBASH_HOOK_DEADLINE_MS: "",
  };
  delete env.ATBASH_AGENT_KEY;
  delete env.ATBASH_ORG_NAME;
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    input: JSON.stringify(input),
  });
}

const notSetUp = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    // The built hook derives the plugin root from its own path: this checkout.
    permissionDecisionReason: notSetUpReason(realpathSync(".")),
  },
};

interface BuildEnvironment {
  sdkPackage: string;
  endpoint?: string;
  chains?: Record<"public" | "private", { blockchainRid: string; nodeUrls: string[] }>;
}

interface RuntimeManifest {
  environment?: string;
  sdkVersion?: string;
  platforms?: Record<string, { package?: string; sha256?: string }>;
}

const PRODUCTION_ENDPOINT = "https://atbash.ai";
const environments = JSON.parse(readFileSync("build-environments.json", "utf8")) as Record<
  string,
  BuildEnvironment
>;

function runtimeManifest(): { manifest: RuntimeManifest; environment: BuildEnvironment } {
  const manifest = JSON.parse(readFileSync("runtime/manifest.json", "utf8")) as RuntimeManifest;
  const environment = environments[manifest.environment ?? ""];
  assert.ok(environment, `runtime/manifest.json names an unknown environment`);
  return { manifest, environment };
}

/** The endpoint and pinned chains a build must target: runtime/ per its manifest, dist/ per the test build. */
function expectedTarget(directory: "dist" | "runtime"): {
  endpoint: string;
  chains: BuildEnvironment["chains"];
} {
  const environment =
    directory === "runtime"
      ? runtimeManifest().environment
      : environments[process.env.ATBASH_BUILD_ENV?.trim() || "prod"];
  assert.ok(environment, `${directory} was built for an unknown environment`);
  return { endpoint: environment.endpoint ?? PRODUCTION_ENDPOINT, chains: environment.chains };
}

test("built hook is self-contained and fails closed", () => {
  assert.equal(existsSync(`dist/native/${process.platform}-${process.arch}/atbash.node`), true);

  const result = runHook("dist/pre-tool-use.cjs");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), notSetUp);
});

test("built runtime lets setup run before any configuration exists", () => {
  const launcher = resolve("skills/atbash-setup/scripts/atbash-control.mjs");
  const command = (value: string) =>
    makeHookInput({ tool_name: "Bash", tool_input: { command: value } });

  const allowed = runHook(
    "runtime/pre-tool-use.cjs",
    command(`node "${launcher}" setup start --host codex`),
  );
  const chained = runHook(
    "runtime/pre-tool-use.cjs",
    command(`node "${launcher}" setup start --host codex && cat ~/.ssh/id_rsa`),
  );

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  assert.deepEqual(JSON.parse(chained.stdout), notSetUp);
});

// Codex on macOS reads the skill with sed (captured from Codex 0.163). A denied read
// left it nothing to try, so the denial now names a read that is allowed — and that
// read must itself pass, or the hint is one more dead end.
test("built runtime lets the setup skill be read, and its denial names a read that works", () => {
  const skill = resolve("skills/atbash-setup/SKILL.md");
  const command = (value: string) =>
    makeHookInput({ tool_name: "Bash", tool_input: { command: value } });

  const sed = runHook("runtime/pre-tool-use.cjs", command(`sed -n '1,240p' ${skill}`));
  assert.equal(sed.status, 0, sed.stderr);
  assert.equal(sed.stdout, "");

  const denied = runHook("runtime/pre-tool-use.cjs", command("ls"));
  const reason = (JSON.parse(denied.stdout) as typeof notSetUp).hookSpecificOutput
    .permissionDecisionReason;
  const hint = /run: (cat '[^']+')$/.exec(reason)?.[1];
  assert.ok(hint, reason);
  const followed = runHook("runtime/pre-tool-use.cjs", command(hint));
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(followed.stdout, "");
});

test("marketplace runtime includes every supported native target", () => {
  const platforms = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"] as const;
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const { manifest, environment } = runtimeManifest();
  const pinned =
    packageJson.dependencies?.[environment.sdkPackage] ??
    packageJson.devDependencies?.[environment.sdkPackage];

  assert.equal(manifest.sdkVersion, pinned?.replace(/^npm:@atbash\/sdk@/, ""));
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

  const result = runHook("runtime/pre-tool-use.cjs");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), notSetUp);
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

test("marketplace runtime targets the environment recorded in its manifest", () => {
  const { manifest, environment } = runtimeManifest();
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const n = require("./runtime/atbash-native.cjs");
      process.stdout.write(JSON.stringify({
        endpoint: n.DEFAULT_ENDPOINT,
        public: { blockchainRid: n.DEFAULT_BLOCKCHAIN_RID, nodeUrls: n.defaultChromiaNodeUrls() },
        private: { blockchainRid: n.DEFAULT_PRIVATE_BLOCKCHAIN_RID, nodeUrls: n.defaultPrivateNodeUrls() },
      }));`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout) as { endpoint: string } & BuildEnvironment["chains"];

  if (environment.endpoint !== undefined) {
    assert.deepEqual(actual, { endpoint: environment.endpoint, ...environment.chains });
    return;
  }

  // Production keeps the SDK's own defaults and carries no other environment's values.
  assert.equal(manifest.environment, "prod");
  assert.equal(actual.endpoint, PRODUCTION_ENDPOINT);
  const bundles = readdirSync("runtime")
    .filter((name) => name.endsWith(".cjs"))
    .map((name) => readFileSync(join("runtime", name), "utf8").toLowerCase());
  for (const [name, other] of Object.entries(environments)) {
    if (other.endpoint === undefined) continue;
    const pinned = [
      new URL(other.endpoint).hostname,
      other.chains?.public.blockchainRid,
      other.chains?.private.blockchainRid,
    ];
    for (const value of pinned) {
      assert.ok(value);
      for (const bundle of bundles)
        assert.doesNotMatch(bundle, new RegExp(value.toLowerCase()), name);
    }
  }
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
  // AT-576: the helper can cancel a job, but only an instruction makes the agent use it.
  assert.match(skill, /`setup cancel <job-id>`/);
  assert.match(readFileSync("skills/atbash-manage/SKILL.md", "utf8"), /`manage cancel <job-id>`/);
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

test("bundled SDK trusts its environment's judge while rejecting other hosts and plaintext", () => {
  for (const directory of ["dist", "runtime"] as const) {
    const { endpoint } = expectedTarget(directory);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const assert = require('node:assert/strict');
        const { createAtbashGuard } = require('./${directory}/index.cjs');
        const endpoint = ${JSON.stringify(endpoint)};
        const host = new URL(endpoint).host;
        process.env.ATBASH_ENDPOINT = endpoint;
        assert.equal(createAtbashGuard().endpoint, endpoint);
        process.env.ATBASH_ENDPOINT = 'https://untrusted.example';
        assert.throws(() => createAtbashGuard(), /not in the trusted allowlist/);
        process.env.ATBASH_ENDPOINT = 'http://' + host;
        assert.throws(() => createAtbashGuard(), /must use https/);
        process.env.ATBASH_ENDPOINT = 'https://user:password@' + host;
        assert.throws(() => createAtbashGuard(), /must not contain credentials/);
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ATBASH_CONFIG_DIR: `${process.cwd()}/dist-tests/unused-endpoint-test-home`,
          ATBASH_AGENT_KEY: "01".repeat(32),
          ATBASH_ORG_NAME: "endpoint-test",
          ATBASH_ENDPOINT: "",
          ATBASH_JUDGE_VERIFY_PUBKEY: "",
          ATBASH_DEFAULT_CHAIN_NETWORK: "",
          ATBASH_TELEMETRY_DISABLED: "true",
          ATBASH_CODEX_TIMEOUT_MS: "30000",
        },
      },
    );
    assert.equal(result.status, 0, `${directory}: ${result.stderr}`);
  }
});

test("bundled SDK uses its environment's BRIDs and node pools for defaults and organization routing", () => {
  for (const directory of ["dist", "runtime"] as const) {
    const { endpoint, chains } = expectedTarget(directory);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const assert = require('node:assert/strict');
        const { createAtbashGuard } = require('./${directory}/index.cjs');
        const native = require('./${directory}/atbash-native.cjs');
        // Production pins nothing, so it must route with the SDK's own defaults.
        const expected = ${JSON.stringify(chains ?? null)} ?? {
          public: { blockchainRid: native.DEFAULT_BLOCKCHAIN_RID, nodeUrls: native.defaultChromiaNodeUrls() },
          private: { blockchainRid: native.DEFAULT_PRIVATE_BLOCKCHAIN_RID, nodeUrls: native.defaultPrivateNodeUrls() },
        };
        const chains = {
          public: { network: 'public', ...expected.public },
          private: { network: 'private', ...expected.private },
        };
        (async () => {
          for (const network of ['public', 'private']) {
            process.env.ATBASH_DEFAULT_CHAIN_NETWORK = network;
            const client = createAtbashGuard();
            assert.equal(client.blockchainRid, chains[network].blockchainRid);
            assert.deepEqual(client.nodeUrls, chains[network].nodeUrls);
          }
          delete process.env.ATBASH_DEFAULT_CHAIN_NETWORK;
          let requests = 0;
          global.fetch = async (input) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            assert.equal(url.origin, new URL(${JSON.stringify(endpoint)}).origin);
            assert.equal(url.pathname, '/api/org-network');
            const network = url.searchParams.get('org');
            assert.ok(network === 'public' || network === 'private');
            requests++;
            return new Response(JSON.stringify({ network }), { status: 200 });
          };
          const client = createAtbashGuard();
          for (const network of ['public', 'private']) {
            assert.deepEqual(await client.resolveChainForOrg(network), chains[network]);
          }
          assert.equal(requests, 2);
        })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          ATBASH_CONFIG_DIR: `${process.cwd()}/dist-tests/unused-chain-test-home`,
          ATBASH_AGENT_KEY: "01".repeat(32),
          ATBASH_ORG_NAME: "chain-test",
          ATBASH_ENDPOINT: "",
          ATBASH_JUDGE_VERIFY_PUBKEY: "",
          ATBASH_DEFAULT_CHAIN_NETWORK: "",
          ATBASH_TELEMETRY_DISABLED: "true",
          ATBASH_CODEX_TIMEOUT_MS: "30000",
        },
      },
    );
    assert.equal(result.status, 0, `${directory}: ${result.stderr}`);
  }
});
