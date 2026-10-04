// Turns real Codex rollout lines into a fixture that keeps their STRUCTURE and nothing else.
//
//   node scrub-codex-rollout.mjs <rollout.jsonl> <line numbers, e.g. 1-7,10,34-35> > fixture.jsonl
//
// Every key, nesting level, item type, role and Codex harness marker (the `<tag>` blocks, the
// "# AGENTS.md instructions" and "# Response annotations" headings, the agent-message header) is
// kept. Every other string is replaced by a marker word naming what the text IS, so a test can check
// where each kind of text ends up without any real content in the repository:
//
//   userword       what the user typed                 harnessword  text inside a harness block
//   quotedword     text an annotation quotes from an   harnessnote  Codex's own note above the
//                  earlier agent response                           annotations
//   relayword      a word in a parent agent's relayed  toolword     tool output
//                  task header                         assistantword / developerword / reasoningword
//
// Ids, paths, timestamps, hashes, instructions and encrypted payloads are replaced with fixed
// values. Long arrays keep their first few items. Review the output before committing it.

import { readFileSync } from "node:fs";
import process from "node:process";

const [input, selector] = process.argv.slice(2);
if (!input || !selector) {
  process.stderr.write("usage: node scrub-codex-rollout.mjs <rollout.jsonl> <lines>\n");
  process.exit(2);
}
const wanted = new Set();
for (const part of selector.split(",")) {
  const [a, b] = part.split("-").map(Number);
  for (let n = a; n <= (b ?? a); n++) wanted.add(n);
}

const KEEP_KEYS = new Set(["type", "role"]);
const TOOL_NAMES = new Set([
  "exec",
  "apply_patch",
  "send_message",
  "spawn_agent",
  "wait_agent",
  "shell",
]);
const MAX_ITEMS = 4;
const ZERO_ID = "00000000-0000-4000-8000-000000000000";

/** Any value with every string replaced: the generic fallback for metadata. */
function scrubValue(value, key) {
  if (key === "create_time" && typeof value === "number") return 1790000000;
  if (typeof value === "string") {
    if (KEEP_KEYS.has(key)) return value;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return ZERO_ID;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "2026-10-04T00:00:00.000Z";
    return "scrubbed";
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => scrubValue(v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, k)]));
  }
  return value;
}

/** Blocks whose inner text is page content the agent read, not harness text. */
const PAGE_BLOCKS = new Set(["in-app-browser-context", "external_codex_apps_open_page"]);

/**
 * A harness block: its opening and closing tags (attributes kept) around one marker word. A
 * question reply keeps its JSON shape: the agent's question becomes quotedword, the user's answer
 * userword.
 */
function scrubHarness(text) {
  const open = text.match(/^\s*<([a-zA-Z_][\w-]*)([^>]*)>/);
  if (!open) return "<scrubbed_block>\nharnessword\n</scrubbed_block>";
  const tag = open[1];
  const attrs = open[2].replace(/"[^"]*"/g, (m) => (/^"[a-z_-]+"$/.test(m) ? m : '"scrubbed"'));
  let inner = PAGE_BLOCKS.has(tag) ? "pageword" : "harnessword";
  if (tag === "send_user_message_question_reply") {
    try {
      const body = text.slice(text.indexOf(">") + 1, text.lastIndexOf(`</${tag}>`)).trim();
      inner = JSON.stringify(
        JSON.parse(body)
          .slice(0, MAX_ITEMS)
          .map((item) =>
            Object.fromEntries(
              Object.entries(item ?? {}).map(([k, v]) => [
                k,
                k === "question" ? "quotedword" : k === "answer" ? "userword" : scrubValue(v, k),
              ]),
            ),
          ),
      );
    } catch {
      inner = "harnessword";
    }
  }
  return `<${tag}${attrs}>\n${inner}\n</${tag}>`;
}

/** A "Response annotations" message: Codex's note, the quoted items, then the user's request. */
function scrubAnnotations(text) {
  const open = text.indexOf("<response-annotations>");
  const close = text.lastIndexOf("</response-annotations>");
  let items;
  try {
    items = JSON.parse(text.slice(open + "<response-annotations>".length, close));
  } catch {
    items = [{}];
  }
  const scrubbed = items.slice(0, MAX_ITEMS).map((item) => {
    const out = {};
    for (const [k, v] of Object.entries(item ?? {})) {
      if (k === "text") out.text = "quotedword quotedword";
      else if (k === "comment") out.comment = "userword";
      else out[k] = scrubValue(v, k);
    }
    return out;
  });
  const heading = text.slice(close).match(/^<\/response-annotations>\s*(## [^\n]*\n)?/);
  return (
    "\n# Response annotations:\nharnessnote harnessnote\n<response-annotations>\n" +
    JSON.stringify(scrubbed) +
    "\n</response-annotations>\n\n" +
    (heading?.[1] ?? "") +
    "userword userword\n"
  );
}

/** One text part of a user-role message, by what Codex put there. */
function scrubUserText(text) {
  const head = text.slice(0, 256).trimStart();
  if (head.startsWith("# Response annotations")) return scrubAnnotations(text);
  if (head.startsWith("# AGENTS.md instructions"))
    return "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nharnessword\n</INSTRUCTIONS>";
  if (head.startsWith("<")) return scrubHarness(text);
  return "userword userword";
}

function scrubParts(content, word, user = false) {
  if (typeof content === "string") return user ? scrubUserText(content) : word;
  if (!Array.isArray(content)) return scrubValue(content);
  return content.slice(0, MAX_ITEMS).map((part) => {
    if (part === null || typeof part !== "object") return word;
    const out = {};
    for (const [k, v] of Object.entries(part)) {
      if (k === "text" && typeof v === "string") out.text = user ? scrubUserText(v) : word;
      else if (k === "encrypted_content") out.encrypted_content = "ENCRYPTED";
      else out[k] = scrubValue(v, k);
    }
    return out;
  });
}

/** A parent agent's relayed task: the real header lines, a scrubbed task name, no payload text. */
function scrubAgentMessage(item) {
  const out = scrubValue(item);
  out.content = (item.content ?? []).slice(0, MAX_ITEMS).map((part) => {
    if (part?.encrypted_content !== undefined)
      return { type: part.type, encrypted_content: "ENCRYPTED" };
    if (typeof part?.text === "string") {
      const labels = [...part.text.matchAll(/^([A-Z][A-Za-z ]+):/gm)].map((m) => m[1]);
      const lines = labels.map((label) =>
        label === "Message Type"
          ? "Message Type: NEW_TASK"
          : label === "Task name"
            ? "Task name: /root/relayword_task"
            : label === "Sender"
              ? "Sender: /root"
              : `${label}:`,
      );
      return { type: part.type, text: `${lines.join("\n")}\n` };
    }
    return scrubValue(part);
  });
  return out;
}

/** One response item (also used for compacted history items). */
function scrubItem(item) {
  if (item === null || typeof item !== "object") return scrubValue(item);
  const t = item.type;
  if (t === "message") {
    const word =
      item.role === "assistant"
        ? "assistantword"
        : item.role === "developer"
          ? "developerword"
          : "userword";
    return { ...scrubValue(item), content: scrubParts(item.content, word, item.role === "user") };
  }
  if (t === "agent_message") return scrubAgentMessage(item);
  if (t === "reasoning") {
    const out = scrubValue(item);
    if (Array.isArray(item.summary)) out.summary = scrubParts(item.summary, "reasoningword");
    if (item.encrypted_content !== undefined) out.encrypted_content = "ENCRYPTED";
    return out;
  }
  if (t === "function_call" || t === "custom_tool_call") {
    const out = scrubValue(item);
    if (typeof item.name === "string") out.name = TOOL_NAMES.has(item.name) ? item.name : "tool";
    if (item.arguments !== undefined) out.arguments = JSON.stringify({ cmd: "assistantword" });
    if (item.input !== undefined) out.input = "assistantword";
    return out;
  }
  if (typeof t === "string" && t.endsWith("_output")) {
    const out = scrubValue(item);
    const o = item.output;
    if (typeof o === "string" || Array.isArray(o)) out.output = scrubParts(o, "toolword toolword");
    else if (o !== null && typeof o === "object") {
      out.output = scrubValue(o);
      if (o.content !== undefined) out.output.content = scrubParts(o.content, "toolword toolword");
      if (typeof o.output === "string") out.output.output = "toolword toolword";
    }
    return out;
  }
  return scrubValue(item);
}

function scrubEntry(e) {
  const out = { timestamp: "2026-10-04T00:00:00.000Z", type: e.type };
  const p = e.payload;
  if (e.type === "response_item") out.payload = scrubItem(p);
  else if (e.type === "compacted") {
    out.payload = scrubValue(p);
    out.payload.message = "";
    if (Array.isArray(p?.replacement_history)) {
      out.payload.replacement_history = p.replacement_history
        .slice(0, MAX_ITEMS + 2)
        .map(scrubItem);
    }
    if (Array.isArray(p?.replacement_history_metadata)) {
      out.payload.replacement_history_metadata = p.replacement_history_metadata
        .slice(0, MAX_ITEMS + 2)
        .map((m) => scrubValue(m));
    }
  } else if (e.type === "event_msg" && p?.type === "user_message") {
    out.payload = { ...scrubValue(p), message: scrubUserText(String(p.message ?? "")) };
  } else if (e.type === "session_meta") {
    out.payload = scrubValue(p);
    if (p?.base_instructions !== undefined) out.payload.base_instructions = { text: "scrubbed" };
  } else if (p !== undefined) out.payload = scrubValue(p);
  for (const [k, v] of Object.entries(e))
    if (!(k in out) && k !== "payload") out[k] = scrubValue(v, k);
  return out;
}

const lines = readFileSync(input, "utf8").split(/\r?\n/);
lines.forEach((line, i) => {
  if (!wanted.has(i + 1) || !line) return;
  process.stdout.write(`${JSON.stringify(scrubEntry(JSON.parse(line)))}\n`);
});
