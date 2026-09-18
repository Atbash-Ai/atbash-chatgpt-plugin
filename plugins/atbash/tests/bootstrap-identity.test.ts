import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { addFixtureGrant, createFixture, readFixtureDescriptor } from "./windows-acl-fixture.js";

// Only this disposable child changes resolver inputs. Production has no test
// root override or callbacks, and the parent's personal SDK root is never used.
const CHILD = String.raw`
import childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import fs from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [home, mode] = process.argv.slice(1);
if (dirname(resolve(home)).toLowerCase() !== resolve(os.homedir()).toLowerCase() ||
    !basename(home).startsWith('.atbash-bootstrap-fixture-')) throw new Error('Invalid fixture root');
if (mode === 'diagnostic-exit') {
  process.stdout.write('private-output-sentinel');
  process.stderr.write('private-error-sentinel');
  process.exit(9);
}
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
  fault('readback');
  if (mode === 'error-readback-mismatch' && !faultInjected) {
    faultInjected = true;
    boundaries.push('readback-mismatch');
    // Negating the compressed point preserves a valid but different public key.
    return {pubkey:(agent.pubkey.startsWith('02') ? '03' : '02') + agent.pubkey.slice(2)};
  }
  return agent;
};
let storageCalls = 0;
let secretWrites = 0;
let writtenBytes = 0;
let encodedLength = 0;
let publications = 0;
let partialVerified = false;
let faultInjected = false;
let driftInjected = false;
let replacementVerified = false;
let replacementOriginal;
let replacementFailure;
let directoryObserved;
let preClaimPinObserved;
let hardlinkVerified = false;
const linkFixture = fs.link.bind(fs);
const boundaries = [];
async function extraLink(phase) {
  if (hardlinkVerified) return;
  for (const kind of ['claim','stage']) {
    if (mode !== 'extra-link-' + kind + '-' + phase) continue;
    const directory = join(home,'.config','atbash');
    const target = join(directory,kind === 'claim' ? '.onboarding-bootstrap-claim' : '.onboarding-bootstrap-staging');
    const extra = join(directory,'.onboarding-extra-' + kind);
    const before = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    await linkFixture(target,extra);
    const original = await fs.lstat(target,{bigint:true});
    const linked = await fs.lstat(extra,{bigint:true});
    hardlinkVerified = original.isFile() && linked.isFile() && original.ino === linked.ino &&
      original.dev === linked.dev && original.nlink === 2n && linked.nlink === 2n &&
      before === createHash('sha256').update(await fs.readFile(target)).digest('hex');
    boundaries.push(kind + '-' + phase);
  }
}
async function substitute(phase) {
  if (replacementVerified) return;
  for (const kind of ['claim','stage','directory']) {
    const denialControl = kind === 'directory' && mode === 'rename-denied-' + phase;
    if (mode !== 'replace-' + kind + '-' + phase && !denialControl) continue;
    const directory = join(home,'.config','atbash');
    const target = kind === 'directory' ? directory : join(directory, kind === 'claim' ? '.onboarding-bootstrap-claim' : '.onboarding-bootstrap-staging');
    const backup = target + '.preserved';
    const before = await fs.lstat(target, {bigint:true});
    replacementOriginal = {ino:String(before.ino),dev:String(before.dev)};
    try { await fs.rename(target, backup); }
    catch (error) {
      replacementFailure = {operation:'rename',code:['EPERM','EACCES','EBUSY','EEXIST','ENOENT'].includes(error.code) ? error.code : 'OTHER'};
      if (denialControl && error.code === 'EPERM') {
        boundaries.push('directory-rename-denied-' + phase);
        return;
      }
      throw error;
    }
    if (kind === 'directory') await fs.mkdir(target);
    else await fs.copyFile(backup, target);
    const retained = await fs.lstat(backup, {bigint:true});
    const replaced = await fs.lstat(target, {bigint:true});
    replacementVerified = retained.ino === before.ino && retained.dev === before.dev &&
      replaced.ino !== before.ino && retained.size === before.size;
    replacementOriginal = {ino:String(before.ino),dev:String(before.dev)};
    boundaries.push(kind + '-' + phase);
  }
}
async function drift(phase) {
  if (driftInjected) return;
  for (const kind of ['config','legacy','environment-key','home']) {
    if (mode !== 'drift-' + kind + '-' + phase) continue;
    if (kind === 'config' || kind === 'legacy') {
      const name = kind === 'config' ? 'config.json' : 'atbash-client-key';
      await fs.writeFile(join(home,'.config','atbash',name), 'concurrent public marker', {flag:'wx'});
    } else if (kind === 'environment-key') process.env.ATBASH_AGENT_KEY = '';
    else {
      const alternate = join(home,'drift-home');
      await fs.mkdir(alternate);
      process.env.HOME = alternate;
    }
    driftInjected = true;
    boundaries.push(kind + '-' + phase);
  }
}
function fault(boundary) {
  if (mode !== 'error-' + boundary || faultInjected) return;
  faultInjected = true;
  boundaries.push(boundary);
  throw new Error('Synthetic fixture I/O failure');
}
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
    if (method === 'lstat') {
      for (const code of ['EACCES','EIO']) {
        const name = basename(String(args[0]));
        if (['config.json','guard-client-key','atbash-client-key'].includes(name) &&
            String(args[0]) === join(home,'.config','atbash',name) && mode === 'metadata-' + code + '-' + name) {
          boundaries.push(code + '-' + name);
          throw Object.assign(new Error('Synthetic fixture metadata refusal'),{code});
        }
      }
    }
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-claim') {
      preClaimPinObserved = directoryObserved;
      await substitute('before-claim');
    }
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
    if (method === 'link') { checkpoint('before-link'); fault('before-link'); }
    const result = await original(...args);
    if (method === 'lstat' && String(args[0]) === join(home,'.config','atbash')) directoryObserved = {ino:String(result.ino),dev:String(result.dev)};
    if (method === 'link') { publications++; checkpoint('after-link'); await drift('after-publication'); }
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-claim') checkpoint('claim');
    if (method === 'open' && basename(String(args[0])) === '.onboarding-bootstrap-staging') {
      checkpoint('empty-stage');
      await drift('before-generation');
      await substitute('before-generation');
      await extraLink('before-generation');
      if (mode === 'config-drift-before-generation') {
        await fs.writeFile(join(home,'.config','atbash','config.json'), 'concurrent public marker', {flag:'wx'});
        boundaries.push('config-inserted');
      }
      const write = result.writeFile.bind(result);
      result.writeFile = async (...values) => {
        secretWrites++;
        encodedLength = values[0].length;
        if (mode === 'crash-partial-write' || mode === 'error-partial-write') {
          const short = await result.write(values[0].subarray(0, Math.floor(encodedLength / 2)));
          writtenBytes = short.bytesWritten;
          const actual = await fs.readFile(join(home,'.config','atbash','.onboarding-bootstrap-staging'));
          partialVerified = writtenBytes === Math.floor(encodedLength / 2) &&
            writtenBytes > 0 && actual.equals(values[0].subarray(0,writtenBytes));
          actual.fill(0);
          checkpoint('partial-write');
          fault('partial-write');
        }
        const outcome = await write(...values);
        writtenBytes = encodedLength;
        checkpoint('write');
        return outcome;
      };
      for (const [method, boundary] of [['sync','fsync'],['close','close']]) {
        const operation = result[method].bind(result);
        result[method] = async (...values) => {
          if (method === 'sync') fault('before-fsync');
          const outcome = await operation(...values);
          checkpoint(boundary);
          if (method === 'close') fault('after-close');
          if (method === 'close') await drift('before-publication');
          if (method === 'close') await substitute('before-publication');
          if (method === 'close') await extraLink('before-publication');
          return outcome;
        };
      }
    }
    return result;
  };
}
syncBuiltinESMExports();
const {WindowsStorageSession} = await import(pathToFileURL(resolve('plugins/atbash/dist-tests/src/atbash/windows-storage-session.js')).href);
const verifyStorage = WindowsStorageSession.prototype.verifyStorage;
let verification = 0;
WindowsStorageSession.prototype.verifyStorage = async function(...args) {
  verification++;
  const selected = mode === 'acl-before-generation' ? 1 : mode === 'acl-before-write' ? 2 : 0;
  if (verification === selected) {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { process.removeListener('message', receive); reject(new Error('Fixture grant deadline')); }, 10_000);
      function receive(message) {
        clearTimeout(timer);
        if (message !== 'acl-applied') reject(new Error('Unexpected fixture acknowledgement'));
        else done();
      }
      process.once('message', receive);
      process.send('acl-ready');
    });
    boundaries.push(mode);
    process.disconnect();
  }
  return verifyStorage.apply(this,args);
};
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
process.stdout.write(JSON.stringify({failed,message,result,generated,generatedPubkey,storageCalls,secretWrites,writtenBytes,encodedLength,partialVerified,replacementVerified,replacementOriginal,replacementFailure,preClaimPinObserved,hardlinkVerified,publications,boundaries,helperCount:helpers.length,helpersClosed:helpers.every(h=>h.closed),helperRequests,elapsedMs:Math.round(performance.now()-started)}));
`;

interface ChildResult {
  failed: boolean;
  message?: string;
  result?: { state: string; pubkey?: string };
  generated: number;
  storageCalls: number;
  secretWrites: number;
  publications: number;
  writtenBytes: number;
  encodedLength: number;
  partialVerified: boolean;
  generatedPubkey?: string;
  replacementVerified: boolean;
  replacementOriginal?: { ino: string; dev: string };
  replacementFailure?: { operation: string; code: string };
  preClaimPinObserved?: { ino: string; dev: string };
  hardlinkVerified: boolean;
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
    const started = performance.now();
    let phase = "starting";
    let readyEvents = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let exitSignal = "none";
    let parsed = false;
    const failure = () =>
      new Error(
        "Isolated bootstrap fixture failed; raw output withheld. " +
          JSON.stringify({
            phase,
            readyEvents,
            stdoutBytes,
            stderrBytes,
            exitCode,
            exitSignal,
            parsed,
            elapsedMs: Math.round(performance.now() - started),
          }),
      );
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
    child.on("message", (message) => {
      if (message === "claim-ready" || message === "acl-ready") {
        readyEvents++;
        try {
          onReady?.(child);
        } catch {
          child.kill();
          phase = "checkpoint-callback";
          reject(failure());
        }
      }
    });
    child.stdout!.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      stdout += data.toString("utf8");
      if (stdout.length > 4096) child.kill();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 4096) child.kill();
    });
    child.on("error", () => {
      phase = "process-error";
      reject(failure());
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal =
        signal === null
          ? "none"
          : ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(signal)
            ? signal
            : "other";
      void (async () => {
        try {
          // Do not print child errors or serialized key material on failure.
          phase = "stderr-check";
          assert.equal(stderrBytes, 0, "Fixture stderr must be empty");
          if (onCrash) {
            phase = "crash-exit";
            assert.equal(code, 73, "Crash must reach its explicit boundary exit");
            assert.equal(stdout, "", "Crash must not emit a normal return or secret output");
            phase = "crash-marker";
            const marker = await readFile(join(home, ".bootstrap-crash.json"), "utf8");
            assert.ok(marker.length < 4096);
            const result = JSON.parse(marker) as CrashResult;
            parsed = true;
            phase = "crash-helper-exit";
            await helpersExited(result.helperPids);
            phase = "crash-assertions";
            await onCrash(result);
            // The crash caller consumes only its marker, never a fabricated success.
            done();
            return;
          }
          phase = "normal-exit";
          assert.equal(code, 0, "Isolated fixture process must complete");
          phase = "result-parse";
          const result = JSON.parse(stdout) as ChildResult;
          parsed = true;
          phase = "helper-closure";
          assert.equal(
            result.helpersClosed,
            true,
            "Every owned helper must close before returning",
          );
          done(result);
        } catch {
          reject(failure());
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

async function snapshotFixture(home: string) {
  const entries: {
    path: string;
    ino: bigint;
    dev: bigint;
    size: bigint;
    nlink: bigint;
    directory: boolean;
    hash?: string;
  }[] = [];
  async function visit(relative: string): Promise<void> {
    const path = join(home, relative);
    const stats = await lstat(path, { bigint: true });
    assert.equal(stats.isSymbolicLink(), false);
    const directory = stats.isDirectory();
    assert.ok(directory || stats.isFile());
    entries.push({
      path: relative,
      ino: stats.ino,
      dev: stats.dev,
      size: stats.size,
      nlink: stats.nlink,
      directory,
      ...(directory
        ? {}
        : {
            hash: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          }),
    });
    if (directory)
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
  }
  await visit("");
  return entries;
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

  test("bootstrap failure diagnostics expose metadata but never child output", async () => {
    const home = await createFixture();
    await assert.rejects(run(home, "diagnostic-exit"), (error: unknown) => {
      assert.ok(error instanceof Error);
      const prefix = "Isolated bootstrap fixture failed; raw output withheld. ";
      assert.ok(error.message.startsWith(prefix));
      assert.equal(error.message.includes("private-output-sentinel"), false);
      assert.equal(error.message.includes("private-error-sentinel"), false);
      const metadata = JSON.parse(error.message.slice(prefix.length));
      assert.equal(metadata.phase, "stderr-check");
      assert.equal(metadata.exitCode, 9);
      assert.equal(metadata.exitSignal, "none");
      assert.equal(metadata.readyEvents, 0);
      assert.equal(metadata.stdoutBytes, Buffer.byteLength("private-output-sentinel"));
      assert.equal(metadata.stderrBytes, Buffer.byteLength("private-error-sentinel"));
      assert.equal(metadata.parsed, false);
      assert.ok(Number.isSafeInteger(metadata.elapsedMs) && metadata.elapsedMs >= 0);
      return true;
    });
  });

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

  for (const boundary of [
    "partial-write",
    "before-fsync",
    "after-close",
    "before-link",
    "readback",
    "readback-mismatch",
  ]) {
    test(`bootstrap injected ${boundary} error preserves identity and refuses readiness`, async () => {
      const home = await createFixture();
      const result = await run(home, `error-${boundary}`);
      const published = boundary.startsWith("readback");
      assert.deepEqual(result.boundaries, [boundary], "Fault must reach its exact boundary once");
      assert.equal(result.failed, true);
      assert.equal(result.result, undefined);
      assert.equal(
        result.message,
        "Local identity setup could not safely finish. Existing files were preserved.",
      );
      assert.equal(result.generated, 1);
      assert.equal(result.secretWrites, 1);
      assert.equal(result.publications, published ? 1 : 0);
      assert.equal(result.helperCount, 1);
      assert.equal(result.helpersClosed, true);
      assert.match(result.generatedPubkey ?? "", /^(02|03)[0-9a-f]{64}$/);
      assert.ok(result.writtenBytes > 0);
      if (boundary === "partial-write") {
        assert.equal(result.partialVerified, true);
        assert.ok(result.writtenBytes < result.encodedLength);
      } else assert.equal(result.writtenBytes, result.encodedLength);
      const directory = join(home, ".config", "atbash");
      const names = [
        ".onboarding-bootstrap-claim",
        ".onboarding-bootstrap-staging",
        ...(published ? ["guard-client-key"] : []),
      ];
      assert.deepEqual((await readdir(directory)).sort(), names);
      const snapshot = async () =>
        Promise.all(
          names.map(async (name) => {
            const file = join(directory, name);
            const stats = await lstat(file, { bigint: true });
            assert.equal(stats.isFile(), true);
            assert.equal(stats.isSymbolicLink(), false);
            return {
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
      assert.equal(before[0]!.nlink, 1n);
      assert.equal(before[0]!.size, 0n);
      assert.equal(before[1]!.nlink, published ? 2n : 1n);
      assert.equal(before[1]!.size, BigInt(result.writtenBytes));
      if (published) {
        assert.deepEqual(before[2], before[1]);
        const restart = await run(home, "read");
        assert.equal(restart.failed, false);
        assert.equal(restart.generated, 0);
        assert.equal(restart.result?.pubkey, result.generatedPubkey);
      } else await assert.rejects(lstat(join(directory, "guard-client-key")), { code: "ENOENT" });
      refused(await run(home));
      assert.deepEqual((await readdir(directory)).sort(), names);
      assert.deepEqual(await snapshot(), before);
    });
  }

  for (const kind of ["config", "legacy", "environment-key", "home"]) {
    for (const phase of ["before-generation", "before-publication", "after-publication"]) {
      test(`bootstrap ${kind} drift ${phase} preserves evidence and refuses readiness`, async () => {
        const home = await createFixture();
        const result = await run(home, `drift-${kind}-${phase}`);
        const generated = phase === "before-generation" ? 0 : 1;
        const published = phase === "after-publication";
        assert.deepEqual(result.boundaries, [`${kind}-${phase}`]);
        assert.equal(result.failed, true);
        assert.equal(result.result, undefined);
        assert.equal(
          result.message,
          "Local identity setup could not safely finish. Existing files were preserved.",
        );
        assert.equal(result.generated, generated);
        assert.equal(result.secretWrites, generated);
        assert.equal(result.publications, published ? 1 : 0);
        assert.equal(result.helperCount, 1);
        assert.equal(result.helpersClosed, true);
        const directory = join(home, ".config", "atbash");
        const injected =
          kind === "config" ? "config.json" : kind === "legacy" ? "atbash-client-key" : undefined;
        const names = [
          ".onboarding-bootstrap-claim",
          ".onboarding-bootstrap-staging",
          ...(published ? ["guard-client-key"] : []),
          ...(injected ? [injected] : []),
        ].sort();
        assert.deepEqual((await readdir(directory)).sort(), names);
        if (injected)
          assert.equal(
            await readFile(join(directory, injected), "utf8"),
            "concurrent public marker",
          );
        if (kind === "home") assert.deepEqual(await readdir(join(home, "drift-home")), []);
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
        const claim = before.find((file) => file.name === ".onboarding-bootstrap-claim")!;
        const stage = before.find((file) => file.name === ".onboarding-bootstrap-staging")!;
        assert.equal(claim.nlink, 1n);
        assert.equal(claim.size, 0n);
        assert.equal(stage.nlink, published ? 2n : 1n);
        assert.equal(stage.size, BigInt(result.writtenBytes));
        if (generated) {
          assert.ok(stage.size > 0n);
          assert.equal(result.writtenBytes, result.encodedLength);
        } else assert.equal(stage.size, 0n);
        if (published) {
          const canonical = before.find((file) => file.name === "guard-client-key")!;
          assert.equal(canonical.ino, stage.ino);
          assert.equal(canonical.dev, stage.dev);
          assert.equal(canonical.nlink, 2n);
          const restart = await run(home, "read");
          assert.equal(restart.failed, false);
          assert.equal(restart.generated, 0);
          assert.equal(restart.result?.pubkey, result.generatedPubkey);
        } else await assert.rejects(lstat(join(directory, "guard-client-key")), { code: "ENOENT" });
        // A new child uses original HOME and no injected environment key.
        refused(await run(home));
        assert.deepEqual((await readdir(directory)).sort(), names);
        assert.deepEqual(await snapshot(), before);
        if (kind === "home") assert.deepEqual(await readdir(join(home, "drift-home")), []);
      });
    }
  }

  for (const kind of ["claim", "stage"]) {
    for (const phase of ["before-generation", "before-publication"]) {
      test(`bootstrap ${kind} replacement ${phase} refuses the changed fixture state`, async () => {
        const home = await createFixture();
        const result = await run(home, `replace-${kind}-${phase}`);
        assert.equal(
          result.replacementFailure,
          undefined,
          "Directory/file injection must actually complete",
        );
        const generated = phase === "before-generation" ? 0 : 1;
        assert.deepEqual(result.boundaries, [`${kind}-${phase}`]);
        assert.equal(result.replacementVerified, true);
        assert.equal(result.failed, true);
        assert.equal(result.result, undefined);
        assert.equal(
          result.message,
          "Local identity setup could not safely finish. Existing files were preserved.",
        );
        assert.equal(result.generated, generated);
        assert.equal(result.secretWrites, generated);
        assert.equal(result.publications, 0);
        assert.equal(result.helperCount, 1);
        assert.equal(result.helpersClosed, true);
        const directory = join(home, ".config", "atbash");
        const target =
          kind === "directory"
            ? directory
            : join(
                directory,
                kind === "claim" ? ".onboarding-bootstrap-claim" : ".onboarding-bootstrap-staging",
              );
        const retained = await lstat(target + ".preserved", { bigint: true });
        const replacement = await lstat(target, { bigint: true });
        assert.equal(String(retained.ino), result.replacementOriginal?.ino);
        assert.equal(String(retained.dev), result.replacementOriginal?.dev);
        assert.notEqual(replacement.ino, retained.ino);
        if (kind !== "directory") {
          assert.equal(
            createHash("sha256")
              .update(await readFile(target))
              .digest("hex"),
            createHash("sha256")
              .update(await readFile(target + ".preserved"))
              .digest("hex"),
          );
        } else assert.deepEqual(await readdir(directory), []);
        const originalDirectory = kind === "directory" ? directory + ".preserved" : directory;
        const stage = await lstat(join(originalDirectory, ".onboarding-bootstrap-staging"), {
          bigint: true,
        });
        const claim = await lstat(join(originalDirectory, ".onboarding-bootstrap-claim"), {
          bigint: true,
        });
        assert.equal(stage.size, BigInt(result.writtenBytes));
        assert.equal(stage.nlink, 1n);
        assert.equal(claim.size, 0n);
        assert.equal(claim.nlink, 1n);
        await assert.rejects(lstat(join(directory, "guard-client-key")), { code: "ENOENT" });
        await assert.rejects(lstat(join(originalDirectory, "guard-client-key")), {
          code: "ENOENT",
        });
        const before = await snapshotFixture(home);
        refused(await run(home));
        assert.deepEqual(await snapshotFixture(home), before);
      });
    }
  }

  for (const phase of ["before-generation", "before-publication"]) {
    test(`bootstrap directory rename is refused by this Windows host ${phase} without disrupting creation`, async () => {
      const home = await createFixture();
      const result = await run(home, `rename-denied-${phase}`);
      assert.deepEqual(result.boundaries, [`directory-rename-denied-${phase}`]);
      assert.deepEqual(result.replacementFailure, { operation: "rename", code: "EPERM" });
      assert.equal(result.replacementVerified, false);
      assert.equal(result.failed, false);
      assert.equal(result.result?.state, "created");
      assert.equal(result.generated, 1);
      assert.equal(result.secretWrites, 1);
      assert.equal(result.publications, 1);
      assert.equal(result.helpersClosed, true);
      const directory = join(home, ".config", "atbash");
      const retained = await lstat(directory, { bigint: true });
      assert.equal(String(retained.ino), result.replacementOriginal?.ino);
      assert.equal(String(retained.dev), result.replacementOriginal?.dev);
      await assert.rejects(lstat(directory + ".preserved"), { code: "ENOENT" });
      assert.deepEqual((await readdir(directory)).sort(), [
        ".onboarding-bootstrap-claim",
        ".onboarding-bootstrap-staging",
        "guard-client-key",
      ]);
      const stage = await lstat(join(directory, ".onboarding-bootstrap-staging"), { bigint: true });
      const published = await lstat(join(directory, "guard-client-key"), { bigint: true });
      assert.equal(stage.ino, published.ino);
      assert.equal(stage.dev, published.dev);
      assert.equal(stage.nlink, 2n);
      assert.equal(published.nlink, 2n);
      const restart = await run(home, "read");
      assert.equal(restart.failed, false);
      assert.equal(restart.result?.pubkey, result.result?.pubkey);
      const before = await snapshotFixture(home);
      refused(await run(home));
      assert.deepEqual(await snapshotFixture(home), before);
    });
  }

  test("bootstrap actual directory replacement after pinning and before claim creation refuses readiness", async () => {
    const home = await createFixture();
    const result = await run(home, "replace-directory-before-claim");
    assert.equal(result.replacementFailure, undefined);
    assert.equal(result.replacementVerified, true);
    assert.ok(result.preClaimPinObserved);
    assert.deepEqual(result.preClaimPinObserved, result.replacementOriginal);
    assert.deepEqual(result.boundaries, ["directory-before-claim"]);
    refused(result);
    assert.equal(result.helperCount, 1);
    assert.equal(result.helpersClosed, true);
    const directory = join(home, ".config", "atbash");
    const original = await lstat(directory + ".preserved", { bigint: true });
    const replacement = await lstat(directory, { bigint: true });
    assert.equal(String(original.ino), result.replacementOriginal?.ino);
    assert.equal(String(original.dev), result.replacementOriginal?.dev);
    assert.notEqual(original.ino, replacement.ino);
    assert.deepEqual(await readdir(directory + ".preserved"), []);
    assert.deepEqual((await readdir(directory)).sort(), [
      ".onboarding-bootstrap-claim",
      ".onboarding-bootstrap-staging",
    ]);
    const before = await snapshotFixture(home);
    refused(await run(home));
    assert.deepEqual(await snapshotFixture(home), before);
  });

  for (const [mode, generated] of [
    ["acl-before-generation", 0],
    ["acl-before-write", 1],
  ] as const) {
    test(`bootstrap real ${mode} permission change refuses before secret writes`, async () => {
      const home = await createFixture();
      const stage = join(home, ".config", "atbash", ".onboarding-bootstrap-staging");
      let changed = 0;
      let descriptor = "";
      const result = await run(home, mode, (child) => {
        const before = readFixtureDescriptor(stage);
        addFixtureGrant(stage, "S-1-1-0");
        descriptor = readFixtureDescriptor(stage);
        assert.notEqual(descriptor, before, "Real stored ACL must change before bootstrap resumes");
        changed++;
        child.send("acl-applied");
      });
      assert.equal(changed, 1);
      assert.deepEqual(result.boundaries, [mode]);
      assert.equal(result.failed, true);
      assert.equal(result.result, undefined);
      assert.equal(
        result.message,
        "Local identity setup could not safely finish. Existing files were preserved.",
      );
      assert.equal(result.generated, generated);
      assert.equal(result.secretWrites, 0);
      assert.equal(result.publications, 0);
      assert.equal(result.helperCount, 1);
      assert.equal(result.helpersClosed, true);
      assert.equal((await lstat(stage)).size, 0);
      assert.deepEqual((await readdir(join(home, ".config", "atbash"))).sort(), [
        ".onboarding-bootstrap-claim",
        ".onboarding-bootstrap-staging",
      ]);
      assert.equal(readFixtureDescriptor(stage), descriptor);
      const before = await snapshotFixture(home);
      refused(await run(home));
      assert.deepEqual(await snapshotFixture(home), before);
      assert.equal(readFixtureDescriptor(stage), descriptor);
    });
  }

  for (const kind of ["claim", "stage"]) {
    for (const phase of ["before-generation", "before-publication"]) {
      test(`bootstrap extra ${kind} hardlink ${phase} refuses unexpected link count`, async () => {
        const home = await createFixture();
        const result = await run(home, `extra-link-${kind}-${phase}`);
        const generated = phase === "before-generation" ? 0 : 1;
        assert.deepEqual(result.boundaries, [`${kind}-${phase}`]);
        assert.equal(result.hardlinkVerified, true);
        assert.equal(result.failed, true);
        assert.equal(result.result, undefined);
        assert.equal(
          result.message,
          "Local identity setup could not safely finish. Existing files were preserved.",
        );
        assert.equal(result.generated, generated);
        assert.equal(result.secretWrites, generated);
        assert.equal(result.publications, 0);
        assert.equal(result.helperCount, 1);
        assert.equal(result.helpersClosed, true);
        const directory = join(home, ".config", "atbash");
        assert.deepEqual((await readdir(directory)).sort(), [
          ".onboarding-bootstrap-claim",
          ".onboarding-bootstrap-staging",
          `.onboarding-extra-${kind}`,
        ]);
        const target = join(
          directory,
          kind === "claim" ? ".onboarding-bootstrap-claim" : ".onboarding-bootstrap-staging",
        );
        const extra = join(directory, `.onboarding-extra-${kind}`);
        const original = await lstat(target, { bigint: true });
        const linked = await lstat(extra, { bigint: true });
        assert.equal(original.ino, linked.ino);
        assert.equal(original.dev, linked.dev);
        assert.equal(original.nlink, 2n);
        assert.equal(linked.nlink, 2n);
        assert.equal(
          createHash("sha256")
            .update(await readFile(target))
            .digest("hex"),
          createHash("sha256")
            .update(await readFile(extra))
            .digest("hex"),
        );
        const stage = await lstat(join(directory, ".onboarding-bootstrap-staging"), {
          bigint: true,
        });
        const claim = await lstat(join(directory, ".onboarding-bootstrap-claim"), { bigint: true });
        assert.equal(stage.size, BigInt(result.writtenBytes));
        assert.equal(claim.size, 0n);
        assert.equal(stage.nlink, kind === "stage" ? 2n : 1n);
        assert.equal(claim.nlink, kind === "claim" ? 2n : 1n);
        const before = await snapshotFixture(home);
        refused(await run(home));
        assert.deepEqual(await snapshotFixture(home), before);
      });
    }
  }

  for (const name of ["config.json", "guard-client-key", "atbash-client-key"]) {
    test(`bootstrap preserves dangling junction store ${name} without starting a helper`, async () => {
      const home = await createFixture();
      const directory = join(home, ".config", "atbash");
      await mkdir(directory, { recursive: true });
      const path = join(directory, name);
      const target = join(home, "absent-junction-target");
      await symlink(target, path, "junction");
      const before = await lstat(path, { bigint: true });
      const linkTarget = await readlink(path);
      assert.equal(before.isSymbolicLink(), true);
      await assert.rejects(stat(path), { code: "ENOENT" });
      await assert.rejects(lstat(target), { code: "ENOENT" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(home);
        refused(result);
        assert.equal(result.helperCount, 0);
        assert.deepEqual(result.boundaries, []);
        const after = await lstat(path, { bigint: true });
        assert.equal(after.isSymbolicLink(), true);
        assert.equal(after.ino, before.ino);
        assert.equal(after.dev, before.dev);
        assert.equal(after.size, before.size);
        assert.equal(after.nlink, before.nlink);
        assert.equal(await readlink(path), linkTarget);
        assert.deepEqual(await readdir(home), [".config"]);
        assert.deepEqual(await readdir(join(home, ".config")), ["atbash"]);
        assert.deepEqual(await readdir(directory), [name]);
        await assert.rejects(lstat(target), { code: "ENOENT" });
        await assert.rejects(stat(path), { code: "ENOENT" });
      }
    });
    for (const code of ["EACCES", "EIO"]) {
      test(`bootstrap refuses ${code} inspecting ${name} before any helper or mutation`, async () => {
        const home = await createFixture();
        const directory = join(home, ".config", "atbash");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, name), "existing public marker", { flag: "wx" });
        const before = await snapshotFixture(home);
        const result = await run(home, `metadata-${code}-${name}`);
        refused(result);
        assert.equal(result.helperCount, 0);
        assert.deepEqual(result.boundaries, [`${code}-${name}`]);
        assert.deepEqual(await snapshotFixture(home), before);
        const retry = await run(home);
        refused(retry);
        assert.equal(retry.helperCount, 0);
        assert.deepEqual(retry.boundaries, []);
        assert.deepEqual(await snapshotFixture(home), before);
      });
    }
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
