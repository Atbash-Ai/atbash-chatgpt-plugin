import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { WindowsStorageSession } from "../src/atbash/windows-storage-session.js";
import {
  preparePrivateWindowsDirectory,
  preparePrivateWindowsFile,
} from "../src/atbash/windows-storage-security.js";
import { addFixtureGrant, createFixture, readFixtureDescriptor } from "./windows-acl-fixture.js";

function observe(t: TestContext) {
  const children: ChildProcess[] = [];
  let launch: Parameters<typeof childProcess.spawn> | undefined;
  const original = childProcess.spawn;
  const stub = t.mock.method(
    childProcess,
    "spawn",
    (...args: Parameters<typeof childProcess.spawn>) => {
      launch = args;
      const child = Reflect.apply(original, childProcess, args) as ChildProcess;
      children.push(child);
      return child;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
  return { children, launch: () => launch };
}

async function writePrivateFixture(path: string): Promise<void> {
  await writeFile(path, "", { flag: "wx" });
  preparePrivateWindowsFile(path);
  await writeFile(path, "public fixture", { flag: "r+" });
}

if (process.platform === "win32") {
  test("persistent ACL helper performs fresh real checks and exits after refusal", async (t) => {
    const observation = observe(t);
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    const session = new WindowsStorageSession();
    try {
      await session.prepareDirectory(directory);
      const file = join(directory, "marker");
      await writePrivateFixture(file);
      await session.verifyStorage(directory, [file]);
      addFixtureGrant(file, "S-1-1-0");
      const before = readFixtureDescriptor(file);
      await assert.rejects(session.verifyStorage(directory, [file]), /cannot be verified/);
      await assert.rejects(session.verifyFile(file), /cannot be verified/);
      assert.equal(readFixtureDescriptor(file), before);
    } finally {
      await session.dispose();
    }
    assert.equal(observation.children.length, 1);
    assert.ok(
      observation.children.every((child) => child.exitCode !== null || child.signalCode !== null),
    );
  });

  test("persistent ACL helper has a fixed request budget and never restarts", async (t) => {
    const observation = observe(t);
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    const session = new WindowsStorageSession();
    try {
      await session.prepareDirectory(directory);
      const file = join(directory, "marker");
      await writePrivateFixture(file);
      for (let index = 0; index < 7; index++) await session.verifyFile(file);
      await assert.rejects(session.verifyFile(file), /cannot be verified/);
      await assert.rejects(session.finish(), /cannot be verified/);
    } finally {
      await session.dispose();
    }
    assert.equal(observation.children.length, 1);
    assert.ok(
      observation.children.every((child) => child.exitCode !== null || child.signalCode !== null),
    );
  });

  test(
    "persistent ACL timeout closes a real owned helper with a stalled reply",
    { timeout: 35_000 },
    async (t) => {
      const observation = observe(t);
      const fixture = await createFixture();
      const directory = join(fixture, "private");
      const session = new WindowsStorageSession();
      try {
        await session.prepareDirectory(directory);
        const file = join(directory, "marker");
        await writePrivateFixture(file);
        await session.verifyFile(file);
        assert.equal(observation.children.length, 1);
        observation.children[0]!.stdout!.pause();
        const pending = assert.rejects(session.verifyFile(file), /cannot be verified/);
        // Exercise the real request deadline and OS process cleanup. Timer
        // virtualization is confined to the separate fake-process budget tests.
        await pending;
      } finally {
        await session.dispose();
      }
      assert.ok(
        observation.children.every((child) => child.exitCode !== null || child.signalCode !== null),
      );
    },
  );

  test("persistent ACL helper rejects malformed raw requests before touching paths", async (t) => {
    const observation = observe(t);
    const fixture = await createFixture();
    const directory = join(fixture, "private");
    preparePrivateWindowsDirectory(directory);
    const file = join(directory, "marker");
    await writePrivateFixture(file);
    const session = new WindowsStorageSession();
    await session.verifyFile(file);
    await session.finish();
    await session.dispose();
    const launch = observation.launch();
    assert.ok(launch);
    const request = JSON.stringify({
      session: "a".repeat(32),
      sequence: 1,
      operation: "verify-file",
      path: file,
    });
    const run = (input: string | Buffer) =>
      childProcess.spawnSync(launch[0], launch[1] as string[], {
        input,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2048,
      });
    const positive = run(request + "\n");
    assert.equal(positive.status, 0);
    assert.equal(positive.stderr, "");
    assert.deepEqual(JSON.parse(positive.stdout), {
      session: "a".repeat(32),
      sequence: 1,
      ok: true,
    });
    for (const input of [
      "\n",
      request,
      request.replace('"sequence":1', '"sequence":1,"sequence":1') + "\n",
      request.replace('"sequence":1', '"sequence":2') + "\n",
      request.replace('"verify-file"', '"VERIFY-FILE"') + "\n",
      request.slice(0, -1) + ',"extra":true}\n',
      Buffer.from([0xc3, 0x28, 10]),
      Buffer.alloc(16 * 1024 + 1, 65),
    ]) {
      const result = run(input);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const changedSession = request
      .replace("a".repeat(32), "b".repeat(32))
      .replace('"sequence":1', '"sequence":2');
    const changed = run(request + "\n" + changedSession + "\n");
    assert.equal(changed.status, 1);
    assert.equal(
      changed.stdout,
      positive.stdout,
      "Only the first valid request may receive a success",
    );
  });
}

class FixtureProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  ended = false;
  kills = 0;
  constructor(reply: (request: Record<string, unknown>, child: FixtureProcess) => void) {
    super();
    this.stdin.on("data", (bytes: Buffer) =>
      reply(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>, this),
    );
    this.stdin.on("finish", () => this.end(0, null));
  }
  end(code: number | null, signal: string | null) {
    if (this.ended) return;
    this.ended = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
  kill() {
    this.kills++;
    this.end(null, "SIGTERM");
    return true;
  }
}

function fakeSession(
  t: TestContext,
  reply: (request: Record<string, unknown>, child: FixtureProcess) => void,
) {
  const child = new FixtureProcess(reply);
  const stub = t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess);
  syncBuiltinESMExports();
  return {
    child,
    session: new WindowsStorageSession(),
    restore: () => {
      stub.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

if (process.platform === "win32") {
  test("persistent ACL cleanup failure never escapes as a signaling exception", async (t) => {
    const { session, child, restore } = fakeSession(t, () => {});
    const pending = assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    t.mock.method(child, "kill", () => {
      throw new Error("synthetic signaling failure");
    });
    try {
      assert.doesNotThrow(() => child.emit("error", new Error("public failure fixture")));
      await pending;
    } finally {
      child.end(1, null);
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await session.dispose();
      restore();
    }
  });

  test("persistent ACL cleanup failure poisons repeated errors only once", async (t) => {
    const { session, child, restore } = fakeSession(t, () => {});
    const pending = assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    let kills = 0;
    t.mock.method(child, "kill", () => {
      kills++;
      return false;
    });
    try {
      assert.doesNotThrow(() => {
        child.emit("error", new Error("public failure fixture"));
        child.emit("error", new Error("another public failure fixture"));
      });
      child.stderr.write("public stderr fixture");
      await pending;
      assert.equal(kills, 1);
    } finally {
      child.end(1, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await session.dispose();
      restore();
    }
  });

  test("persistent ACL cleanup failure consumes only one cleanup budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { session, child, restore } = fakeSession(t, (request, process) => {
      process.stdout.write(
        JSON.stringify({ session: request.session, sequence: request.sequence, ok: true }) + "\n",
      );
    });
    child.stdin.removeAllListeners("finish");
    t.mock.method(child, "kill", () => false);
    let disposal: Promise<void> | undefined;
    try {
      await session.verifyFile("C:\\public-fixture");
      const finishing = assert.rejects(session.finish(), /cannot be verified/);
      t.mock.timers.tick(2_000);
      await finishing;
      let refused = false;
      disposal = session.dispose().then(
        () => {
          assert.fail("Unconfirmed exit cannot succeed");
        },
        () => {
          refused = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(refused, true, "Dispose must reuse the already expired cleanup budget");
    } finally {
      t.mock.timers.tick(2_000);
      await disposal;
      child.end(1, null);
      restore();
    }
  });
  for (const phase of ["buffered reply", "next request"] as const) {
    test(`persistent ACL observed process exit cannot authorize ${phase}`, async (t) => {
      const { session, child, restore } = fakeSession(t, (request, process) => {
        if (phase === "buffered reply") process.emit("exit", 1, null);
        process.stdout.write(
          JSON.stringify({ session: request.session, sequence: request.sequence, ok: true }) + "\n",
        );
      });
      try {
        if (phase === "buffered reply") {
          await assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
        } else {
          await session.verifyFile("C:\\public-fixture");
          child.emit("exit", 0, null);
          await assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
        }
      } finally {
        // Model the later close separately: exit has already been delivered,
        // but this fake process does not automatically close with its pipes.
        child.end(1, null);
        await session.dispose();
        restore();
      }
    });
  }
  test("persistent ACL response parser refuses malformed and unsolicited transport data", async (t) => {
    for (const mode of [
      "valid",
      "wrong-session",
      "wrong-sequence",
      "duplicate-key",
      "extra-field",
      "extra-line",
      "partial",
      "utf8",
      "oversized",
      "stderr",
      "exit",
    ] as const) {
      const { session, child, restore } = fakeSession(t, (request, process) => {
        const valid = JSON.stringify({
          session: request.session,
          sequence: request.sequence,
          ok: true,
        });
        if (mode === "stderr") {
          process.stderr.write("public fixture");
          return;
        }
        if (mode === "exit") {
          process.end(0, null);
          return;
        }
        if (mode === "partial") {
          process.stdout.write(valid);
          process.end(0, null);
          return;
        }
        const text =
          mode === "wrong-session"
            ? valid.replace(String(request.session), "b".repeat(32))
            : mode === "wrong-sequence"
              ? valid.replace('"sequence":1', '"sequence":2')
              : mode === "duplicate-key"
                ? valid.replace('"ok":true', '"ok":false,"ok":true')
                : mode === "extra-field"
                  ? valid.slice(0, -1) + ',"extra":1}'
                  : mode === "extra-line"
                    ? valid + "\n" + valid
                    : valid;
        process.stdout.write(
          mode === "utf8"
            ? Buffer.from([0xc3, 0x28, 10])
            : mode === "oversized"
              ? Buffer.alloc(2049, 65)
              : text + "\n",
        );
      });
      try {
        if (mode === "valid") {
          await session.verifyFile("C:\\public-fixture");
          await session.finish();
        } else {
          await assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
          await assert.rejects(session.finish(), /cannot be verified/);
        }
      } finally {
        await session.dispose();
        restore();
      }
      assert.equal(child.ended, true);
    }
  });

  test("persistent ACL deadlines reject late replies and expired sessions", async (t) => {
    let now = performance.now();
    t.mock.method(performance, "now", () => now);
    const { session, child, restore } = fakeSession(t, (request, process) => {
      now += 20_001;
      process.stdout.write(
        JSON.stringify({ session: request.session, sequence: request.sequence, ok: true }) + "\n",
      );
    });
    await assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    await session.dispose();
    restore();
    assert.equal(child.ended, true);
    const other = fakeSession(t, () => assert.fail("Expired lifetime must refuse before writing"));
    now += 60_001;
    await assert.rejects(other.session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    await other.session.dispose();
    other.restore();
    assert.equal(other.child.ended, true);
  });

  test("persistent ACL transport permits only one request in flight", async (t) => {
    const { session, child, restore } = fakeSession(t, () => {});
    const first = assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    await assert.rejects(session.verifyFile("C:\\public-fixture"), /cannot be verified/);
    await first;
    await session.dispose();
    restore();
    assert.equal(child.ended, true);
  });
}
