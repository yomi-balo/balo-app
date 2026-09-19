'use client';

import { useEffect, useState } from 'react';

import { relativeDay } from './relative-day';

/**
 * An ABSOLUTE date/time, in the VIEWER's timezone (BAL-388 §R2). A recap — and a case — is a
 * RECORD, so it never says "2 hours ago".
 *
 * ⚠ THE ZONE IS ANNOUNCED, NOT ONLY HOVERED. A `title` reaches a mouse and nothing else,
 * so the resolved zone is also rendered as an `sr-only` span — on a page whose whole job is to
 * be an authoritative record, a keyboard or screen-reader user must be able to tell WHICH
 * clock the timestamp is in.
 *
 * ⚠⚠ THE SERVER RENDER IS UTC AND THE CLIENT UPGRADES IT AFTER MOUNT. Formatting with the
 * browser timezone during the first render would produce server/client HTML that differs for
 * every viewer outside UTC — a hydration mismatch on every page load. The initial state is
 * therefore the SAME string the server produced, and `useEffect` swaps in the local one. This
 * is the entire reason this component exists rather than an inline `toLocaleString`, and it is
 * why the case surface reuses it rather than formatting dates of its own.
 *
 * ⚠ MOVED HERE FROM `meetings/[meetingId]/_components/` BY BAL-421 — MOVED, NOT COPIED. The
 * case surface is the second consumer, and a route-private `_components/` file imported from
 * another route is a lie about ownership. The `variant` prop below is ADDITIVE: `full` is the
 * default and the recap's call site is unchanged.
 *
 * ⚠ `timeZone` (BAL-416) IS ADDITIVE TOO, AND IT CHANGES THE UPGRADE RULE WHEN SUPPLIED. An
 * EXPLICIT zone is AUTHORITATIVE and is never upgraded to the viewer's — BAL-416 renders a
 * conflicting session in the EXPERT'S OWN schedule timezone (the same zone the resolver
 * expands their time-off block in), so "in the viewer's clock" would be a different, wrong
 * answer for a travelling expert. It also means server and client render the SAME string on
 * first paint, so this path has no hydration gap to close. All five pre-existing consumers
 * omit the prop and keep the viewer-upgrade behaviour above, byte-for-byte.
 */
export type LocalDateTimeVariant = 'full' | 'day-month' | 'day-month-time';

export function LocalDateTime({
  iso,
  variant = 'full',
  timeZone,
  relativeDays = false,
}: Readonly<{
  iso: string;
  variant?: LocalDateTimeVariant;
  timeZone?: string;
  /**
   * Render "Today at 6:00 pm" / "Tomorrow at 6:00 pm" when the instant falls on one of those
   * calendar days, falling back to `variant` otherwise. For APPOINTMENTS only — see
   * `relative-day.ts` for why this does not contradict the no-elapsed-time rule above.
   *
   * ⚠ Resolves only after mount, even with an explicit `timeZone`: it depends on `now`, which
   * server and client never agree on. First paint is always the absolute form.
   */
  relativeDays?: boolean;
}>): React.JSX.Element {
  const [label, setLabel] = useState(() => formatIn(iso, timeZone ?? 'UTC', variant));
  const [zone, setZone] = useState(timeZone ?? 'UTC');

  useEffect(() => {
    const resolved = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!resolved) return;
    setZone(resolved);
    setLabel(labelFor(iso, resolved, variant, relativeDays));
  }, [iso, variant, timeZone, relativeDays]);

  return (
    <time dateTime={iso} title={label + ' (' + zone + ')'}>
      {label}
      <span className="sr-only"> ({zone})</span>
    </time>
  );
}

/**
 * ⚠ A LOOKUP OBJECT, NOT A NESTED TERNARY (SonarCloud). Each entry is the `Intl` option set
 * for one variant:
 *   · `full`           — "Tue 29 Jul 2026, 2:14 pm" (the recap's meta line)
 *   · `day-month`      — "12 Jun" (the case header's "Opened", the consultation row)
 *   · `day-month-time` — "Tue 4 Aug, 10:00" (the upcoming-consultation nudge)
 */
const VARIANT_OPTIONS: Readonly<Record<LocalDateTimeVariant, Intl.DateTimeFormatOptions>> = {
  full: {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
  'day-month': { day: 'numeric', month: 'short' },
  'day-month-time': {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  },
};

/**
 * A relative day plus a clock time when `relativeDays` is on and the instant lands today or
 * tomorrow, otherwise the plain `variant` format.
 *
 * ⚠ Only the DATE half is ever replaced — "Today" alone would drop the one thing an
 * appointment row exists to tell you.
 */
function labelFor(
  iso: string,
  timeZone: string,
  variant: LocalDateTimeVariant,
  relativeDays: boolean
): string {
  if (relativeDays) {
    const day = relativeDay(iso, timeZone, new Date());
    if (day !== null) {
      const time = new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
      return `${day === 'today' ? 'Today' : 'Tomorrow'} at ${time}`;
    }
  }
  return formatIn(iso, timeZone, variant);
}

function formatIn(iso: string, timeZone: string, variant: LocalDateTimeVariant): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    ...VARIANT_OPTIONS[variant],
  }).format(new Date(iso));
}
