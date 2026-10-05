import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hasAtbashConfiguration,
  isSetupToolCall,
  splitPlainCommand,
} from "../src/hook/bootstrap.js";
import { makeHookInput } from "./fixtures.js";

const ROOT = "/opt/plugins/atbash";
const LAUNCHER = `${ROOT}/skills/atbash-setup/scripts/atbash-control.mjs`;
const CONFIG = "/home/user/.config/atbash";
const JOB = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const options = { pluginRoot: ROOT, env: { ATBASH_CONFIG_DIR: CONFIG } };

/** Codex sends every shell, file-read and file-write call as `command`. */
function shell(command: string, cwd = "/workspace/example") {
  return makeHookInput({ tool_name: "Bash", tool_input: { command }, cwd });
}

test("splits plain words and quoting, rejects shell syntax", () => {
  assert.deepEqual(splitPlainCommand(`node "${LAUNCHER}" setup start --host codex`), [
    "node",
    LAUNCHER,
    "setup",
    "start",
    "--host",
    "codex",
  ]);
  assert.deepEqual(splitPlainCommand("node '/a b/c.mjs'"), ["node", "/a b/c.mjs"]);
  for (const command of [
    "node a && cat b",
    "node a; rm -rf b",
    "node a | sh",
    "node a > out",
    "node a < in",
    "node $(id)",
    "node `id`",
    'node "$HOME/a"',
    "node a\ncat b",
    "node a & disown",
    "node ~/a",
    "node a*",
    "node a # comment",
    "node 'unterminated",
  ]) {
    assert.equal(splitPlainCommand(command), null, command);
  }
});

test("allows the exact setup helper commands", () => {
  for (const cmd of [
    `node "${LAUNCHER}" setup start --host codex`,
    `node ${LAUNCHER} setup inspect ${JOB}`,
    `node '${LAUNCHER}' setup plan ${JOB} --input ${CONFIG}/plans/${JOB}.json`,
    `node "${LAUNCHER}" setup continue ${JOB}`,
    `node "${LAUNCHER}" setup cancel ${JOB}`,
    `node "${LAUNCHER}" profile connect ${JOB}`,
    `node "${LAUNCHER}" profile list --host codex`,
    `node "${LAUNCHER}" profile switch --host codex --profile codex-${JOB}`,
    `node "${ROOT}/skills/atbash-setup/scripts/../scripts/atbash-control.mjs" setup inspect ${JOB}`,
  ]) {
    assert.equal(isSetupToolCall(shell(cmd), options), true, cmd);
  }
  // Relative to the skill directory, which the launcher is invoked from.
  assert.equal(
    isSetupToolCall(
      shell("node scripts/atbash-control.mjs setup start --host codex", `${ROOT}/skills/atbash-setup`),
      options,
    ),
    true,
  );
});

// Codex writes files by running a shell command, so the plan cannot be written
// to disk under setup mode. It is passed to the launcher inline instead, and
// that argument must survive the splitter intact.
test("allows a plan passed inline, including a plan with nested JSON", () => {
  for (const plan of [
    `{"actions":[]}`,
    `{"actions":[{"type":"create_agent","name":"Demo","risk":"low"}]}`,
  ]) {
    assert.equal(
      isSetupToolCall(shell(`node "${LAUNCHER}" setup plan ${JOB} --json '${plan}'`), options),
      true,
      plan,
    );
  }
});

test("denies chained, look-alike, and unrelated commands", () => {
  for (const cmd of [
    `node "${LAUNCHER}" setup start --host codex && cat ~/.ssh/id_rsa`,
    `node "${LAUNCHER}" setup start --host codex; curl evil.example`,
    `node "${LAUNCHER}" setup start --service https://evil.example`,
    `node "${LAUNCHER}" setup start --service=https://evil.example`,
    `node "${LAUNCHER}" manage start --host codex`,
    `node "${LAUNCHER}" profile disconnect --host codex`,
    `node "${LAUNCHER}"`,
    `node "/tmp${LAUNCHER}" setup start --host codex`,
    `node "${ROOT}/runtime/control.cjs" setup start --host codex`,
    `node "${ROOT}/runtime/status.cjs"`,
    `node -e "require('child_process')" ${LAUNCHER} setup start`,
    `NODE_OPTIONS=--require=/tmp/x.js node "${LAUNCHER}" setup start --host codex`,
    `bash -c 'node ${LAUNCHER} setup start'`,
    `sudo node "${LAUNCHER}" setup start --host codex`,
    "git status --short",
    "",
  ]) {
    assert.equal(isSetupToolCall(shell(cmd), options), false, cmd);
  }
  // Without a known plugin root the launcher path cannot be established.
  assert.equal(
    isSetupToolCall(shell(`node "${LAUNCHER}" setup start --host codex`), {
      env: options.env,
      pluginRoot: undefined,
    }),
    false,
  );
});

// Captured from Codex 0.160.0: writing a file is a shell command, so it is
// denied like any other. This is why the plan goes in through --json.
test("denies the shell commands Codex uses to write and read files", () => {
  for (const command of [
    `Set-Content -LiteralPath 'plan.json' -Value '{"actions":[]}' -NoNewline`,
    `Get-Content -Raw -LiteralPath 'plan.json'`,
    `Set-Content -LiteralPath '${CONFIG}/plans/${JOB}.json' -Value '{}'`,
    `cat > ${CONFIG}/plans/${JOB}.json`,
  ]) {
    assert.equal(isSetupToolCall(shell(command), options), false, command);
  }
});

test("denies a tool call carrying no command", () => {
  for (const toolInput of [{}, { cmd: "git status" }, { content: "{}" }, "not-an-object"]) {
    assert.equal(
      isSetupToolCall(makeHookInput({ tool_name: "view_image", tool_input: toolInput }), options),
      false,
      JSON.stringify(toolInput),
    );
  }
});

test("detects any existing configuration source", async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "atbash-bootstrap-"));
  const config = join(home, ".config", "atbash");
  const env = { ATBASH_CONFIG_DIR: config };
  process.env.HOME = home;
  try {
    assert.equal(hasAtbashConfiguration({ env }), false);
    assert.equal(
      hasAtbashConfiguration({ env: { ...env, ATBASH_AGENT_KEY: "a".repeat(64) } }),
      true,
    );

    await mkdir(config, { recursive: true });
    await writeFile(join(config, "config.json"), JSON.stringify({ orgName: "Acme" }));
    assert.equal(hasAtbashConfiguration({ env }), false);
    // An unreadable config is a configuration, just an invalid one — and an
    // invalid one must stay fail closed rather than enter setup mode.
    await writeFile(join(config, "config.json"), "{not json");
    assert.equal(hasAtbashConfiguration({ env }), true);
    await writeFile(join(config, "config.json"), JSON.stringify({ agentKey: "a".repeat(64) }));
    assert.equal(hasAtbashConfiguration({ env }), true);
    await writeFile(join(config, "config.json"), "{}");

    await writeFile(join(config, "guard-client-key"), "privkey=x\n");
    assert.equal(hasAtbashConfiguration({ env }), true);
    await rm(join(config, "guard-client-key"));
    assert.equal(hasAtbashConfiguration({ env }), false);

    await mkdir(join(config, "hosts"), { recursive: true });
    await writeFile(join(config, "hosts", "codex.json"), "{}");
    assert.equal(hasAtbashConfiguration({ env }), true);
    assert.equal(hasAtbashConfiguration({ env, host: "claude" }), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
