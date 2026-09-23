import { spawn } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, win32 } from "node:path";
import { trustedWindowsPowerShell } from "./windows-system-powershell.js";

const FAILURE = "A trusted system Google Chrome installation is required for pairing.";

function trustedPosixBinary(candidate: string): string {
  const actual = realpathSync.native(candidate);
  if (actual !== candidate) throw new Error(FAILURE);
  let current = candidate;
  while (true) {
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0)
      throw new Error(FAILURE);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!statSync(candidate).isFile()) throw new Error(FAILURE);
  return candidate;
}

function trustedWindowsBinary(candidate: string): string {
  const actual = realpathSync.native(candidate);
  const entry = lstatSync(candidate);
  if (
    !isAbsolute(actual) ||
    actual.toLowerCase() !== candidate.toLowerCase() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    !entry.isFile()
  )
    throw new Error(FAILURE);
  return actual;
}

function browserEnvironment(): NodeJS.ProcessEnv {
  const account = userInfo();
  if (process.platform === "win32") {
    const trusted = trustedWindowsPowerShell().env;
    return {
      SystemRoot: trusted.SystemRoot,
      windir: trusted.windir,
      USERPROFILE: trusted.USERPROFILE,
      LOCALAPPDATA: trusted.LOCALAPPDATA,
      APPDATA: trusted.APPDATA,
      TEMP: trusted.TEMP,
      TMP: trusted.TMP,
      HOMEDRIVE: trusted.HOMEDRIVE,
      HOMEPATH: trusted.HOMEPATH,
    };
  }
  const env: NodeJS.ProcessEnv = { HOME: account.homedir };
  if (process.platform === "linux") {
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    const runtime = `/run/user/${account.uid}`;
    if (display && /^:\d+(?:\.\d+)?$/.test(display)) env.DISPLAY = display;
    if (wayland && /^wayland-\d+$/.test(wayland)) env.WAYLAND_DISPLAY = wayland;
    try {
      const runtimeStat = statSync(runtime);
      if (
        realpathSync.native(runtime) === runtime &&
        runtimeStat.uid === account.uid &&
        (runtimeStat.mode & 0o077) === 0
      ) {
        env.XDG_RUNTIME_DIR = runtime;
        if (process.env.DBUS_SESSION_BUS_ADDRESS === `unix:path=${runtime}/bus`)
          env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
      }
    } catch {
      // A missing or untrusted runtime directory is never inherited.
    }
  }
  const lang = process.env.LANG;
  if (lang && /^[A-Za-z0-9_.@-]{1,64}$/.test(lang)) env.LANG = lang;
  return env;
}

export async function resolveDashboardBrowser(url: string): Promise<{
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}> {
  try {
    let executable: string;
    if (process.platform === "win32") {
      const windowsRoot = trustedWindowsPowerShell().env.SystemRoot;
      if (!windowsRoot) throw new Error(FAILURE);
      const drive = win32.parse(windowsRoot).root;
      const candidates = [
        win32.join(drive, "Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        win32.join(drive, "Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      ];
      executable = "";
      for (const candidate of candidates) {
        try {
          executable = trustedWindowsBinary(candidate);
          break;
        } catch {
          // Only fixed machine-install candidates are eligible.
        }
      }
    } else if (process.platform === "darwin") {
      executable = trustedPosixBinary(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );
    } else if (process.platform === "linux") {
      executable = "";
      for (const candidate of ["/opt/google/chrome/chrome", "/usr/lib/google-chrome/chrome"]) {
        try {
          executable = trustedPosixBinary(candidate);
          break;
        } catch {
          // Continue only to the next fixed system-install candidate.
        }
      }
    } else {
      throw new Error(FAILURE);
    }
    if (!executable || !isAbsolute(executable)) throw new Error(FAILURE);
    return { executable, args: [url], env: browserEnvironment() };
  } catch {
    throw new Error(FAILURE);
  }
}

export async function openDashboardBrowser(url: string): Promise<void> {
  const { executable, args, env } = await resolveDashboardBrowser(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("Could not open the Dashboard browser.")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
