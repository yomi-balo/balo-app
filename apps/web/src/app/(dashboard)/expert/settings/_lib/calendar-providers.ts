import { GoogleIcon, MicrosoftIcon } from '../_components/calendar-provider-icons';
import type { CalendarCredentialStatus, CalendarProvider } from '../_types/calendar';

export interface CalendarProviderMeta {
  readonly label: string;
  readonly sublabel: string;
  readonly Icon: (props: { size?: number }) => React.JSX.Element;
}

/**
 * Stable render order. The API returns connections in insertion order; the UI must not reorder
 * cards when a connection is added or removed.
 */
export const PROVIDER_ORDER = [
  'google',
  'microsoft',
] as const satisfies readonly CalendarProvider[];

export const PROVIDER_META: Record<CalendarProvider, CalendarProviderMeta> = {
  google: { label: 'Google Calendar', sublabel: 'Google Workspace or Gmail', Icon: GoogleIcon },
  microsoft: {
    label: 'Microsoft Outlook',
    sublabel: 'Microsoft 365 or Outlook.com',
    Icon: MicrosoftIcon,
  },
};

/**
 * BAL-396 fix round, Finding 2 — a real guard, not `as CalendarProvider`. Moved here from its
 * former private home in `calendar-tab.tsx` (BAL-397): it guards a browser-editable
 * query-string value and now has three call sites, so it can no longer stay private to one
 * component.
 */
export function isCalendarProvider(value: string | null | undefined): value is CalendarProvider {
  return value === 'google' || value === 'microsoft';
}

/**
 * BAL-397 — sibling guard for `?calendar_status=`, which is equally browser-editable. An
 * unrecognised value must be treated as absent, never cast.
 */
export function isCalendarCredentialStatus(
  value: string | null | undefined
): value is CalendarCredentialStatus {
  return (
    value === 'ACTIVE' || value === 'SYNC_PENDING' || value === 'EXPIRED' || value === 'REVOKED'
  );
}
