import type { ProjectEngagementWithMilestones, TimeEntryListRow, TimeEntrySums } from '@balo/db';
import { hoursLabel, type BillingPeriod } from '@balo/shared/engagements';
import { formatShortUtc } from '@/lib/format/utc-date';
import { deriveEngagementParties, type EngagementParties } from './engagement-parties';
import type { EngagementViewerContext } from './resolve-engagement-lens';

/**
 * The hours surfaces of a time-and-materials project: a bar and a log on each milestone, the
 * project totals, and the over-estimate banner. PURE. Time is whole minutes; hours appear only
 * in labels. No string here carries a rate or an amount, in any lens.
 */

/** Logged time at or above this share of a milestone's estimate reads as "near". */
const NEAR_ESTIMATE_RATIO = 0.8;

export interface TimeEntryView {
  id: string;
  /** "14 Oct". */
  workedOnLabel: string;
  note: string;
  /** "1.5 hrs". */
  hoursLabel: string;
  minutes: number;
  canEdit: boolean;
  canDelete: boolean;
}

export interface MilestoneTimeView {
  milestoneId: string;
  milestoneTitle: string;
  loggedMinutes: number;
  estimatedMinutes: number | null;
  tone: 'ok' | 'near' | 'over';
  /** 0..100; 0 when there is no estimate to fill against. */
  fillPercent: number;
  /** "3 of 8 hrs logged", or "3 hrs logged" without an estimate. */
  loggedLabel: string;
  /** "1 hr left of estimate" | "2 hrs over estimate"; null while comfortably within it. */
  remainingLabel: string | null;
  entries: TimeEntryView[];
  /** "Time log (3)". */
  logToggleLabel: string;
  /** "Logged by you" | "Logged by Charles"; null with no entries. */
  authorsLabel: string | null;
  canLog: boolean;
  /** The invitation shown when the viewer can log and nothing is logged yet; otherwise null. */
  emptyLabel: string | null;
  /** The client was already told this milestone went over its current estimate. */
  overNoticeSent: boolean;
}

export interface TimeTotalsView {
  loggedLabel: string;
  /** 0..100; null when no milestone carries an estimate. */
  fillPercent: number | null;
  over: boolean;
  period: { hoursLabel: string; detail: string } | null;
}

export interface WorkspaceTimeView {
  byMilestoneId: Record<string, MilestoneTimeView>;
  totals: TimeTotalsView;
  overEstimateBanner: { title: string; body: string } | null;
  clientCompanyName: string;
}

type MilestoneNode = ProjectEngagementWithMilestones['milestones'][number];

/** Minutes as a bare hour figure, e.g. "1.5". */
function hoursFigure(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

function listify(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function toneFor(logged: number, estimate: number | null): MilestoneTimeView['tone'] {
  if (estimate === null) return 'ok';
  if (logged > estimate) return 'over';
  if (estimate > 0 && logged >= estimate * NEAR_ESTIMATE_RATIO) return 'near';
  return 'ok';
}

function fillFor(logged: number, estimate: number | null): number {
  if (estimate === null) return 0;
  if (estimate === 0) return logged > 0 ? 100 : 0;
  return Math.min(100, Math.round((logged / estimate) * 100));
}

function remainingLabelFor(
  tone: MilestoneTimeView['tone'],
  logged: number,
  estimate: number | null
): string | null {
  if (estimate === null) return null;
  if (tone === 'near') return `${hoursLabel(estimate - logged)} left of estimate`;
  if (tone === 'over') return `${hoursLabel(logged - estimate)} over estimate`;
  return null;
}

function authorsLabelFor(
  entries: readonly TimeEntryListRow[],
  viewerUserId: string
): string | null {
  if (entries.length === 0) return null;
  const names = new Set<string>();
  if (entries.some((e) => e.userId === viewerUserId)) names.add('you');
  for (const entry of entries) {
    if (entry.userId !== viewerUserId) names.add(entry.authorFirstName ?? 'a teammate');
  }
  return `Logged by ${listify([...names])}`;
}

function entryView(
  entry: TimeEntryListRow,
  viewerUserId: string,
  canLogTime: boolean,
  inProgress: boolean
): TimeEntryView {
  const authored = canLogTime && entry.userId === viewerUserId;
  return {
    id: entry.id,
    workedOnLabel: formatShortUtc(new Date(entry.workedOn)),
    note: entry.note,
    hoursLabel: hoursLabel(entry.minutes),
    minutes: entry.minutes,
    canEdit: authored && inProgress,
    canDelete: authored,
  };
}

function milestoneTimeView(
  milestone: MilestoneNode,
  entries: readonly TimeEntryListRow[],
  loggedMinutes: number,
  input: {
    viewerUserId: string;
    canLogTime: boolean;
    clientCompanyName: string;
    overNoticeSent: boolean;
  }
): MilestoneTimeView {
  const estimate = milestone.estimatedMinutes;
  const inProgress = milestone.status === 'in_progress';
  const canLog = input.canLogTime && inProgress;
  const tone = toneFor(loggedMinutes, estimate);
  return {
    milestoneId: milestone.id,
    milestoneTitle: milestone.title,
    loggedMinutes,
    estimatedMinutes: estimate,
    tone,
    fillPercent: fillFor(loggedMinutes, estimate),
    loggedLabel:
      estimate === null
        ? `${hoursFigure(loggedMinutes)} hrs logged`
        : `${hoursFigure(loggedMinutes)} of ${hoursFigure(estimate)} hrs logged`,
    remainingLabel: remainingLabelFor(tone, loggedMinutes, estimate),
    entries: entries.map((e) => entryView(e, input.viewerUserId, input.canLogTime, inProgress)),
    logToggleLabel: `Time log (${entries.length})`,
    authorsLabel: authorsLabelFor(entries, input.viewerUserId),
    canLog,
    emptyLabel:
      canLog && entries.length === 0
        ? `Log time as you work — ${input.clientCompanyName} sees every entry and its note.`
        : null,
    overNoticeSent: input.overNoticeSent,
  };
}

/** "1 Oct – 31 Oct": the period's first and last day (its end is exclusive). */
function periodRangeLabel(period: BillingPeriod): string {
  const start = new Date(period.startOn);
  const last = new Date(new Date(period.endOn).getTime() - 24 * 60 * 60 * 1000);
  return `${formatShortUtc(start)} – ${formatShortUtc(last)}`;
}

/** Fill for the project total: a zero total estimate with time logged reads as full. */
function totalFill(logged: number, estimate: number): number {
  if (estimate === 0) return logged > 0 ? 100 : 0;
  return fillFor(logged, estimate);
}

function totalsView(input: {
  milestones: readonly MilestoneNode[];
  sums: TimeEntrySums;
  period: BillingPeriod | null;
  lens: EngagementViewerContext['lens'];
  parties: EngagementParties;
}): TimeTotalsView {
  const { milestones, sums, period, lens, parties } = input;
  const estimated = milestones.filter((m) => m.estimatedMinutes !== null);
  const hasEstimate = estimated.length > 0;
  const estimate = estimated.reduce((sum, m) => sum + (m.estimatedMinutes ?? 0), 0);
  // Only time on a milestone that carries an estimate is measured against the estimate.
  const logged = estimated.reduce((sum, m) => sum + (sums.byMilestone[m.id] ?? 0), 0);
  const unestimatedNote =
    hasEstimate && sums.totalMinutes > logged
      ? ` · ${hoursFigure(sums.totalMinutes)} hrs in all`
      : '';

  let periodView: TimeTotalsView['period'] = null;
  if (period !== null && sums.periodMinutes !== null) {
    const invoiceOn = formatShortUtc(new Date(period.nextInvoiceOn));
    const billing =
      lens === 'client'
        ? `invoiced on ${invoiceOn} for the time ${parties.expertPersonShort} has logged`
        : `billed to ${parties.clientCompanyName} on ${invoiceOn}, whatever the review status`;
    periodView = {
      hoursLabel: hoursLabel(sums.periodMinutes),
      detail: `${periodRangeLabel(period)} · ${billing}`,
    };
  }

  return {
    loggedLabel: hasEstimate
      ? `${hoursFigure(logged)} of ${hoursFigure(estimate)} hrs logged against the estimate${unestimatedNote}`
      : `${hoursFigure(sums.totalMinutes)} hrs logged`,
    fillPercent: hasEstimate ? totalFill(logged, estimate) : null,
    over: hasEstimate && logged > estimate,
    period: periodView,
  };
}

function overEstimateBanner(
  overTitles: readonly string[],
  lens: EngagementViewerContext['lens'],
  parties: EngagementParties
): WorkspaceTimeView['overEstimateBanner'] {
  if (overTitles.length === 0) return null;
  const titles = listify(overTitles);
  const single = overTitles.length === 1;
  if (lens === 'expert') {
    return {
      title: `${titles} ${single ? 'is' : 'are'} over estimate.`,
      body: `${parties.clientCompanyName} sees the hours on every milestone. If the scope has grown, propose a change rather than logging on.`,
    };
  }
  return {
    title: `${titles} ${single ? 'has' : 'have'} gone over estimate.`,
    body: `The time log on each milestone shows what the hours went on. If the scope has grown, ${parties.expertPartyShort} can propose a change.`,
  };
}

/**
 * The time view for the workspace, or null unless the project is time and materials.
 * `canLogTime` is the page's capability decision; the mapper never derives it from the lens.
 */
export function mapTimeToView(input: {
  engagement: ProjectEngagementWithMilestones;
  ctx: EngagementViewerContext;
  entries: readonly TimeEntryListRow[];
  sums: TimeEntrySums;
  period: BillingPeriod | null;
  viewerUserId: string;
  canLogTime: boolean;
  /** Milestones whose over-estimate notice was already sent at their current estimate. */
  notifiedMilestoneIds: readonly string[];
}): WorkspaceTimeView | null {
  const { engagement, ctx, entries, sums, period, viewerUserId, canLogTime } = input;
  if (engagement.pricingMethod !== 'tm') return null;

  const parties = deriveEngagementParties(engagement);
  const byMilestoneId: Record<string, MilestoneTimeView> = {};
  const overTitles: string[] = [];
  for (const milestone of engagement.milestones) {
    const own = entries.filter((e) => e.engagementMilestoneId === milestone.id);
    const view = milestoneTimeView(milestone, own, sums.byMilestone[milestone.id] ?? 0, {
      viewerUserId,
      canLogTime,
      clientCompanyName: parties.clientCompanyName,
      overNoticeSent: input.notifiedMilestoneIds.includes(milestone.id),
    });
    byMilestoneId[milestone.id] = view;
    if (view.tone === 'over') overTitles.push(milestone.title);
  }

  return {
    byMilestoneId,
    totals: totalsView({
      milestones: engagement.milestones,
      sums,
      period,
      lens: ctx.lens,
      parties,
    }),
    overEstimateBanner: overEstimateBanner(overTitles, ctx.lens, parties),
    clientCompanyName: parties.clientCompanyName,
  };
}
