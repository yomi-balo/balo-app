import {
  narrowToProjectRequestCloseReason,
  type ProjectRequestCloseReason,
} from '@balo/shared/project-requests';

/**
 * BAL-540 — the `project_request_close_reason` CATEGORY → its client-facing label. Shared by
 * the email template (`index.ts`) and the in-app template (`in-app-templates.ts`) so the two
 * copies of "why was my request closed" can never drift (a repeated string union / lookup would
 * trip the SonarCloud new-code duplication gate).
 *
 * The union and its narrowing both come from `@balo/shared/project-requests` — the ONE
 * definition, shared with the notification payload, the analytics event map and the web
 * surfaces. This module owns only the LABELS.
 *
 * ⚠ NEVER RENDERS `close_note` — the note is staff-only (D11) and never leaves the DB. This is
 * the CATEGORY label only.
 */
export const REASON_LABEL: Record<ProjectRequestCloseReason, string> = {
  // A client never sees this rendered (the client-closed arm fires no email — a toast only),
  // but the map stays total so a future caller cannot silently fall through.
  withdrawn: 'it was withdrawn', // pending-MJ
  declined: 'Balo declined to proceed with it', // pending-MJ
  unfilled: 'no expert was available in time', // pending-MJ
  superseded: 'the work is now covered elsewhere', // pending-MJ
};

/** Narrow the merged payload's `reason`; anything unknown degrades to `'unfilled'`. */
export function readCloseReason(value: unknown): ProjectRequestCloseReason {
  return narrowToProjectRequestCloseReason(value) ?? 'unfilled';
}
