import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function resolveDashboardBrowser(url: string): Promise<{
  executable: string;
  args: string[];
}> {
  let executable = "google-chrome";
  let args = [url];
  if (process.platform === "win32") {
    const candidates = [
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
    executable = "";
    for (const candidate of candidates) {
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {
        /* Try next conventional install. */
      }
    }
    if (!executable) throw new Error("Google Chrome is required for this pairing preview.");
  } else if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    args = ["-a", "Google Chrome", url];
  }
  return { executable, args };
}

export async function openDashboardBrowser(url: string): Promise<void> {
  const { executable, args } = await resolveDashboardBrowser(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not open the Dashboard browser.")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
