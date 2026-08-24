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
