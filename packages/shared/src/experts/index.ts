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
