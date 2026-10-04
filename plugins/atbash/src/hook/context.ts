import { basename } from "node:path";

import type { CallOrigin } from "./call-origin.js";
import type { PreToolUseInput } from "./protocol.js";

/** Placeholder until the rule exists (red commit): the sentence is defined, never added yet. */
export const CALL_ORIGIN_TOOL_OUTPUT =
  "call_origin=tool_output (the instruction for this call appeared in a tool output, not in the user request)";

export function buildAtbashContext(input: PreToolUseInput, origin: CallOrigin = "unknown"): string {
  void origin;
  return [
    "source=codex",
    `workspace=${basename(input.cwd) || "unknown"}`,
    `model=${input.model}`,
    `permission_mode=${input.permission_mode}`,
  ].join("; ");
}
