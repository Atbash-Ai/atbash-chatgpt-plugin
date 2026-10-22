import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hasAtbashConfiguration,
  isSetupToolCall,
  NOT_SET_UP_REASON,
  notSetUpReason,
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

// Captured from Codex 0.163 on macOS, which reads a skill with sed when the user
// asks in plain words ("set up atbash") instead of invoking $atbash-setup.
test("allows the print-only sed, head and tail reads Codex uses on macOS", () => {
  const skill = `${ROOT}/skills/atbash-setup/SKILL.md`;
  for (const command of [
    `sed -n '1,240p' ${skill}`,
    `sed -n '1,200p' '${skill}'`,
    `sed -n 1,200p ${skill}`,
    `sed -n '5p' ${skill}`,
    `sed -n '1,$p' ${skill}`,
    `head ${skill}`,
    `head -n 200 ${skill}`,
    `tail -n 50 ${skill}`,
    `tail -n +40 ${skill}`,
  ]) {
    assert.equal(isSetupToolCall(shell(command), options), true, command);
  }
  // Relative to the call's own working directory, as Codex sends it.
  const fromSkill = makeHookInput({
    tool_name: "Bash",
    tool_input: { command: "sed -n '1,240p' SKILL.md", workdir: `${ROOT}/skills/atbash-setup` },
  });
  assert.equal(isSetupToolCall(fromSkill, options), true);
});

test("sed, head and tail match only their print-only shapes", () => {
  const skill = `${ROOT}/skills/atbash-setup/SKILL.md`;
  for (const command of [
    `sed -i '1,240p' ${skill}`, // edits in place
    `sed -n -i '1p' ${skill}`,
    `sed -n '1,240p' -i ${skill}`,
    `sed '1,240p' ${skill}`, // no -n
    `sed -n '1w /tmp/out' ${skill}`, // writes another file
    `sed -n '1r /etc/passwd' ${skill}`, // reads another file
    `sed -n '1e id' ${skill}`, // runs a command
    `sed -n 's/a/b/w /tmp/out' ${skill}`,
    `sed -n '1e id;1p' ${skill}`, // ends in p, but `e` runs the rest of the line
    `sed -n 's/a/b/p' ${skill}`, // a script, not a line range
    `sed -n '1p;2p' ${skill}`,
    `sed -n -e '1p' ${skill}`,
    `sed -n '1,240p' ${skill} ${ROOT}/runtime/manifest.json`, // a second file
    `sed -n '1,240p' ${ROOT}/runtime/manifest.json`, // outside skills/
    `sed -n '1,240p' ~/.ssh/id_rsa`,
    `sed -n '1,240p'`,
    `head -c 100 ${skill}`,
    `head -n -5 ${skill}`,
    `head -5 ${skill}`,
    `tail -f ${skill}`,
    `tail -n 5 -f ${skill}`,
    `tail -n +40 ${skill} ${ROOT}/runtime/manifest.json`,
    `head -n 200 ${ROOT}/../secrets.txt`,
    `sed -n '1,240p' ${skill} && cat ~/.ssh/id_rsa`,
    `sed -n '1,240p' ${skill} | sh`,
  ]) {
    assert.equal(isSetupToolCall(shell(command), options), false, command);
  }
  // An option in the file position is refused even from inside skills/: GNU tools
  // take options anywhere on the line, and `tail +1f` is "from line 1, follow".
  for (const command of [
    "tail -n 5 -f",
    "sed -n '1p' -i",
    "head -n 5 --follow",
    "tail +1f",
    "tail +5",
    "head +5",
  ]) {
    const inSkill = makeHookInput({
      tool_name: "Bash",
      tool_input: { command, workdir: `${ROOT}/skills/atbash-setup` },
    });
    assert.equal(isSetupToolCall(inSkill, options), false, command);
  }
});

// `..` is resolved as text, but the shell follows a directory link before it, so
// `skills/link/../x` could leave skills/ through a link inside it.
test("a skill read refuses any '..' in the path", () => {
  for (const command of [
    `sed -n '1p' ${ROOT}/skills/atbash-setup/../atbash-setup/SKILL.md`,
    `cat ${ROOT}/skills/link/../outside.txt`,
    `tail -n 1 skills\\link\\..\\outside.txt`,
  ]) {
    assert.equal(isSetupToolCall(shell(command, ROOT), options), false, command);
  }
});

// PowerShell treats curly quotes as quotes; this splitter does not, so they would
// end PowerShell's string inside what reads here as one quoted word.
test("refuses curly quotes, which PowerShell reads as quotes", () => {
  const inSkill = (command: string) =>
    makeHookInput({
      tool_name: "Bash",
      tool_input: { command, workdir: `${ROOT}/skills/atbash-setup` },
    });
  for (const command of [
    "cat 'x’;New-Item pwned | Out-Null;’'",
    "Get-Content -Raw 'x’;New-Item pwned | Out-Null;’'",
    "sed -n '1p' 'x’;New-Item pwned | Out-Null;’'",
    'tail -n 5 "x”;New-Item pwned | Out-Null;“"',
    `node ${LAUNCHER} setup inspect 'x’;calc;’'`,
  ]) {
    assert.equal(splitPlainCommand(command), null, command);
    assert.equal(isSetupToolCall(inSkill(command), options), false, command);
  }
});

test("the not-set-up denial names a read that setup mode allows", () => {
  const reason = notSetUpReason(ROOT);
  assert.ok(reason.startsWith(NOT_SET_UP_REASON), reason);
  const hint = /run: (cat '[^']+')$/.exec(reason)?.[1];
  assert.equal(hint, `cat '${ROOT}/skills/atbash-setup/SKILL.md'`);
  assert.equal(isSetupToolCall(shell(hint!), options), true);
});

test("the denial leaves the hint out when it cannot be given safely", () => {
  assert.equal(notSetUpReason(undefined), NOT_SET_UP_REASON);
  assert.equal(notSetUpReason("/opt/it's/atbash"), NOT_SET_UP_REASON); // cannot be single-quoted
  assert.equal(notSetUpReason("/opt/a\nb/atbash"), NOT_SET_UP_REASON);
  assert.equal(notSetUpReason("/opt/a\u0001b/atbash"), NOT_SET_UP_REASON);
  assert.equal(notSetUpReason("/opt/it’s/atbash"), NOT_SET_UP_REASON); // a PowerShell quote
  // The hook collapses whitespace runs, which would rewrite the path in the hint.
  assert.equal(notSetUpReason("/Users/x/My  Plugins/atbash"), NOT_SET_UP_REASON);
  assert.equal(notSetUpReason("/Users/x/My Plugins/atbash"), NOT_SET_UP_REASON);
  assert.notEqual(notSetUpReason("/Users/x/My Plugins/atbash"), NOT_SET_UP_REASON);
});

test("the hint is kept up to the reason cap and left out past it", () => {
  const reasonFor = (root: string) =>
    `${NOT_SET_UP_REASON} To read the setup instructions, run: cat '${root}/skills/atbash-setup/SKILL.md'`;
  const fixed = reasonFor("/").length - 1; // everything but the root's own characters
  const rootOf = (length: number) => `/${"x".repeat(length - 1)}`;
  assert.equal(reasonFor(rootOf(800 - fixed)).length, 800);
  assert.equal(notSetUpReason(rootOf(800 - fixed)), reasonFor(rootOf(800 - fixed)));
  assert.equal(notSetUpReason(rootOf(801 - fixed)), NOT_SET_UP_REASON);
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
