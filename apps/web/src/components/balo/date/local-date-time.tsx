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
 *
 * ⚠ `'day-month-time-range'` BAKES THE LENGTH INTO THE STRING — a reschedule moves a
 * booking, it never resizes it, so the length is always known before the range renders, and a
 * separate call site can no longer drop it by omission. `durationMinutes` is required only on
 * this variant (a discriminated union, not an optional prop every other variant ignores).
 * `relativeDays` is not offered here: no range consumer collapses to "Today"/"Tomorrow".
 */
export type LocalDateTimeVariant = 'full' | 'day-month' | 'day-month-time' | 'day-month-time-range';

type LocalDateTimeSharedProps = Readonly<{
  iso: string;
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
  /**
   * The caller's "now", for `relativeDays`. ⚠ SUPPLY A TICKING ONE (`useViewerClock`) OR THE
   * LABEL DECAYS: a surface left open overnight keeps saying "Tomorrow at 9:00 am" about a call
   * that is now today. The clock is LIFTED to the list rather than run here so one timer serves
   * every row instead of one per rendered date. Omitted, the label is computed once at mount.
   */
  now?: Date;
}>;

export type LocalDateTimeProps =
  | (LocalDateTimeSharedProps & { variant?: Exclude<LocalDateTimeVariant, 'day-month-time-range'> })
  | (LocalDateTimeSharedProps & {
      variant: 'day-month-time-range';
      /** Minutes from `iso`. The range's end and its "· N min" suffix both derive from this. */
      durationMinutes: number;
      /** Default `true`. `false` drops the leading date, for a row already grouped under a day
       *  heading (`availability-slots-panel.tsx`) — the ONE consumer of this variant that must
       *  not repeat it on every row. */
      showDay?: boolean;
    });

export function LocalDateTime(props: LocalDateTimeProps): React.JSX.Element {
  const { iso, timeZone, relativeDays = false, now } = props;
  const variant = props.variant ?? 'full';
  const isRange = props.variant === 'day-month-time-range';
  // Primitives, not an object — an object literal here would be a NEW reference every render
  // and re-fire the effect below on every re-render regardless of whether either value changed.
  const durationMinutes = isRange ? props.durationMinutes : undefined;
  const showDay = isRange ? (props.showDay ?? true) : true;

  const [label, setLabel] = useState(() =>
    formatFor(iso, timeZone ?? 'UTC', variant, durationMinutes, showDay)
  );
  const [zone, setZone] = useState(timeZone ?? 'UTC');

  useEffect(() => {
    const resolved = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!resolved) return;
    setZone(resolved);
    setLabel(
      durationMinutes === undefined
        ? labelFor(iso, resolved, variant, relativeDays, now ?? new Date())
        : formatFor(iso, resolved, variant, durationMinutes, showDay)
    );
  }, [iso, variant, timeZone, relativeDays, now, durationMinutes, showDay]);

  /* ⚠ THE TOOLTIP STAYS ABSOLUTE even when the visible label reads "Today at 6:00 pm". The
     relative form is the convenience; the exact date is the thing a record must always be able
     to answer, and the `sr-only` zone below is announced against it for the same reason. */
  const absolute = formatFor(iso, zone, variant, durationMinutes, showDay);

  return (
    <time dateTime={iso} title={absolute + ' (' + zone + ')'}>
      {label}
      <span className="sr-only"> ({zone})</span>
    </time>
  );
}

type NonRangeVariant = Exclude<LocalDateTimeVariant, 'day-month-time-range'>;

/**
 * ⚠ A LOOKUP OBJECT, NOT A NESTED TERNARY (SonarCloud). Each entry is the `Intl` option set
 * for one variant:
 *   · `full`           — "Tue 29 Jul 2026, 2:14 pm" (the recap's meta line)
 *   · `day-month`      — "12 Jun" (the case header's "Opened", the consultation row)
 *   · `day-month-time` — "Tue 4 Aug, 10:00" (the upcoming-consultation nudge)
 */
const VARIANT_OPTIONS: Readonly<Record<NonRangeVariant, Intl.DateTimeFormatOptions>> = {
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
  relativeDays: boolean,
  now: Date
): string {
  if (relativeDays) {
    const day = relativeDay(iso, timeZone, now);
    if (day !== null) {
      const time = new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
      return `${day === 'today' ? 'Today' : 'Tomorrow'} at ${time}`;
    }
  }
  // Callers only ever reach this with a non-range variant (the range variant carries its own
  // `durationMinutes` and is formatted by `formatFor` directly) — the fallback is unreachable
  // through the exported component, kept only so this function's own type stays honest.
  return formatIn(iso, timeZone, variant === 'day-month-time-range' ? 'day-month-time' : variant);
}

function formatIn(iso: string, timeZone: string, variant: NonRangeVariant): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    ...VARIANT_OPTIONS[variant],
  }).format(new Date(iso));
}

/** `iso`'s hour/minute/dayPeriod parts in `timeZone` — never the punctuation, which varies by
 *  ICU version. Sourced by `formatTimeRange` for both ends of a range. */
function timeParts(iso: string, timeZone: string): { clock: string; period: string } {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
  return { clock: `${hour}:${minute}`, period };
}

/** "6:00 – 6:30 pm", or "11:45 am – 12:15 pm" once the range crosses the am/pm boundary — the
 *  period is stated once unless the two ends disagree. */
function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const start = timeParts(startIso, timeZone);
  const end = timeParts(endIso, timeZone);
  return start.period === end.period
    ? `${start.clock} – ${end.clock} ${end.period}`
    : `${start.clock} ${start.period} – ${end.clock} ${end.period}`;
}

/** The day half of `'day-month-time'` (weekday + day + month), reused so the range's date reads
 *  identically to every other variant that shows one. */
function formatDayFor(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

function formatRangeIn(
  iso: string,
  timeZone: string,
  durationMinutes: number,
  showDay: boolean
): string {
  const endIso = new Date(new Date(iso).getTime() + durationMinutes * 60_000).toISOString();
  const range = `${formatTimeRange(iso, endIso, timeZone)} · ${durationMinutes} min`;
  return showDay ? `${formatDayFor(iso, timeZone)}, ${range}` : range;
}

function formatFor(
  iso: string,
  timeZone: string,
  variant: LocalDateTimeVariant,
  durationMinutes: number | undefined,
  showDay: boolean
): string {
  if (variant === 'day-month-time-range') {
    // Guaranteed a real number by `LocalDateTimeProps`'s discriminated union — the `?? 0` is
    // unreachable through the exported component, not a real fallback.
    return formatRangeIn(iso, timeZone, durationMinutes ?? 0, showDay);
  }
  return formatIn(iso, timeZone, variant);
}
