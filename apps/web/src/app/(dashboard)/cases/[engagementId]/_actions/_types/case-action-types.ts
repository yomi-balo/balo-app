import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';

/**
 * BAL-421 — result shapes for the case surface's Server Actions. PLAIN TYPES ONLY.
 *
 * ⚠⚠ THIS MODULE EXISTS BECAUSE OF THE `'use server'` VALUE-EXPORT HAZARD. A `'use server'`
 * module may export ONLY async functions. An `export const` — or any exported non-async value,
 * including a `type` in a file that also exports one — fails `next build` with a
 * runtime-shaped error while `tsc`, ESLint AND vitest all pass: there is NO local gate that
 * catches it, and it only fails once the module is reachable from the client graph (memory
 * `reference_use_server_no_value_exports`). Declaring the shapes here and importing them back
 * with `import type` erases at compile and emits nothing into the action modules. Same reason
 * `meetings/[meetingId]/_actions/_types/recap-action-types.ts` exists.
 */

/** The uniform result the case surface's mutations return. Islands toast `error` verbatim. */
export type CaseActionResult = { success: true } | { success: false; error: string };

export type PostCaseMessageResult =
  | { success: true; message: ConversationMessageView }
  | { success: false; error: string };

export type FetchCaseThreadResult =
  | {
      success: true;
      messages: ConversationMessageView[];
      hasEarlier: boolean;
      files?: ConversationFileView[];
    }
  | { success: false; error: string };

export type MarkCaseThreadReadResult =
  | { success: true; lastReadAtIso: string }
  | { success: false; error: string };

export type RequestCaseFileUploadResult =
  | { success: true; presignedUrl: string; key: string }
  | { success: false; error: string };

export type ConfirmCaseFileUploadResult =
  | { success: true; file: ConversationFileView }
  | { success: false; error: string };

export type GetCaseFileDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

/** BAL-409 — `rescheduleConsultationAction`'s failure vocabulary, mapped from the api's fixed
 *  literals + the transport layer's own `unauthenticated`/`request_failed`. Never a raw
 *  `err.message` — see `reschedule-consultation.ts`. */
export type RescheduleFailureCode =
  | 'unauthenticated'
  | 'invalid_request'
  | 'not_permitted'
  | 'meeting_not_found'
  | 'meeting_not_reschedulable'
  | 'slot_unavailable'
  | 'rate_limited'
  | 'unknown';

export interface RescheduleConsultationInput {
  engagementId: string;
  meetingId: string;
  /** The picker's selected start — ISO. The end is SERVER-COMPUTED from the current duration. */
  startIso: string;
}

export type RescheduleConsultationResult =
  | {
      success: true;
      /** The SERVER's committed values, never the client's submitted slot. */
      scheduledStart: string;
      scheduledEnd: string;
    }
  | { success: false; code: RescheduleFailureCode; error: string };

// ── BAL-410 — cancel a booked consultation ──────────────────────────────────────────────

/**
 * BAL-410 — `cancelConsultationAction`'s failure vocabulary, mapped from the api's fixed
 * literals + the transport layer's own `unauthenticated`/`request_failed`. Never a raw
 * `err.message` — same rule as its reschedule sibling.
 *
 * ⚠ DELIBERATELY NOT `RescheduleFailureCode | …`. Cancel cannot produce `slot_unavailable` (it
 * consumes no slot and makes no availability read), and reusing the union would put a
 * permanently-unreachable arm in the dialog's failure map that SonarCloud counts as uncovered.
 */
export type CancelFailureCode =
  | 'unauthenticated'
  | 'invalid_request'
  | 'not_permitted'
  | 'meeting_not_found'
  | 'meeting_not_cancellable'
  | 'rate_limited'
  | 'unknown';

export interface CancelConsultationInput {
  engagementId: string;
  meetingId: string;
}

export type CancelConsultationResult =
  | {
      success: true;
      /** ISO — the SERVER's released window, never anything the client submitted. */
      scheduledStart: string;
      /**
       * WHICH AXIS authorized it, straight from the api. ⚠ The dialog reports THIS as
       * `initiated_by`; it must never re-derive the value from the lens.
       */
      initiatedBy: 'client' | 'expert' | 'admin';
      /**
       * Whether a credit hold was released. `false` is the common case (nobody joined early).
       *
       * ⚠ `null` MEANS "NOT DISCLOSED", NEVER "no hold was released" — the api returns this on
       * the CLIENT arm only (security LOW-1: the hold is the client's money, and the expert-side
       * surfaces deliberately withhold its state). Nothing renders it; it is logged only.
       */
      holdReleased: boolean | null;
    }
  | { success: false; code: CancelFailureCode; error: string };

/**
 * BAL-411 — the reschedule-PROPOSAL failure vocabulary. Extends `RescheduleFailureCode` (the
 * shipped BAL-409 union) with the four literals the proposal API adds — never a raw
 * `err.message`, same rule as its sibling.
 */
export type RescheduleProposalFailureCode =
  | RescheduleFailureCode
  | 'proposal_not_answerable'
  | 'proposal_stale'
  | 'proposal_already_pending'
  | 'case_closed';

// ── propose (EXPERT — engagement axis) ──────────────────────────────────────────────────

export interface ProposeRescheduleInput {
  engagementId: string;
  meetingId: string;
  /** 1..3 ISO instants, in display order — the ends are ALWAYS server-pinned. */
  optionStartIsos: string[];
}

export interface ProposeRescheduleOptionResult {
  optionId: string;
  scheduledStart: string;
  scheduledEnd: string;
  position: number;
}

export type ProposeRescheduleResult =
  | {
      success: true;
      proposalId: string;
      meetingId: string;
      expiresAtIso: string;
      options: ProposeRescheduleOptionResult[];
    }
  | { success: false; code: RescheduleProposalFailureCode; error: string };

// ── withdraw (EXPERT — engagement axis) ─────────────────────────────────────────────────

export interface WithdrawRescheduleProposalInput {
  engagementId: string;
  meetingId: string;
  proposalId: string;
}

export type WithdrawRescheduleProposalResult =
  | { success: true; proposalId: string }
  | { success: false; code: RescheduleProposalFailureCode; error: string };

// ── accept (CLIENT — membership axis) ───────────────────────────────────────────────────

export interface AcceptRescheduleProposalInput {
  engagementId: string;
  meetingId: string;
  proposalId: string;
  optionId: string;
}

export type AcceptRescheduleProposalResult =
  | {
      success: true;
      proposalId: string;
      /** The SERVER's committed values, never the client's submitted option. */
      scheduledStart: string;
      scheduledEnd: string;
    }
  | { success: false; code: RescheduleProposalFailureCode; error: string };

// ── decline (CLIENT — membership axis) ──────────────────────────────────────────────────

export interface DeclineRescheduleProposalInput {
  engagementId: string;
  meetingId: string;
  proposalId: string;
}

export type DeclineRescheduleProposalResult =
  | { success: true; proposalId: string }
  | { success: false; code: RescheduleProposalFailureCode; error: string };
