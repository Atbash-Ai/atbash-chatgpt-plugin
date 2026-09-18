import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createFixture } from "./windows-acl-fixture.js";

// Only this disposable child changes resolver inputs. Production has no test
// root override or callbacks, and the parent's personal SDK root is never used.
const CHILD = String.raw`
import childProcess from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [home, mode] = process.argv.slice(1);
if (dirname(resolve(home)).toLowerCase() !== resolve(os.homedir()).toLowerCase() ||
    !basename(home).startsWith('.atbash-bootstrap-fixture-')) throw new Error('Invalid fixture root');
os.homedir = () => home;
process.env.HOME = mode === 'home-mismatch' ? join(home, 'other') : home;
if (mode === 'blank-env') process.env.ATBASH_AGENT_KEY = '';
const helpers = [];
const helperRequests = [];
const spawnHelper = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawnHelper(...args);
  if (String(args[0]).toLowerCase().endsWith('powershell.exe')) {
    const state = {closed:false};
    helpers.push(state);
    child.once('close', () => { state.closed = true; });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      const request = JSON.parse(Buffer.from(chunk).toString('utf8'));
      helperRequests.push({operation:request.operation,sequence:request.sequence});
      return write(chunk, ...rest);
    };
  }
  return child;
};
syncBuiltinESMExports();
const native = createRequire(import.meta.url)('@atbash/sdk/native');
const generate = native.generateKeypair;
let generated = 0;
native.generateKeypair = (...args) => { generated++; return generate(...args); };
let storageCalls = 0;
let secretWrites = 0;
const boundaries = [];
for (const method of ['lstat', 'realpath', 'link', 'open']) {
  const original = fs[method];
  fs[method] = async (...args) => {
    storageCalls++;
    if (method === 'open' && mode === 'concurrent' && basename(String(args[0])) === '.onboarding-bootstrap-claim') {
      boundaries.push('claim-ready');
      await new Promise((ready) => { process.once('message', ready); process.send('claim-ready'); });
      boundaries.push('claim-released');
      process.disconnect();
    }
    if (method === 'link' && mode === 'destination-race') {
      await fs.writeFile(join(home,'.config','atbash','guard-client-key'), 'concurrent public marker', {flag:'wx'});
      boundaries.push('destination-created');
    }
    const result = await original(...args);
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-staging') {
      if (mode === 'config-drift-before-generation') {
        await fs.writeFile(join(home,'.config','atbash','config.json'), 'concurrent public marker', {flag:'wx'});
        boundaries.push('config-inserted');
      }
      const write = result.writeFile.bind(result);
      result.writeFile = async (...values) => { secretWrites++; return write(...values); };
    }
    return result;
  };
}
syncBuiltinESMExports();
const {bootstrapWindowsIdentity} = await import(pathToFileURL(resolve('plugins/atbash/dist-tests/src/atbash/bootstrap-identity.js')).href);
let result;
let failed = false;
let message;
try {
  if (mode === 'import-only') result = {state:'imported'};
  else if (mode === 'read') {
    const {loadAgentFromFile} = await import('@atbash/sdk');
    result = {state:'read',pubkey:loadAgentFromFile(join(home,'.config','atbash','guard-client-key')).pubkey};
  } else if (mode === 'override-key') result = await bootstrapWindowsIdentity({agentKey:''});
  else if (mode === 'override-path') result = await bootstrapWindowsIdentity({keyPath:''});
  else result = await bootstrapWindowsIdentity();
} catch (error) { failed = true; message = error.message; }
process.stdout.write(JSON.stringify({failed,message,result,generated,storageCalls,secretWrites,boundaries,helperCount:helpers.length,helpersClosed:helpers.every(h=>h.closed),helperRequests}));
`;

interface ChildResult {
  failed: boolean;
  message?: string;
  result?: { state: string; pubkey?: string };
  generated: number;
  storageCalls: number;
  secretWrites: number;
  boundaries: string[];
  helperCount: number;
  helpersClosed: boolean;
  helperRequests: { operation: string; sequence: number }[];
}

async function run(
  home: string,
  mode = "invoke",
  onReady?: (child: ChildProcess) => void,
): Promise<ChildResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.toUpperCase().startsWith("ATBASH_") && name.toUpperCase() !== "NODE_OPTIONS",
    ),
  );
  env.NODE_OPTIONS = "";
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=module", "--eval", CHILD, home, mode],
      {
        cwd: resolve(import.meta.dirname, "../../../.."),
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeout: 120_000,
      },
    );
    let stdout = "";
    let stderrBytes = 0;
    child.on("message", (message) => {
      if (message === "claim-ready") onReady?.(child);
    });
    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > 4096) child.kill();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 4096) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        // Do not print child errors or serialized key material on failure.
        assert.equal(code, 0, "Isolated fixture process must complete");
        assert.equal(stderrBytes, 0, "Fixture stderr must be empty");
        const result = JSON.parse(stdout) as ChildResult;
        assert.equal(result.helpersClosed, true, "Every owned helper must close before returning");
        done(result);
      } catch {
        reject(new Error("Isolated bootstrap fixture failed; raw output withheld."));
      }
    });
  });
}

function refused(result: ChildResult): void {
  assert.equal(result.failed, true);
  assert.equal(result.generated, 0);
  assert.equal(result.secretWrites, 0);
  assert.equal(result.result, undefined);
  assert.equal(
    result.message,
    "Local identity setup could not safely finish. Existing files were preserved.",
  );
}

if (process.platform === "win32") {
  test("bootstrap fixture refuses inherited Node preloads before isolated startup", async () => {
    const home = await createFixture();
    const preload = join(home, "harmless-preload.cjs");
    const control = join(home, "control-marker");
    const blocked = join(home, "blocked-marker");
    await writeFile(
      preload,
      "require('node:fs').writeFileSync(process.env.BOOTSTRAP_FIXTURE_PRELOAD_MARKER, 'loaded');",
    );
    const injected = `--require=${JSON.stringify(preload.replaceAll("\\", "/"))}`;
    const positive = spawnSync(process.execPath, ["--eval", ""], {
      env: {
        SystemRoot: process.env.SystemRoot,
        NODE_OPTIONS: injected,
        BOOTSTRAP_FIXTURE_PRELOAD_MARKER: control,
      },
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(positive.status, 0);
    assert.equal(
      await readFile(control, "utf8"),
      "loaded",
      "The harmless preload must be executable",
    );
    const previous = process.env.NODE_OPTIONS;
    const previousMarker = process.env.BOOTSTRAP_FIXTURE_PRELOAD_MARKER;
    try {
      process.env.NODE_OPTIONS = injected;
      process.env.BOOTSTRAP_FIXTURE_PRELOAD_MARKER = blocked;
      const result = await run(home, "import-only");
      assert.equal(result.failed, false);
      assert.equal(result.generated, 0);
      assert.equal(result.storageCalls, 0);
      await assert.rejects(lstat(blocked), { code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
      if (previousMarker === undefined) delete process.env.BOOTSTRAP_FIXTURE_PRELOAD_MARKER;
      else process.env.BOOTSTRAP_FIXTURE_PRELOAD_MARKER = previousMarker;
    }
  });

  test("bootstrap import performs no identity generation or storage operations", async () => {
    const home = await createFixture();
    const result = await run(home, "import-only");
    assert.equal(result.failed, false);
    assert.equal(result.generated, 0);
    assert.equal(result.storageCalls, 0);
    assert.equal(result.secretWrites, 0);
    assert.deepEqual(await readdir(home), []);
  });

  for (const mode of ["blank-env", "home-mismatch", "override-key", "override-path"]) {
    test(`bootstrap refuses ${mode} before storage operations`, async () => {
      const home = await createFixture();
      const result = await run(home, mode);
      refused(result);
      assert.equal(result.storageCalls, 0);
      assert.deepEqual(await readdir(home), []);
    });
  }

  test("two real bootstrap processes publish exactly one identity", async () => {
    const home = await createFixture();
    const waiting: ChildProcess[] = [];
    const releaseTogether = (child: ChildProcess) => {
      waiting.push(child);
      if (waiting.length === 2) for (const contender of waiting) contender.send("go");
    };
    const results = await Promise.all([
      run(home, "concurrent", releaseTogether),
      run(home, "concurrent", releaseTogether),
    ]);
    assert.equal(waiting.length, 2);
    for (const result of results)
      assert.deepEqual(result.boundaries, ["claim-ready", "claim-released"]);
    assert.equal(results.filter((result) => !result.failed).length, 1);
    assert.equal(
      results.reduce((sum, result) => sum + result.generated, 0),
      1,
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.secretWrites, 0),
      1,
    );
    const loser = results.find((result) => result.failed)!;
    refused(loser);
    const winner = results.find((result) => !result.failed)!;
    const restart = await run(home, "read");
    assert.equal(restart.failed, false);
    assert.equal(restart.result?.pubkey, winner.result?.pubkey);
  });

  test("bootstrap notices another store before generation and preserves it", async () => {
    const home = await createFixture();
    const result = await run(home, "config-drift-before-generation");
    refused(result);
    assert.deepEqual(result.boundaries, ["config-inserted"]);
    const directory = join(home, ".config", "atbash");
    assert.equal(
      await readFile(join(directory, "config.json"), "utf8"),
      "concurrent public marker",
    );
    assert.equal((await lstat(join(directory, ".onboarding-bootstrap-staging"))).size, 0);
    await assert.rejects(lstat(join(directory, "guard-client-key")), { code: "ENOENT" });
  });

  test("bootstrap never overwrites a destination created at publication", async () => {
    const home = await createFixture();
    const result = await run(home, "destination-race");
    assert.equal(result.failed, true);
    assert.equal(result.result, undefined);
    assert.equal(result.generated, 1);
    assert.equal(result.secretWrites, 1);
    assert.deepEqual(result.boundaries, ["destination-created"]);
    const directory = join(home, ".config", "atbash");
    assert.equal(
      await readFile(join(directory, "guard-client-key"), "utf8"),
      "concurrent public marker",
    );
    assert.equal(
      (await lstat(join(directory, ".onboarding-bootstrap-staging"), { bigint: true })).nlink,
      1n,
    );
    refused(await run(home));
  });

  for (const name of ["config.json", "guard-client-key", "atbash-client-key"]) {
    for (const contents of ["", "not a key or config"]) {
      test(`bootstrap preserves existing ${name} (${contents ? "malformed" : "empty"}) without generation`, async () => {
        const home = await createFixture();
        const directory = join(home, ".config", "atbash");
        await mkdir(directory, { recursive: true });
        const path = join(directory, name);
        await writeFile(path, contents);
        refused(await run(home));
        assert.equal(await readFile(path, "utf8"), contents);
        assert.deepEqual(await readdir(directory), [name]);
      });
    }
  }

  test("bootstrap publishes one native identity, survives SDK restart and refuses replacement", async () => {
    const home = await createFixture();
    const first = await run(home);
    assert.equal(first.failed, false);
    assert.equal(first.generated, 1);
    assert.equal(first.secretWrites, 1);
    assert.equal(first.helperCount, 1);
    assert.deepEqual(
      first.helperRequests,
      [
        "prepare-directory",
        "prepare-directory",
        "verify-file",
        "verify-storage",
        "verify-storage",
        "verify-storage",
        "verify-storage",
        "verify-storage",
      ].map((operation, index) => ({ operation, sequence: index + 1 })),
    );
    assert.deepEqual(Object.keys(first.result ?? {}).sort(), ["pubkey", "state"]);
    assert.equal(first.result?.state, "created");
    assert.match(first.result?.pubkey ?? "", /^(02|03)[0-9a-f]{64}$/);
    const directory = join(home, ".config", "atbash");
    const published = join(directory, "guard-client-key");
    const staging = join(directory, ".onboarding-bootstrap-staging");
    const before = await lstat(published, { bigint: true });
    const staged = await lstat(staging, { bigint: true });
    assert.equal(before.nlink, 2n);
    assert.equal(staged.ino, before.ino);
    assert.equal(staged.dev, before.dev);
    const hashBefore = createHash("sha256")
      .update(await readFile(published))
      .digest("hex");
    const restart = await run(home, "read");
    assert.equal(restart.failed, false);
    assert.equal(restart.generated, 0);
    assert.equal(restart.result?.pubkey, first.result?.pubkey);
    refused(await run(home));
    assert.equal(
      createHash("sha256")
        .update(await readFile(published))
        .digest("hex"),
      hashBefore,
    );
    assert.equal((await lstat(published, { bigint: true })).ino, before.ino);
    assert.equal((await lstat(published, { bigint: true })).nlink, 2n);
  });
}
