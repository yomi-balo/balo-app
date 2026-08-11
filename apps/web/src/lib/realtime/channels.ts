/**
 * Conversation realtime channel naming + event names (BAL-271 / A4).
 *
 * Shared between the SERVER publisher (`ably-server.ts`) and the CLIENT
 * subscriber hook (`use-conversation-realtime.ts`) — deliberately NO
 * `server-only` and no imports, so both bundles can use it without dragging
 * anything heavy across the boundary.
 *
 * ⚠ CHANNELS KEY ON `conversations.id` (BAL-424), NOT on the relationship. The
 * conversation id is the thread identity across EVERY anchor: a Case has no
 * relationship row at all, and a project thread that carries over at kickoff
 * gains a second context row while keeping ONE conversation — so keying on the
 * relationship would either be impossible or would change the channel mid-life,
 * silently orphaning every subscriber. (The superseded D2 rationale keyed on
 * `request_expert_relationships.id` because that was then the only anchor.) The
 * conversation UUID is globally unique, so no prefix is needed.
 */

/** `conversation:{conversationId}` — one private channel per thread. */
export function conversationChannelName(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Channel message name carrying a `ConversationMessageView` JSON payload. */
export const CONVERSATION_EVENT_MESSAGE = 'message';
/** Channel message name carrying a `ConversationFileView` JSON payload. */
export const CONVERSATION_EVENT_FILE = 'file';
