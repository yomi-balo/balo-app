// ⚠ EXTENSIONLESS relative specifier — packages/shared ships raw TS consumed directly by
// Turbopack (no transpilePackages). A `.js` suffix here 404s at build time. Opposite rule to
// apps/api. See packages/shared/src/calendar/index.ts for the established precedent.
export {
  EXPERT_CHECKLIST_ITEM_KEYS,
  type ExpertChecklistItemKey,
  type ExpertCalendarConnectionState,
  type ExpertChecklistInputs,
  type ExpertChecklistItems,
  type ExpertChecklistDerivation,
  deriveExpertChecklist,
  hasLiveCalendarConnection,
  // BAL-566 R2 — the calendar-disconnected banner predicate, built ON the ANY-ACTIVE rule above.
  RECONNECT_NEEDED_CREDENTIAL_STATUSES,
  calendarConnectionNeedsReconnect,
  withCredentialStatusOverride,
  type ExpertSearchabilityTrigger,
  searchabilityTriggerFor,
  type ExpertSearchabilitySource,
  buildSearchabilityAnalyticsProperties,
} from './checklist';

// BAL-549 — the expert-application DECISION vocabulary (the client-safe restatement of the
// `expert_decline_reason` pgEnum, pinned to it by an `Exact<>` in `@balo/db`'s schema) plus the
// ONE days-waiting derivation the applications surfaces and the analytics property share.
export {
  EXPERT_DECLINE_REASONS,
  type ExpertDeclineReason,
  narrowToExpertDeclineReason,
  applicationWaitingDays,
} from './application-decision';

// BAL-549 FIX ROUND (F13) — the ONE project-count range vocabulary, shared by the applicant's
// picker, the applicant's review page and the staff review page (three drifting copies before).
export { PROJECT_COUNT_RANGES, type ProjectCountRange, projectRangeLabel } from './project-ranges';

// BAL-593 — a Balo-staff edit of an expert application: the editable-status vocabulary, the
// four edit sections and the delta the Server Action sends.
export {
  STAFF_EDITABLE_APPLICATION_STATUSES,
  type StaffEditableApplicationStatus,
  EXPERT_APPLICATION_EDIT_SECTIONS,
  type ExpertApplicationEditSection,
  type StaffApplicationEdit,
  type StaffApplicationEditCounts,
} from './application-edit';

// BAL-593 H1 — the one predicate gating an applicant-authored draft write against a row a staff
// edit may now also act on.
export {
  APPLICANT_POST_SUBMIT_GRACE_MS,
  type ApplicantDraftWriteDecision,
  classifyApplicantDraftWrite,
} from './applicant-write-window';

// The ONE language/industry cap definition, shared by the applicant
// profile save, the staff edit Zod schema and the wizard step schemas.
export { EXPERT_LANGUAGES_MAX, EXPERT_INDUSTRIES_MAX } from './expert-profile-limits';
