export {
  type CalendarConnectProvider,
  CALENDAR_CONNECT_PROVIDERS,
  calendarConnectNonceCookieName,
  calendarConnectCookieDomain,
} from './connect-cookie';

// BAL-397 §13.1 — no `.js` extension on this relative re-export. Unlike `apps/api`,
// `packages/shared` is consumed as raw TypeScript by Turbopack; a `.js` suffix here 404s at
// build time while every local gate (tsc, eslint, vitest) stays green.
export { EXPERT_CALENDAR_SETTINGS_PATH } from './settings-path';

// BAL-475 §6 — the ONE definition of RFC 5545 §3.3.11 TEXT escaping. No `.js` extension —
// see the note above.
export { escapeIcsText } from './ics-text';

// One-click "create event" links for the web calendars. No `.js` extension — see the note above.
export {
  buildGoogleCalendarLink,
  buildOutlookCalendarLink,
  toIcsUtcStamp,
  type CalendarLinkInput,
  type OutlookCalendarKind,
} from './calendar-links';
export { ADD_TO_CALENDAR_PATH_PREFIX } from './add-to-calendar-path';

// BAL-603 — the ONE busy-read trust rule (`listBusyBlocks` fails closed on it; web derives the
// "Bookings paused" status from it). No `.js` extension — see the note above.
export {
  BUSY_READABLE_CREDENTIAL_STATUS,
  type BusyReadTargetState,
  isConsideredForBusyRead,
  isUnreadable,
  unreadableBusyReadTargets,
} from './busy-read';
