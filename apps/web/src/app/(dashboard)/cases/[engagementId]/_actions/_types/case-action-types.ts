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
