/**
 * Realtime channel naming + event names (BAL-271 / A4; extended by BAL-437).
 *
 * TWO NAMESPACES, TWO GRAINS — see `meetingChannelName` below for the split and for why chat
 * deliberately does NOT ride the meeting channel.
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

/**
 * BAL-437 — ⚠⚠ **THE CALL-GRAIN CHANNEL, AND WHY CHAT DOES NOT RIDE IT.**
 *
 * The obvious-looking move is to publish everything in a call to `meeting:{meetingId}`. It is
 * wrong for MESSAGES: an in-call message is written into the ENGAGEMENT's durable thread, so a
 * colleague with the case surface open in another tab must receive it — and that surface
 * subscribes to `conversation:{conversationId}` and to nothing else. Publishing chat here as
 * well would be either a double publish (two definitions of "a message was posted") or a
 * silently stale dashboard thread.
 *
 * So the grain split is:
 *   · `conversation:{conversationId}` → `message` (durable, reaches BOTH the in-call panel and
 *     the dashboard surfaces through the SHIPPED `publishConversationEvent`);
 *   · `meeting:{meetingId}`           → `reaction` (ephemeral, no durable record anywhere) and
 *     `file` (`meeting_files` is a DIFFERENT table with a meeting-grain anchor, so its
 *     invalidation cannot ride a conversation channel).
 *
 * ⚠⚠ THE NAMESPACE SPELLING IS A CONTRACT. Ably matches a channel rule or a token capability
 * against the namespace LITERALLY up to the first colon (`using-ably` §4), so `meeting` does
 * NOT match `meetings:*`. This name is **SINGULAR**, matching `meetings.id` the same way
 * `conversation:` matches `conversations.id`. Any future Ably dashboard rule must be written
 * `meeting:*`, never `meetings:*`.
 *
 * ⚠ NO `persisted: true` RULE, EVER, ON THIS NAMESPACE. Reactions are ephemeral by acceptance
 * criterion; non-persistence is Ably's DEFAULT (history covers only the ~2-minute recovery
 * window), so the AC is satisfied by NOT configuring persistence rather than by a per-message
 * flag — there is no such flag, and inventing one is the classic mistake here.
 */
export function meetingChannelName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

/** Channel message name carrying a `MeetingReactionPayload` JSON payload. Ephemeral. */
export const MEETING_EVENT_REACTION = 'reaction';
/** Channel message name carrying a `MeetingFileView` JSON payload. */
export const MEETING_EVENT_FILE = 'file';
