import 'server-only';
import type { AdminApplicationsEventMap } from '@/lib/analytics';

/**
 * BAL-593 — copy + result shape for `editExpertApplicationAction`, mirroring
 * `_shared/decision-outcome.ts`'s split: a `server-only` module for the copy and the result
 * type, a client-safe sibling (here, the `code` union is small enough to live inline) for
 * anything a `'use client'` caller must branch on.
 *
 * ⚠ A SEPARATE `code` UNION FROM `DecisionFailureCode` — `'not_editable'` is this action's own
 * outcome (a decline landed between page-load and save), never folded into the decide actions'
 * `'not_pending'` / `'gone'` pair, and this union carries no `'not_pending'` at all: an edit does
 * not race a pending-vs-decided distinction, it races pending-vs-ineditable.
 *
 * `'invalid_experience'` maps the repository's `invalid_experience` outcome — a delta whose
 * effective (locked snapshot merged with the edit) lead count exceeds its effective involved
 * count. The repository refuses the write before anything is committed, so this reaches the
 * client with its own copy — never folded into the generic
 * `APPLICATION_EDIT_FAILURE`, which would read as an unexplained save failure rather than naming
 * the rule that was violated.
 */
export const APPLICATION_EDIT_GONE = 'That application no longer exists.'; // pending-MJ
export const APPLICATION_EDIT_NOT_EDITABLE = 'That application can no longer be edited.'; // pending-MJ
export const APPLICATION_EDIT_FAILURE =
  "Couldn't save the changes. Nothing was written, so try again."; // pending-MJ
export const APPLICATION_EDIT_INVALID_EXPERIENCE =
  "Projects led can't be more than total projects. Nothing was written."; // pending-MJ

export type EditApplicationActionResult =
  | {
      success: true;
      changed: true;
      live: boolean;
      analytics: AdminApplicationsEventMap['admin_applications_edited'];
    }
  | { success: true; changed: false }
  | {
      success: false;
      error: string;
      code?: 'denied' | 'gone' | 'not_editable' | 'invalid_experience';
    };
