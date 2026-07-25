/**
 * Ephemeral handoff for a chat's first message: `handleStartAIChat`
 * (OverlayContainer's search-to-chat action) creates the chat resource and
 * navigates to it before any message exists, so the query text can't be
 * attached to a message resource yet. Stash it here, keyed by the new
 * chat's subject, and `AIChatPage` consumes it once on mount to auto-submit
 * — same module-level-map pattern OverlayContainer already uses for its own
 * ephemeral cross-component search state.
 */
const pendingFirstMessages = new Map<string, string>();

export function setPendingFirstMessage(chatSubject: string, text: string): void {
  pendingFirstMessages.set(chatSubject, text);
}

/** Reads and clears — a chat consumes its pending first message at most once. */
export function consumePendingFirstMessage(
  chatSubject: string,
): string | undefined {
  const text = pendingFirstMessages.get(chatSubject);
  pendingFirstMessages.delete(chatSubject);

  return text;
}
