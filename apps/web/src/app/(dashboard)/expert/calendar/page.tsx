import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { weekStartDayKey, todayDayKey, isValidDayKey } from '@/lib/calendar/zoned-grid';
import { loadExpertCalendar, resolveExpertScheduleTimezone } from './_lib/load-expert-calendar';
import { CalendarShell } from './_components/calendar-shell';

export const metadata: Metadata = {
  title: 'Calendar — Balo',
  robots: { index: false, follow: false },
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far from today a `?week=` value may point before it is discarded (BAL-498 fix round 3, S2).
 * `?week=1000-01-01` passes BOTH `DAY_KEY_PATTERN` and `isValidDayKey` — the latter only rejects
 * years < 100, a `Date.UTC` 0-99 → 1900+n artefact — and opened a ~1000-year repository window on
 * an RSC render, which (unlike the availability API) nothing rate-limits. A year either side is
 * far more than a calendar with no month view can navigate to by hand.
 */
const MAX_WEEK_OFFSET_DAYS = 365;

/**
 * `true` when `dayKey` is within {@link MAX_WEEK_OFFSET_DAYS} of `todayKey`. Day keys are
 * `yyyy-MM-dd`, zero-padded, so `Date.UTC` diffing them is exact and zone-free.
 */
function isWeekWithinBounds(dayKey: string, todayKey: string): boolean {
  const asUtcMs = (key: string): number => {
    const [year, month, day] = key.split('-').map(Number);
    if (year === undefined || month === undefined || day === undefined) return Number.NaN;
    return Date.UTC(year, month - 1, day);
  };
  const offsetDays = Math.abs(asUtcMs(dayKey) - asUtcMs(todayKey)) / 86_400_000;
  return Number.isFinite(offsetDays) && offsetDays <= MAX_WEEK_OFFSET_DAYS;
}

interface ExpertCalendarPageProps {
  searchParams: Promise<{ view?: string; week?: string }>;
}

export default async function ExpertCalendarPage({
  searchParams,
}: Readonly<ExpertCalendarPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  // `/dashboard`, NOT `/login` — unified with `expert/layout.tsx:11`, which renders concurrently
  // and would otherwise race this page to a DIFFERENT destination for the same session state
  // (BAL-498 fix round 3, R6). The `(dashboard)` middleware sends an unauthenticated request on
  // to `/login` from there.
  if (!user) {
    redirect('/dashboard');
  }
  // ⚠ RE-CHECKS `activeMode`, NOT ONLY `expertProfileId` (BAL-498 fix round 3, R6). The layout
  // gate is the same condition, but Next renders layout and page CONCURRENTLY — without this,
  // `loadExpertCalendar`'s three-way DB fan-out still executes for a client-mode session the
  // layout is already redirecting away. Every sibling action in this segment re-checks both
  // (`save-schedule.ts`, `save-rate.ts`). `/dashboard` for both arms, matching the layout —
  // `expertProfileId` is read from the session, never a param, so there is no id to substitute.
  if (user.activeMode !== 'expert' || user.expertProfileId === undefined) {
    redirect('/dashboard');
  }
  const expertProfileId = user.expertProfileId;

  // ⚠ THE TIMEZONE MUST RESOLVE BEFORE "today" IS COMPUTED. `todayDayKey('UTC')` (the previous
  // implementation) picks the wrong WEEK for any expert whose local date disagrees with UTC's at
  // request time — routine for AEST/AEDT/NZST and for US zones near midnight UTC. `cache()`d, so
  // this is a de-duped read, not a second round trip (`loadExpertCalendar` resolves the same
  // value again below). BAL-498 fix round 1, B3.
  const scheduleTimezone = await resolveExpertScheduleTimezone(expertProfileId, user.id);

  const params = await searchParams;
  const todayKey = todayDayKey(scheduleTimezone);
  // Three gates, all required: SHAPE (the anchored regex), REALITY (`isValidDayKey` — `9999-99-99`
  // is well-shaped but not a date), and RANGE (S2 — `1000-01-01` is a real date, and opened a
  // millennium-wide unbounded query). Anything failing any of them falls back to this week.
  const requestedWeek =
    params.week !== undefined &&
    DAY_KEY_PATTERN.test(params.week) &&
    isValidDayKey(params.week) &&
    isWeekWithinBounds(params.week, todayKey)
      ? params.week
      : todayKey;
  const resolvedWeekStart = weekStartDayKey(requestedWeek);

  let view;
  try {
    view = await loadExpertCalendar({
      expertProfileId,
      userId: user.id,
      weekStartDayKey: resolvedWeekStart,
    });
  } catch (error) {
    log.error('Failed to load expert calendar', {
      expertProfileId,
      weekStartDayKey: resolvedWeekStart,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <CalendarShell view={view} initialWeekStartDayKey={resolvedWeekStart} />
    </div>
  );
}
