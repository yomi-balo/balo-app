import type { StaffAccessPerson, StaffAccessSaveRefusal } from '@balo/shared/authz';

/**
 * BAL-561 — the client-safe outcome layer for both Staff access Server Actions, following the
 * `decision-staleness.ts` / W3 lesson from Applications: the failure-code union and its messages
 * live where BOTH a `'use server'` action (which produces them) and a `'use client'` component
 * (which must branch on them) can import from. No `server-only` here.
 */

/**
 * Every failure code `saveStaffAccessAction` can return. `actor_not_authorized` from the shared
 * refusal union is EXCLUDED — `save-staff-access.ts` maps it to `'denied'` before returning (F8:
 * NOT the gate helper, `require-staff-access-manager.ts`, which never sees this refusal at all —
 * it only ever returns its OWN denial before the transaction runs), so the two never appear side
 * by side with different copy for the same underlying cause.
 */
export type StaffAccessFailureCode =
  | Exclude<StaffAccessSaveRefusal, 'actor_not_authorized'>
  | 'denied'
  | 'invalid'
  | 'failed';

export type StaffCandidateFailureCode = 'not_found' | 'invalid' | 'denied' | 'failed';

/** All gender-neutral, pending-MJ. `denied` is the gate helper's own denial string. */
export const STAFF_ACCESS_SAVE_MESSAGES: Readonly<Record<StaffAccessFailureCode, string>> = {
  denied: 'You do not have permission to do this.',
  invalid: 'That request was not valid. Reload and try again.',
  failed: 'The change did not save. Nothing was changed — try again.',
  self_edit: 'You cannot change your own access. Ask another super admin.',
  target_not_found: 'That account no longer exists.',
  stale:
    "This person's access changed since you opened it. Reload to see the latest before saving.",
  no_change: 'Nothing to save — access is already set this way.',
  unknown_capability: 'One of those capabilities no longer exists. Reload and try again.',
  custom_list_requires_staff_role: 'A custom list needs the Admin or Super admin role.',
  staff_management_requires_super_admin:
    'Only a super admin can hold "Change what other staff can do".',
  floor_violation:
    'Someone must still be able to open this page and manage staff. Give that access to someone else first.',
  target_ineligible:
    "This account can't be given more access while it's suspended or its email address isn't verified.",
};

export const STAFF_CANDIDATE_MESSAGES: Readonly<Record<StaffCandidateFailureCode, string>> = {
  denied: 'You do not have permission to do this.',
  invalid: 'Enter a full email address.',
  not_found: 'No account found with that email.',
  failed: 'The lookup did not run. Try again.',
};

/**
 * Does this failure mean the page the operator reviewed is out of date? `stale` and
 * `target_not_found` mean the target changed under them; `floor_violation` means another save
 * landed first and changed who else holds the floor; `unknown_capability` means a stored token
 * the UI didn't know about reached the mutator (a retired-token edge, D6-adjacent);
 * `target_ineligible` (F1) means the target's live/verified state may have changed since the page
 * loaded — a reload is the only way to see whether it still would. None of the others say
 * anything about staleness — `self_edit`, the two `custom_list_*` refusals, `no_change`, `denied`,
 * `invalid` and `failed` are all true regardless of when the page was loaded.
 */
export function staffAccessFailureNeedsReload(code: StaffAccessFailureCode): boolean {
  return (
    code === 'stale' ||
    code === 'target_not_found' ||
    code === 'floor_violation' ||
    code === 'unknown_capability' ||
    code === 'target_ineligible'
  );
}

export type SaveStaffAccessActionResult =
  | { readonly success: true; readonly roleChanged: boolean; readonly customListChanged: boolean }
  | { readonly success: false; readonly code: StaffAccessFailureCode; readonly error: string };

export type FindStaffCandidateActionResult =
  | { readonly success: true; readonly person: StaffAccessPerson }
  | { readonly success: false; readonly code: StaffCandidateFailureCode; readonly error: string };
