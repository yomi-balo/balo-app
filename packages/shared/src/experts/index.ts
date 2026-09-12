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
