/**
 * Realtime channel naming + event names (BAL-271 / A4; extended by BAL-437).
 *
 * THREE NAMESPACES — see `meetingChannelName` below for the conversation/meeting grain split and
 * for why chat deliberately does NOT ride the meeting channel, and `typingChannelName` for why
 * the "someone is typing" signal lives in a namespace of its own rather than on either. The
 * SERVER publishes on all three; client tokens are subscribe-only everywhere.
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
 * window), so the AC is satisfied by NOT configuring persistence. Be exact about the two
 * directions a per-message flag could point:
 *   · "PERSIST THIS ONE MESSAGE" — no such flag exists. Persistence is a channel-rule /
 *     namespace setting, and inventing a per-message opt-in is the classic mistake here.
 *   · "NEVER KEEP THIS ONE MESSAGE" — this one DOES exist: `extras: { ephemeral: true }` exempts
 *     a message from persisted history, rewind, resume and integrations. It is defence in depth
 *     on top of the namespace setting, never a substitute for it (and in an atomic multi-message
 *     publish every message must be ephemeral or none is, or Ably rejects the publish). The
 *     `typing` namespace below uses it.
 * Either way the conclusion stands: never configure persistence on this namespace.
 */
export function meetingChannelName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

/** Channel message name carrying a `MeetingReactionPayload` JSON payload. Ephemeral. */
export const MEETING_EVENT_REACTION = 'reaction';
/** Channel message name carrying a `MeetingFileView` JSON payload. */
export const MEETING_EVENT_FILE = 'file';

/**
 * The namespace prefix of the typing channel, colon included. Private: every reader goes through
 * {@link typingChannelName} / {@link isTypingChannelName}, so the spelling has one definition.
 */
const TYPING_NAMESPACE_PREFIX = 'typing:';

/**
 * `typing:{conversationId}` — ⚠⚠ **THE EPHEMERAL "SOMEONE IS TYPING" SIGNAL, IN A NAMESPACE OF
 * ITS OWN.**
 *
 * ── ⚠⚠ THE SERVER PUBLISHES IT, EXACTLY LIKE EVERYTHING ELSE ────────────────────────────
 *
 * Clients hold `['subscribe']` here, as on every channel. A typing signal travels composer →
 * Server Action → `publishTypingSignal` (`ably-server.ts`), where the action re-runs the SAME
 * gate its surface's post action runs — "you may signal typing exactly when you may post" — and
 * the server stamps the message's `clientId` with the session's `users.id`. A client publish
 * grant was the alternative and was rejected: an Ably capability has no message-name dimension
 * and no rate or size bound, so a member holding `publish` on any channel could fan arbitrary,
 * unpersisted, billable payloads to every participant with no Balo code in the path. That is
 * the same reasoning that routes meeting reactions through a Server Action (ruling R2).
 *
 * ── ⚠ WHY A SEPARATE CHANNEL AT ALL ─────────────────────────────────────────────────────
 *
 *   · FAN-OUT. A project request subscribes one `conversation:` channel per invited expert; typing
 *     is attached for the ONE thread on screen, so a busy request does not deliver every thread's
 *     keystroke heartbeats to every viewer (and Ably caps attached channels at 200 per connection).
 *   · GRAIN. The durable message stream and a disposable signal must never share a rule. Ably
 *     matches a channel rule or a capability against the namespace LITERALLY UP TO THE FIRST COLON
 *     (see `meetingChannelName` above), so `conversation:{id}:typing` would still sit in the
 *     `conversation` namespace and silently inherit any persistence or integration rule written
 *     for messages. Only a different first segment keeps them apart. Any Ably dashboard rule for
 *     this channel must be written `typing:*` — and there must never be a persistence or
 *     integration rule on it.
 *
 * ── ⚠ THE WIRE FORMAT: A NAME, AN IDENTITY, NOTHING ELSE ─────────────────────────────────
 *
 *   · {@link TYPING_EVENT_STARTED} / {@link TYPING_EVENT_STOPPED}, NO `data`, and
 *     `extras: { ephemeral: true }` so the signal is exempt from history, rewind, resume and
 *     integrations.
 *   · Identity is the message's `clientId` — the server-stamped `users.id`. A receiver reads the
 *     name and the `clientId` and NEVER `data`, so nothing is added to `message-payload.ts`. The
 *     one reader is `typing-channel.ts`; the one writer is `publishTypingSignal`.
 */
export function typingChannelName(conversationId: string): string {
  return `${TYPING_NAMESPACE_PREFIX}${conversationId}`;
}

/**
 * Whether a fully-qualified channel name sits in the `typing` namespace — i.e. its segment up to
 * the FIRST colon is exactly `typing`. `typingx:y` and `conversation:x:typing` are not.
 */
export function isTypingChannelName(channel: string): boolean {
  return channel.startsWith(TYPING_NAMESPACE_PREFIX);
}

/** Channel message name: the sender started (or is still) typing. Published with no payload. */
export const TYPING_EVENT_STARTED = 'typing.started';
/** Channel message name: the sender stopped typing. Published with no payload. */
export const TYPING_EVENT_STOPPED = 'typing.stopped';

/**
 * The two typing signals, independent of their wire names — the closed set the typing Server
 * Actions accept (`z.enum(TYPING_SIGNALS)`), so no free string ever reaches a channel.
 */
export const TYPING_SIGNALS = ['started', 'stopped'] as const;
export type TypingSignal = (typeof TYPING_SIGNALS)[number];

/** The wire name a signal is published under. */
export function typingEventNameFor(signal: TypingSignal): string {
  return signal === 'started' ? TYPING_EVENT_STARTED : TYPING_EVENT_STOPPED;
}

/** The signal a wire name carries, or `null` for any other name. */
export function typingSignalFromEventName(name: unknown): TypingSignal | null {
  if (name === TYPING_EVENT_STARTED) return 'started';
  if (name === TYPING_EVENT_STOPPED) return 'stopped';
  return null;
}
