/**
 * The ANCHOR-AGNOSTIC conversation view types (BAL-424 / BAL-421).
 *
 * ⚠⚠ THESE TWO SHAPES ARE THE ABLY WIRE PAYLOADS. Both key on `conversationId` and on
 * NOTHING ELSE — no `relationshipId`, no `requestId`, no `engagementId` — because BAL-424
 * re-anchored messaging onto the ADR-1045 §2 CONTEXT seam and the channel is the
 * conversation. Redefining either shape anywhere would FORK THE WIRE FORMAT: the client
 * hook's guards (`isConversationMessagePayload` / `isConversationFilePayload`) are
 * STRUCTURAL, so a second declaration that drifted by one field would silently reject
 * every inbound message with a green typecheck.
 *
 * ⚠ THEY MOVED HERE FROM `lib/project-request/` FOR EXACTLY ONE REASON: a CASE has no
 * project request and no relationship, so BAL-421's case surface would otherwise import
 * its core conversation contract from a `project-request` path — a lie about ownership.
 * `lib/project-request/conversation-view-types.ts` RE-EXPORTS both names, so every
 * existing import keeps working unchanged and no call site was touched by the move.
 *
 * CLIENT-SAFE on purpose: no runtime imports at all, so the conversation island and its
 * leaf components can import these without dragging postgres-js into the browser bundle
 * (memory `reference_balo_db_client_bundle_footgun`).
 */

/**
 * ⚠ THIS IS THE ABLY WIRE PAYLOAD. It carries `conversationId`, NOT `relationshipId`
 * (BAL-424) — the channel is keyed on the conversation, and the client hook's structural
 * type guard requires this exact field.
 */
export interface ConversationMessageView {
  id: string;
  conversationId: string;
  /** Sanitised at ingest (plain text → escaped HTML → sanitizeProjectHtml). */
  bodyHtml: string;
  senderUserId: string;
  senderName: string;
  createdAtIso: string;
}

/** Also an Ably wire payload — see {@link ConversationMessageView}. */
export interface ConversationFileView {
  id: string;
  conversationId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  uploadedByName: string;
  createdAtIso: string;
}
