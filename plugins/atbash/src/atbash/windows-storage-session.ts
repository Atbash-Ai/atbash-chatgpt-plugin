import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { WINDOWS_STORAGE_CHECKS } from "./windows-storage-security.js";

const FAILURE = "Windows private storage cannot be verified.";
const REQUEST_MS = 20_000;
const LIFETIME_MS = 60_000;
const CLEANUP_MS = 2_000;
const MAX_REQUEST = 16 * 1024;
const MAX_INPUT = 128 * 1024;
const MAX_RESPONSE = 256;
const MAX_OUTPUT = 2048;

// A deliberately canonical wire grammar rejects duplicate/unknown fields BEFORE
// ConvertFrom-Json can collapse them. Paths remain JSON string values, never code.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$clock = [Diagnostics.Stopwatch]::StartNew()
$session = $null
$next = 1
$totalInput = 0
$totalOutput = 0
$jsonString = '"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
$pattern = '\A\{"session":"[0-9a-f]{32}","sequence":[1-8],"operation":"(?:prepare-directory|verify-file|verify-storage)","path":' + $jsonString + '(?:,"files":\[' + $jsonString + '(?:,' + $jsonString + '){0,2}\])?\}\z'
$grammar = [Text.RegularExpressions.Regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant, [TimeSpan]::FromMilliseconds(100))
function CheckRequest($request) {
${WINDOWS_STORAGE_CHECKS}
}
try {
  while ($true) {
    $line = [Collections.Generic.List[byte]]::new()
    while ($true) {
      $byte = $inputStream.ReadByte()
      if ($byte -eq -1) {
        if ($line.Count -ne 0) { throw 'protocol' }
        exit 0
      }
      $totalInput++
      if ($totalInput -gt 131072 -or $clock.ElapsedMilliseconds -ge 60000) { throw 'protocol' }
      if ($byte -eq 10) { break }
      if ($line.Count -ge 16384) { throw 'protocol' }
      $line.Add([byte]$byte)
    }
    if ($next -gt 8 -or $line.Count -eq 0) { throw 'protocol' }
    $text = $utf8.GetString($line.ToArray())
    if (-not $grammar.IsMatch($text)) { throw 'protocol' }
    $wire = $text | ConvertFrom-Json
    if ($wire.sequence -ne $next) { throw 'protocol' }
    if ($null -eq $session) { $session = $wire.session }
    if (-not [string]::Equals($wire.session, $session, [StringComparison]::Ordinal)) { throw 'protocol' }
    $batch = [string]::Equals($wire.operation, 'verify-storage', [StringComparison]::Ordinal)
    $hasFiles = $wire.PSObject.Properties.Name -contains 'files'
    if ($batch -ne $hasFiles) { throw 'protocol' }
    $request = [pscustomobject]@{operation=$wire.operation; path=$wire.path}
    if ($batch) { $request | Add-Member NoteProperty files $wire.files }
    CheckRequest $request
    if ($clock.ElapsedMilliseconds -ge 60000) { throw 'protocol' }
    $reply = $utf8.GetBytes('{"session":"' + $session + '","sequence":' + $next + ',"ok":true}' + [char]10)
    $totalOutput += $reply.Length
    if ($reply.Length -gt 256 -or $totalOutput -gt 2048) { throw 'protocol' }
    $outputStream.Write($reply, 0, $reply.Length)
    $outputStream.Flush()
    $next++
  }
} catch {
  # An exit without a success reply is a failed check; no raw exception is sent.
  exit 1
} finally {
  $inputStream.Dispose()
  $outputStream.Dispose()
}
`;

interface Pending {
  sequence: number;
  deadline: number;
  written: boolean;
  received: boolean;
  scheduled: boolean;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Internal per-attempt transport. No credential, resolver override or test callback. */
export class WindowsStorageSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #session = randomBytes(16).toString("hex");
  readonly #deadline = performance.now() + LIFETIME_MS;
  readonly #lifetime: NodeJS.Timeout;
  readonly #closed: Promise<void>;
  #sequence = 0;
  #inputBytes = 0;
  #outputBytes = 0;
  #buffer: number[] = [];
  #pending: Pending | undefined;
  #failed = false;
  #finishing = false;
  #exited = false;
  #cleanExit = false;

  constructor() {
    const systemRoot = process.env.SystemRoot;
    if (
      arguments.length !== 0 ||
      process.platform !== "win32" ||
      !systemRoot ||
      !isAbsolute(systemRoot)
    )
      throw new Error(FAILURE);
    this.#child = spawn(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64"),
      ],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#lifetime = setTimeout(() => this.#poison(), LIFETIME_MS);
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#exited = true;
        this.#cleanExit = code === 0 && signal === null;
        if (!this.#finishing || this.#pending || this.#buffer.length || !this.#cleanExit)
          this.#poison();
        resolve();
      });
    });
    this.#child.once("error", () => this.#poison());
    this.#child.stdin.on("error", () => this.#poison());
    this.#child.stdout.on("error", () => this.#poison());
    this.#child.stderr.on("error", () => this.#poison());
    // Do not accumulate stderr at all, including exceptions containing paths.
    this.#child.stderr.on("data", () => this.#poison());
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#child.stdout.once("end", () => {
      if (!this.#finishing || this.#pending || this.#buffer.length) this.#poison();
    });
  }

  assertHealthy(): void {
    if (performance.now() >= this.#deadline) this.#poison();
    if (this.#failed || this.#exited || this.#finishing) throw new Error(FAILURE);
  }

  #poison(): void {
    this.#failed = true;
    clearTimeout(this.#lifetime);
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(FAILURE));
    }
    this.#buffer = [];
    this.#child.stdin.destroy();
    if (!this.#exited) this.#child.kill();
  }

  #receive(chunk: Buffer): void {
    if (this.#failed) return;
    this.#outputBytes += chunk.length;
    if (this.#outputBytes > MAX_OUTPUT || !this.#pending || this.#finishing) return this.#poison();
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!;
      if (this.#pending.received || this.#buffer.length >= MAX_RESPONSE) return this.#poison();
      if (byte !== 10) {
        this.#buffer.push(byte);
        continue;
      }
      // Success replies have one exact ASCII serialization. It also excludes
      // malformed UTF-8, duplicate keys, extra fields, whitespace and partial JSON.
      const expected = Buffer.from(
        JSON.stringify({ session: this.#session, sequence: this.#pending.sequence, ok: true }),
      );
      if (!Buffer.from(this.#buffer).equals(expected) || index !== chunk.length - 1)
        return this.#poison();
      this.#buffer = [];
      this.#pending.received = true;
      this.#settle();
    }
  }

  #settle(): void {
    const pending = this.#pending;
    if (!pending || !pending.written || !pending.received || pending.scheduled) return;
    pending.scheduled = true;
    setImmediate(() => {
      if (this.#pending !== pending) return;
      if (
        performance.now() >= pending.deadline ||
        performance.now() >= this.#deadline ||
        this.#failed
      )
        return this.#poison();
      clearTimeout(pending.timer);
      this.#pending = undefined;
      pending.resolve();
    });
  }

  async #request(
    operation: "prepare-directory" | "verify-file" | "verify-storage",
    path: string,
    files?: readonly string[],
  ): Promise<void> {
    this.assertHealthy();
    if (this.#pending || this.#sequence >= 8 || typeof path !== "string" || !isAbsolute(path)) {
      this.#poison();
      throw new Error(FAILURE);
    }
    if (
      operation === "verify-storage" &&
      (!Array.isArray(files) ||
        files.length < 1 ||
        files.length > 3 ||
        files.some((file) => typeof file !== "string"))
    ) {
      this.#poison();
      throw new Error(FAILURE);
    }
    const sequence = ++this.#sequence;
    const bytes = Buffer.from(
      JSON.stringify({
        session: this.#session,
        sequence,
        operation,
        path,
        ...(files === undefined ? {} : { files }),
      }) + "\n",
    );
    this.#inputBytes += bytes.length;
    if (bytes.length > MAX_REQUEST || this.#inputBytes > MAX_INPUT) {
      this.#poison();
      throw new Error(FAILURE);
    }
    await new Promise<void>((resolve, reject) => {
      const pending: Pending = {
        sequence,
        deadline: Math.min(performance.now() + REQUEST_MS, this.#deadline),
        written: false,
        received: false,
        scheduled: false,
        timer: setTimeout(
          () => this.#poison(),
          Math.min(REQUEST_MS, Math.max(0, this.#deadline - performance.now())),
        ),
        resolve,
        reject,
      };
      this.#pending = pending;
      this.#child.stdin.write(bytes, (error) => {
        if (error) return this.#poison();
        if (this.#pending !== pending) return;
        pending.written = true;
        this.#settle();
      });
    });
  }

  prepareDirectory(path: string): Promise<void> {
    return this.#request("prepare-directory", path);
  }
  verifyFile(path: string): Promise<void> {
    return this.#request("verify-file", path);
  }
  verifyStorage(path: string, files: readonly string[]): Promise<void> {
    return this.#request("verify-storage", path, files);
  }

  async #awaitExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.#poison();
            reject(new Error(FAILURE));
          }, CLEANUP_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async finish(): Promise<void> {
    this.assertHealthy();
    if (this.#pending) {
      this.#poison();
      throw new Error(FAILURE);
    }
    this.#finishing = true;
    this.#child.stdin.end();
    await this.#awaitExit();
    clearTimeout(this.#lifetime);
    if (this.#failed || !this.#cleanExit || performance.now() >= this.#deadline)
      throw new Error(FAILURE);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.#lifetime);
    if (!this.#exited) this.#poison();
    await this.#awaitExit();
  }
}
