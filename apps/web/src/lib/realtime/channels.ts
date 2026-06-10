/**
 * Conversation realtime channel naming + event names (BAL-271 / A4).
 *
 * Shared between the SERVER publisher (`ably-server.ts`) and the CLIENT
 * subscriber hook (`use-conversation-realtime.ts`) — deliberately NO
 * `server-only` and no imports, so both bundles can use it without dragging
 * anything heavy across the boundary.
 *
 * Channels key on the `request_expert_relationships.id` (D2: relationship id is
 * the stable thread identity — EOIs are soft-deleted/re-created on
 * withdraw/resubmit). The relationship UUID is globally unique, so no request
 * prefix is needed.
 */

/** `conversation:{relationshipId}` — one private channel per thread. */
export function conversationChannelName(relationshipId: string): string {
  return `conversation:${relationshipId}`;
}

/** Channel message name carrying a `ConversationMessageView` JSON payload. */
export const CONVERSATION_EVENT_MESSAGE = 'message';
/** Channel message name carrying a `ConversationFileView` JSON payload. */
export const CONVERSATION_EVENT_FILE = 'file';
