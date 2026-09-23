import { lstatSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
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
    const systemModules = `${dirname(executable)}\\Modules`;
    if (!statSync(systemModules).isDirectory()) throw new Error(FAILURE);
    // Windows PowerShell prepends AllUsers modules when PSModulePath exactly
    // equals its system Modules path. The equivalent trailing \\. prevents that
    // rewrite while keeping command discovery within the trusted directory.
    const modulePath = `${systemModules}\\.`;
    // Windows PowerShell reads its module-analysis cache from LOCALAPPDATA.
    // Keep that one cache location only when it is the existing canonical
    // local-drive AppData directory, never an inherited arbitrary path.
    const candidate = process.env.LOCALAPPDATA;
    if (!candidate || !/^[A-Za-z]:\\/.test(candidate) || !/\\AppData\\Local\\?$/i.test(candidate))
      throw new Error(FAILURE);
    const localAppData = realpathSync.native(candidate);
    const account = userInfo();
    const accountProfile = realpathSync.native(account.homedir);
    if (
      !/^[A-Za-z]:\\/.test(localAppData) ||
      !/\\AppData\\Local$/i.test(localAppData) ||
      localAppData.toLowerCase() !== win32.normalize(candidate).replace(/\\$/, "").toLowerCase() ||
      localAppData.toLowerCase() !== win32.join(accountProfile, "AppData", "Local").toLowerCase() ||
      lstatSync(candidate).isSymbolicLink() ||
      !statSync(localAppData).isDirectory()
    )
      throw new Error(FAILURE);
    const roaming = win32.join(accountProfile, "AppData", "Roaming");
    const temp = win32.join(localAppData, "Temp");
    if (!statSync(roaming).isDirectory() || !statSync(temp).isDirectory()) throw new Error(FAILURE);
    const homeDrive = win32.parse(accountProfile).root.slice(0, 2);
    const homePath = accountProfile.slice(homeDrive.length);
    return {
      executable,
      // PowerShell hosts the CLR. Inheriting COR_*, CORECLR_* or PSModulePath
      // would let caller-controlled environment state load code into the ACL
      // verifier. Profile and temp locations below are derived from the OS
      // account, never from inherited environment variables.
      env: {
        SystemRoot: systemRoot,
        windir: systemRoot,
        PSModulePath: modulePath,
        LOCALAPPDATA: localAppData,
        APPDATA: roaming,
        TEMP: temp,
        TMP: temp,
        USERPROFILE: accountProfile,
        HOMEDRIVE: homeDrive,
        HOMEPATH: homePath,
        USERNAME: account.username,
      },
    };
  } catch {
    // No PATH, SystemRoot or other attacker-supplied fallback is safe here.
    throw new Error(FAILURE);
  }
}
