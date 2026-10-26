import type { MilestoneTimeView, TimeEntryView } from '@/lib/engagement/time-view';

export function entryView(overrides: Partial<TimeEntryView> = {}): TimeEntryView {
  return {
    id: 'te-1',
    workedOnLabel: '12 Oct',
    note: 'Mapped the discovery flows',
    hoursLabel: '1.5 hrs',
    minutes: 90,
    canEdit: false,
    canDelete: false,
    ...overrides,
  };
}

export function milestoneTimeView(overrides: Partial<MilestoneTimeView> = {}): MilestoneTimeView {
  return {
    milestoneId: 'm-1',
    milestoneTitle: 'Discovery workshop',
    loggedMinutes: 240,
    estimatedMinutes: 480,
    tone: 'ok',
    fillPercent: 50,
    loggedLabel: '4 of 8 hrs logged',
    remainingLabel: null,
    entries: [entryView()],
    logToggleLabel: 'Time log (1)',
    authorsLabel: 'Logged by Priya',
    canLog: false,
    emptyLabel: null,
    ...overrides,
  };
}
