// ── Date formatting (display only; no timezone math) ─────────────
//
// Moved out of `date-overrides-card.tsx` (BAL-416) so `date-override-add-popover.tsx` can
// reuse it for the warning view's range label without a circular import between the card
// and the popover (the card renders the popover) or a second copy of this ~15-line
// formatter (SonarCloud's cross-file duplication gate).

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const [ys, ms, ds] = iso.split('-');
  if (ys === undefined || ms === undefined || ds === undefined) return null;
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return { y, m, d };
}

function formatDay(iso: string, withWeekday: boolean): string {
  const parsed = parseIso(iso);
  if (!parsed) return iso;
  const month = MONTHS[parsed.m - 1] ?? '';
  const base = `${parsed.d} ${month} ${parsed.y}`;
  if (!withWeekday) return base;
  const weekday = WEEKDAYS[new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDay()] ?? '';
  return `${weekday}, ${base}`;
}

/** Single day → `Thu, 25 Dec 2026`; range → `25 Dec 2026 – 2 Jan 2027`. */
export function formatOverrideRange(startIso: string, endIso: string): string {
  if (startIso === endIso) return formatDay(startIso, true);
  return `${formatDay(startIso, false)} – ${formatDay(endIso, false)}`;
}
