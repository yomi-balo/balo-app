/**
 * The public "Add to calendar" page, `/add-to-calendar/{token}` — linked from the calendar invite
 * email. Pure constant (Edge-safe): `apps/web`'s route registry and the redaction registry both
 * key on it. The token module is `@balo/shared/calendar-link-token` (server-only).
 */
export const ADD_TO_CALENDAR_PATH_PREFIX = '/add-to-calendar/';
