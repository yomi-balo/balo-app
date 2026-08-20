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
