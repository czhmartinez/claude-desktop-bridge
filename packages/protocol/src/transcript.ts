export const CLAUDE_INTERRUPTED_USER_MESSAGE = "[Request interrupted by user]";
export const CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE = "No response requested.";

export function isClaudeTranscriptControlMessage(
  role: "user" | "assistant",
  text: string,
): boolean {
  const normalized = text.trim();
  return (
    (role === "user" && normalized === CLAUDE_INTERRUPTED_USER_MESSAGE) ||
    (role === "assistant" && normalized === CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE)
  );
}
