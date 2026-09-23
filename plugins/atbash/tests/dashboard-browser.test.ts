import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import test from "node:test";
import { openDashboardBrowser, resolveDashboardBrowser } from "../src/atbash/dashboard-browser.js";

async function waitFor(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("pairing rejects an environment-selected browser executable", async () => {
  if (process.platform === "darwin") {
    try {
      const selected = await resolveDashboardBrowser("https://dashboard.atbash.ai/pair");
      assert.equal(
        selected.executable,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );
    } catch (error) {
      assert.match(String(error), /trusted system Google Chrome installation/);
    }
    return;
  }
  if (process.platform !== "win32" && process.platform !== "linux") {
    await assert.rejects(resolveDashboardBrowser("https://dashboard.atbash.ai/pair"));
    return;
  }
  const fixture = await mkdtemp(join(tmpdir(), "atbash-browser-poison-"));
  const tempRoot = await realpath(tmpdir());
  const fixtureRoot = await realpath(fixture);
  assert.ok(
    fixtureRoot.toLowerCase().startsWith((tempRoot + sep).toLowerCase()),
    "fixture must stay within the temporary root",
  );
  const marker = join(fixture, "captured-browser-argument");
  const syntheticUrl = "https://dashboard.atbash.ai/pair#token=synthetic-test-capability";
  const original = {
    ProgramFiles: process.env.ProgramFiles,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PAIRING_BROWSER_CAPTURE: process.env.PAIRING_BROWSER_CAPTURE,
  };
  let fakeExecutable: string;
  try {
    if (process.platform === "win32") {
      fakeExecutable = join(fixture, "Google", "Chrome", "Application", "chrome.exe");
      await mkdir(join(fixture, "Google", "Chrome", "Application"), { recursive: true });
      await copyFile(process.execPath, fakeExecutable);
      const preload = join(fixture, "capture.cjs");
      await writeFile(
        preload,
        "require('node:fs').writeFileSync(process.env.PAIRING_BROWSER_CAPTURE, process.argv.join(' '));",
      );
      process.env.ProgramFiles = fixture;
      process.env.NODE_OPTIONS = `--require=${preload}`;
    } else {
      fakeExecutable = join(fixture, "google-chrome");
      await writeFile(
        fakeExecutable,
        '#!/bin/sh\nprintf \'%s\' "$1" > "$PAIRING_BROWSER_CAPTURE"\n',
      );
      await chmod(fakeExecutable, 0o755);
      process.env.PATH = `${fixture}${delimiter}${original.PATH ?? ""}`;
    }
    process.env.PAIRING_BROWSER_CAPTURE = marker;
    let selected: Awaited<ReturnType<typeof resolveDashboardBrowser>> | undefined;
    try {
      selected = await resolveDashboardBrowser(syntheticUrl);
    } catch (error) {
      assert.match(String(error), /trusted system Google Chrome installation/);
    }
    if (selected && (!isAbsolute(selected.executable) || selected.executable === fakeExecutable)) {
      // Exercise the old vulnerable launch through a real child process. The
      // fixed resolver never reaches this branch or a user-facing browser.
      await openDashboardBrowser(syntheticUrl);
      assert.equal(await waitFor(marker), true, "the poisoned executable ran");
    }
    assert.ok(!selected || isAbsolute(selected.executable));
    assert.notEqual(selected?.executable, fakeExecutable);
    assert.equal(existsSync(marker), false, "the capability never reached the poisoned browser");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pairing browser child environment excludes loader and profiler hooks", async () => {
  try {
    const selected = await resolveDashboardBrowser("https://dashboard.atbash.ai/pair");
    const childEnvironment = (selected as { env?: NodeJS.ProcessEnv }).env;
    assert.ok(childEnvironment, "browser launch must use an explicit child environment");
    assert.equal(childEnvironment.PATH, undefined);
    assert.equal(childEnvironment.LD_PRELOAD, undefined);
    assert.equal(childEnvironment.BASH_ENV, undefined);
    assert.equal(childEnvironment.NODE_OPTIONS, undefined);
    assert.equal(childEnvironment.COR_ENABLE_PROFILING, undefined);
    assert.equal(childEnvironment.DYLD_INSERT_LIBRARIES, undefined);
  } catch (error) {
    assert.match(String(error), /trusted system Google Chrome installation/);
  }
});
