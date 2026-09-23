import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const FAILURE = "Windows private storage cannot be verified.";
// GLOBALROOT starts at the Windows object-manager root. Environment variables
// such as SystemRoot must not choose the executable that decides private ACLs.
const SYSTEM_POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

export function trustedWindowsPowerShell(): {
  executable: string;
  env: NodeJS.ProcessEnv;
} {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error(FAILURE);
  try {
    const executable = realpathSync.native(SYSTEM_POWERSHELL);
    if (
      !isAbsolute(executable) ||
      !/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(executable) ||
      !statSync(executable).isFile()
    )
      throw new Error(FAILURE);
    const systemRoot = dirname(dirname(dirname(dirname(executable))));
    if (!/^[A-Za-z]:\\/.test(systemRoot)) throw new Error(FAILURE);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(systemroot|windir)$/i.test(name)),
    );
    return {
      executable,
      env: { ...env, SystemRoot: systemRoot, windir: systemRoot },
    };
  } catch {
    // No PATH, SystemRoot or other attacker-supplied fallback is safe here.
    throw new Error(FAILURE);
  }
}
