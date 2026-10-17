import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("SECURITY documents the remaining host-protocol permit paths", () => {
  const security = readFileSync("../../SECURITY.md", "utf8");

  assert.match(security, /## Host-protocol residuals/);
  assert.match(security, /deny JSON.*exit 0/);
  assert.match(security, /closed or unwritable stdout/);
  assert.match(security, /exit 2.*Claude Code.*blocks/);
  assert.match(security, /Codex 0\.154\.0.*measured on 2026-09-17/);
  assert.match(security, /exit 2.*permit/);
  assert.match(security, /exit 0 with empty stdout.*permit on both hosts/);
  assert.match(security, /synchronous native hang/);
  assert.match(security, /event loop.*deadline timer/);
  assert.match(security, /direct fd-1 writes/);
  assert.match(security, /unparseable stdout.*permit/);
  assert.match(security, /too-small pipe/);
  assert.match(security, /3584 serialized bytes/);
  assert.match(security, /host timeout.*permit/);
  assert.match(security, /abort or signal.*without running exit listeners.*permit on both hosts/);
  assert.match(security, /On POSIX.*exits 2.*permit/);
  assert.match(security, /In-process code.*permit/);
  assert.match(security, /host-protocol change.*not an in-hook fix/);
  assert.match(security, /host-boundary\.test\.ts/);
  assert.match(security, /does not close the Codex residual/);
});
