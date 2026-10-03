import type { PreToolUseInput } from "./protocol.js";

/**
 * The shape of a model id, including provider-prefixed ids such as "openai/gpt-oss-120b". No
 * spaces, "=", ";" or line breaks, so a value cannot add a fact.
 */
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;

/**
 * The judge context is written to the public chain, so it carries only fixed facts about the
 * host. The working directory is never sent: a folder name can identify a client, and it is
 * free text a cloned repository controls. The model also comes from the host and can be
 * influenced by repository configuration, so it is sent only when it has the shape of a model
 * id and as "other" otherwise. The permission mode is already one of a closed set (protocol.ts).
 */
export function buildAtbashContext(input: PreToolUseInput): string {
  return [
    "source=codex",
    `model=${MODEL_ID.test(input.model) ? input.model : "other"}`,
    `permission_mode=${input.permission_mode}`,
  ].join("; ");
}
