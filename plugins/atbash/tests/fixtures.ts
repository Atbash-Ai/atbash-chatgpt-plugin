import type { PreToolUseInput } from "../src/hook/protocol.js";

export function makeHookInput(overrides: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return {
    hook_event_name: "PreToolUse",
    cwd: "/workspace/example",
    model: "gpt-test",
    permission_mode: "default",
    session_id: "session-test",
    // `command`, not `cmd`: captured from Codex 0.160.0, which sends
    // {"command":"git status"} for every shell, file-read and file-write call.
    tool_input: { command: "git status --short" },
    tool_name: "Bash",
    tool_use_id: "tool-use-test",
    transcript_path: null,
    turn_id: "turn-test",
    ...overrides,
  };
}
