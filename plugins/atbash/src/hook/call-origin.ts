// Placeholder: the call-origin rule is not implemented yet. Its tests are committed first (red).

export type CallOrigin = "tool_output" | "unknown";

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const TIME_BUDGET_MS = 1000;

export interface TranscriptText {
  userText: string;
  untrustedText: string;
}

export function classifyCallOrigin(
  toolInput: unknown,
  transcript: TranscriptText | null,
): CallOrigin {
  void toolInput;
  void transcript;
  return "unknown";
}

export function splitTranscript(lines: readonly string[]): TranscriptText {
  void lines;
  return { userText: "", untrustedText: "" };
}

export function readTranscriptTail(
  path: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptText | null {
  void path;
  void maxBytes;
  return null;
}

export function callOriginFor(
  toolInput: unknown,
  transcriptPath: string | null | undefined,
): CallOrigin {
  void toolInput;
  void transcriptPath;
  return "unknown";
}
