import type { CallOrigin } from "./call-origin.js";
import type { PreToolUseInput } from "./protocol.js";

/**
 * The fact sent when the call's instruction appears to come from tool output. A fixed sentence,
 * identical to the Claude Code plugin's: no transcript text ever leaves the machine. "unknown" adds
 * nothing, so the context is unchanged.
 */
export const CALL_ORIGIN_TOOL_OUTPUT =
  "call_origin=tool_output (the instruction for this call appeared in a tool output, not in the user request)";

/**
 * The shape of a model id, including provider-prefixed ids such as "openai/gpt-oss-120b". No
 * spaces, "=", ";" or line breaks, so a value cannot add a fact.
 */
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;

/** A 12-digit AWS account id inside an ARN (Bedrock inference profiles) identifies the customer. */
const AWS_ACCOUNT_IN_ARN = /:\d{12}:/g;

/** The model as sent: model-id shaped values pass with any AWS account id masked; others are "other". */
function checkedModel(model: string): string {
  return MODEL_ID.test(model) ? model.replace(AWS_ACCOUNT_IN_ARN, ":account:") : "other";
}

/**
 * The judge context is written to the public chain, so it carries only fixed facts about the
 * host. The working directory is never sent: a folder name can identify a client, and it is
 * free text a cloned repository controls. The model also comes from the host and can be
 * influenced by repository configuration, so it is sent only when it has the shape of a model
 * id (with any AWS account id in an ARN masked) and as "other" otherwise. The permission mode
 * is already one of a closed set (protocol.ts).
 */
export function buildAtbashContext(input: PreToolUseInput, origin: CallOrigin = "unknown"): string {
  const parts = [
    "source=codex",
    `model=${checkedModel(input.model)}`,
    `permission_mode=${input.permission_mode}`,
  ];
  if (origin === "tool_output") {
    parts.push(CALL_ORIGIN_TOOL_OUTPUT);
  }
  return parts.join("; ");
}
