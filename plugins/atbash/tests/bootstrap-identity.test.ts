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
import {writeFileSync} from 'node:fs';
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
    const state = {closed:false,pid:child.pid};
    helpers.push(state);
    child.once('close', () => { state.closed = true; });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      const request = JSON.parse(Buffer.from(chunk).toString('utf8'));
      helperRequests.push({operation:request.operation,sequence:request.sequence});
      if (mode === 'helper-exit-' + request.sequence) {
        boundaries.push('helper-exit-' + request.sequence);
        child.kill();
      }
      return write(chunk, ...rest);
    };
  }
  return child;
};
syncBuiltinESMExports();
const native = createRequire(import.meta.url)('@atbash/sdk/native');
const generate = native.generateKeypair;
let generated = 0;
let generatedPubkey;
native.generateKeypair = (...args) => {
  generated++;
  const pair = generate(...args);
  generatedPubkey = pair.pub_key;
  checkpoint('generation');
  return pair;
};
const load = native.loadAgent;
native.loadAgent = (...args) => {
  const agent = load(...args);
  checkpoint('readback');
  return agent;
};
let storageCalls = 0;
let secretWrites = 0;
let writtenBytes = 0;
let encodedLength = 0;
let publications = 0;
let partialVerified = false;
const boundaries = [];
function checkpoint(boundary) {
  if (mode !== 'crash-' + boundary) return;
  // Only public metadata is serialized. Abrupt exit deliberately skips finally.
  writeFileSync(join(home,'.bootstrap-crash.json'), JSON.stringify({
    boundary,generated,secretWrites,writtenBytes,encodedLength,generatedPubkey,publications,partialVerified,
    helperPids:helpers.map(helper=>helper.pid),helperRequests,
  }), {flag:'wx'});
  process.exit(73);
}
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
    if (method === 'link') checkpoint('before-link');
    const result = await original(...args);
    if (method === 'link') { publications++; checkpoint('after-link'); }
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-claim') checkpoint('claim');
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-staging') {
      checkpoint('empty-stage');
      if (mode === 'config-drift-before-generation') {
        await fs.writeFile(join(home,'.config','atbash','config.json'), 'concurrent public marker', {flag:'wx'});
        boundaries.push('config-inserted');
      }
      const write = result.writeFile.bind(result);
      result.writeFile = async (...values) => {
        secretWrites++;
        encodedLength = values[0].length;
        if (mode === 'crash-partial-write') {
          const short = await result.write(values[0].subarray(0, Math.floor(encodedLength / 2)));
          writtenBytes = short.bytesWritten;
          const actual = await fs.readFile(join(home,'.config','atbash','.onboarding-bootstrap-staging'));
          partialVerified = writtenBytes === Math.floor(encodedLength / 2) &&
            writtenBytes > 0 && actual.equals(values[0].subarray(0,writtenBytes));
          actual.fill(0);
          checkpoint('partial-write');
        }
        const outcome = await write(...values);
        writtenBytes = encodedLength;
        checkpoint('write');
        return outcome;
      };
      for (const [method, boundary] of [['sync','fsync'],['close','close']]) {
        const operation = result[method].bind(result);
        result[method] = async (...values) => {
          const outcome = await operation(...values);
          checkpoint(boundary);
          return outcome;
        };
      }
    }
    return result;
  };
}
syncBuiltinESMExports();
const {bootstrapWindowsIdentity} = await import(pathToFileURL(resolve('plugins/atbash/dist-tests/src/atbash/bootstrap-identity.js')).href);
let result;
let failed = false;
let message;
const started = performance.now();
try {
  if (mode === 'import-only') result = {state:'imported'};
  else if (mode === 'read') {
    const {loadAgentFromFile} = await import('@atbash/sdk');
    result = {state:'read',pubkey:loadAgentFromFile(join(home,'.config','atbash','guard-client-key')).pubkey};
  } else if (mode === 'override-key') result = await bootstrapWindowsIdentity({agentKey:''});
  else if (mode === 'override-path') result = await bootstrapWindowsIdentity({keyPath:''});
  else result = await bootstrapWindowsIdentity();
} catch (error) { failed = true; message = error.message; }
process.stdout.write(JSON.stringify({failed,message,result,generated,storageCalls,secretWrites,publications,boundaries,helperCount:helpers.length,helpersClosed:helpers.every(h=>h.closed),helperRequests,elapsedMs:Math.round(performance.now()-started)}));
`;

interface ChildResult {
  failed: boolean;
  message?: string;
  result?: { state: string; pubkey?: string };
  generated: number;
  storageCalls: number;
  secretWrites: number;
  publications: number;
  boundaries: string[];
  helperCount: number;
  helpersClosed: boolean;
  helperRequests: { operation: string; sequence: number }[];
  elapsedMs: number;
}

interface CrashResult {
  boundary: string;
  generated: number;
  secretWrites: number;
  writtenBytes: number;
  encodedLength: number;
  publications: number;
  partialVerified: boolean;
  generatedPubkey?: string;
  helperPids: number[];
  helperRequests: { operation: string; sequence: number }[];
}

async function helpersExited(pids: number[]): Promise<void> {
  assert.equal(pids.length, 1, "Crash fixture must identify its one actual helper");
  const deadline = performance.now() + 2000;
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    for (;;) {
      try {
        // Signal zero observes existence only; never terminate by a recorded PID.
        process.kill(pid, 0);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        break;
      }
      assert.ok(performance.now() < deadline, "Owned helper must exit after parent pipe EOF");
      await new Promise((done) => setTimeout(done, 20));
    }
  }
}

function run(
  home: string,
  mode?: string,
  onReady?: (child: ChildProcess) => void,
): Promise<ChildResult>;
function run(
  home: string,
  mode: string,
  onReady: undefined,
  onCrash: (result: CrashResult) => Promise<void>,
): Promise<void>;
async function run(
  home: string,
  mode = "invoke",
  onReady?: (child: ChildProcess) => void,
  onCrash?: (result: CrashResult) => Promise<void>,
): Promise<ChildResult | void> {
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
      void (async () => {
        try {
          // Do not print child errors or serialized key material on failure.
          assert.equal(stderrBytes, 0, "Fixture stderr must be empty");
          if (onCrash) {
            assert.equal(code, 73, "Crash must reach its explicit boundary exit");
            assert.equal(stdout, "", "Crash must not emit a normal return or secret output");
            const marker = await readFile(join(home, ".bootstrap-crash.json"), "utf8");
            assert.ok(marker.length < 4096);
            const result = JSON.parse(marker) as CrashResult;
            await helpersExited(result.helperPids);
            await onCrash(result);
            // The crash caller consumes only its marker, never a fabricated success.
            done();
            return;
          }
          assert.equal(code, 0, "Isolated fixture process must complete");
          const result = JSON.parse(stdout) as ChildResult;
          assert.equal(
            result.helpersClosed,
            true,
            "Every owned helper must close before returning",
          );
          done(result);
        } catch {
          reject(new Error("Isolated bootstrap fixture failed; raw output withheld."));
        }
      })();
    });
  });
}

function refused(result: ChildResult): void {
  assert.equal(result.failed, true);
  assert.equal(result.generated, 0);
  assert.equal(result.secretWrites, 0);
  assert.equal(result.publications, 0);
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

  for (const sequence of [4, 5, 6, 7, 8]) {
    test(`bootstrap helper termination at boundary ${sequence} refuses readiness and preserves identity`, async () => {
      const home = await createFixture();
      const result = await run(home, `helper-exit-${sequence}`);
      assert.deepEqual(result.boundaries, [`helper-exit-${sequence}`]);
      assert.equal(result.helperCount, 1);
      assert.equal(result.helpersClosed, true);
      assert.equal(result.failed, true);
      assert.equal(result.result, undefined);
      assert.equal(result.generated, sequence >= 5 ? 1 : 0);
      assert.equal(result.secretWrites, sequence >= 6 ? 1 : 0);
      assert.equal(
        result.message,
        "Local identity setup could not safely finish. Existing files were preserved.",
      );
      const directory = join(home, ".config", "atbash");
      const stage = join(directory, ".onboarding-bootstrap-staging");
      const before = await lstat(stage, { bigint: true });
      const digest = createHash("sha256")
        .update(await readFile(stage))
        .digest("hex");
      if (sequence < 6) assert.equal(before.size, 0n);
      else assert.ok(before.size > 0n);
      if (sequence < 7)
        await assert.rejects(lstat(join(directory, "guard-client-key")), { code: "ENOENT" });
      else
        assert.equal(
          (await lstat(join(directory, "guard-client-key"), { bigint: true })).ino,
          before.ino,
        );
      refused(await run(home));
      assert.equal((await lstat(stage, { bigint: true })).ino, before.ino);
      assert.equal(
        createHash("sha256")
          .update(await readFile(stage))
          .digest("hex"),
        digest,
      );
    });
  }

  for (const [boundary, generated, writes, published] of [
    ["claim", 0, 0, false],
    ["empty-stage", 0, 0, false],
    ["generation", 1, 0, false],
    ["partial-write", 1, 1, false],
    ["write", 1, 1, false],
    ["fsync", 1, 1, false],
    ["close", 1, 1, false],
    ["before-link", 1, 1, false],
    ["after-link", 1, 1, true],
    ["readback", 1, 1, true],
  ] as const) {
    test(`bootstrap parent crash at ${boundary} preserves remnants and refuses regeneration`, async () => {
      const home = await createFixture();
      await run(home, `crash-${boundary}`, undefined, async (marker) => {
        assert.equal(marker.boundary, boundary);
        assert.equal(marker.generated, generated);
        assert.equal(marker.secretWrites, writes);
        assert.equal(marker.publications, published ? 1 : 0);
        if (generated) assert.match(marker.generatedPubkey ?? "", /^(02|03)[0-9a-f]{64}$/);
        else assert.equal(marker.generatedPubkey, undefined);
        const directory = join(home, ".config", "atbash");
        const claim = ".onboarding-bootstrap-claim";
        const stage = ".onboarding-bootstrap-staging";
        const destination = "guard-client-key";
        const names = [
          claim,
          ...(boundary === "claim" ? [] : [stage]),
          ...(published ? [destination] : []),
        ].sort();
        assert.deepEqual((await readdir(directory)).sort(), names);
        const snapshot = async () =>
          Promise.all(
            names.map(async (name) => {
              const file = join(directory, name);
              const stats = await lstat(file, { bigint: true });
              assert.equal(stats.isFile(), true);
              assert.equal(stats.isSymbolicLink(), false);
              return {
                name,
                ino: stats.ino,
                dev: stats.dev,
                nlink: stats.nlink,
                size: stats.size,
                hash: createHash("sha256")
                  .update(await readFile(file))
                  .digest("hex"),
              };
            }),
          );
        const before = await snapshot();
        const claimed = before.find((file) => file.name === claim)!;
        assert.equal(claimed.nlink, 1n);
        assert.equal(claimed.size, 0n);
        const staged = before.find((file) => file.name === stage);
        if (staged) {
          assert.equal(staged.nlink, published ? 2n : 1n);
          assert.equal(staged.size, BigInt(marker.writtenBytes));
          if (!writes) assert.equal(staged.size, 0n);
          else if (boundary === "partial-write") {
            assert.equal(
              marker.partialVerified,
              true,
              "Actual stage must contain the exact nonempty prefix",
            );
            assert.ok(marker.writtenBytes > 0 && marker.writtenBytes < marker.encodedLength);
          } else {
            assert.ok(marker.writtenBytes > 0);
            assert.equal(marker.writtenBytes, marker.encodedLength);
          }
        }
        if (published) {
          const canonical = before.find((file) => file.name === destination)!;
          assert.equal(canonical.ino, staged!.ino);
          assert.equal(canonical.dev, staged!.dev);
          assert.equal(canonical.nlink, 2n);
          const restarted = await run(home, "read");
          assert.equal(restarted.failed, false);
          assert.equal(restarted.generated, 0);
          assert.equal(restarted.result?.pubkey, marker.generatedPubkey);
        } else await assert.rejects(lstat(join(directory, destination)), { code: "ENOENT" });
        const retry = await run(home);
        refused(retry);
        assert.deepEqual((await readdir(directory)).sort(), names);
        assert.deepEqual(await snapshot(), before);
      });
    });
  }

  test("bootstrap publishes one native identity, survives SDK restart and refuses replacement", async (t) => {
    const home = await createFixture();
    const start = performance.now();
    const first = await run(home);
    t.diagnostic(
      `Cold bootstrap subprocess ${Math.round(performance.now() - start)}ms; bootstrap function ${first.elapsedMs}ms. Local fixture only.`,
    );
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
