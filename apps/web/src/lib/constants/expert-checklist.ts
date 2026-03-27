export const CHECKLIST_ITEMS = [
  { key: 'profile', label: 'Complete your profile', tab: 'profile' },
  { key: 'phone', label: 'Verify your phone', tab: 'profile' },
  { key: 'rate', label: 'Set your rate', tab: 'rate' },
  { key: 'calendar', label: 'Connect calendar', tab: 'schedule' },
  { key: 'availability', label: 'Set your availability', tab: 'schedule' },
  { key: 'payouts', label: 'Set up payouts', tab: 'payouts' },
] as const;

export type ChecklistItemKey = (typeof CHECKLIST_ITEMS)[number]['key'];
