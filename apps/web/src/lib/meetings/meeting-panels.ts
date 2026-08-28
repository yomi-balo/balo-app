import type { GuestForViewer } from '@balo/shared/meetings';
import type { DrawdownState } from '@balo/shared/credit';
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
 * ── ⚠⚠ THE GUEST SEAM — BAL-445 OPENED READ-ONLY FILES + CHAT; WRITE STAYS CLOSED ────────
 *
 * A guest now gets a READ-ONLY Files list and a READ-ONLY Chat transcript, never reactions and
 * never authorship. Of the three structural closures the pre-BAL-445 version of this docblock
 * named, two are now DELIBERATE NARROWINGS rather than absences, and one still fully holds:
 *
 *   1. Both guest mounts (`join/[token]/join-control.tsx`, `join/m/[meetingId]/lobby-client.tsx`)
 *      DO mount `MeetingRouteContextProvider` now, with a `MeetingGuestPanelRegistration` —
 *      a narrower TYPE than the member one, not the member one with flags off. See
 *      `MeetingGuestPanelRegistration`'s own docblock.
 *   2. The guest READ actions (`app/join/_actions/{list,get,fetch}-guest-…`) gate on
 *      `resolveMeetingGuestSubject`, the BAL-445 per-request subject resolver — an AUTH HELPER,
 *      not `requireUser()`. The four MEMBER in-call actions are untouched and still gate on
 *      `requireUser()` / `requireOnboardedUser()`, which a guest satisfies neither of.
 *   3. `conversation_messages.sender_user_id` is STILL `notNull` with an FK to `users.id` — this
 *      is the ONE REMAINING BLOCK, and it is slice 4's (a split-out ticket, guest authorship).
 *      A guest still cannot author a message at all without that migration.
 *
 * The predicate IS now called — `authorizeMeetingFileAccess`'s guest arm and
 * `resolveMeetingChatAccess`'s guest arm both call `guestMayReadMeeting` /
 * `resolveGuestConversationScope`, the shipped scope rules, exactly once each. It is called
 * from the GATE, never from a component.
 *
 * ── ⚠⚠ BAL-403 ADDED `'balance'`; BAL-466 MADE IT REACHABLE FOR A `case` CONSULTATION ────────
 *
 * `MeetingPanelRegistration.balance !== null` requires a `credit_sessions` row for THIS
 * meeting. `apps/web`'s `openSessionAction` still has zero non-test callers — the seam is
 * server-side (`connectSessionAction` no longer exists — F1 of the BAL-466 fix round deleted
 * it): `joinMeetingAsMember` (`apps/api`) opens a
 * `duration_source='presence'` session when the first CLIENT-side member is admitted to a
 * `case` meeting. `hasBalance: false` is still the answer for every non-`case` meeting and for
 * a Case whose client has not yet been admitted — not a bug: no slot button, no More-sheet row,
 * no poll, no fetch, no panel. See `page.tsx`'s `resolveBalanceSlot` docblock for the full
 * reasoning.
 */
export type MeetingPanelId = 'people' | 'files' | 'chat' | 'balance';

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

/**
 * BAL-445 — the GUEST read of the in-call thread.
 *
 * ⚠ THERE IS NO `viewerUserId` AND NO `writable` HERE, AND BOTH ABSENCES ARE THE POINT. A
 * guest has no `users.id`, so own-vs-other bubble alignment is unanswerable and every bubble
 * renders as somebody else's. And there is no composer to report writability to — R9: absence
 * beats disablement.
 */
export type FetchGuestMeetingThreadResult =
  | {
      readonly success: true;
      readonly messages: readonly ConversationMessageView[];
      readonly hasEarlier: boolean;
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

// ── BAL-403 — the BALANCE slot ───────────────────────────────────────────────────────────

/**
 * ⚠ `retryable` DISTINGUISHES A TRANSPORT BLIP FROM A VERDICT, exactly as the guests result
 * does above — the poll keeps its schedule on the first, stops on the second.
 *
 * ⚠⚠ THE FIRST `success: true` ARM CARRIES `sessionId` AND THE SECOND DOES NOT — that is the
 * discriminant a consumer narrows on. The id is returned BY the server's own answer, never
 * supplied TO the client as configuration: `MeetingBalancePanelActions` stays id-free (the
 * registration closes over `meetingId` only, per the rule at the top of this file), and every
 * consumer of the id (`nudgeAdminAction`, `in_session_panel_viewed`'s property) re-gates
 * server-side on its own, so the id is an opaque UUID that authorizes nothing by itself.
 *
 * ⚠⚠ THE SECOND ARM — `{ success: true, state: null }` — IS A **SUCCESS, NOT AN ERROR**. See
 * {@link MeetingPanelId}'s BAL-403 note. It means `credit_sessions.meeting_id` resolved to no
 * row (or a soft-deleted / cancelled one) — the ordinary answer for every non-`case` meeting and
 * for a Case whose client has not yet been admitted. ⚠⚠ G4 (second review round) — CORRECTING A
 * NOW-FALSE CLAIM: this used to say that was true "of every meeting until the session-open
 * ticket ships". BAL-466 shipped that ticket — the first arm above IS now reachable, for an
 * admitted Case consultation. Never surface the second arm as an error state.
 */
export type GetMeetingDrawdownResult =
  | { readonly success: true; readonly state: DrawdownState; readonly sessionId: string }
  | { readonly success: true; readonly state: null }
  | { readonly success: false; readonly error: string; readonly retryable: boolean };

/** The Balance half of the registration — one callback, closing over `meetingId`. */
export interface MeetingBalancePanelActions {
  /** ⚠ CLOSES OVER `meetingId` IN `call-client.tsx`. No id crosses this interface. */
  readonly loadDrawdownState: () => Promise<GetMeetingDrawdownResult>;
}

/** Everything the member route registers today, unchanged, plus the discriminant (BAL-445). */
export interface MeetingMemberPanelRegistration {
  readonly audience: 'member';
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
  /**
   * BAL-403 — ⚠⚠ `null` ⇒ **NO BALANCE SLOT AT ALL.** Resolved SERVER-SIDE in the RSC
   * (`resolveBalanceSlot` in `page.tsx`), not in the browser, for the identical no-flash reason
   * `chat` is. ⚠⚠ G4 (second review round) — CORRECTING A NOW-FALSE CLAIM: this used to say
   * "`false`/`null` is the EXPECTED value for every meeting today… this is the forward seam;
   * nothing opens a credit session yet." BAL-466 is that seam and it now opens one:
   * `joinMeetingAsMember` opens a `duration_source='presence'` session the moment the first
   * CLIENT-side member is admitted to a `case` meeting, so this slot is non-null from that
   * point on. `null`/`false` remains the correct, EXPECTED answer for every non-`case` meeting
   * and for a Case whose client has not yet been admitted — see {@link MeetingPanelId}'s
   * BAL-403 note.
   */
  readonly balance: MeetingBalancePanelActions | null;
}

// ── BAL-445 — the GUEST registration: a NARROWER TYPE, not the member one with flags off ──

/**
 * ⚠ READ-ONLY BY CONSTRUCTION. Two callbacks and one nullable slot — that is the whole surface.
 * There is NO `requestUpload`, NO `confirmUpload` on this interface — a guest may not upload,
 * and there is no expression in the type system that reaches one from here.
 */
export interface MeetingGuestFilePanelActions {
  readonly list: () => Promise<ListMeetingFilesActionResult>;
  readonly download: (fileId: string) => Promise<DownloadFileActionResult>;
}

/**
 * ⚠ NO `postMessage`, NO upload pair. A guest reads the transcript; there is no composer to
 * report writability to.
 */
export interface MeetingGuestChatPanelActions {
  readonly fetchThread: (before?: {
    createdAtIso: string;
    id: string;
  }) => Promise<FetchGuestMeetingThreadResult>;
}

/**
 * ⚠⚠ THE GUEST REGISTRATION IS A **NARROWER TYPE**, NOT THE MEMBER ONE WITH FLAGS SET FALSE
 * (R9). A boolean like `canUpload: false` would leave the upload callback sitting on the
 * object, one `if` away from being reached. Absence of the CALLBACK is what replaces it: there
 * is no expression in the type system that reaches an upload, an invite, a realtime token or a
 * balance read from here.
 */
export interface MeetingGuestPanelRegistration {
  readonly audience: 'guest';
  readonly files: MeetingGuestFilePanelActions;
  /** `null` ⇒ NO CHAT SLOT AT ALL — the meeting resolved to no conversation anchor. */
  readonly chat: MeetingGuestChatPanelActions | null;
  // ⚠ NO `joinLinkUrl` (a guest may not invite), NO People callbacks, NO `realtime`
  //    (BAL-437 mints no guest Ably token), NO `balance` (a guest is not the payer).
}

export type MeetingPanelRegistration =
  | MeetingMemberPanelRegistration
  | MeetingGuestPanelRegistration;
