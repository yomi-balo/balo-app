import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  reminderSendAt,
  type ReminderStep,
} from '@balo/shared/notifications';

const MINUTE_MS = 60_000;

export interface PlannedStep {
  readonly stepKey: string;
  readonly fireAt: Date;
}

/**
 * The steps a sweep should arm now. A step's send time is its offset from the anchor with the
 * step's timing window applied; it is armable from one `leadMs` before that send time until
 * `REMINDER_ARMABLE_AFTER_DUE_MS` after it. The 24-hour grace is measured on the SEND time, so
 * a Saturday step still arms for Monday 09:00, and an outage never releases an older backlog.
 */
export function planDueSteps(input: {
  steps: readonly ReminderStep[];
  anchor: Date;
  now: Date;
  leadMs: number;
  zone: string;
}): PlannedStep[] {
  const earliest = input.now.getTime() - REMINDER_ARMABLE_AFTER_DUE_MS;
  const latest = input.now.getTime() + input.leadMs;
  const planned: PlannedStep[] = [];
  for (const step of input.steps) {
    const dueAt = new Date(input.anchor.getTime() + step.offsetMinutes * MINUTE_MS);
    const fireAt = reminderSendAt(dueAt, step.timing, input.zone);
    if (fireAt.getTime() >= earliest && fireAt.getTime() <= latest) {
      planned.push({ stepKey: step.key, fireAt });
    }
  }
  return planned;
}
