import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, win32 } from "node:path";

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
    const modulePath = `${dirname(executable)}\\Modules`;
    if (!statSync(modulePath).isDirectory()) throw new Error(FAILURE);
    // Windows PowerShell reads its module-analysis cache from LOCALAPPDATA.
    // Keep that one cache location only when it is the existing canonical
    // local-drive AppData directory, never an inherited arbitrary path.
    const candidate = process.env.LOCALAPPDATA;
    if (!candidate || !/^[A-Za-z]:\\/.test(candidate) || !/\\AppData\\Local\\?$/i.test(candidate))
      throw new Error(FAILURE);
    const localAppData = realpathSync.native(candidate);
    if (
      !/^[A-Za-z]:\\/.test(localAppData) ||
      !/\\AppData\\Local$/i.test(localAppData) ||
      localAppData.toLowerCase() !== win32.normalize(candidate).replace(/\\$/, "").toLowerCase() ||
      lstatSync(candidate).isSymbolicLink() ||
      !statSync(localAppData).isDirectory()
    )
      throw new Error(FAILURE);
    return {
      executable,
      // PowerShell hosts the CLR. Inheriting COR_*, CORECLR_* or PSModulePath
      // would let caller-controlled environment state load code into the ACL
      // verifier. Its encoded command needs only the trusted Windows root.
      env: {
        SystemRoot: systemRoot,
        windir: systemRoot,
        PSModulePath: modulePath,
        LOCALAPPDATA: localAppData,
      },
    };
  } catch {
    // No PATH, SystemRoot or other attacker-supplied fallback is safe here.
    throw new Error(FAILURE);
  }
}
