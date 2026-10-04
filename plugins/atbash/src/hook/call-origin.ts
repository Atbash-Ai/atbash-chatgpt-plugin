import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Where the instruction behind a tool call came from, as far as this machine can tell.
 *
 * Prompt injection works by hiding an instruction in content the agent reads (a web page, an
 * email, a tool's output) and getting the agent to act on it. The judge only sees the call, so it
 * cannot tell "the user asked for this" from "a document told the agent to do this". Codex hands
 * the hook the path of the session's rollout transcript (`transcript_path`). This module computes
 * ONE fact locally from that transcript and sends only that fact, never any text:
 *
 *   "tool_output": an instruction addressed to the agent ("please ...", "ignore previous ...", an
 *   imperative sentence) appeared in tool output earlier in the session, it shares at least two
 *   distinctive words with this call's argument values, and those words appear nowhere in what the
 *   user typed.
 *
 *   It is also "tool_output" when this call, or a call earlier in the tail, names the rollout file
 *   or the sessions folder: the agent can write its own transcript, so a session it wrote to cannot
 *   vouch for what the user typed (the stricter answer).
 *
 *   "unknown": anything else, including no transcript, an unreadable one, input too large to check
 *   within the time budget, or any doubt. Unknown changes nothing about how the call is judged.
 *
 * It never claims "the user asked for this": that label would make the judge MORE permissive, so a
 * wrong guess could be abused.
 *
 * The rule (between the SHARED RULE markers) and the transcript reader are copied verbatim from the
 * Claude Code plugin (Atbash-Ai/atbash-claude-plugin, plugins/atbash/src/hook/call-origin.ts at
 * e52b2ef), with every bound its five security-review rounds added: a linear character scanner,
 * capped inputs, a two-pass read of long values with an overlap at the 4 KiB cut, no caps decoys
 * could exhaust, a line scan with no per-line regex split, a 1 s time budget, and a 2 MiB tail read
 * of absolute, local, regular files only. A test pins the rule block by hash. Only splitTranscript
 * differs: it reads Codex's rollout format instead of Claude Code's.
 */

// --- BEGIN SHARED RULE (Atbash-Ai/atbash-claude-plugin plugins/atbash/src/hook/call-origin.ts lines 31-299 at e52b2ef; do not edit here alone) ---
export type CallOrigin = "tool_output" | "unknown";

/** Only the end of the transcript is read: recent turns are what the next call acts on. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Upper bound on the tool-output text scanned for instructions. */
const MAX_UNTRUSTED_CHARS = 512 * 1024;
/** Upper bound on the user text and on the call's argument values (in total, and per value). */
const MAX_USER_CHARS = 256 * 1024;
const MAX_CALL_CHARS = 64 * 1024;
/** First pass over the call: this much of every value, shortest values first. */
const FIRST_PASS_VALUE_CHARS = 4 * 1024;
/** Transcript content nested deeper than this is not text anyone wrote; it is skipped. */
const MAX_CONTENT_DEPTH = 32;
/** A token longer than this is not a word anyone would repeat; it is skipped. */
const MAX_WORD_LENGTH = 64;
/**
 * The whole check gives up after this long. A hard stop for pathological input only, far below
 * Claude Code's 35 s hook timeout; the worst case an attacker can build within the 512 KiB window
 * (a flood of instruction-like or very short lines) measured 30-240 ms alone and up to 334 ms with
 * the whole test suite running in parallel, so the budget cannot be used to suppress the fact
 * (security re-reviews 2026-10-03). On a host several times slower the check gives up and adds
 * nothing: the call is judged as it was before this check existed, never allowed more easily.
 */
export const TIME_BUDGET_MS = 1000;

const STOP = new Set(
  (
    "this that with from have will your what when where which there their they them then than these those " +
    "into onto about after before please should would could must need make sure file files code line lines test tests using used " +
    "also only just more most some such each other same very like does done here were been being call tool tools user users data " +
    "value values name names path paths true false none null self return function class import print error errors output input " +
    "string number list dict type types args kwargs kindly"
  ).split(" "),
);

class OverBudget extends Error {}

function makeDeadline(): () => void {
  const end = performance.now() + TIME_BUDGET_MS;
  let n = 0;
  return () => {
    // Checking the clock every call would cost more than the work; every 256 steps is enough.
    if ((++n & 0xff) === 0 && performance.now() > end) throw new OverBudget();
  };
}

const isAlnum = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
/** Word characters: a-z 0-9 _ . - / @ # (the text is lower-cased first). */
const isWordChar = (c: number): boolean =>
  isAlnum(c) || c === 95 || c === 46 || c === 45 || c === 47 || c === 64 || c === 35;
/** Trailing punctuation trimmed from a word: . , ; : */
const isTrailing = (c: number): boolean => c === 46 || c === 44 || c === 59 || c === 58;

/**
 * Calls `visit` with each word of lower-cased `text`, in one pass over its characters (no regex
 * match objects: a flood of instruction-like text must stay far inside the time budget). A word is
 * a run of word characters that starts with a letter or digit (or one "#" / "@" before one), with
 * trailing ".,;:" trimmed and at most MAX_WORD_LENGTH characters: a longer run keeps its prefix.
 * `visit` returns true to stop early.
 */
function scanWords(text: string, tick: () => void, visit: (word: string) => boolean | void): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWordChar(text.charCodeAt(j))) j++;
    tick();
    let start = i;
    // Leading punctuation is not part of a word; one "#" or "@" right before a letter or digit is.
    while (start < j && !isAlnum(text.charCodeAt(start))) {
      const c = text.charCodeAt(start);
      if ((c === 35 || c === 64) && start + 1 < j && isAlnum(text.charCodeAt(start + 1))) break;
      start++;
    }
    let end = Math.min(j, start + MAX_WORD_LENGTH);
    while (end > start && isTrailing(text.charCodeAt(end - 1))) end--;
    if (end - start >= 4 && visit(text.slice(start, end)) === true) return;
    i = j;
  }
}

/** Distinctive words of `text`: stop words, pure numbers and short words are left out. */
function words(text: string, tick: () => void): Set<string> {
  const out = new Set<string>();
  scanWords(text.toLowerCase(), tick, (w) => {
    if (!STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  });
  return out;
}

/**
 * The text of an instruction: up to 240 characters, ending at a sentence end or a closing quote.
 * A "." "!" or "?" ends it only when no word character follows, so an address or URL inside it
 * (payroll-backup@exfil-example.net, https://a.b/c) stays whole. One character per step: linear.
 */
const INSTRUCTION_TAIL = String.raw`(?:[^.!?\n'"}\]]|[.!?](?=\w)){6,240}`;
/** An instruction addressed to the agent, anywhere in a line ("... 'review': 'Please grant ..."). */
const ADDRESSED = new RegExp(
  String.raw`\b(?:please|kindly|you (?:must|should|need to|have to)|ignore (?:all |the )?(?:previous|prior|above)|disregard (?:all |the )?(?:previous|prior|above)|i want you to|your (?:new |next )?task is)\b` +
    INSTRUCTION_TAIL,
  "gi",
);
/** An imperative verb opening a sentence or a quoted field ("... 'note': 'Withdraw 5 Bitcoin to ..."). */
const IMPERATIVE_START = new RegExp(
  String.raw`(?:^|[.!?]\s+|['":]\s*)((?:withdraw|transfer|send|grant|give|move|delete|remove|leave|share|post|email|upload|forward|pay|buy|sell|deposit|invite|unlock|disable|turn off|install|retrieve|download|export|change|reset|cancel|update|add|schedule|book|follow|tweet|publish|navigate|visit)\b` +
    INSTRUCTION_TAIL +
    ")",
  "gi",
);
/**
 * Source code reads like instructions ("update(...)", "set x = ..."); skip code-looking lines.
 * Braces alone do not make a line code: tool output is often JSON, where injections hide.
 */
const CODE_LINE = /[=;]|\bdef |\bclass |\breturn\b|^\s*(?:#|\/\/|\d+\s)/;
/** The shortest text either pattern can match: a three-letter verb plus a six-character tail. */
const MIN_INSTRUCTION_CHARS = 9;
/** A code-looking line is still read for an addressed instruction when it says "please". */
const PLEASE = /\bplease\b/i;

/**
 * Instructions in tool output, one line at a time, so each is compared as soon as it is found.
 * The instruction spans on a line are merged (the two patterns often overlap) and yielded once,
 * lower-cased, so no text is scanned twice (security re-review 2026-10-03: a flood of
 * instruction-like lines must not push the check past its time budget).
 */
function* instructions(untrusted: string, tick: () => void): Generator<string> {
  // Lines end at a newline or a literal backslash-n (tool output is often JSON-escaped). They are
  // found with indexOf, not a regex split, and a line too short to hold an instruction is skipped
  // before any regex runs: the cost must not grow with the number of lines (security re-review
  // 2026-10-03: 512K empty lines ran out the budget).
  const n = untrusted.length;
  let pos = 0;
  let nextNewline = untrusted.indexOf("\n");
  let nextEscaped = untrusted.indexOf("\\n");
  while (pos <= n) {
    if (nextNewline !== -1 && nextNewline < pos) nextNewline = untrusted.indexOf("\n", pos);
    if (nextEscaped !== -1 && nextEscaped < pos) nextEscaped = untrusted.indexOf("\\n", pos);
    let cut = n;
    let step = 0;
    if (nextNewline !== -1 && (nextEscaped === -1 || nextNewline < nextEscaped)) {
      cut = nextNewline;
      step = 1;
    } else if (nextEscaped !== -1) {
      cut = nextEscaped;
      step = 2;
    }
    const lineStart = pos;
    let lineEnd = cut;
    if (step === 1 && lineEnd > lineStart && untrusted.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    pos = step === 0 ? n + 1 : cut + step;
    tick();
    if (lineEnd - lineStart < MIN_INSTRUCTION_CHARS) continue;
    const line = untrusted.slice(lineStart, lineEnd);
    const code = CODE_LINE.test(line);
    const spans: Array<[number, number]> = [];
    if (!code || PLEASE.test(line)) {
      ADDRESSED.lastIndex = 0;
      for (let m = ADDRESSED.exec(line); m !== null; m = ADDRESSED.exec(line)) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }
    if (!code) {
      IMPERATIVE_START.lastIndex = 0;
      for (let m = IMPERATIVE_START.exec(line); m !== null; m = IMPERATIVE_START.exec(line)) {
        const text = m[1] ?? "";
        const start = m.index + m[0].length - text.length;
        spans.push([start, start + text.length]);
      }
    }
    if (spans.length === 0) continue;
    spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = spans[0] as [number, number];
    for (const [s, e] of spans.slice(1)) {
      if (s <= end) end = Math.max(end, e);
      else {
        yield line.slice(start, end).toLowerCase();
        [start, end] = [s, e];
      }
    }
    yield line.slice(start, end).toLowerCase();
  }
}

/** True when `text` (lower-case) holds at least two distinct words of `callWords`. One pass. */
function sharesTwoWords(text: string, callWords: ReadonlySet<string>, tick: () => void): boolean {
  let first: string | undefined;
  let found = false;
  scanWords(text, tick, (w) => {
    if (!callWords.has(w)) return false;
    if (first === undefined) first = w;
    else if (w !== first) found = true;
    return found;
  });
  return found;
}

/**
 * The call's string values within MAX_CALL_CHARS. First pass: up to 4 KiB of every value, shortest
 * values first, so short values that name a target (a recipient, a URL) always count and a long
 * body cannot crowd them out. Second pass: the rest of the long values, so a target written past
 * 4 KiB in one value still counts (security re-review 2026-10-03). Every leaf costs budget.
 */
function stringValues(toolInput: unknown, tick: () => void): string[] {
  const values: string[] = [];
  let leaves = 0;
  const walk = (value: unknown, depth: number): void => {
    tick();
    if (depth > 20 || leaves >= MAX_CALL_CHARS) return;
    leaves++;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, depth + 1);
    else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(toolInput, 0);
  values.sort((a, b) => a.length - b.length);
  let budget = MAX_CALL_CHARS - leaves;
  const out: string[] = [];
  for (const v of values) {
    if (budget <= 0) break;
    const part = v.slice(0, Math.min(FIRST_PASS_VALUE_CHARS, budget));
    budget -= part.length;
    out.push(part);
  }
  for (const v of values) {
    if (budget <= 0) break;
    if (v.length <= FIRST_PASS_VALUE_CHARS) continue;
    // Starts one word length before the first-pass cut, so a word that crosses the cut is read
    // whole here (security re-review 2026-10-03).
    const from = FIRST_PASS_VALUE_CHARS - MAX_WORD_LENGTH;
    const rest = v.slice(from, from + budget);
    budget -= rest.length;
    out.push(rest);
  }
  return out;
}

/** The rule itself, on text already extracted from the transcript. Never throws. */
export function classifyCallOrigin(
  toolInput: unknown,
  transcript: TranscriptText | null,
): CallOrigin {
  if (transcript === null) return "unknown";
  const tick = makeDeadline();
  try {
    const userWords = words(transcript.userText.slice(-MAX_USER_CHARS), tick);
    // No word cap: the 64 KiB character budget already bounds the set (about 13K words), and a
    // cap would let a flood of short values crowd out the target (security re-review 2026-10-03).
    const callWords = new Set<string>();
    for (const w of words(stringValues(toolInput, tick).join(" "), tick)) {
      if (!userWords.has(w)) callWords.add(w);
    }
    if (callWords.size < 2) return "unknown";
    const untrusted = transcript.untrustedText.slice(-MAX_UNTRUSTED_CHARS);
    // Cost is linear in the instruction text: each word is looked up in the call's set once.
    for (const ins of instructions(untrusted, tick)) {
      if (sharesTwoWords(ins, callWords, tick)) return "tool_output";
    }
    return "unknown";
  } catch {
    // Over budget, or anything unexpected: no claim either way.
    return "unknown";
  }
}
// --- END SHARED RULE ---

function textOf(content: unknown, depth = 0): string {
  if (typeof content === "string") return content;
  if (depth >= MAX_CONTENT_DEPTH) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.content !== undefined) return textOf(p.content, depth + 1);
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/** Blocks Codex wraps into a user-role message that hold page content the agent read. */
const UNTRUSTED_BLOCKS = ["<in-app-browser-context", "<external_codex_apps_open_page"];
/** The block Codex wraps around the user's own answer to a question the agent asked. */
const USER_REPLY_BLOCK = "<send_user_message_question_reply";

/**
 * The user's own answers in a question-reply block:
 * `<send_user_message_question_reply>\n[{"questionItemId","question","answer"}]`. Only each `answer`
 * is the user's; the `question` is the agent's text, and an injection could make the agent ask about
 * its target so that those words would count as typed by the user (security review 2026-10-04).
 * Anything that does not parse to that shape adds nothing: dropping user words only tightens.
 */
function replyAnswers(text: string): string[] {
  try {
    const start = text.indexOf(">");
    const close = text.lastIndexOf("</send_user_message_question_reply>");
    const body = text.slice(start + 1, close > start ? close : text.length).trim();
    const items: unknown = JSON.parse(body);
    if (!Array.isArray(items)) return [];
    const answers: string[] = [];
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const answer = (item as Record<string, unknown>).answer;
      if (typeof answer === "string") answers.push(answer);
    }
    return answers;
  } catch {
    return [];
  }
}

/** Codex's heading on a user message that quotes parts of an earlier agent response. */
const ANNOTATIONS_HEADING = "# Response annotations";
const ANNOTATIONS_CLOSE = "</response-annotations>";

/**
 * The user's own words in a message that comments on an earlier response (as recorded in real
 * rollouts): `# Response annotations:\n<Codex's note>\n<response-annotations>\n[{"text","source"}]\n
 * </response-annotations>\n\n## My request:\n<what the user typed>`. Each item's `text` is selected
 * from the agent's own earlier response, which an injection can steer toward its target, so neither
 * it nor Codex's note is the user's (security review 2026-10-04). Only the request after the LAST
 * closing tag is (a quoted closing tag can only cut the user's words short, never add quoted ones).
 * Without a closing tag nothing is the user's. An item's own comment, if Codex adds one, is left
 * out too: its field is not seen in real rollouts, and dropping user words only tightens.
 */
function annotatedRequest(text: string): string[] {
  const close = text.lastIndexOf(ANNOTATIONS_CLOSE);
  if (close === -1) return [];
  const request = text
    .slice(close + ANNOTATIONS_CLOSE.length)
    .replace(/^\s*## My request:[ \t]*/, "")
    .trim();
  return request.length > 0 ? [request] : [];
}

/**
 * The first line of a task one agent relays to another ("Message Type: NEW_TASK", then "Task name",
 * "Sender", "Payload:"). In real rollouts (multi_agent_version v2, 449 sub-agent rollouts checked on
 * 2026-10-04) relays arrive only as `agent_message` items, ignored below, and the payload is
 * encrypted; a relay delivered as a user message is not the user's words either.
 */
const RELAY_HEADER = /^Message Type: [^\n]*\n/;

/**
 * Codex's local compaction stores the model's own summary of the session as a user-role message
 * opening with a fixed prefix (codex-rs prompts/templates/compact/summary_prefix.md; before it, the
 * history bridge in core/templates/compact/history_bridge.md). The model writes it, and an injection
 * can steer it, so it is never the user's words (security review 2026-10-04). The bridge also quotes
 * the user's earlier messages; dropping them only tightens.
 */
const COMPACTION_PREFIXES = [
  "Another language model started to solve this problem",
  "You were originally given instructions from a user over one or more turns",
];

/**
 * One text part of a user-role message. Codex puts its own context into user-role messages too:
 * page content the agent read is untrusted; AGENTS.md instructions and other `<...>` harness blocks
 * (environment, heartbeat, goals) are neither the user's words nor tool output, and are ignored, as
 * Claude Code's `isMeta` notes are. Quoted annotations and relayed agent tasks are not the user's
 * either, and neither is a compaction summary. Everything else is what the user typed.
 */
function userPart(text: string, user: string[], untrusted: string[]): void {
  const head = text.slice(0, 256).trimStart();
  if (UNTRUSTED_BLOCKS.some((tag) => head.startsWith(tag))) untrusted.push(text);
  else if (head.startsWith(USER_REPLY_BLOCK)) user.push(...replyAnswers(text));
  else if (head.startsWith(ANNOTATIONS_HEADING)) user.push(...annotatedRequest(text));
  else if (RELAY_HEADER.test(head)) return;
  else if (COMPACTION_PREFIXES.some((prefix) => head.startsWith(prefix))) return;
  else if (!head.startsWith("<") && !head.startsWith("# AGENTS.md instructions")) user.push(text);
}

/** The text of a tool output: a string, content parts, or an object holding them. */
function outputText(output: unknown): string {
  if (typeof output === "string" || Array.isArray(output)) return textOf(output);
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (o.content !== undefined) return textOf(o.content);
    if (typeof o.output === "string") return o.output;
    return JSON.stringify(o);
  }
  return "";
}

/** One rollout item: a user message, or any `*_output` item (function, custom, shell, MCP tools). */
function readItem(item: unknown, user: string[], untrusted: string[]): void {
  if (item === null || typeof item !== "object") return;
  const it = item as Record<string, unknown>;
  // A task or reply one agent sends another (sub-agents): never the user's words. Its plain text is
  // a header, its payload encrypted; it is not tool output this hook can read either.
  if (it.type === "agent_message") return;
  if (it.type === "message") {
    if (it.role !== "user") return;
    if (typeof it.content === "string") userPart(it.content, user, untrusted);
    else if (Array.isArray(it.content)) {
      for (const part of it.content) {
        if (part === null || typeof part !== "object") continue;
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") userPart(text, user, untrusted);
      }
    }
    return;
  }
  if (typeof it.type === "string" && it.type.endsWith("_output"))
    untrusted.push(outputText(it.output));
}

/**
 * Split Codex rollout lines into what the user typed and what tools returned.
 * User-typed: user-role `message` items (minus Codex's own context blocks), `event_msg` /
 * `user_message` events, and the user messages a `compacted` line keeps. Untrusted: every
 * `*_output` item, and page content Codex attaches to a user message. Assistant, developer,
 * reasoning and inter-agent items (`agent_message`) are ignored, and so are the parts of a user
 * message that are not the user's: Codex's context blocks, the agent's question in a question
 * reply, the text an annotation quotes from an earlier response, and a relayed agent task. In a
 * forked sub-agent's rollout the user messages it inherits from its parent are the user's own. Items are read in both the current shape
 * (`{ type: "response_item", payload }`) and the older top-level shape. Malformed lines (including
 * a first line cut by the tail read) are skipped.
 */
export function splitTranscript(
  lines: readonly string[],
  sessionMarkers: readonly string[] = [],
): TranscriptText {
  const user: string[] = [];
  const untrusted: string[] = [];
  let touchesSession = false;
  for (const line of lines) {
    // One malformed or pathological line is skipped; it never discards the rest of the transcript.
    try {
      const entry: unknown = JSON.parse(line);
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const payload =
        e.payload !== null && typeof e.payload === "object"
          ? (e.payload as Record<string, unknown>)
          : undefined;
      const callItem = e.type === "response_item" ? payload : e;
      if (
        !touchesSession &&
        sessionMarkers.length > 0 &&
        typeof callItem?.type === "string" &&
        callItem.type.endsWith("_call") &&
        (namesSession(line, sessionMarkers) ||
          namesSession(decodedCallText(callItem), sessionMarkers))
      )
        touchesSession = true;
      if (e.type === "response_item") readItem(payload, user, untrusted);
      else if (e.type === "event_msg") {
        if (payload?.type === "user_message" && typeof payload.message === "string")
          userPart(payload.message, user, untrusted);
      } else if (e.type === "compacted") {
        const history = payload?.replacement_history;
        if (Array.isArray(history)) {
          for (const item of history) {
            if (
              item !== null &&
              typeof item === "object" &&
              (item as { type?: unknown }).type === "message"
            )
              readItem(item, user, untrusted);
          }
        }
      } else readItem(e, user, untrusted);
    } catch {
      // The tail read cuts its first line, which then fails to parse. A call there that named the
      // session is still seen: the raw fragment is scanned for the markers (tighten-only).
      if (
        lines.length > 0 &&
        line === lines[0] &&
        !touchesSession &&
        sessionMarkers.length > 0 &&
        namesSession(line, sessionMarkers)
      )
        touchesSession = true;
      continue;
    }
  }
  return { userText: user.join("\n"), untrustedText: untrusted.join("\n"), touchesSession };
}

export interface TranscriptText {
  /** What the user typed in this session (not hook or system messages). */
  userText: string;
  /** Tool results and attachments: content the agent read but the user did not write. */
  untrustedText: string;
  /** A call in the tail named the rollout file or the sessions folder (see sessionMarkersFor). */
  touchesSession?: boolean;
}

/** Backslashes as slashes, lower case: one spelling of a path for every shell and JSON escape. */
function normalizePathText(text: string): string {
  return text.replace(/\\+/g, "/").toLowerCase();
}

/**
 * What names this session's transcript in a call: the rollout file's name and the sessions folder
 * that holds it (Codex's own, and the one in the path when it sits under a sessions folder). The
 * transcript's own folder is not a marker unless it is under a sessions folder: a transcript in a
 * general folder would otherwise flag every call that works there.
 *
 * Security review 2026-10-04 (MEDIUM): an injected agent with a shell can append a forged user line
 * to its own rollout file and then make the harmful call, so a session whose transcript a call
 * touched cannot vouch for the user's words.
 */
export function sessionMarkersFor(transcriptPath: string): string[] {
  const markers = [normalizePathText(basename(transcriptPath)), ".codex/sessions/"];
  const folder = `${normalizePathText(dirname(transcriptPath))}/`;
  const sessions = folder.lastIndexOf("/sessions/");
  if (sessions > 0) markers.push(folder.slice(0, sessions + "/sessions/".length));
  return markers;
}

/**
 * Spellings that reach a rollout without naming it (security re-review 2026-10-04): any path into
 * Codex's home folder (`.codex/`, `.codex` at the end, `$CODEX_HOME`), or a rollout or sessions
 * `.jsonl` named by pattern. Matching them only adds the fact (tighten-only): at worst the judge is
 * more careful on a legitimate edit of Codex's own configuration. A path built at run time
 * (concatenation, an encoded command, a script written first) is out of reach of any string check;
 * the Codex sandbox, which does not let the agent write its sessions folder, is the control there.
 */
function namesCodexHome(t: string): boolean {
  if (t.includes(".codex/") || /\.codex(?![\w.-])/.test(t) || t.includes("codex_home")) return true;
  if (!t.includes(".jsonl")) return false;
  return t.includes("rollout") || t.includes("sessions/");
}

/** The whole text is scanned, in one linear pass (a cap could hide a marker past it). */
function namesSession(text: string, markers: readonly string[]): boolean {
  const t = normalizePathText(text);
  return namesCodexHome(t) || markers.some((marker) => marker.length > 0 && t.includes(marker));
}

/**
 * A tail call item with its arguments decoded: a function call's `arguments` is itself a JSON string,
 * so an escape the model wrote inside it (the dot of ".codex" as a unicode escape) survives in the
 * raw line. Parsing it and serialising the result again spells every such character plainly.
 */
function decodedCallText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["arguments", "input", "action"]) {
    const value = item[key];
    if (typeof value === "string") {
      parts.push(value);
      try {
        parts.push(JSON.stringify(JSON.parse(value)) ?? "");
      } catch {
        // not JSON: the plain string above is what the call said
      }
    } else if (value !== undefined) parts.push(callText(value));
  }
  return parts.join("\n");
}

/** The call's arguments as one string; anything that cannot be serialised is empty. */
function callText(toolInput: unknown): string {
  try {
    return typeof toolInput === "string" ? toolInput : (JSON.stringify(toolInput) ?? "");
  } catch {
    return "";
  }
}

/** Network paths (\\host\share, //host/share) are never opened: no outbound connection from the hook. */
function isNetworkPath(path: string): boolean {
  return /^(?:\\\\|\/\/)/.test(path);
}

/**
 * Read the last `maxBytes` of the transcript. Never throws: any failure is `null`.
 * Only an absolute, local, regular file is read; a pipe, FIFO, device or network path is refused
 * before it is opened, because opening one can block the hook (security review 2026-10-02).
 */
export function readTranscriptTail(
  path: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptText | null {
  if (!isAbsolute(path) || isNetworkPath(path)) return null;
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return null;
    // O_NONBLOCK where it exists (POSIX): a file swapped for a FIFO after the check cannot block.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, stat.size - length);
    return splitTranscript(
      buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/),
      sessionMarkersFor(path),
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to recover
      }
    }
  }
}

/**
 * The fact for one call. Never throws; no transcript, or any failure, is "unknown". A call that names
 * the session's transcript, now or earlier in the tail, is "tool_output" (see sessionMarkersFor).
 */
export function callOriginFor(
  toolInput: unknown,
  transcriptPath: string | null | undefined,
): CallOrigin {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return "unknown";
  try {
    if (namesSession(callText(toolInput), sessionMarkersFor(transcriptPath))) return "tool_output";
    const transcript = readTranscriptTail(transcriptPath);
    if (transcript?.touchesSession === true) return "tool_output";
    return classifyCallOrigin(toolInput, transcript);
  } catch {
    return "unknown";
  }
}
