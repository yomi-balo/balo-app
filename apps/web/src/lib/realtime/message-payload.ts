import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';

/**
 * BAL-437 — the TRUST BOUNDARY over an inbound Ably `conversation:{id}` payload: the structural
 * guards, and the client-side re-sanitiser that runs before any body may reach
 * `dangerouslySetInnerHTML`.
 *
 * ── ⚠⚠ WHY THIS IS IN `lib/realtime` AND NOT IN `components/balo/conversation` ──────────
 *
 * It used to live inside `use-conversation-realtime.ts`, and the in-call hook imported it FROM
 * THERE — i.e. the CALL surface reached into the project-request/case CONVERSATION feature for
 * a transport-level primitive. That is the same coupling BAL-421 had already broken once for
 * the token plumbing (which is why `ably-auth.ts` exists beside this file), reintroduced one
 * import lower down. Nothing here is conversation-FEATURE code: it is "what a message-shaped
 * Ably payload must look like before we believe it", which is the transport's own question.
 *
 * ⚠⚠ **NO `server-only` MARKER, DELIBERATELY**, exactly as `ably-auth.ts` states. Both
 * consumers are `'use client'` hooks; the marker would break `next build` for each of them.
 * The only import above is `import type`, so nothing reaches a bundle but the three functions.
 *
 * ⚠ THE GUARDS ARE **STRUCTURAL, FIELD BY FIELD**, and that is not belt-and-braces. The payload
 * arrives as `unknown` from a THIRD PARTY, so naming a field wrong here rejects every inbound
 * message SILENTLY — a green typecheck cannot catch it, because there is no type on the wire.
 */

function hasStringFields<K extends string>(
  data: unknown,
  keys: readonly K[]
): data is Record<K, string> {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === 'string');
}

/**
 * Full structural guard over every message field either island consumes.
 *
 * ⚠ `conversationId` (BAL-424), NOT `relationshipId`. See the module docblock for why a wrong
 * field name here is invisible to `tsc`.
 */
export function isConversationMessagePayload(data: unknown): data is ConversationMessageView {
  return hasStringFields(data, [
    'id',
    'conversationId',
    'bodyHtml',
    'senderUserId',
    'senderName',
    'createdAtIso',
  ]);
}

/** Full structural guard over every file field the conversation island consumes. */
export function isConversationFilePayload(data: unknown): data is ConversationFileView {
  return (
    hasStringFields(data, [
      'id',
      'conversationId',
      'fileName',
      'contentType',
      'uploadedByUserId',
      'uploadedByName',
      'createdAtIso',
    ]) && typeof (data as { sizeBytes?: unknown }).sizeBytes === 'number'
  );
}

/** The only tags a realtime message body may carry (what the server emits). */
const REALTIME_ALLOWED_TAG = /^<(?:\/?p|br\s*\/?)>$/i;

/**
 * Client-side defense-in-depth for Ably-delivered `bodyHtml` before it can reach
 * `dangerouslySetInnerHTML`: every tag except `<p>`, `</p>`, `<br>` is escaped in place (no
 * sanitizer dependency in the bundle). Server-built payloads (`plainMessageToHtml` →
 * `sanitizeProjectHtml`) pass through unchanged; a hostile payload renders as inert text.
 */
export function sanitizeRealtimeBodyHtml(html: string): string {
  // `<` up to the next `>` (or end of input for an unterminated tag). ⚠ THE NEGATED CLASS
  // EXCLUDES ITS OWN OPENING DELIMITER (`[^<>]`, not `[^>]`) — SonarCloud S5852: `[^>]` still
  // matches `<`, so overlapping start positions re-scan the same region (O(n²)).
  return html.replace(/<[^<>]*>?/g, (tag) =>
    REALTIME_ALLOWED_TAG.test(tag) ? tag : tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  );
}
