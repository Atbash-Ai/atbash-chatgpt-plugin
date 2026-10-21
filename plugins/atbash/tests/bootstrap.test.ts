import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
    // The skill sends an organization with no subscription here to choose a paid
    // plan; without it that step is denied on an unconfigured install.
    `node "${LAUNCHER}" setup checkout ${JOB} --organization qa_org_01`,
    `node "${LAUNCHER}" setup checkout ${JOB} --organization "Acme Labs"`,
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
      shell(
        "node scripts/atbash-control.mjs setup start --host codex",
        `${ROOT}/skills/atbash-setup`,
      ),
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

// A skill is a file the assistant must read before it can follow it, and on
// Codex that read is a shell command. Without this, the setup skill is
// unreadable and setup cannot begin — captured verbatim from Codex 0.160.0.
test("allows reading the skill's own instructions", () => {
  const skill = `${ROOT}/skills/atbash-setup/SKILL.md`;
  for (const command of [
    `Get-Content -Raw '${skill}'`,
    `Get-Content -Raw -LiteralPath '${skill}'`,
    `cat "${skill}"`,
    `Get-Content '${ROOT}/skills/atbash-manage/SKILL.md'`,
  ]) {
    assert.equal(isSetupToolCall(shell(command), options), true, command);
  }
});

test("a skill read cannot be pointed outside the plugin's skills directory", () => {
  for (const command of [
    `Get-Content -Raw '${ROOT}/runtime/manifest.json'`,
    `Get-Content -Raw 'C:/Users/someone/.ssh/id_rsa'`,
    `Get-Content -Raw '${ROOT}/skills/../../../secrets.txt'`,
    `Get-Content -Raw '${ROOT}/skills/atbash-setup/SKILL.md' -OutVariable x`,
    `Get-Content -Raw '${ROOT}/skills/a.md' '${ROOT}/../b.md'`,
    `Get-Content -Raw '${ROOT}/skills/atbash-setup/SKILL.md' && cat secrets`,
    `Remove-Item '${ROOT}/skills/atbash-setup/SKILL.md'`,
    `Get-Content`,
  ]) {
    assert.equal(isSetupToolCall(shell(command), options), false, command);
  }
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

function permissions(value: unknown) {
  return makeHookInput({
    tool_name: "request_permissions",
    tool_input: { permissions: value, reason: "Atbash setup" },
  });
}

// Shapes captured from the Codex app's session logs (hook trusted, no profile).
test("allows only network and Atbash-directory write permission requests", () => {
  for (const value of [
    { network: { enabled: true } },
    { file_system: { write: [CONFIG] } },
    { file_system: { write: [`${CONFIG}/pending`, `${CONFIG}/credentials`] } },
    { network: { enabled: true }, file_system: { write: [CONFIG] } },
    { network: { enabled: true }, file_system: null },
  ]) {
    assert.equal(isSetupToolCall(permissions(value), options), true, JSON.stringify(value));
  }
  const home = { pluginRoot: ROOT, env: {} };
  assert.equal(
    isSetupToolCall(permissions({ file_system: { write: ["~/.config/atbash"] } }), home),
    true,
  );
  assert.equal(
    isSetupToolCall(
      permissions({ file_system: { write: [join(homedir(), ".config", "atbash")] } }),
      home,
    ),
    true,
  );

  for (const value of [
    {},
    { network: null, file_system: null },
    { file_system: { write: ["/home/user"] } },
    { file_system: { write: ["/home/user/.config"] } },
    { file_system: { write: [`${CONFIG}-other`] } },
    { file_system: { write: [`${CONFIG}/../../.ssh`] } },
    { file_system: { write: ["relative/path"] } },
    { file_system: { write: [] } },
    { file_system: { write: [CONFIG, "/etc"] } },
    { file_system: { read: [CONFIG] } },
    { file_system: { write: [CONFIG], read: ["/"] } },
    { network: { enabled: true, hosts: ["*"] } },
    { network: true },
    { network: { enabled: true }, macos: { accessibility: true } },
    [{ network: { enabled: true } }],
  ]) {
    assert.equal(isSetupToolCall(permissions(value), options), false, JSON.stringify(value));
  }
});

// Codex hosts without the request_permissions tool ask on the shell call itself.
test("a setup command may carry the same access, and no more", () => {
  const command = `node "${LAUNCHER}" setup start --host codex`;
  const call = (extra: Record<string, unknown>) =>
    makeHookInput({ tool_name: "Bash", tool_input: { command, ...extra } });

  for (const extra of [
    { sandbox_permissions: "require_escalated", justification: "Atbash setup" },
    {
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: { network: { enabled: true }, file_system: { write: [CONFIG] } },
    },
    { sandbox_permissions: "use_default", additional_permissions: null },
  ]) {
    assert.equal(isSetupToolCall(call(extra), options), true, JSON.stringify(extra));
  }
  for (const additional_permissions of [
    { file_system: { write: ["/home/user"] } },
    { file_system: { read: ["/"] } },
    { network: { enabled: true }, macos: { accessibility: true } },
    {},
  ]) {
    assert.equal(
      isSetupToolCall(
        call({ sandbox_permissions: "with_additional_permissions", additional_permissions }),
        options,
      ),
      false,
      JSON.stringify(additional_permissions),
    );
  }
  // The access check never turns a non-setup command into a setup call.
  assert.equal(
    isSetupToolCall(
      makeHookInput({
        tool_name: "Bash",
        tool_input: { command: "git status", sandbox_permissions: "require_escalated" },
      }),
      options,
    ),
    false,
  );
});

test("a write grant cannot reach outside the directory through a link inside it", async () => {
  const base = await mkdtemp(join(tmpdir(), "atbash-bootstrap-link-"));
  const config = join(base, "config");
  const outside = join(base, "outside");
  try {
    await mkdir(config, { recursive: true });
    await mkdir(outside, { recursive: true });
    // A junction needs no elevation on Windows; elsewhere the type is ignored.
    await symlink(outside, join(config, "escape"), "junction");
    const linked = { pluginRoot: ROOT, env: { ATBASH_CONFIG_DIR: config } };
    assert.equal(
      isSetupToolCall(permissions({ file_system: { write: [join(config, "plans")] } }), linked),
      true,
    );
    assert.equal(
      isSetupToolCall(permissions({ file_system: { write: [join(config, "escape")] } }), linked),
      false,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("allows Codex's question prompts", () => {
  for (const toolName of ["request_user_input", "request_user_input_async"]) {
    const input = makeHookInput({
      tool_name: toolName,
      tool_input: { questions: [{ title: "Agent name", options: ["Create", "Connect"] }] },
    });
    assert.equal(isSetupToolCall(input, options), true, toolName);
  }
});

test("only a shell call is read as a command", () => {
  // apply_patch carries its patch text in a field also named `command`.
  for (const toolName of ["apply_patch", "view_image", "update_plan", "mcp__atbash__status"]) {
    const input = makeHookInput({
      tool_name: toolName,
      tool_input: { command: `node "${LAUNCHER}" setup start --host codex` },
    });
    assert.equal(isSetupToolCall(input, options), false, toolName);
  }
});

test("a relative path resolves against the call's own workdir", () => {
  const relative = "skills/atbash-setup/scripts/atbash-control.mjs";
  const call = (cwd: string, workdir?: string) =>
    makeHookInput({
      tool_name: "Bash",
      tool_input: { command: `node ${relative} setup start --host codex`, workdir },
      cwd,
    });
  assert.equal(isSetupToolCall(call("/workspace/example", ROOT), options), true);
  // The session sits in the plugin, but the command runs somewhere else: a
  // look-alike launcher there must not pass as the real one.
  assert.equal(isSetupToolCall(call(ROOT, "/tmp/elsewhere"), options), false);
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
