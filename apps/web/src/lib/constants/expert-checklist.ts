export const CHECKLIST_ITEMS = [
  { key: 'profile', label: 'Complete your profile' },
  { key: 'phone', label: 'Verify your phone' },
  { key: 'rate', label: 'Set your rate' },
  { key: 'calendar', label: 'Connect calendar' },
  { key: 'availability', label: 'Set your availability' },
  { key: 'payouts', label: 'Set up payouts' },
] as const;

export type ChecklistItemKey = (typeof CHECKLIST_ITEMS)[number]['key'];

/**
 * BAL-566 fix round 2 (W2) — the ONE key → settings-tab mapping. Fix round 1 (F11) had
 * `CHECKLIST_ITEMS` carry its own `tab` field AND this record repeat the same six literals a
 * second time, with nothing tying the two together — a wrong tab in either place still compiled.
 * `CHECKLIST_ITEMS` no longer has a `tab` field: every reader of it in `apps/web/src`
 * (`expert-dashboard.tsx`, `expert/settings/page.tsx`, `setup-context-bar.tsx`) uses only `.key`
 * and/or `.label`, never `.tab`. This Record is now the SOLE definition, and `satisfies` keeps it
 * total BY CONSTRUCTION: TypeScript refuses to compile if a `ChecklistItemKey` is added above
 * without a matching entry here. No throw is needed, and none was reachable anyway — every
 * `ChecklistItemKey` value is a literal from `CHECKLIST_ITEMS` itself.
 */
const CHECKLIST_TAB_BY_KEY = {
  profile: 'profile',
  phone: 'profile',
  rate: 'rate',
  calendar: 'schedule',
  availability: 'schedule',
  payouts: 'payouts',
} as const satisfies Record<ChecklistItemKey, string>;

/**
 * BAL-566 — the ONE definition of "which settings tab does this checklist item deep-link to",
 * extracted from `getting-started-checklist.tsx`'s inline template so the dashboard's R2
 * calendar-disconnected banner can point at the exact same destination
 * (`expertSettingsHrefFor('calendar')` → `/expert/settings?tab=schedule&setup=calendar`, the same
 * URL Calendar's own connect CTA uses) without a second hand-written template.
 */
export function expertSettingsHrefFor(key: ChecklistItemKey): string {
  return `/expert/settings?tab=${CHECKLIST_TAB_BY_KEY[key]}&setup=${key}`;
}
