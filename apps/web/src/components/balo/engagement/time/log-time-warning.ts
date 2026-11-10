import { hoursLabel } from '@balo/shared/engagements';

interface LogTimeWarningInput {
  milestoneTitle: string;
  estimatedMinutes: number | null;
  /** The milestone's live total right now, including the entry being edited. */
  loggedMinutes: number;
  /** The entry being edited, whose minutes the new value replaces; 0 when logging fresh. */
  replacedMinutes: number;
  /** The minutes typed into the form. */
  addMinutes: number;
  clientCompanyName: string;
  /** The client was already told this milestone went over its current estimate. */
  overNoticeSent: boolean;
}

/**
 * The inline heads-up under the log-time form when the typed hours take the milestone past
 * its estimate, or null when they don't. Going over is allowed; the warning only makes it
 * visible before it happens. The "before" total leaves out the entry being edited.
 */
export function logTimeWarning(input: Readonly<LogTimeWarningInput>): string | null {
  const { milestoneTitle, estimatedMinutes, loggedMinutes, replacedMinutes, addMinutes } = input;
  if (estimatedMinutes === null || addMinutes <= 0) return null;
  const before = loggedMinutes - replacedMinutes;
  const projected = before + addMinutes;
  if (projected <= estimatedMinutes) return null;
  const estimate = hoursLabel(estimatedMinutes);
  if (before > estimatedMinutes) {
    return `${milestoneTitle} is already over its ${estimate} estimate. This takes it to ${hoursLabel(projected)}.`;
  }
  const crossing = `This takes ${milestoneTitle} ${hoursLabel(projected - estimatedMinutes)} over its ${estimate} estimate.`;
  return input.overNoticeSent
    ? `${crossing} ${input.clientCompanyName} was told when it first went over.`
    : `${crossing} ${input.clientCompanyName} will be notified.`;
}
