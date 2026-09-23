// Test-only process boundary. SDK parsing, resolution, native key loading and
// the packaged CLI remain real. No user configuration or key file is opened.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const childProcess = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const fixtureRoot = process.env.PAIR_TEST_ROOT;
if (!fixtureRoot || !process.env.ATBASH_AGENT_KEY) throw Error("Missing isolated fixture");
const nativeHome = os.homedir();
const configRoot = path.join(process.env.HOME || nativeHome, ".config", "atbash");
const fixtureConfig = path.join(fixtureRoot, ".config", "atbash", "config.json");
const tracePath = path.join(fixtureRoot, "trace.json");
const writeTrace = fs.writeFileSync.bind(fs);
const trace = { configReads: 0, blockedAccess: 0, browser: 0, server: 0, network: 0, queries: [] };
const normalize = (value) => {
  const p =
    value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  return typeof p === "string" ? path.resolve(p).toLowerCase() : "";
};
const protectedRoots = [configRoot, path.join(nativeHome, ".config", "atbash")].map(normalize);
const sourceConfig = normalize(path.join(configRoot, "config.json"));
function protect(value, canReadConfig = false) {
  const p = normalize(value);
  if (canReadConfig && (p === sourceConfig || p === normalize(fixtureConfig))) {
    trace.configReads++;
    return fixtureConfig;
  }
  if (protectedRoots.some((root) => p === root || p.startsWith(root + path.sep))) {
    trace.blockedAccess++;
    throw Error("Real Atbash storage access prohibited by test");
  }
  return value;
}
for (const method of [
  "existsSync",
  "readFileSync",
  "openSync",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "statSync",
  "lstatSync",
  "realpathSync",
  "unlinkSync",
  "rmSync",
  "chmodSync",
  "readdirSync",
]) {
  const original = fs[method].bind(fs);
  fs[method] = (file, ...args) =>
    original(protect(file, method === "existsSync" || method === "readFileSync"), ...args);
}
for (const method of [
  "readFile",
  "open",
  "writeFile",
  "appendFile",
  "mkdir",
  "stat",
  "lstat",
  "realpath",
  "unlink",
  "rm",
  "rmdir",
  "chmod",
  "readdir",
  "access",
]) {
  for (const api of [fs, fsp]) {
    const original = api[method].bind(api);
    api[method] = (file, ...args) => original(protect(file), ...args);
  }
}
for (const api of [fs, fsp]) {
  const original = api.rename.bind(api);
  api.rename = (from, to, ...args) => original(protect(from), protect(to), ...args);
}
os.homedir = () => fixtureRoot;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => {
    trace.browser++;
    throw Error("Process launch prohibited by test");
  };
}
net.Server.prototype.listen = () => {
  trace.server++;
  throw Error("Server launch prohibited by test");
};
net.Socket.prototype.connect = () => {
  trace.network++;
  throw Error("Network prohibited by test");
};
for (const api of [http, https]) {
  api.request = api.get = () => {
    trace.network++;
    throw Error("Network prohibited by test");
  };
}
syncBuiltinESMExports();
process.on("exit", () => writeTrace(tracePath, JSON.stringify(trace)));
globalThis.fetch = async () => {
  trace.network++;
  throw Error("No network request is permitted before owner authorization");
};
