/**
 * BAL-396 §7.3 / §11.2 — the ONE place a Balo-facing provider DISPLAY LABEL is derived from
 * the raw `'google' | 'microsoft'` vocabulary.
 *
 * ⚠⚠ THIS FUNCTION MUST LIVE HERE, NOT IN `notifications/`. Both the reconnect email
 * (`notifications/channels/templates/index.ts`) and its in-app counterpart
 * (`notifications/channels/templates/in-app-templates.ts`) need a human-readable label for
 * `CalendarAuthErrorPayload.provider`, and originally each declared its own private
 * `calendarProviderLabel` — two copies of the same branch, both OUTSIDE the two directories
 * `invariants/sync-token-parity.test.ts`'s Scan B exempts (`lib/apiroc/`, `routes/calendar/`).
 * Scan B is TREE-WIDE over `apps/api/src` as of ADR-1021's 18 Aug 2026 (BAL-396) amendment §1
 * precisely so a provider-name branch cannot be written anywhere else — `notifications/` is
 * explicitly named as newly-covered surface. The fix is not a third exemption (an allowlist
 * that grows is an invariant that stops being read); it is ONE shared function living inside
 * the vendor boundary that already exists for this vocabulary, imported by both call sites.
 *
 * Degrades anything unrecognised to the generic noun rather than throwing — the payload's
 * `provider` field is untyped at the merged-notification-payload boundary.
 *
 * ⚠⚠ BAL-396 FIX ROUND — INCLUDES THE TRAILING NOUN "calendar" WHERE IT DOESN'T ALREADY END
 * IN ONE, SO CALL SITES NEVER APPEND THEIR OWN. Both call sites used to interpolate this
 * value into `your ${providerLabel} calendar`, which — combined with a `'Google Calendar'`
 * return value — produced "your Google Calendar calendar", and on the generic fallback "your
 * calendar calendar". Composing the noun HERE, once, is what makes a doubled noun
 * structurally unreachable rather than a per-call-site discipline. `'microsoft'` already
 * lower-cases "calendar" since "Microsoft 365" (unlike "Google Calendar") is not itself a
 * product that carries the word.
 */
export function calendarProviderLabel(value: unknown): string {
  if (value === 'google') return 'Google Calendar';
  if (value === 'microsoft') return 'Microsoft 365 calendar';
  return 'calendar';
}
