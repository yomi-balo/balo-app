/**
 * BAL-435 (ruling R10) — THE SCHEDULED START, IN THE **VIEWER's** OWN TIMEZONE.
 *
 * ⚠⚠ THE FORMATTING HAPPENS IN THE BROWSER, DELIBERATELY. The server does not know the viewer's
 * zone, and "Due to start at 10:00" stated in the wrong zone — on a surface whose sibling
 * sentences settle money — is worse than saying nothing at all. So the API sends an INSTANT
 * (ISO 8601) and this turns it into a label.
 *
 * ⚠ `undefined` LOCALE ON PURPOSE: the runtime's own locale, not a hardcoded `en-US`, so a
 * 24-hour-clock viewer sees a 24-hour clock.
 *
 * ⚠ `null` IN ⇒ `null` OUT, and an unparseable instant is also `null` — the caller then has no
 * subject at all and the waiting stage renders party-neutral copy. Never a placeholder string:
 * `"the scheduled time"` shipped as a literal once already.
 */
export function formatScheduledStartLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
