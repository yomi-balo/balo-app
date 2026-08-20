/**
 * BAL-397 §13.1 — the ONE path to the expert's calendar surface. It is a SECTION inside the
 * Schedule tab (`schedule-tab.tsx` renders `<CalendarConnectionsSection />` below the weekly
 * editor), not a tab of its own — `?tab=calendar` is not in `VALID_TABS` and silently falls
 * back to Profile. Callers append `&calendar_*` params, so this must stay query-shaped and
 * MUST NOT carry a fragment (a `#` would swallow everything appended after it).
 *
 * Fixes a dead link that existed in FOUR places before this constant: the OAuth callback
 * redirect, the reconnect in-app notification CTA, and the reconnect email CTA all sent the
 * expert to `?tab=calendar`, which `page.tsx` silently falls back to `profile` for — meaning
 * every callback-driven UI state in BAL-397 was unreachable in production, and the one
 * proactive channel Balo has (the reconnect email) sent the expert to a page with no calendar
 * on it.
 */
export const EXPERT_CALENDAR_SETTINGS_PATH = '/expert/settings?tab=schedule';
