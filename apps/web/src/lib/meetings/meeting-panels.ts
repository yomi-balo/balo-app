import type { GuestForViewer } from '@balo/shared/meetings';
import type {
  MeetingPanelInviteOutcome,
  MeetingPanelDecisionOutcome,
} from '@balo/analytics/client';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { RealtimeTokenResult } from '@/lib/realtime/ably-auth';
import type { MeetingFileView } from './meeting-file-view-types';
import type { MeetingReactionEmoji } from './meeting-reactions';

/**
 * BAL-436 — the SIDE PANEL's registration contract. TYPES ONLY: no values, no functions, no
 * constants, no React.
 *
 * ⚠⚠ IT CARRIES **CALLBACKS, NOT DATA**. Panel state lives in the panel; this is the
 * capability plus its Server Actions. Two consequences, both deliberate:
 *   1. `MeetingCallSurface`'s prop contract stays FROZEN — BAL-435's seam docblock states the
 *      rule ("a prop added later is a contract change; a prop added here is the contract"),
 *      so the panel extends the route CONTEXT instead.
 *   2. Every panel component is testable with plain fakes — no `next/headers` mock, no Server
 *      Action machinery, no api double.
 *
 * ⚠ THE `meetingId` IS **NOT** ON THIS INTERFACE. The registration closes over it in
 * `call-client.tsx`, so no panel component ever handles a meeting id it could send to the
 * wrong action.
 *
 * ⚠ CLIENT-SAFE. Every import above is `import type` and every module it reaches is pure, so
 * nothing here can drag `@balo/db` (and therefore `postgres`) into a browser graph — the
 * `next build` "can't resolve 'tls'" footgun, which no local gate catches.
 */

/**
 * The registered slots.
 *
 * ⚠⚠ BAL-437 ADDED `'chat'` — AND A MEMBER HERE IS STILL NOT A PROMISE THAT THE SLOT EXISTS.
 * Chat is registered only when the meeting resolves to a conversation anchor
 * (`MeetingPanelRegistration.chat !== null`); a `project_discovery`, an `admin` call, an
 * ambiguous context or an unprovisioned thread all render the slot ABSENT — no toolbar button,
 * no More-sheet row, no panel. Never a disabled control.
 *
 * ── ⚠⚠ THE GUEST SEAM, NAMED AND FAIL-CLOSED — **BAL-445 OWNS IT** ──────────────────────
 *
 * A guest gets NO chat and NO reactions, and there is no check anywhere that says so. It is
 * structural, three times over:
 *
 *   1. `MeetingRouteContextProvider` is mounted ONLY on the member route, so both guest
 *      surfaces read the context default `panels: null`;
 *   2. all four in-call Server Actions gate on `requireUser()` / `requireOnboardedUser()`,
 *      which a guest satisfies neither of;
 *   3. `conversation_messages.sender_user_id` is `notNull` with an FK to `users.id`, so a
 *      guest **cannot author a message at all** without a migration adding a nullable sender
 *      plus a guest attribution column plus a CHECK.
 *
 * ⚠ DO NOT CALL `guestMayReadMeeting` TO "SUPPORT" GUESTS HERE. Its own docblock forbids
 * speculative calls: authorizing a read against a grant with no authenticated subject to bind
 * it to is worse than denying. **BAL-445** mints the session and fills the arm.
 */
export type MeetingPanelId = 'people' | 'files' | 'chat';

/** The guests GET payload, exactly as the api returns it. */
export interface MeetingGuestsPayload {
  readonly guests: readonly GuestForViewer[];
  /**
   * ⚠⚠ THE SERVER'S PER-ACTOR `hasEngagementCapability(HOST_MEETINGS)` VERDICT for this exact
   * meeting, computed behind the tenancy gate that must run first.
   *
   * **DO NOT CALL THE WEB ENGAGEMENT RESOLVER TO RE-DERIVE IT, EVEN THOUGH ONE NOW EXISTS**
   * (`apps/web/src/lib/authz/engagement.ts`, opened by BAL-421). A second resolution in the
   * browser tier would be a second expression of one rule, and it would run WITHOUT
   * `authorizeMeetingParticipation` in front of it. `meeting-call-no-lens-gate.test.ts`
   * enforces this mechanically for the whole call subtree.
   */
  readonly canHost: boolean;
  /**
   * ⚠⚠ A **SEAT** COUNT — the reserved pair plus pre-admitted and admitted guests, from the
   * very counter the server refuses invites on. It is NOT the tile count and the two
   * routinely differ. Render "{n} of {cap}" from this pair, never from a local count.
   */
  readonly participantCount: number;
  readonly participantCap: number;
}

/**
 * ⚠ `retryable` DISTINGUISHES A TRANSPORT BLIP FROM A VERDICT. The poll keeps its schedule on
 * a retryable failure and stops on a terminal one — collapsing the two is what makes a
 * dropped packet look like a dead meeting.
 */
export type GetMeetingGuestsResult =
  | { readonly success: true; readonly data: MeetingGuestsPayload }
  | { readonly success: false; readonly error: string; readonly retryable: boolean };

/**
 * ⚠ `outcome` IS THE ANALYTICS DIMENSION, CARRIED BACK RATHER THAN RE-DERIVED FROM THE COPY.
 * Branching a PostHog property on a user-facing string would mean every copy edit silently
 * re-buckets a dashboard.
 */
export type InviteMeetingGuestsResult =
  | {
      readonly success: true;
      readonly invitedCount: number;
      readonly participantCount: number;
      readonly participantCap: number;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly outcome: Exclude<MeetingPanelInviteOutcome, 'ok'>;
    };

/**
 * ⚠⚠ `already_decided` IS NOT A FAILURE — it is the two-hosts race answer (`409
 * guest_not_pending`). The panel renders it as an INFORMATIONAL toast plus a refetch, never
 * as an error: the outcome the host wanted has happened, just not by their click.
 */
export type DecideAdmissionActionResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: string;
      readonly outcome: Exclude<MeetingPanelDecisionOutcome, 'ok'>;
    };

export type ResendLinkActionResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

/** BAL-423's shipped file actions, re-stated as the shape the panel is handed. */
export type ListMeetingFilesActionResult =
  | { readonly success: true; readonly files: MeetingFileView[] }
  | { readonly success: false; readonly error: string };

export type RequestUploadActionResult =
  | { readonly success: true; readonly presignedUrl: string; readonly key: string }
  | { readonly success: false; readonly error: string };

export type ConfirmUploadActionResult =
  | { readonly success: true; readonly file: MeetingFileView }
  | { readonly success: false; readonly error: string };

export type DownloadFileActionResult =
  | { readonly success: true; readonly url: string }
  | { readonly success: false; readonly error: string };

/** The Files half of the registration, grouped so the People half reads cleanly. */
export interface MeetingFilePanelActions {
  readonly list: () => Promise<ListMeetingFilesActionResult>;
  readonly requestUpload: (input: {
    contentType: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<RequestUploadActionResult>;
  readonly confirmUpload: (input: {
    key: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<ConfirmUploadActionResult>;
  readonly download: (fileId: string) => Promise<DownloadFileActionResult>;
}

// ── BAL-437 — the CHAT slot and the REALTIME transport ──────────────────────────────────

export type FetchMeetingThreadResult =
  | {
      readonly success: true;
      /** Chronological, oldest first — the order the list renders top-down. */
      readonly messages: readonly ConversationMessageView[];
      readonly hasEarlier: boolean;
      /**
       * ⚠ FOR OWN-vs-OTHER BUBBLE ALIGNMENT, AND THE PANEL GETS NO OTHER IDENTITY. Not a
       * capability, not a lens — the viewer's own `users.id`, which they already know.
       */
      readonly viewerUserId: string;
      /** ⚠ `false` ⇒ THE COMPOSER IS READ-ONLY. History stays fully readable either way. */
      readonly writable: boolean;
    }
  | { readonly success: false; readonly error: string };

export type PostMeetingMessageResult =
  | { readonly success: true; readonly message: ConversationMessageView }
  | { readonly success: false; readonly error: string };

export type SendMeetingReactionResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

/**
 * The Chat half of the registration.
 *
 * ⚠ THE UPLOAD PAIR IS THE **SAME** ACTION THE FILES DROP USES, bound with `source: 'chat'`.
 * One publisher, one publish, two entry points — that is the "one shared fan-out" acceptance
 * criterion made structural rather than conventional. There is deliberately no `list` here:
 * the chat timeline's inline file rows are a VIEW over the Files panel's own read.
 */
export interface MeetingChatPanelActions {
  readonly fetchThread: (before?: {
    createdAtIso: string;
    id: string;
  }) => Promise<FetchMeetingThreadResult>;
  readonly postMessage: (body: string) => Promise<PostMeetingMessageResult>;
  readonly requestUpload: (input: {
    contentType: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<RequestUploadActionResult>;
  /** ⚠ BOUND WITH `source: 'chat'` in `call-client.tsx` — the mirror of the Files drop. */
  readonly confirmUpload: (input: {
    key: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<ConfirmUploadActionResult>;
}

/**
 * The realtime transport for the whole call.
 *
 * ⚠⚠ `null` ON THE REGISTRATION ⇒ NO `ABLY_API_KEY` ⇒ **THE REACTIONS CONTROL IS ABSENT.** A
 * reaction with no transport reaches nobody, which is precisely the "broken affordance dressed
 * as a working one" the slot rule forbids. Chat STAYS registered in that state, because chat
 * has a durable record and works entirely over HTTP — it degrades visibly with one line in the
 * panel instead.
 *
 * ⚠ BOTH CHANNEL NAMES ARE BUILT SERVER-ADJACENT (in `call-client.tsx`, from the RSC's
 * resolution) rather than assembled inside the hook, for the same reason `meetingId` is not on
 * this interface: no panel component handles an id it could point at the wrong call.
 */
export interface MeetingRealtimeRegistration {
  /** Re-runs the FULL tenancy gate on every ably-js refresh (≤15 min). */
  readonly fetchToken: () => Promise<RealtimeTokenResult>;
  /**
   * ⚠⚠ THE REACTION RIDES A **SERVER ACTION**, NOT A CLIENT PUBLISH (ruling R2). That is what
   * keeps the client's meeting-channel token subscribe-only, and it is why the payload carries
   * an opaque `nonce` the sender uses to drop its own echo.
   */
  readonly sendReaction: (input: {
    emoji: MeetingReactionEmoji;
    nonce: string;
  }) => Promise<SendMeetingReactionResult>;
  /** `meeting:{meetingId}` — reactions and file invalidations. Always present. */
  readonly meetingChannel: string;
  /** `conversation:{conversationId}`, or `null` when the meeting has no anchor. */
  readonly conversationChannel: string | null;
}

export interface MeetingPanelRegistration {
  /**
   * ⚠⚠ THE BARE, **TOKENLESS** JOIN URL — `${APP_URL}/join/m/{meetingId}`. Built server-side.
   *
   * The raw guest token never comes back from the api and the UI never builds a link
   * (`guests.ts` contract point 4). Anyone opening this lands in the pending lobby and must
   * be admitted, which is exactly what the button's helper line says.
   */
  readonly joinLinkUrl: string;
  readonly loadGuests: () => Promise<GetMeetingGuestsResult>;
  readonly inviteGuests: (emails: readonly string[]) => Promise<InviteMeetingGuestsResult>;
  readonly decideAdmission: (
    guestId: string,
    decision: 'admit' | 'deny'
  ) => Promise<DecideAdmissionActionResult>;
  readonly resendLink: (guestId: string) => Promise<ResendLinkActionResult>;
  readonly files: MeetingFilePanelActions;
  /**
   * BAL-437 — ⚠⚠ `null` ⇒ **NO CHAT SLOT AT ALL.** Resolved SERVER-SIDE in the RSC, not in the
   * browser: resolving it client-side would flash a Chat button on mount and vanish it when
   * the first answer arrived. See {@link MeetingPanelId} for the four shapes that answer null.
   */
  readonly chat: MeetingChatPanelActions | null;
  /** BAL-437 — ⚠⚠ `null` ⇒ NO REACTIONS CONTROL. See {@link MeetingRealtimeRegistration}. */
  readonly realtime: MeetingRealtimeRegistration | null;
}
