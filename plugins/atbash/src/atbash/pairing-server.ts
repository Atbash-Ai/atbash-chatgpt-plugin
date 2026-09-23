import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  serializePublicIntent,
  verifyPairingIntent,
  type SignedPairingIntent,
  PAIRING_ORIGINS,
} from "./pairing-intent.js";

const ORIGINS: ReadonlySet<string> = new Set(PAIRING_ORIGINS);
const CAPABILITY_HEADER = "x-atbash-pairing";
const REQUEST_HEADERS = ["content-type", CAPABILITY_HEADER];
const MAX_LIFETIME_MS = 5 * 60_000;

/** Transport only: verification must read pinned chain state independently.
 * A browser callback, or delivery of the intent, never establishes readiness.
 * The caller supplies PUBLIC, already signed intent bytes; no signing API is exposed.
 */
export async function startPairingServer(options: {
  origin: string;
  publicIntent: SignedPairingIntent;
  expiresAt: number;
  verify: (signal: AbortSignal) => Promise<boolean>;
}) {
  if (!ORIGINS.has(options.origin)) throw new Error("Unsupported pairing origin.");
  if (
    !verifyPairingIntent(options.publicIntent) ||
    options.publicIntent.intent.origin !== options.origin ||
    options.publicIntent.intent.expiresAt !== options.expiresAt
  )
    throw new Error("Invalid signed pairing intent.");
  const lifetime = options.expiresAt - Date.now();
  if (!Number.isSafeInteger(options.expiresAt) || lifetime <= 0 || lifetime > MAX_LIFETIME_MS) {
    throw new Error("Invalid pairing lifetime.");
  }
  // Serialize once: browser requests cannot change the local expectations.
  const intent = serializePublicIntent(options.publicIntent);
  if (Buffer.byteLength(intent) > 32_768) throw new Error("Pairing intent is too large.");
  const capability = randomBytes(32).toString("hex");
  let host = "";
  let verifying = false;
  let verified = false;
  let closed = false;
  let verification: AbortController | undefined;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Connection: "close",
      });
      res.end(body);
    };
    // Reject duplicate security headers rather than accepting Node's join rules.
    const count = (name: string) =>
      req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
        .length;
    if (
      count("host") !== 1 ||
      count("origin") !== 1 ||
      req.headers.host !== host ||
      req.headers.origin !== options.origin
    ) {
      reply(403, '{"error":"forbidden"}');
      return;
    }
    if (Date.now() >= options.expiresAt) {
      reply(410, '{"error":"expired"}');
      return;
    }
    if (req.url !== "/intent" && req.url !== "/verify") {
      reply(404, '{"error":"not_found"}');
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", options.origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      const requested = String(req.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .sort();
      if (
        req.headers["access-control-request-method"] !== "POST" ||
        requested.join(",") !== REQUEST_HEADERS.join(",")
      ) {
        reply(403, '{"error":"forbidden"}');
        return;
      }
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader("Access-Control-Allow-Headers", REQUEST_HEADERS.join(", "));
      reply(204, "");
      return;
    }
    const provided = req.headers[CAPABILITY_HEADER];
    if (
      req.method !== "POST" ||
      count(CAPABILITY_HEADER) !== 1 ||
      typeof provided !== "string" ||
      !/^[a-f0-9]{64}$/.test(provided) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(capability)) ||
      count("content-type") !== 1 ||
      req.headers["content-type"] !== "application/json"
    ) {
      reply(403, '{"error":"forbidden"}');
      return;
    }
    // No caller-controlled enrollment fields, filenames or signing payloads.
    let body = "";
    try {
      for await (const chunk of req) {
        body += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(body) > 2) {
          reply(413, '{"error":"body_too_large"}');
          return;
        }
      }
    } catch {
      res.destroy();
      return;
    }
    if (body !== "{}") {
      reply(400, '{"error":"invalid_body"}');
      return;
    }
    if (verified) {
      // Recover a lost success response without repeating verification or any
      // activation. The token cannot request another enrollment intent.
      reply(
        req.url === "/verify" ? 200 : 410,
        req.url === "/verify" ? '{"verified":true}' : '{"error":"consumed"}',
      );
      return;
    }
    if (req.url === "/intent") {
      reply(200, intent);
      return;
    }
    if (verifying) {
      reply(409, '{"error":"verification_in_progress"}');
      return;
    }
    verifying = true;
    const controller = new AbortController();
    verification = controller;
    req.socket.setTimeout(21_000);
    const deadline = setTimeout(() => controller.abort(), 20_000);
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Verification cancelled."));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([options.verify(controller.signal), cancelled]);
      if (closed || controller.signal.aborted || Date.now() >= options.expiresAt) {
        reply(410, '{"error":"expired"}');
        return;
      }
      verified = result === true;
      reply(verified ? 200 : 409, JSON.stringify({ verified }));
    } catch {
      reply(503, '{"error":"verification_unavailable"}');
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onAbort);
      verification = undefined;
      verifying = false;
    }
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 20;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    closed = true;
    verification?.abort();
    server.closeAllConnections();
    server.close();
    clearTimeout(expiry);
  };
  const expiry = setTimeout(close, lifetime);
  expiry.unref();
  return { endpoint: `http://${host}`, capability, close };
}
